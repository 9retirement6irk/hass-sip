/* SIP listen card: hear a phone line's call in the browser (listen-only).
 *
 *   type: custom:sip-listen-card
 *   entity: media_player.sip_4_phone_line
 *   name: Line 1            # optional
 */
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
    this._update();
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._ctx = new Ctx();
      await this._ctx.resume();
      this._nextTime = 0;
      const unsub = await this._hass.connection.subscribeMessage(
        (event) => this._onAudio(event),
        { type: "sip/listen", entity_id: this._config.entity }
      );
      if (!this._starting) {
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
    if (this._ctx) {
      this._ctx.close().catch(() => {});
      this._ctx = null;
    }
  }

  _setLevel(value) {
    const bar = this.shadowRoot && this.shadowRoot.querySelector(".level i");
    if (bar) bar.style.height = `${Math.min(100, Math.round(value * 100))}%`;
  }

  _onAudio(event) {
    const ctx = this._ctx;
    if (!ctx || !event || !event.pcm) return;
    const raw = atob(event.pcm);
    const count = raw.length >> 1;
    if (!count) return;
    const buffer = ctx.createBuffer(1, count, event.rate);
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < count; i++) {
      let sample = raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8);
      if (sample >= 32768) sample -= 65536;
      const value = sample / 32768;
      data[i] = value;
      const abs = value < 0 ? -value : value;
      if (abs > peak) peak = abs;
    }
    this._setLevel(Math.sqrt(peak));

    const now = ctx.currentTime;
    // Start a little ahead so network jitter does not cause gaps, and jump
    // back to "now" if a stall let the queue grow into noticeable delay.
    if (this._nextTime < now + 0.02 || this._nextTime > now + 0.6) {
      this._nextTime = now + 0.12;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(this._nextTime);
    this._nextTime += buffer.duration;
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
