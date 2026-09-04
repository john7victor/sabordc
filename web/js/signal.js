// Cliente do canal de sinalização (WebSocket). Só texto passa por aqui.

export class Signal extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.you = null;
    this.closedByUs = false;
    this.attempt = 0;
    this.queue = [];
    this.rtt = null;
    this._pinger = null;
  }

  connect() {
    this.closedByUs = false;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.attempt = 0;
      this.emit("open");
      for (const m of this.queue.splice(0)) this.ws.send(m);
      this._pinger = setInterval(() => this.send({ t: "ping", ts: Date.now() }), 5000);
    };

    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === "welcome") this.you = msg.you;
      if (msg.t === "pong") { this.rtt = Date.now() - msg.ts; this.emit("rtt", this.rtt); return; }
      this.emit(msg.t, msg);
      this.emit("*", msg);
    };

    this.ws.onclose = (ev) => {
      clearInterval(this._pinger);
      this.emit("close", ev);
      if (this.closedByUs) return;
      // 403/409/423 chegam como falha de handshake: não adianta insistir muito.
      const delay = Math.min(800 * 2 ** this.attempt++, 8000);
      if (this.attempt <= 8) {
        this.emit("reconnecting", { in: delay, attempt: this.attempt });
        setTimeout(() => this.connect(), delay);
      } else {
        this.emit("dead");
      }
    };

    this.ws.onerror = () => this.emit("error");
    return this;
  }

  send(msg) {
    const raw = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(raw);
    else if (this.queue.length < 100) this.queue.push(raw);
  }

  signal(to, payload) {
    this.send({ t: "signal", to, payload });
  }

  close() {
    this.closedByUs = true;
    clearInterval(this._pinger);
    this.ws?.close();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    this.addEventListener(type, (e) => fn(e.detail));
    return this;
  }
}
