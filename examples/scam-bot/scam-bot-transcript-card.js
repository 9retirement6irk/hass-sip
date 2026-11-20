// Scam Bot call card: everything for Scam Bot calls in one place.
// One tab per phone line. Each tab shows that line's calls as a chat.
//  - Line idle: number / reason / menu keys and a Call button.
//  - Line in a call: a text box to send Margaret an instruction (Enter or Send),
//    plus Conference and End call buttons at the top right.
//  - Listen in / Stop listening plays the selected line in the browser.
// Config:
//   type: custom:scam-bot-transcript-card
//   pipeline_id: 01m7nq83cs796fvwt4v02en2p7
//   lines:
//     - name: Line 1
//       player: media_player.sip_4_phone_line
//       active: binary_sensor.sip_4_call_active
//   max_calls: 3, interval: 2            (optional)
//   Optional overrides: instruction_entity, send_script, call_script,
//   add_script, number_entity, reason_entity, keys_entity
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

class ScamBotTranscriptCard extends HTMLElement {
  setConfig(config) {
    if (!config.pipeline_id) throw new Error("pipeline_id is required");
    this._stopListening();
    this._config = {
      max_calls: 3,
      interval: 2,
      instruction_entity: "input_text.scam_bot_live_instruction",
      send_script: "script.scam_bot_send_instruction",
      call_script: "script.scam_bot_call_number",
      add_script: "script.scam_bot_add_number",
      number_entity: "input_text.scam_bot_number",
      reason_entity: "input_text.scam_bot_scam_type",
      keys_entity: "input_text.scam_bot_menu_keys",
      ai_task_entity: "ai_task.claude_ai_task_2",
      lines: [],
      ...config,
    };
    this._lines = (this._config.lines || []).map((l, i) => ({
      name: l.name || `Line ${i + 1}`,
      player: l.player || "",
      active: l.active || "",
      key: (l.player || "").split(".")[1] || "",
    }));
    if (!this._lines.length) this._lines = [{ name: "All calls", player: "", active: "", key: "" }];
    this._cache = {}; // run_id -> {ts, events, done}
    this._sent = this._lines.map(() => []); // instructions typed here, per tab
    this._drafts = this._lines.map(() => "");
    this._pending = this._lines.map(() => 0); // when Call was pressed, until it connects
    this._pendingNum = this._lines.map(() => "");
    this._caps = this._lines.map(() => []); // live captions per line
    this._tab = 0;
    this._tabChosen = false;
    this._error = "";
    this._note = "";
    this._noteBad = false;
    this._confirmEnd = false;
    this._filled = false;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._build();
    this._update();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) { this._subscribeCaptions(); this._tick(); }
    else this._updateChrome();
  }

  connectedCallback() {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this._tick(), (this._config?.interval || 2) * 1000);
    if (this._hass) { this._subscribeCaptions(); this._tick(); }
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
    if (this._capUnsub) { this._capUnsub.then((u) => u()).catch(() => {}); this._capUnsub = null; }
    this._stopListening();
  }

  getCardSize() { return 10; }
  getGridOptions() { return { columns: 12, rows: 10, min_columns: 6 }; }

  _state(entity) {
    const s = entity && this._hass && this._hass.states[entity];
    return s ? s.state : "";
  }

  _isLive(i) {
    return this._state(this._lines[i].active) === "on";
  }

  // Dialling: Call was pressed here and the line has not connected yet.
  _isPending(i) {
    return !this._isLive(i) && Date.now() - this._pending[i] < 55000;
  }

  // The other party's number on this line, formatted, or "" when idle.
  _number(i) {
    let raw = "";
    if (this._isLive(i)) {
      const s = this._hass && this._hass.states[this._lines[i].player];
      const a = (s && s.attributes) || {};
      raw = a.remote_party || a.remote_name || "";
    } else if (this._isPending(i)) {
      raw = this._pendingNum[i];
    }
    raw = String(raw || "").replace(/^sip:/, "").replace(/@.*$/, "");
    let d = raw.replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    return raw;
  }

  // Live captions from the SIP integration (sip.start_transcription).
  _subscribeCaptions() {
    if (this._capUnsub || !this._hass || !this._hass.connection || !this._hass.connection.subscribeEvents) return;
    this._capUnsub = this._hass.connection.subscribeEvents((ev) => this._onCaption(ev), "sip_live_transcript");
    this._capUnsub.catch(() => { this._capUnsub = null; });
  }

  _onCaption(ev) {
    const d = (ev && ev.data) || {};
    if (!d.text) return;
    const ents = (this._hass && this._hass.entities) || {};
    const i = this._lines.findIndex((l) => ents[l.player] && ents[l.player].device_id === d.device_id);
    if (i < 0) return;
    this._caps[i].push({ text: d.text, at: Date.now(), over: Boolean(d.over_reply) });
    this._caps[i] = this._caps[i].slice(-3);
    this._updateChrome();
  }

  _busyLine(i) {
    return this._isLive(i) || this._isPending(i);
  }

  async _tick() {
    if (!this._hass || this._busy) return;
    this._busy = true;
    try {
      const pid = this._config.pipeline_id;
      const list = await this._hass.callWS({ type: "assist_pipeline/pipeline_debug/list", pipeline_id: pid });
      const runs = list.pipeline_runs || [];
      for (const r of runs) {
        const c = this._cache[r.pipeline_run_id];
        if (c && c.done) continue;
        const res = await this._hass.callWS({
          type: "assist_pipeline/pipeline_debug/get",
          pipeline_id: pid,
          pipeline_run_id: r.pipeline_run_id,
        });
        const events = res.events || [];
        this._cache[r.pipeline_run_id] = {
          ts: r.timestamp,
          events,
          done: events.some((e) => e.type === "run-end"),
        };
      }
      const keep = new Set(runs.map((r) => r.pipeline_run_id));
      for (const id of Object.keys(this._cache)) if (!keep.has(id)) delete this._cache[id];
      this._error = "";
    } catch (e) {
      this._error = (e && (e.message || e.code)) || String(e);
    }
    this._busy = false;
    this._update();
  }

  // Which tab a conversation belongs to: converse puts the line in the id
  // (scambot_<line>_<time>); older ids without a line show on every tab.
  _belongs(cid, i) {
    const key = this._lines[i].key;
    if (!key) return true;
    if (cid.includes(key)) return true;
    return !this._lines.some((l) => l.key && cid.includes(l.key));
  }

  _calls(i) {
    const calls = {};
    const runs = Object.entries(this._cache).sort((a, b) => a[1].ts.localeCompare(b[1].ts));
    for (const [, run] of runs) {
      const start = run.events.find((e) => e.type === "run-start");
      const cid = start?.data?.conversation_id || "unknown";
      if (!this._belongs(cid, i)) continue;
      if (!calls[cid]) calls[cid] = { start: run.ts, lines: [] };
      const call = calls[cid];
      const sttEnd = run.events.find((e) => e.type === "stt-end");
      const vadStart = run.events.find((e) => e.type === "stt-vad-start");
      const intentEnd = run.events.find((e) => e.type === "intent-end");
      const err = run.events.find((e) => e.type === "error");
      const partial = run.events
        .filter((e) => e.type === "intent-progress" && e.data?.chat_log_delta?.content)
        .map((e) => e.data.chat_log_delta.content)
        .join("");
      if (sttEnd) {
        const t = sttEnd.data?.stt_output?.text || "";
        call.lines.push({ who: "them", text: t || "(couldn't make out what they said)", ts: sttEnd.timestamp, faint: !t });
      } else if (!run.done) {
        call.lines.push({ who: "status", text: vadStart ? "They're talking…" : "Listening…", ts: run.ts });
      } else if (err) {
        call.lines.push({ who: "status", text: err.data?.code === "stt-stream-failed" ? "(silence or unclear audio)" : `(error: ${err.data?.code || "unknown"})`, ts: err.timestamp });
      }
      if (intentEnd) {
        const t = intentEnd.data?.intent_output?.response?.speech?.plain?.speech || partial;
        call.lines.push({ who: "bot", text: t, ts: intentEnd.timestamp });
      } else if (sttEnd && !run.done) {
        call.lines.push({ who: "bot", text: partial ? partial + "…" : "Thinking…", ts: sttEnd.timestamp, faint: !partial });
      }
      call.end = run.ts;
    }
    // oldest first, so the newest call sits just above the text box
    const list = Object.values(calls)
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(-this._config.max_calls);
    // drop your own instructions into the call they were sent during
    const sent = this._sent[i];
    list.forEach((call, n) => {
      const from = n === 0 ? "" : call.start;
      const to = n === list.length - 1 ? "\uffff" : list[n + 1].start;
      for (const s of sent) if (s.ts >= from && s.ts < to) call.lines.push({ who: "you", text: s.text, ts: s.ts });
      call.lines.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    });
    if (!list.length && sent.length) {
      list.push({ start: sent[0].ts, lines: sent.map((s) => ({ who: "you", text: s.text, ts: s.ts })) });
    }
    return list;
  }

  _esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  _time(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }); }
    catch { return ""; }
  }

  _errText(e) {
    return (e && (e.message || e.code)) || String(e);
  }

  _build() {
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { position: relative; padding: 8px 16px 12px; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
        .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid var(--divider-color); margin-bottom: 8px; }
        .tabs { display: flex; gap: 4px; }
        .tab { font: inherit; background: none; border: none; cursor: pointer; padding: 10px 14px; color: var(--secondary-text-color);
               border-bottom: 2px solid transparent; margin-bottom: -1px; display: flex; align-items: center; gap: 6px; }
        .tab.sel { color: var(--primary-color); border-bottom-color: var(--primary-color); font-weight: 500; }
        .tnum { font-size: .85em; font-weight: 400; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .tnum::before { content: "· "; }
        .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background: var(--error-color); animation: pulse 1.2s infinite; }
        .dot.off { background: var(--disabled-text-color, #999); animation: none; opacity: .5; }
        @keyframes pulse { 50% { opacity: .3; } }
        .spacer { flex: 1; }
        .pill { font: inherit; cursor: pointer; border: 1px solid var(--divider-color); border-radius: 18px; padding: 6px 14px;
                background: none; color: var(--primary-text-color); white-space: nowrap; }
        .pill.on { border-color: var(--primary-color); color: var(--primary-color); }
        .pill.green { border: none; background: var(--success-color, #43a047); color: #fff; }
        .pill.red { border: none; background: var(--error-color, #db4437); color: #fff; }
        .pill:disabled { opacity: .5; cursor: default; }
        [hidden] { display: none !important; }
        .err { color: var(--error-color); font-size: .85em; margin-bottom: 8px; }
        .log { flex: 1; min-height: 260px; max-height: 520px; overflow-y: auto; padding-right: 4px; }
        .call { border-top: 1px solid var(--divider-color); padding-top: 10px; margin-top: 10px; }
        .call:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
        .callhead { font-size: .85em; color: var(--secondary-text-color); margin-bottom: 8px; text-align: center; }
        .row { display: flex; margin: 6px 0; }
        .row.bot, .row.you { justify-content: flex-end; }
        .row.status { justify-content: center; }
        .bubble { max-width: 80%; padding: 8px 12px; border-radius: 14px; line-height: 1.35; overflow-wrap: anywhere; }
        .them .bubble { background: var(--secondary-background-color); border-bottom-left-radius: 4px; }
        .bot .bubble { background: var(--primary-color); color: var(--text-primary-color, #fff); border-bottom-right-radius: 4px; }
        .you .bubble { background: none; border: 1px dashed var(--primary-color); border-bottom-right-radius: 4px; }
        .bubble.faint { opacity: .6; font-style: italic; }
        .who { font-size: .75em; font-weight: 600; opacity: .8; margin-bottom: 2px; }
        .t { font-weight: 400; opacity: .8; margin-left: 4px; }
        .status { font-size: .8em; color: var(--secondary-text-color); font-style: italic; }
        .empty { color: var(--secondary-text-color); padding: 24px 0; text-align: center; }
        .caps { margin-top: 8px; padding: 6px 12px; border-left: 3px solid var(--primary-color); font-size: .9em; font-style: italic;
                color: var(--secondary-text-color); }
        .caps::before { content: "Hearing now"; display: block; font-size: .75em; font-style: normal; font-weight: 600; opacity: .8; }
        .caps .over { color: var(--primary-text-color); }
        .compose { display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
        input { font: inherit; padding: 10px 14px; border-radius: 20px; outline: none; min-width: 0; box-sizing: border-box;
                border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); }
        input:focus { border-color: var(--primary-color); }
        .compose input { flex: 1; }
        .compose .num { flex: 2 1 160px; }
        .compose .keys { flex: 1 1 120px; }
        .compose .reason { flex: 1 1 100%; }
        .go { font: inherit; cursor: pointer; border: none; border-radius: 20px; padding: 10px 22px;
              background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .go:disabled { opacity: .5; cursor: default; }
        .idle .go { margin-left: auto; }
        .idle .scan { font: inherit; cursor: pointer; border: 1px dashed var(--primary-color); border-radius: 20px; padding: 10px 16px;
                      background: none; color: var(--primary-color); }
        .idle .scan:disabled { opacity: .5; cursor: default; }
        .hint { font-size: .8em; color: var(--secondary-text-color); margin-top: 6px; min-height: 1.2em; }
        .hint.bad { color: var(--error-color); }
        .veil { position: absolute; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: flex-start; justify-content: center;
                padding: 56px 16px 16px; border-radius: inherit; z-index: 2; }
        .dialog { background: var(--card-background-color, #fff); color: var(--primary-text-color); border-radius: 16px; padding: 16px;
                  width: 100%; max-width: 380px; box-shadow: 0 8px 28px rgba(0,0,0,.35); display: flex; flex-direction: column; gap: 10px; }
        .dialog h3 { margin: 0; font-size: 1.1em; font-weight: 500; }
        .dialog .btns { display: flex; gap: 8px; flex-wrap: wrap; }
        .dialog .btns .pill { flex: 1; }
        .dialog .msg { font-size: .85em; color: var(--secondary-text-color); min-height: 1.2em; }
        .dialog .msg.bad { color: var(--error-color); }
      </style>
      <ha-card>
        <div class="top">
          <div class="tabs"></div>
          <button type="button" class="pill listen">Listen in</button>
          <span class="spacer"></span>
          <button type="button" class="pill green conf" hidden>Conference</button>
          <button type="button" class="pill red end" hidden>End call</button>
        </div>
        <div class="err" hidden></div>
        <div class="log"></div>
        <div class="caps" hidden></div>
        <div class="compose live" hidden>
          <input class="msg" type="text" maxlength="255" autocomplete="off" enterkeyhint="send" />
          <button type="button" class="go send">Send</button>
        </div>
        <div class="compose idle" hidden>
          <input class="num" type="tel" maxlength="100" autocomplete="off" placeholder="Phone number to call" />
          <input class="keys" type="text" maxlength="100" autocomplete="off" placeholder="Menu keys (optional, e.g. 1 3)" />
          <input class="reason" type="text" maxlength="255" autocomplete="off" placeholder="Reason for calling (optional, anything)" />
          <input class="scanfile" type="file" accept="image/*,.pdf,application/pdf,.eml,.txt,.html,.htm,message/rfc822,text/plain" hidden />
          <button type="button" class="scan" title="Read the number and reason from a screenshot or an email">From screenshot / email</button>
          <button type="button" class="go callbtn">Call</button>
        </div>
        <div class="hint"></div>
        <div class="veil" hidden>
          <div class="dialog">
            <h3>Conference</h3>
            <input class="addnum" type="tel" maxlength="40" autocomplete="off" placeholder="Number to add to the call" />
            <div class="btns"><button type="button" class="pill green add">Call and add</button></div>
            <div class="btns">
              <button type="button" class="pill merge">Merge lines</button>
              <button type="button" class="pill split">Split lines</button>
            </div>
            <div class="msg"></div>
            <div class="btns"><button type="button" class="pill close">Close</button></div>
          </div>
        </div>
      </ha-card>`;
    const q = (s) => this.shadowRoot.querySelector(s);
    this._el = {
      tabs: q(".tabs"), listen: q(".listen"), conf: q(".conf"), end: q(".end"),
      err: q(".err"), log: q(".log"), caps: q(".caps"), live: q(".compose.live"), idle: q(".compose.idle"),
      input: q("input.msg"), send: q(".send"),
      num: q("input.num"), keys: q("input.keys"), reason: q("input.reason"), call: q(".callbtn"),
      scan: q(".scan"), scanfile: q("input.scanfile"),
      hint: q(".hint"), veil: q(".veil"), addnum: q("input.addnum"), add: q(".add"),
      merge: q(".merge"), split: q(".split"), dmsg: q(".dialog .msg"), close: q(".close"),
    };
    const el = this._el;
    const canAct = this._lines.some((l) => l.player);
    el.listen.hidden = !canAct;
    el.tabs.innerHTML = this._lines
      .map((l, i) => `<button type="button" class="tab" data-i="${i}"><span class="dot off"></span><span>${this._esc(l.name)}</span><span class="tnum"></span></button>`)
      .join("");
    el.tabs.addEventListener("click", (ev) => {
      const b = ev.target.closest(".tab");
      if (b) this._selectTab(Number(b.dataset.i), true);
    });
    const onEnter = (input, fn) => input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); fn(); }
    });
    onEnter(el.input, () => this._send());
    el.input.addEventListener("input", () => { this._drafts[this._tab] = el.input.value; });
    // Keep the keyboard open: the Send button never takes focus from the box.
    el.send.addEventListener("mousedown", (ev) => ev.preventDefault());
    el.send.addEventListener("touchend", (ev) => { ev.preventDefault(); this._send(); });
    el.send.addEventListener("click", () => this._send());
    for (const f of [el.num, el.keys, el.reason]) onEnter(f, () => this._call());
    // keep the helpers in step, so calling in from your phone uses the same reason
    el.num.addEventListener("change", () => this._save(this._config.number_entity, el.num.value));
    el.keys.addEventListener("change", () => this._save(this._config.keys_entity, el.keys.value));
    el.reason.addEventListener("change", () => this._save(this._config.reason_entity, el.reason.value));
    el.call.addEventListener("click", () => this._call());
    el.scan.addEventListener("click", () => el.scanfile.click());
    el.scanfile.addEventListener("change", () => {
      const file = el.scanfile.files && el.scanfile.files[0];
      el.scanfile.value = "";
      if (file) this._scan(file);
    });
    el.listen.addEventListener("click", () => (this._listen ? this._stopListening() : this._startListening()));
    el.end.addEventListener("click", () => this._endCall());
    el.conf.addEventListener("click", () => { el.dmsg.textContent = ""; el.veil.hidden = false; el.addnum.focus(); });
    el.close.addEventListener("click", () => { el.veil.hidden = true; });
    el.veil.addEventListener("click", (ev) => { if (ev.target === el.veil) el.veil.hidden = true; });
    onEnter(el.addnum, () => this._addNumber());
    el.add.addEventListener("click", () => this._addNumber());
    el.merge.addEventListener("click", () => this._bridge("bridge", "Lines merged."));
    el.split.addEventListener("click", () => this._bridge("unbridge", "Lines split."));
    this._lastHtml = null;
  }

  _save(entity, value) {
    if (!entity || !this._hass) return Promise.resolve();
    return this._hass.callService("input_text", "set_value", { entity_id: entity, value: value.trim() }).catch((e) => {
      this._setNote(`Couldn't save: ${this._errText(e)}`, true);
    });
  }

  _setNote(text, bad) {
    this._note = text || "";
    this._noteBad = Boolean(bad);
    clearTimeout(this._noteTimer);
    if (text) this._noteTimer = setTimeout(() => { this._note = ""; this._updateChrome(); }, 8000);
    this._updateChrome();
  }

  _selectTab(i, byUser) {
    if (byUser) this._tabChosen = true;
    if (i === this._tab) return;
    this._drafts[this._tab] = this._el.input.value;
    this._tab = i;
    this._el.input.value = this._drafts[i] || "";
    this._note = "";
    this._confirmEnd = false;
    this._lastHtml = null;
    this._stick = true;
    if (this._listen) this._startListening(); // follow the selected line
    this._update();
  }

  // Tabs, buttons, which input row shows, and the hint line.
  _updateChrome() {
    const el = this._el;
    if (!el) return;
    // until you pick a tab yourself, follow whichever line is in a call
    if (!this._tabChosen && !this._busyLine(this._tab)) {
      const live = this._lines.findIndex((_, i) => this._isLive(i));
      if (live >= 0 && live !== this._tab) { this._selectTab(live, false); return; }
    }
    // fill the call fields from the helpers once
    if (!this._filled && this._hass) {
      const val = (e) => { const s = this._state(e); return s === "unknown" || s === "unavailable" ? "" : s; };
      el.num.value = val(this._config.number_entity);
      el.keys.value = val(this._config.keys_entity);
      el.reason.value = val(this._config.reason_entity);
      this._filled = true;
    }
    el.tabs.querySelectorAll(".tab").forEach((b, i) => {
      b.classList.toggle("sel", i === this._tab);
      b.querySelector(".dot").classList.toggle("off", !this._isLive(i));
      const num = this._number(i);
      const t = b.querySelector(".tnum");
      t.textContent = num;
      t.hidden = !num;
    });
    const line = this._lines[this._tab];
    const live = this._isLive(this._tab);
    const pending = this._isPending(this._tab);
    const busy = live || pending;
    if (!busy) this._confirmEnd = false;
    el.live.hidden = !line.player || !busy;
    el.idle.hidden = !line.player || busy;
    el.conf.hidden = !line.player || !live;
    el.end.hidden = !line.player || !busy;
    el.end.textContent = this._confirmEnd ? "Are you sure?" : pending ? "Cancel call" : "End call";
    el.listen.textContent = this._listen ? "Stop listening" : "Listen in";
    el.listen.classList.toggle("on", Boolean(this._listen));
    el.input.placeholder = `Tell Margaret on ${line.name}…`;
    el.hint.hidden = !line.player;
    el.hint.classList.toggle("bad", Boolean(this._note) && this._noteBad);
    el.hint.textContent = this._note
      || (live ? "Only Margaret gets this. The caller can't hear it."
        : pending ? `Calling ${this._number(this._tab) || "…"} on ${line.name}`
        : `${line.name} is free. Enter a number and tap Call.`);
    const caps = this._caps[this._tab].filter((c) => Date.now() - c.at < 15000);
    el.caps.hidden = !live || !caps.length;
    el.caps.innerHTML = caps.map((c) => `<div class="${c.over ? "over" : ""}">${this._esc(c.text)}</div>`).join("");
  }

  _update() {
    const el = this._el;
    if (!el) return;
    this._updateChrome();
    el.err.hidden = !this._error;
    el.err.textContent = this._error ? `Can't read the transcript: ${this._error} (an admin account is needed)` : "";
    const calls = this._calls(this._tab);
    const live = this._isLive(this._tab);
    const num = this._number(this._tab);
    const html = calls.length
      ? calls.map((c, n) => `
        <div class="call">
          <div class="callhead">${n === calls.length - 1 && live ? `Live call${num ? " with " + this._esc(num) : ""}` : "Call"} · started ${this._esc(this._time(c.start))}</div>
          ${c.lines.map((l) => `
            <div class="row ${l.who}">
              ${l.who === "status"
                ? `<div class="status">${this._esc(l.text)}</div>`
                : `<div class="bubble ${l.faint ? "faint" : ""}">
                     <div class="who">${l.who === "bot" ? "Margaret" : l.who === "you" ? "You → Margaret" : "Them"} <span class="t">${this._esc(this._time(l.ts))}</span></div>
                     <div>${this._esc(l.text)}</div>
                   </div>`}
            </div>`).join("")}
        </div>`).join("")
      : `<div class="empty">No calls on ${this._esc(this._lines[this._tab].name)} yet. The conversation shows up here as it happens.</div>`;
    if (html === this._lastHtml) return;
    const log = el.log;
    const atBottom = this._stick || this._lastHtml === null || log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    this._stick = false;
    log.innerHTML = html;
    this._lastHtml = html;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  async _send() {
    const el = this._el;
    const text = el.input.value.trim();
    const line = this._lines[this._tab];
    if (!text || !line.player || !this._hass || this._sending) return;
    this._sending = true;
    const tab = this._tab;
    // clear right away so the box is ready for the next instruction
    this._drafts[tab] = "";
    el.input.value = "";
    try {
      await this._hass.callService("input_text", "set_value", { entity_id: this._config.instruction_entity, value: text });
      const [domain, service] = this._config.send_script.split(".");
      await this._hass.callService(domain, service, { line: line.player });
      this._sent[tab].push({ text, ts: new Date().toISOString() });
      this._note = "";
      this._stick = true;
    } catch (e) {
      // put the text back so it isn't lost
      if (this._tab === tab && !el.input.value) el.input.value = text;
      else if (!this._drafts[tab]) this._drafts[tab] = text;
      this._setNote(`Couldn't send: ${this._errText(e)}`, true);
    }
    this._sending = false;
    this._update();
  }

  async _call() {
    const el = this._el;
    const line = this._lines[this._tab];
    const number = el.num.value.trim();
    if (!line.player || !this._hass || this._calling) return;
    if (!number) { this._setNote("Enter a phone number first.", true); el.num.focus(); return; }
    this._calling = true;
    el.call.disabled = true;
    const tab = this._tab;
    try {
      await Promise.all([
        this._save(this._config.number_entity, number),
        this._save(this._config.reason_entity, el.reason.value),
        this._save(this._config.keys_entity, el.keys.value),
      ]);
      // script.turn_on returns at once; the script itself runs for the whole call
      await this._hass.callService("script", "turn_on", {
        entity_id: this._config.call_script,
        variables: { number, scam_type: el.reason.value.trim(), menu_keys: el.keys.value.trim(), player: line.player },
      });
      this._pending[tab] = Date.now();
      this._pendingNum[tab] = number;
      this._note = "";
    } catch (e) {
      this._setNote(`Couldn't start the call: ${this._errText(e)}`, true);
    }
    this._calling = false;
    el.call.disabled = false;
    this._update();
  }

  // Read a scam screenshot or email with the AI task and fill in the call fields.
  async _scan(file) {
    const el = this._el;
    if (!this._hass || this._scanning) return;
    this._scanning = true;
    el.scan.disabled = true;
    el.scan.textContent = "Reading it…";
    let uploaded = null;
    try {
      let emailText = "";
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name || "")) {
        const pdf = await this._readPdf(file);
        if (pdf.text) emailText = pdf.text;
        else file = pdf.image;
      }
      const isImage = !emailText && (file.type || "").startsWith("image/");
      const attachments = [];
      if (isImage) {
        const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
        const form = new FormData();
        form.append("media_content_id", "media-source://media_source/local/.");
        form.append("file", new File([file], `scambot_scan_${Date.now()}.${ext}`, { type: file.type }));
        const resp = await this._hass.fetchWithAuth("/api/media_source/local_source/upload", { method: "POST", body: form });
        if (!resp.ok) throw new Error(`upload failed (${resp.status})`);
        uploaded = (await resp.json()).media_content_id;
        attachments.push({ media_content_id: uploaded, media_content_type: file.type });
      } else if (!emailText) {
        emailText = (await file.text()).slice(0, 20000);
      }
      const instructions =
        "This is a scam message (a screenshot, or the text of an email): a fake invoice, order, renewal, refund, " +
        "tech-support or similar scam that tells the victim to call a phone number. " +
        "Return two things. number: the scammer's callback phone number the victim is told to call, as digits only; " +
        "for US numbers give 10 digits without the leading 1; empty if there is none. " +
        "reason: a short brief for Margaret, an elderly woman who believes the message is real and is calling them. " +
        "Write it to her in the second person, like: 'You got an Amazon order email for $278.97 you never placed: " +
        "Apple EarPods, AirPods Pro 3 and a Fire TV Stick, paid with PayPal. Order 453-7901-55091, Nov 20. " +
        "You want it cancelled before it ships. Yes, you got their email.' Include the company they pretend to be, " +
        "what it is for, the amount, every order, invoice or reference number exactly as written, the date, " +
        "what she wants (cancel, refund), and 'Yes, you got their email' (or text/letter, whichever it is). " +
        "Keep reason under 230 characters." +
        (emailText ? `\n\nThe email:\n${emailText}` : "");
      const result = await this._hass.connection.sendMessagePromise({
        type: "call_service",
        domain: "ai_task",
        service: "generate_data",
        service_data: {
          task_name: "Scam Bot scan",
          entity_id: this._config.ai_task_entity,
          instructions,
          attachments,
          structure: {
            number: { description: "Callback phone number, digits only", required: true, selector: { text: {} } },
            reason: { description: "Brief for Margaret, under 230 characters", required: true, selector: { text: {} } },
          },
        },
        return_response: true,
      });
      const data = (result && result.response && result.response.data) || {};
      const number = String(data.number || "").replace(/[^0-9+]/g, "");
      const reason = String(data.reason || "").trim().slice(0, 255);
      if (!number && !reason) throw new Error("couldn't find a number or details in it");
      if (number) { el.num.value = number; this._save(this._config.number_entity, number); }
      if (reason) { el.reason.value = reason; this._save(this._config.reason_entity, reason); }
      el.keys.value = "";
      this._save(this._config.keys_entity, "");
      this._setNote(number ? "Filled in from the scan. Check it, then tap Call." : "Found the details but no phone number; enter it, then tap Call.", !number);
    } catch (e) {
      this._setNote(`Couldn't read it: ${this._errText(e)}`, true);
    } finally {
      if (uploaded) {
        this._hass.connection.sendMessagePromise({ type: "media_source/local_source/remove", media_content_id: uploaded }).catch(() => {});
      }
      this._scanning = false;
      el.scan.disabled = false;
      el.scan.textContent = "From screenshot / email";
    }
  }

  // PDFs: use the text when it has some; a scanned PDF becomes a picture of page 1.
  async _readPdf(file) {
    const base = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/";
    const pdfjs = await import(`${base}pdf.min.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      standardFontDataUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/standard_fonts/",
    }).promise;
    try {
      let text = "";
      for (let p = 1; p <= Math.min(doc.numPages, 5); p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        text += content.items.map((i) => i.str || "").join(" ") + "\n";
      }
      text = text.replace(/[ \t]+/g, " ").trim();
      if (text.length >= 80) return { text: text.slice(0, 20000) };
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't render the PDF"))), "image/png")
      );
      return { image: new File([blob], "page1.png", { type: "image/png" }) };
    } finally {
      doc.destroy();
    }
  }

  async _endCall() {
    const line = this._lines[this._tab];
    if (!line.player || !this._hass) return;
    if (!this._confirmEnd) {
      this._confirmEnd = true;
      clearTimeout(this._endTimer);
      this._endTimer = setTimeout(() => { this._confirmEnd = false; this._updateChrome(); }, 4000);
      this._updateChrome();
      return;
    }
    clearTimeout(this._endTimer);
    this._confirmEnd = false;
    const tab = this._tab;
    try {
      await this._hass.callService("sip", "hangup", { entity_id: line.player });
      this._pending[tab] = 0;
    } catch (e) {
      this._setNote(`Couldn't end the call: ${this._errText(e)}`, true);
    }
    this._updateChrome();
  }

  _dialogMsg(text, bad) {
    this._el.dmsg.textContent = text;
    this._el.dmsg.classList.toggle("bad", Boolean(bad));
  }

  async _addNumber() {
    const number = this._el.addnum.value.trim();
    if (!number) { this._dialogMsg("Enter a number to add.", true); return; }
    try {
      await this._hass.callService("script", "turn_on", { entity_id: this._config.add_script, variables: { number } });
      this._dialogMsg(`Calling ${number}. They join the call when they answer.`);
    } catch (e) {
      this._dialogMsg(`Couldn't add them: ${this._errText(e)}`, true);
    }
  }

  async _bridge(service, done) {
    const players = this._lines.map((l) => l.player).filter(Boolean);
    try {
      await this._hass.callService("sip", service, { entity_id: players });
      this._dialogMsg(done);
    } catch (e) {
      this._dialogMsg(this._errText(e), true);
    }
  }

  // ---- listen in (plays the selected line; follows tab changes) ----
  async _startListening() {
    const line = this._lines[this._tab];
    if (!line.player || !this._hass) return;
    const token = (this._listenToken = (this._listenToken || 0) + 1);
    if (this._listen && this._listen.unsub) {
      try { this._listen.unsub(); } catch (e) { /* gone */ }
      this._listen.unsub = null;
    }
    try {
      if (!this._listen) {
        // created right here, inside the tap, so the browser lets it play
        this._listen = { unsub: null, player: null, ready: sipCreatePcmPlayer() };
        this._updateChrome();
      }
      const l = this._listen;
      if (!l.player) l.player = await l.ready;
      if (token !== this._listenToken || this._listen !== l) return;
      const unsub = await this._hass.connection.subscribeMessage(
        (event) => {
          if (token === this._listenToken && event && event.pcm) l.player.push(event.pcm, event.rate);
        },
        { type: "sip/listen", entity_id: line.player }
      );
      if (token !== this._listenToken || this._listen !== l) { unsub(); return; }
      l.unsub = unsub;
    } catch (e) {
      if (token === this._listenToken) {
        this._stopListening();
        this._setNote(`Couldn't listen in: ${this._errText(e)}`, true);
      }
    }
  }

  _stopListening() {
    this._listenToken = (this._listenToken || 0) + 1;
    const l = this._listen;
    this._listen = null;
    if (l) {
      if (l.unsub) { try { l.unsub(); } catch (e) { /* gone */ } }
      l.ready.then((p) => p.close()).catch(() => {});
    }
    this._updateChrome();
  }
}

customElements.define("scam-bot-transcript-card", ScamBotTranscriptCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "scam-bot-transcript-card",
  name: "Scam Bot calls",
  description: "Scam Bot call control: per-line transcript, call, instruct, listen in, conference",
});
