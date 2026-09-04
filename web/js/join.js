// Sala do convidado: recebe a tela do host, manda a própria voz e ouve todo
// mundo. Uma única conexão — com o PC de quem abriu a sala.

import { $, $$, el, icon, toast, avatarFor, fmtClock, createVoiceMeter } from "./ui.js";
import { Signal } from "./signal.js";
import { Peer, MIC_CONSTRAINTS, displayConstraints, preferVideoCodecs, trackRouter } from "./rtc.js";
import { Grid } from "./grid.js";

// Qualidade de quando UM CONVIDADO transmite. Fica salva no navegador dele
// (não precisa reconfigurar toda vez) — o padrão é conservador de propósito,
// porque quem carrega essa tela é o host, retransmitindo pra todo mundo (o
// mesmo motivo do teto de banda dele). Dá pra baixar na hora se o jeito que
// alguém captura a tela (jogo em resolução esticada, tela cheia exclusiva
// trocando de modo etc.) sair torto — a resolução muda sem precisar
// retransmitir do zero, só a taxa (fps) precisa de uma nova transmissão.
const SHARE_BITRATE = { "720p": 3000, "1080p": 4000, "1440p": 6000, nativa: 6000 };
const OWN_SHARE = {
  resolution: localStorage.getItem("sabor.shareRes") || "1080p",
  framerate: Number(localStorage.getItem("sabor.shareFps")) || 30,
  get bitrateKbps() { return SHARE_BITRATE[this.resolution] || SHARE_BITRATE["1080p"]; },
};

const state = {
  boot: null,
  signal: null,
  me: null,
  hostId: null,
  peer: null,
  mic: null,
  micOn: false,
  micSent: false,
  gateMeter: null,
  people: new Map(),
  voices: new Map(),   // ownerId -> { audio, stream, meter, level }
  live: new Map(),     // peerId -> startedAt (quem esta transmitindo agora)
  salas: [],           // [{id, name}] — como os canais de voz do Discord
  grid: null,           // Grid: um card por transmissao ao vivo na sala
  ownScreen: null,      // MediaStream da NOSSA própria transmissão, se ligada
  ownScreenTx: [],
  screenSent: false,
  volGame: 1,
  volVoice: 1,
  idleTimer: null,
};

const token = new URLSearchParams(location.search).get("t") || "";

// Quando o painel do host manda a gente pra cá pra assistir uma transmissão
// (o botão "Assistir uma transmissão" dele), ele deixa o caminho de volta
// pendurado na âncora do link — funciona mesmo essa sala sendo de outro
// site/PC, porque a âncora viaja junto com a navegação.
const homeUrl = (() => {
  const m = /sabor_home=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
})();

// A tela de "bloqueado" pode aparecer antes de qualquer outra coisa (o fetch
// inicial falhando, por exemplo), então esse botão é ligado direto aqui,
// fora do fluxo normal do portão/sala. Script type="module" já roda depois
// do HTML parseado, então os elementos já existem nesse ponto.
if (homeUrl) {
  const btn = $("#blocked-home");
  btn.hidden = false;
  btn.addEventListener("click", () => { location.href = homeUrl; });
}

/* ======================================================== bootstrap === */

async function boot() {
  let res;
  try {
    res = await fetch(`/api/bootstrap?t=${encodeURIComponent(token)}`);
  } catch {
    return blocked("Sem resposta", "O PC que hospeda a sala parece estar offline.");
  }
  if (!res.ok) {
    return blocked("Link inválido", "Este link expirou ou foi renovado pelo host. Peça um novo.");
  }
  state.boot = await res.json();

  $("#gate-room").textContent = state.boot.roomName;
  $("#room-name").textContent = state.boot.roomName;
  document.title = `${state.boot.roomName} · Sabor DC`;

  $("#gate-name").value = localStorage.getItem("sabor.name") || "";
  $("#gate-mic-icon").replaceChildren(icon("micOff"));
  if (!state.boot.guestsCanTalk) {
    $("#gate-mic").hidden = true;
    $("#gate-note").textContent = "O host desativou o microfone dos convidados.";
  }

  state.grid = new Grid($("#grid"));
  wireGate();
  wireRoom();
}

function blocked(title, sub, retry = true) {
  $("#gate").hidden = true;
  $("#room").hidden = true;
  const b = $("#blocked");
  b.hidden = false;
  $(".blocked-icon").replaceChildren(icon("alert"));
  $("#blocked-title").textContent = title;
  $("#blocked-sub").textContent = sub;
  $("#blocked-retry").hidden = !retry;
}

/* ============================================================ portão == */

function wireGate() {
  $("#gate-mic").addEventListener("click", armMic);
  $("#blocked-retry").addEventListener("click", () => location.reload());

  $("#gate-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#gate-name").value.trim();
    if (!name) return;
    localStorage.setItem("sabor.name", name);
    state.gateMeter?.stop();
    state.gateMeter = null;
    $("#gate").hidden = true;
    $("#room").hidden = false;
    connect(name);
  });
}

async function armMic() {
  if (state.mic) {
    state.mic.getTracks().forEach((t) => t.stop());
    state.mic = null;
    state.gateMeter?.stop();
    state.gateMeter = null;
    $("#gate-mic").classList.remove("on");
    $("#gate-mic-icon").replaceChildren(icon("micOff"));
    $("#gate-mic-title").textContent = "Entrar com microfone";
    $("#gate-mic-sub").textContent = "Toque para liberar e testar";
    $("#gate-level").style.width = "0%";
    return;
  }

  if (!window.isSecureContext) {
    $("#gate-note").className = "gate-note warn";
    $("#gate-note").textContent =
      "Sem HTTPS o navegador bloqueia o microfone. Você entra só assistindo — peça ao host o link https.";
    return;
  }

  try {
    state.mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    $("#gate-mic").classList.add("on");
    $("#gate-mic-icon").replaceChildren(icon("mic"));
    $("#gate-mic-title").textContent = "Microfone liberado";
    $("#gate-mic-sub").textContent = "Fale para ver o medidor mexer";
    state.gateMeter = createVoiceMeter(state.mic, (lvl) => {
      $("#gate-level").style.width = `${Math.round(lvl * 100)}%`;
    });
  } catch {
    $("#gate-note").className = "gate-note warn";
    $("#gate-note").textContent = "Microfone negado. Dá para entrar só assistindo.";
  }
}

/* ======================================================== sinalização = */

function connect(name) {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", state.boot.token);
  url.searchParams.set("name", name);

  const sig = new Signal(url.toString());
  state.signal = sig;

  sig.on("open", () => setNet("ok", "conectado"));
  sig.on("reconnecting", () => setNet("", "reconectando…"));
  sig.on("dead", () =>
    blocked("Conexão perdida", "A sala pode ter sido fechada, trancada ou estar cheia."));
  sig.on("rtt", (ms) => { if (state.peer) setNet("ok", `${ms} ms`); });

  sig.on("welcome", (m) => {
    state.me = m.you;
    state.salas = m.room.salas || [];
    state.people.clear();
    for (const p of m.room.peers) state.people.set(p.id, p);
    for (const l of m.room.live || []) state.live.set(l.id, l.startedAt);
    const host = m.room.peers.find((p) => p.role === "host");
    if (host) openHost(host.id);
    (m.chat || []).forEach(addChat);
    updateWaitingState();
    renderPeople();
  });

  // Alguem (host ou outro convidado) comecou ou parou de transmitir. O card
  // sai da grade por causa DESTA mensagem, nao por o navegador detectar que a
  // faixa de video parou — é o que evita a tela travada em "pausado" que só
  // um sair-e-voltar resolvia antes.
  sig.on("live", (m) => {
    if (m.on) state.live.set(m.id, m.startedAt);
    else {
      state.live.delete(m.id);
      if (m.id !== state.me?.id) state.grid.remove(m.id);
    }
    updateWaitingState();
    renderPeople();
  });

  sig.on("peer-join", (m) => {
    state.people.set(m.peer.id, m.peer);
    if (m.peer.role === "host") openHost(m.peer.id);
    renderPeople();
    sysChat(`${m.peer.name} entrou`);
  });

  sig.on("peer-leave", (m) => {
    const p = state.people.get(m.id);
    if (p) sysChat(`${p.name} saiu`);
    state.people.delete(m.id);
    dropVoice(m.id);
    state.live.delete(m.id);
    state.grid.remove(m.id); // por garantia — o "live:false" já deveria ter tirado o card
    if (m.id === state.hostId) {
      state.hostId = null;
      state.peer?.close();
      state.peer = null;
      updateWaitingState();
      showWaiting("O host saiu", "A transmissão volta quando ele reabrir o Sabor DC.");
    } else {
      updateWaitingState();
    }
    renderPeople();
  });

  sig.on("peer-update", (m) => { state.people.set(m.peer.id, m.peer); renderPeople(); });

  sig.on("salas", (m) => { state.salas = m.salas || []; renderPeople(); });

  sig.on("sala-troca", (m) => {
    const p = state.people.get(m.id);
    if (p) p.sala = m.sala;
    if (m.id === state.me?.id) {
      state.me.sala = m.sala;
      const nome = state.salas.find((s) => s.id === m.sala)?.name || m.sala;
      toast(`Você foi para ${nome}.`, "ok");
      // Quem ficou pra trás some da grade: o host para de mandar essas telas.
      for (const [id] of [...state.grid.tiles]) {
        if (id !== state.me.id && state.people.get(id)?.sala !== m.sala) state.grid.remove(id);
      }
      updateWaitingState();
    }
    renderPeople();
  });
  sig.on("state", (m) => {
    const p = state.people.get(m.id);
    if (p) { p.muted = m.muted; renderPeople(); }
  });

  sig.on("signal", (m) => {
    if (m.from !== state.hostId) return;
    // O host desistiu da rota direta e vai refazer tudo pelo TURN. Precisamos
    // jogar fora a conexão atual: aplicar a oferta nova numa RTCPeerConnection
    // que já falhou não recupera nada.
    if (m.payload?.control === "reset") {
      showWaiting("Reconectando", "Tentando por um caminho alternativo…");
      openHost(state.hostId);
      return;
    }
    state.peer?.accept(m.payload);
  });

  sig.on("chat", addChat);
  sig.on("force-mute", () => {
    if (state.micOn) { setMic(false); toast("O host pediu silêncio.", ""); }
  });
  sig.on("kicked", () => {
    sig.close();
    blocked("Você foi removido", "O host removeu você desta sala.", false);
  });

  sig.connect();
}

function setNet(kind, text) {
  $("#net-pill").className = `pill ${kind === "ok" ? "ok" : ""}`;
  $("#net-text").textContent = text;
}

/**
 * Decide o que mostrar no lugar da grade: ela manda sozinha sempre que tem
 * pelo menos um card ativo, senão a mensagem certa pra cada estado. Basear
 * isso na grade (o que está de fato na tela) em vez de crer cegamente numa
 * mensagem de "ao vivo" é o que evita a tela travada em "pausado" — o mesmo
 * jeito errado que antes só um sair-e-voltar da sala resolvia.
 */
function updateWaitingState() {
  $("#live-pill").hidden = state.live.size === 0;
  if (state.grid.count > 0) { hideWaiting(); return; }
  if (!state.hostId) { showWaiting("Conectando…", "Estabelecendo a conexão direta com o host."); return; }
  if (state.live.size > 0) { showWaiting("Conectando à transmissão…", "Só um instante."); return; }
  showWaiting("Ninguém transmitindo agora", "Assim que alguém começar, aparece aqui.");
}

/* ========================================================== conexão === */

function openHost(hostId) {
  state.hostId = hostId;
  state.peer?.close();

  const peer = new Peer({
    id: hostId,
    polite: true, // o convidado cede em colisões
    iceServers: state.boot.ice,
    relayOnly: !!state.boot.forceRelay,
    send: (payload) => state.signal.signal(hostId, payload),
  });
  state.peer = peer;
  state.micSent = false;
  state.screenSent = false;
  setMic(false);

  // O microfone (e a nossa própria tela, se estivermos transmitindo) só
  // entram depois da primeira oferta do host — e de novo aqui se o host
  // reabriu o app e a conexão teve que ser refeita do zero.
  peer.on("negotiated", () => { sendMic(); sendOwnScreen(); });

  trackRouter(peer, {
    screen: (stream, ownerId, name) => {
      if (ownerId === state.me?.id) return; // a nossa própria já está na grade, local
      const t = state.grid.attach(ownerId, stream, name);
      t.video.volume = state.volGame;
      updateWaitingState();
    },
    voice: (stream, ownerId, name) => attachVoice(ownerId, stream, name),
  });
  peer.on("state", (st) => {
    if (st === "connected") setNet("ok", "conectado");
    if (st === "failed") showWaiting("Não consegui conectar",
      state.boot.hasTurn
        ? "Nem a rota direta nem o servidor de retransmissão fecharam. Verifique se a sua rede bloqueia UDP e a porta 443."
        : "A conexão direta falhou. Se estiver em rede corporativa, 4G ou atrás de CGNAT, peça ao host para configurar um servidor TURN.");
    if (st === "disconnected") setNet("", "instável");
  });
  updateWaitingState();
}

function attachVoice(ownerId, stream, name) {
  if (ownerId === state.me?.id) return;
  let v = state.voices.get(ownerId);
  if (v && v.stream.id === stream.id) return;
  dropVoice(ownerId);

  const audio = el("audio", { autoplay: "", playsinline: "" });
  audio.srcObject = stream;
  audio.volume = state.volVoice;
  $("#voices").append(audio);
  audio.play().catch(() => {
    // autoplay bloqueado: destrava no primeiro clique
    document.addEventListener("click", () => audio.play().catch(() => {}), { once: true });
  });

  const meter = createVoiceMeter(stream, (lvl) => {
    const rec = state.voices.get(ownerId);
    if (!rec) return;
    const speaking = lvl > 0.08;
    if (speaking !== rec.speaking) { rec.speaking = speaking; renderSpeakers(); }
  });

  state.voices.set(ownerId, { audio, stream, meter, speaking: false, name });
}

function dropVoice(ownerId) {
  const v = state.voices.get(ownerId);
  if (!v) return;
  v.meter?.stop();
  v.audio.srcObject = null;
  v.audio.remove();
  state.voices.delete(ownerId);
  renderSpeakers();
}

/* ======================================================== microfone === */

/** Publica a faixa do microfone na conexão (uma vez por conexão). */
function sendMic() {
  const peer = state.peer;
  const track = state.mic?.getAudioTracks()[0];
  if (!peer || !track || state.micSent || !state.boot.guestsCanTalk) return;
  if (peer.pc.signalingState !== "stable") return;
  try {
    // Linha própria e explícita: addTrack poderia reaproveitar uma linha que o
    // host usa para mandar a voz de outra pessoa.
    const stream = new MediaStream([track]);
    peer.pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    // Avisa o host o que essa faixa é — necessário agora que a gente também
    // pode mandar a tela pela mesma conexão, então "é áudio" não basta mais
    // pra saber se é a voz ou o som do sistema.
    state.signal.signal(state.hostId, {
      streams: { [stream.id]: { kind: "voice", owner: state.me.id, name: state.me.name } },
    });
    state.micSent = true;
    setMic(track.enabled);
  } catch (err) {
    console.error(err);
  }
}

/* ==================================================== transmitir a tela == */

/** Publica a NOSSA tela na conexão com o host (uma vez por conexão) — mesmo
 *  padrão do sendMic acima, incluindo o aviso de "o que é essa faixa". */
function sendOwnScreen() {
  const peer = state.peer;
  const stream = state.ownScreen;
  if (!peer || !stream || state.screenSent) return;
  if (peer.pc.signalingState !== "stable") return;
  try {
    const videoTx = peer.pc.addTransceiver(stream.getVideoTracks()[0], {
      direction: "sendonly", streams: [stream],
    });
    preferVideoCodecs(videoTx); // antes da 1a oferta: manda pro encoder da GPU
    const txs = [videoTx];
    const sysAudio = stream.getAudioTracks()[0];
    if (sysAudio) txs.push(peer.pc.addTransceiver(sysAudio, { direction: "sendonly", streams: [stream] }));
    state.ownScreenTx = txs;
    state.signal.signal(state.hostId, {
      streams: { [stream.id]: { kind: "screen", owner: state.me.id, name: state.me.name } },
    });
    peer.setBitrate(videoTx.sender, OWN_SHARE.bitrateKbps, OWN_SHARE.framerate, OWN_SHARE.resolution);
    state.screenSent = true;
  } catch (err) {
    console.error(err);
  }
}

/** Reaplica o teto de qualidade na transmissão já em andamento — a
 *  resolução é só um `scaleResolutionDownBy` sobre o que já foi capturado
 *  (ver rtc.js), então dá pra ajustar sem reiniciar a captura. */
function peerSetShareBitrate() {
  const tx = state.ownScreenTx[0]; // o de vídeo é sempre o primeiro
  if (tx) state.peer?.setBitrate(tx.sender, OWN_SHARE.bitrateKbps, OWN_SHARE.framerate, OWN_SHARE.resolution);
}

async function toggleShare() {
  if (state.ownScreen) return stopOwnScreen();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(
      displayConstraints(OWN_SHARE.framerate)
    );
    startOwnScreen(stream);
  } catch (err) {
    if (err?.name !== "NotAllowedError") {
      toast("Não consegui abrir o seletor de tela.", "err");
      console.error(err);
    }
  }
}

function startOwnScreen(stream) {
  state.ownScreen = stream;
  const video = stream.getVideoTracks()[0];
  video.onended = () => stopOwnScreen();
  // Mesma lógica do painel do host: prioriza manter os quadros em vez da
  // nitidez, que é o que se quer pra jogo/janela em movimento.
  video.contentHint = "motion";
  const sysAudio = stream.getAudioTracks()[0];
  if (sysAudio) sysAudio.contentHint = "music";

  state.grid.attach(state.me.id, stream, `${state.me.name} (você)`, { muted: true });
  sendOwnScreen();
  state.signal.send({ t: "live", on: true });
  updateWaitingState();

  const btn = $("#btn-share");
  btn.replaceChildren(icon("stop"));
  btn.classList.add("active");
  btn.title = "Parar de transmitir (S)";
}

function stopOwnScreen(silent = false) {
  state.ownScreen?.getTracks().forEach((t) => t.stop());
  state.ownScreen = null;
  for (const tx of state.ownScreenTx) { try { tx.sender.replaceTrack(null); } catch {} }
  state.ownScreenTx = [];
  state.screenSent = false;
  if (state.me?.id) state.grid.remove(state.me.id);
  updateWaitingState();
  if (silent) return;

  state.signal?.send({ t: "live", on: false });
  const btn = $("#btn-share");
  btn.replaceChildren(icon("screen"));
  btn.classList.remove("active");
  btn.title = "Transmitir sua tela (S)";
}

async function toggleMic() {
  if (!state.boot.guestsCanTalk) return toast("O host desativou o microfone dos convidados.", "err");

  if (state.mic) {
    const track = state.mic.getAudioTracks()[0];
    track.enabled = !state.micOn;
    sendMic();
    return setMic(track.enabled);
  }

  try {
    state.mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    sendMic();
    setMic(true);
  } catch {
    toast(window.isSecureContext
      ? "Microfone negado pelo navegador."
      : "Sem HTTPS o navegador bloqueia o microfone.", "err");
  }
}

function setMic(on) {
  state.micOn = on;
  const btn = $("#btn-mic");
  btn.replaceChildren(icon(on ? "mic" : "micOff"));
  btn.classList.toggle("active", on);
  btn.classList.toggle("danger", !on);
  state.signal?.send({ t: "state", muted: !on });
}

/* ========================================================= interface == */

function wireRoom() {
  if (homeUrl) {
    $("#btn-home").hidden = false;
    $("#btn-home").addEventListener("click", () => { location.href = homeUrl; });
  }

  $("#btn-share").replaceChildren(icon("screen"));
  $("#btn-share").addEventListener("click", toggleShare);
  $("#share-res").value = OWN_SHARE.resolution;
  $("#share-fps").value = String(OWN_SHARE.framerate);
  $("#share-res").addEventListener("change", (e) => {
    OWN_SHARE.resolution = e.target.value;
    localStorage.setItem("sabor.shareRes", OWN_SHARE.resolution);
    if (state.ownScreen) {
      // Não precisa reiniciar a captura: a resolução é um teto aplicado
      // depois, então dá pra corrigir na hora se algo saiu torto.
      peerSetShareBitrate();
      $("#share-hint").textContent = "Ajustado na transmissão atual.";
    } else {
      $("#share-hint").textContent = "";
    }
  });
  $("#share-fps").addEventListener("change", (e) => {
    OWN_SHARE.framerate = Number(e.target.value);
    localStorage.setItem("sabor.shareFps", String(OWN_SHARE.framerate));
    $("#share-hint").textContent = state.ownScreen ? "Vale na próxima vez que ligar a transmissão." : "";
  });
  $("#btn-mic").replaceChildren(icon("micOff"));
  $("#btn-mic").classList.add("danger");
  $("#btn-mic").addEventListener("click", toggleMic);
  $("#btn-volume").replaceChildren(icon("volume"));
  $("#btn-volume").addEventListener("click", (e) => {
    e.currentTarget.closest(".slider-pop").classList.toggle("open");
  });
  $("#btn-people").prepend(icon("users"));
  $("#btn-chat").prepend(icon("chat"));
  $("#btn-full").replaceChildren(icon("expand"));
  $("#btn-leave").replaceChildren(icon("x"));
  $("#drawer-close").replaceChildren(icon("x"));
  $("#chat-form button").replaceChildren(icon("send"));

  $("#btn-people").addEventListener("click", () => openDrawer("people"));
  $("#btn-chat").addEventListener("click", () => openDrawer("chat"));
  $("#drawer-close").addEventListener("click", () => { $("#drawer").hidden = true; });
  $$(".drawer .tab").forEach((t) => t.addEventListener("click", () => openDrawer(t.dataset.tab)));

  $("#btn-full").addEventListener("click", toggleFullscreen);
  $("#btn-leave").addEventListener("click", () => {
    if (!confirm("Sair da sala?")) return;
    stopOwnScreen(true);
    state.signal?.close();
    state.peer?.close();
    blocked("Você saiu", "Até a próxima.", true);
  });

  $("#vol-game").addEventListener("input", (e) => {
    state.volGame = e.target.value / 100;
    state.grid.setVolume(state.volGame);
  });
  $("#vol-voice").addEventListener("input", (e) => {
    state.volVoice = e.target.value / 100;
    for (const v of state.voices.values()) v.audio.volume = state.volVoice;
  });

  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text) return;
    state.signal.send({ t: "chat", text });
    input.value = "";
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    const k = e.key.toLowerCase();
    if (k === "m") { e.preventDefault(); toggleMic(); }
    if (k === "s") { e.preventDefault(); toggleShare(); }
    if (k === "f") { e.preventDefault(); toggleFullscreen(); }
    if (k === "c") { e.preventDefault(); openDrawer("chat"); $("#chat-input").focus(); }
  });

  window.addEventListener("beforeunload", () => stopOwnScreen(true));

  // esconde os controles quando o mouse para
  const room = $("#room");
  const wake = () => {
    room.classList.remove("idle");
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => room.classList.add("idle"), 2800);
  };
  ["mousemove", "click", "keydown", "touchstart"].forEach((ev) =>
    document.addEventListener(ev, wake, { passive: true }));
  wake();
}

function openDrawer(tab) {
  const drawer = $("#drawer");
  const active = $(`.drawer .tab[data-tab="${tab}"]`).classList.contains("active");
  drawer.hidden = !drawer.hidden && active ? true : false;
  $$(".drawer .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $$(".drawer .panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === tab));
  if (tab === "chat") $("#chat-dot").hidden = true;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#video-wrap").requestFullscreen?.().catch(() => {});
}

function showWaiting(title, sub) {
  $("#waiting").classList.remove("hidden");
  $("#waiting-title").textContent = title;
  $("#waiting-sub").textContent = sub;
}
function hideWaiting() { $("#waiting").classList.add("hidden"); }

function renderSpeakers() {
  const box = $("#speakers");
  const talking = [...state.voices.entries()].filter(([, v]) => v.speaking);
  box.replaceChildren(
    ...talking.map(([id, v]) => {
      const p = state.people.get(id);
      return el("div", { class: "speaker" },
        avatarFor({ id, name: p?.name || v.name || "?" }),
        p?.name || v.name || "Alguém");
    })
  );
  renderPeople();
}

function renderPeople() {
  const list = $("#people-list");
  const people = [...state.people.values()].sort((a, b) =>
    a.role === "host" ? -1 : b.role === "host" ? 1 : a.name.localeCompare(b.name));

  // Agrupado por sala, como os canais de voz do Discord. Clicar numa sala
  // entra nela — e a partir daí você só ouve e vê quem está lá.
  if (state.salas.length) {
    const minha = state.me?.sala || state.salas[0].id;
    list.replaceChildren(...state.salas.map((sala) => {
      const dentro = people.filter((p) => (p.sala || state.salas[0].id) === sala.id);
      const hd = el("div", { class: `sala-hd ${sala.id === minha ? "aqui" : ""}` },
        icon("users"),
        el("span", { class: "sala-nome" }, sala.name),
        el("span", { class: "sala-count" }, String(dentro.length)));
      hd.addEventListener("click", () => {
        if (sala.id !== minha) state.signal?.send({ t: "sala", id: sala.id });
      });
      return el("div", { class: "sala-bloco" }, hd, ...dentro.map(linhaPessoa));
    }));
    $("#people-count").textContent = people.length;
    return;
  }

  list.replaceChildren(...people.map(linhaPessoa));
  $("#people-count").textContent = people.length;
}

function linhaPessoa(p) {
  const mine = p.id === state.me?.id;
  const muted = mine ? !state.micOn : p.muted;
  const av = avatarFor(p);
  if (state.voices.get(p.id)?.speaking) av.classList.add("speaking");
  return el("div", { class: "person" }, av,
    el("div", { class: "meta" },
      el("div", { class: "nm" }, mine ? `${p.name} (você)` : p.name,
        state.live.has(p.id) && el("span", { class: "live-dot", title: "Transmitindo" })),
      el("div", { class: "sub" }, p.role === "host" ? "host" : "convidado")),
    el("div", { class: `mic-state ${muted ? "off" : "on"}` }, icon(muted ? "micOff" : "mic")));
}

/* ------------------------------------------------------------- chat --- */

function addChat(m) {
  const log = $("#chat-log");
  const mine = m.from === state.me?.id;
  log.append(
    el("div", { class: "msg" },
      avatarFor({ id: m.from, name: m.name }),
      el("div", { class: "body" },
        el("div", { class: "who" }, mine ? "Você" : m.name,
          el("span", { class: "time" }, fmtClock(m.ts))),
        el("div", { class: "text" }, m.text)))
  );
  log.scrollTop = log.scrollHeight;
  if (!mine && $("#drawer").hidden) $("#chat-dot").hidden = false;
}

function sysChat(text) {
  const log = $("#chat-log");
  log.append(el("div", { class: "msg sys" }, el("div", { class: "text" }, text)));
  log.scrollTop = log.scrollHeight;
}

// Mesma ideia do painel do host: expor o estado ajuda a diagnosticar pelo console.
window.__sabor = state;

boot();
