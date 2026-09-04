// Utilidades de interface compartilhadas pelo painel e pela sala.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Ícones inline: nada de rede, o app roda offline.
const ICONS = {
  flame: "M12 2s4 4.2 4 8a4 4 0 0 1-8 0c0-1.2.4-2.2 1-3-2.6 1.6-5 4.4-5 8a8 8 0 1 0 16 0c0-5.5-5-9.8-8-13Z",
  screen: "M3 5h18v11H3zM8 20h8M12 16v4",
  mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 11a7 7 0 0 0 14 0M12 18v3",
  micOff: "M9 9v3a3 3 0 0 0 4.6 2.5M15 11V6a3 3 0 0 0-5.9-.7M5 11a7 7 0 0 0 10.8 5.9M12 18v3M3 3l18 18",
  users: "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6",
  chat: "M20 12a7.5 7.5 0 0 1-10.9 6.7L4 20l1.3-4.1A7.5 7.5 0 1 1 20 12Z",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 14H3a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 4.3 7.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.3.9Z",
  copy: "M9 9h10v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V9ZM15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4",
  check: "M4 12.5 9 17.5 20 6.5",
  link: "M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1L11.2 4.7M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7",
  x: "M6 6l12 12M18 6 6 18",
  minus: "M5 12h14",
  square: "M5 5h14v14H5z",
  expand: "M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5",
  volume: "M11 5 6.5 9H3v6h3.5L11 19V5ZM15.5 9.5a4 4 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10",
  volumeOff: "M11 5 6.5 9H3v6h3.5L11 19V5ZM16 10l4 4M20 10l-4 4",
  stop: "M7 7h10v10H7z",
  refresh: "M20 11a8 8 0 1 0-.6 4M20 5v6h-6",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 9h17M3.5 15h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  wifi: "M5 12.5a10 10 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M12 19.5h.01",
  kick: "M14 5h5v14h-5M11 15l3-3-3-3M14 12H3",
  send: "M4 12 20 4l-4 16-4-6-8-2Z",
  alert: "M12 8v5M12 16.5h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  eye: "M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff: "M10.6 6.2A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4M6.3 7.9A16.6 16.6 0 0 0 2 12s3.6 6.5 10 6.5c1.6 0 3-.4 4.2-.9M10 10a3 3 0 0 0 4 4M3 3l18 18",
};

export function icon(name, cls = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (cls) svg.setAttribute("class", cls);
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICONS[name] || "");
  svg.append(p);
  return svg;
}

/* ------------------------------------------------------------- toasts -- */
let toastHost;
export function toast(message, kind = "") {
  if (!toastHost) {
    toastHost = el("div", { id: "toasts" });
    document.body.append(toastHost);
  }
  const node = el("div", { class: `toast ${kind}` }, message);
  toastHost.append(node);
  setTimeout(() => {
    node.style.transition = "opacity .2s, transform .2s";
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    setTimeout(() => node.remove(), 220);
  }, 2600);
}

/* ------------------------------------------------------------ formato -- */
export function initials(name = "?") {
  // Só palavras que começam com letra ou número: "Host (você)" vira "H", não "H(".
  const parts = name.trim().split(/\s+/).filter((p) => /^[\p{L}\p{N}]/u.test(p));
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

const PALETTE = ["#ff7a45", "#ff3d71", "#8b5cf6", "#3ddc97", "#38bdf8", "#fbbf24", "#f472b6", "#22d3ee"];
export function colorFor(seed = "") {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function avatarFor(peer) {
  const node = el("div", { class: "avatar" }, initials(peer.name));
  node.style.background = `linear-gradient(140deg, ${colorFor(peer.id + peer.name)}, ${colorFor(peer.name)})`;
  return node;
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function fmtRate(bitsPerSecond) {
  if (!bitsPerSecond) return "—";
  const mbps = bitsPerSecond / 1e6;
  return mbps >= 1 ? `${mbps.toFixed(1)} Mb/s` : `${Math.round(bitsPerSecond / 1e3)} kb/s`;
}

export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/* ------------------------------------------- detector de fala (voz) ----- */
export function createVoiceMeter(stream, onLevel) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  // A política de autoplay pode deixar o contexto suspenso até um clique de
  // verdade; sem isso o medidor fica sempre em zero.
  const resume = () => ctx.state === "suspended" && ctx.resume().catch(() => {});
  resume();
  if (ctx.state === "suspended") {
    ["click", "keydown", "touchstart"].forEach((ev) =>
      document.addEventListener(ev, resume, { once: true, passive: true })
    );
  }

  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf;

  const tick = () => {
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) / 70));
    raf = requestAnimationFrame(tick);
  };
  tick();

  return {
    stop() {
      cancelAnimationFrame(raf);
      src.disconnect();
      ctx.close().catch(() => {});
    },
  };
}
