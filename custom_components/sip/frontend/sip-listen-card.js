/* SIP listen card: hear a phone line's call in the browser (listen-only).
 *
 *   type: custom:sip-listen-card
 *   entity: media_player.sip_4_phone_line
 *   name: Line 1            # optional
 */
// ---- smooth PCM playback for listen-in ----
// A jitter buffer that plays continuously (instead of one short buffer per
// network message, which crackles and gaps). It starts ~250 ms behind live and
// grows its delay a little each time the network stalls, up to 600 ms.
class SipPcmRing {
  constructor(rate) {
    this.rate = rate;
    this.size = Math.ceil(rate * 2);
    this.buf = new Float32Array(this.size);
    this.r = 0;
    this.n = 0;
    this.target = Math.round(rate * 0.25);
    this.max = Math.round(rate * 0.6);
    this.playing = false;
  }
  push(d) {
    for (let i = 0; i < d.length; i++) {
      this.buf[(this.r + this.n) % this.size] = d[i];
      if (this.n < this.size) this.n++;
      else this.r = (this.r + 1) % this.size;
    }
    // clock drift or a burst after a stall: skip ahead instead of lagging more
    const cap = this.target + Math.round(this.rate * 0.4);
    if (this.n > cap) {
      const drop = this.n - this.target;
      this.r = (this.r + drop) % this.size;
      this.n -= drop;
    }
  }
  pull(out) {
    if (!this.playing && this.n >= this.target) this.playing = true;
    for (let i = 0; i < out.length; i++) {
      if (this.playing && this.n > 0) {
        out[i] = this.buf[this.r];
        this.r = (this.r + 1) % this.size;
        this.n--;
      } else {
        out[i] = 0;
        if (this.playing) {
          // ran dry: wait for a bigger cushion before playing again
          this.playing = false;
          this.target = Math.min(this.max, this.target + Math.round(this.rate * 0.05));
        }
      }
    }
  }
}

const SIP_PCM_WORKLET = `${SipPcmRing.toString()}
class SipPcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new SipPcmRing(sampleRate);
    this.port.onmessage = (e) => this.ring.push(e.data);
  }
  process(inputs, outputs) {
    const ch = outputs[0];
    this.ring.pull(ch[0]);
    for (let c = 1; c < ch.length; c++) ch[c].set(ch[0]);
    return true;
  }
}
registerProcessor("sip-pcm-player", SipPcmPlayerProcessor);`;

// Must be called from a click/tap handler (browsers only start audio then).
async function sipCreatePcmPlayer() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ latencyHint: "playback" });
  const resumed = ctx.resume(); // before any await, while the tap still counts
  let node = null;
  let ring = null;
  // AudioWorklet needs https; over plain http fall back to ScriptProcessor
  if (ctx.audioWorklet && window.isSecureContext && typeof AudioWorkletNode !== "undefined") {
    const url = URL.createObjectURL(new Blob([SIP_PCM_WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
      node = new AudioWorkletNode(ctx, "sip-pcm-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    } catch (e) {
      node = null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!node) {
    ring = new SipPcmRing(ctx.sampleRate);
    node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => ring.pull(e.outputBuffer.getChannelData(0));
  }
  node.connect(ctx.destination);
  await resumed;
  const outRate = ctx.sampleRate;
  // stateful linear resampler, so chunk boundaries join without clicks
  const st = { rate: 0, pos: 0, last: 0 };
  return {
    push(b64, rate) {
      const raw = atob(b64);
      const n = raw.length >> 1;
      if (!n || !rate) return 0;
      const input = new Float32Array(n);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        let s = raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8);
        if (s >= 32768) s -= 65536;
        const v = s / 32768;
        input[i] = v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      if (rate !== st.rate) { st.rate = rate; st.pos = 0; st.last = input[0]; }
      let out = input;
      if (rate !== outRate) {
        const step = rate / outRate;
        out = new Float32Array(Math.ceil((n - st.pos) / step) + 1);
        let k = 0;
        let p = st.pos;
        while (p < n) {
          const i = Math.floor(p);
          const f = p - i;
          const a = i === 0 ? st.last : input[i - 1];
          const b = input[i];
          out[k++] = a + (b - a) * f;
          p += step;
        }
        st.pos = p - n;
        out = out.subarray(0, k);
      }
      st.last = input[n - 1];
      if (ring) ring.push(out);
      else node.port.postMessage(out.slice());
      return peak;
    },
    close() {
      try { node.disconnect(); } catch (e) { /* already */ }
      try { const p = ctx.close(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* closed */ }
    },
  };
}

class SipListenCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("Set 'entity' to a SIP phone line media_player");
    }
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  getCardSize() {
    return 1;
  }

  static getStubConfig(hass) {
    const entity = Object.keys(hass.states).find(
      (id) => id.startsWith("media_player.") && id.endsWith("_phone_line")
    );
    return { entity: entity || "" };
  }

  disconnectedCallback() {
    this._stop();
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px 16px; display: flex; align-items: center; gap: 12px; }
        .text { flex: 1; min-width: 0; }
        .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .status { color: var(--secondary-text-color); font-size: 0.9em; }
        button {
          font: inherit; cursor: pointer; border: none; border-radius: 18px;
          padding: 8px 18px; min-width: 88px;
          background: var(--primary-color); color: var(--text-primary-color, #fff);
        }
        button.on { background: var(--error-color, #db4437); }
        .level { width: 8px; height: 28px; border-radius: 4px; background: var(--divider-color); position: relative; overflow: hidden; }
        .level i { position: absolute; left: 0; right: 0; bottom: 0; height: 0; background: var(--success-color, #43a047); transition: height 80ms linear; }
      </style>
      <ha-card>
        <div class="text">
          <div class="name"></div>
          <div class="status"></div>
        </div>
        <div class="level"><i></i></div>
        <button type="button">Listen</button>
      </ha-card>`;
    this.shadowRoot.querySelector("button").addEventListener("click", () => {
      if (this._unsub || this._starting) this._stop();
      else this._start();
    });
    this._update();
  }

  _update() {
    if (!this.shadowRoot || !this._config) return;
    const stateObj = this._hass && this._hass.states[this._config.entity];
    const name =
      this._config.name ||
      (stateObj && stateObj.attributes.friendly_name) ||
      this._config.entity;
    const listening = Boolean(this._unsub);
    let status = stateObj ? stateObj.state : "unavailable";
    if (this._error) status = this._error;
    else if (listening) status = `Listening · line is ${status}`;
    this.shadowRoot.querySelector(".name").textContent = name;
    this.shadowRoot.querySelector(".status").textContent = status;
    const button = this.shadowRoot.querySelector("button");
    button.textContent = listening || this._starting ? "Stop" : "Listen";
    button.classList.toggle("on", listening || Boolean(this._starting));
  }

  async _start() {
    this._error = "";
    this._starting = true;
    // created right here, inside the tap, so the browser lets it play
    const ready = sipCreatePcmPlayer();
    this._ready = ready;
    this._update();
    try {
      this._player = await ready;
      const unsub = await this._hass.connection.subscribeMessage(
        (event) => this._onAudio(event),
        { type: "sip/listen", entity_id: this._config.entity }
      );
      if (!this._starting || this._ready !== ready) {
        unsub();
        return;
      }
      this._unsub = unsub;
    } catch (err) {
      this._error = (err && err.message) || "Could not start listening";
      this._closeAudio();
    } finally {
      this._starting = false;
      this._update();
    }
  }

  _stop() {
    this._starting = false;
    if (this._unsub) {
      try {
        this._unsub();
      } catch (err) {
        /* connection already gone */
      }
      this._unsub = null;
    }
    this._closeAudio();
    this._setLevel(0);
    this._update();
  }

  _closeAudio() {
    const ready = this._ready;
    this._ready = null;
    this._player = null;
    if (ready) ready.then((p) => p.close()).catch(() => {});
  }

  _setLevel(value) {
    const bar = this.shadowRoot && this.shadowRoot.querySelector(".level i");
    if (bar) bar.style.height = `${Math.min(100, Math.round(value * 100))}%`;
  }

  _onAudio(event) {
    if (!this._player || !event || !event.pcm) return;
    this._setLevel(Math.sqrt(this._player.push(event.pcm, event.rate)));
  }
}

if (!customElements.get("sip-listen-card")) {
  customElements.define("sip-listen-card", SipListenCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "sip-listen-card",
    name: "SIP Listen",
    description: "Listen in on a SIP phone line's call from the browser.",
  });
}
