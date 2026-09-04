// Painel do host: captura a tela, mantém uma conexão com cada convidado e
// retransmite a voz de todo mundo. Este navegador é o centro da estrela.

import { $, $$, el, icon, toast, avatarFor, initials, colorFor, fmtDuration, fmtRate, fmtClock, copyText, createVoiceMeter } from "./ui.js";
import { Signal } from "./signal.js";
import { Peer, displayConstraints, preferVideoCodecs, natMapping, isCgnatRange, MIC_CONSTRAINTS, trackRouter } from "./rtc.js";
import { Grid } from "./grid.js";

/* ======================================================== estado ====== */

const state = {
  boot: null,
  api: null,          // ponte pywebview (null quando aberto no navegador)
  desktop: false,
  signal: null,
  me: null,
  peers: new Map(),   // peerId -> { info, peer, tx:{video,sys,voice}, relay:Map<key,Set<transceiver>> }
  guestVoice: new Map(),  // peerId -> { track, stream }
  guestScreen: new Map(), // peerId -> { stream, tracks:[...], name }
  live: new Map(),        // peerId -> startedAt (quem esta transmitindo agora, host ou convidado)
  salas: [],              // [{id, name}] — cada pessoa está em uma delas
  grid: null,              // Grid: um card por transmissao ao vivo na sala
  screen: null,       // MediaStream da captura
  mic: null,          // MediaStream do microfone
  micOn: false,
  // Desligada por padrão: desenhar a própria captura aqui disputa GPU com o
  // jogo, e é a causa mais comum de perder FPS transmitindo. Quem quiser ver
  // liga no olho da barra de baixo — não muda nada pra quem assiste.
  previewOn: false,
  codec: null,
  meter: null,
  liveSince: null,
  links: { local: null, lan: null, public: null },
  scope: "lan",
  settings: null,
  unread: 0,
  audioEls: new Map(),
  update: null,       // { tag, page, asset, status } quando existe versão nova
  updatePoll: null,
};

// Streams de saída: o id de cada um viaja no SDP e é a chave que diz ao
// convidado o que ele está recebendo.
const outScreen = new MediaStream();
const outVoice = new MediaStream();

function streamMap() {
  const map = {
    [outVoice.id]: { kind: "voice", owner: state.me?.id || "host", name: state.settings?.display_name },
  };
  // Só entra no mapa quando a captura está de fato ligada. O transceiver de
  // vídeo é criado pra cada convidado desde a entrada dele (pra trocar de
  // tela sem renegociar), então incluir isso sempre faria o card aparecer na
  // grade de todo mundo com uma faixa vazia antes do host clicar em
  // "Transmitir" — a mesma classe de bug do card travado, só que ao contrário.
  if (state.screen) {
    map[outScreen.id] = { kind: "screen", owner: state.me?.id || "host", name: state.settings?.display_name };
  }
  for (const [gid, v] of state.guestVoice) {
    map[v.stream.id] = { kind: "voice", owner: gid, name: state.peers.get(gid)?.info.name };
  }
  // Telas de convidados que tambem estao transmitindo: o host retransmite
  // pra todo mundo, igual ja fazia com a voz — e o que deixa duas pessoas ao
  // vivo na mesma sala.
  for (const [gid, g] of state.guestScreen) {
    map[g.stream.id] = { kind: "screen", owner: gid, name: g.name || state.peers.get(gid)?.info.name };
  }
  return map;
}

/* ==================================================== atualização ===== */

// Repositório público de propósito: a API de releases responde sem token
// nenhum. Num repo privado o app teria que carregar um segredo embutido, e
// qualquer um extrai isso de um .exe.
const REPO = "john7victor/sabordc";

/** "v1.2.3" / "1.2.3" -> [1,2,3]. Pedaço não numérico vira 0. */
function parseVersion(text) {
  return String(text || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

/**
 * Pergunta ao GitHub qual é a última versão publicada e, se for mais nova,
 * já começa a baixar o instalador em segundo plano — instalar depois vira um
 * clique. Falha em silêncio de propósito: sem internet, com a API fora do ar
 * ou com o repositório ainda sem release nenhuma, o app não tem nada de útil
 * a dizer — e não é motivo pra encher o painel de erro.
 */
async function checkUpdate({ manual = false } = {}) {
  // Sem `manual`, a checagem é silenciosa quando não há novidade. Só que
  // silêncio de "está tudo atualizado" é idêntico a silêncio de "a checagem
  // quebrou" — por isso o botão em Ajustes conta o resultado dos dois jeitos.
  // Escreve em Ajustes E mostra um aviso passageiro: o botão do rodapé fica
  // sempre à mão, e de lá não dá pra ver o texto que está dentro da aba.
  const diga = (texto, ruim = false, passageiro = true) => {
    if (!manual) return;
    const el = $("#update-status");
    el.textContent = texto;
    el.className = ruim ? "hint warn" : "hint";
    if (passageiro) toast(texto, ruim ? "err" : "ok");
  };

  try {
    diga("Perguntando ao GitHub…", false, false); // esse não vira aviso na tela
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      diga(`O GitHub respondeu ${res.status}. Tente de novo daqui a pouco.`, true);
      return;
    }
    const release = await res.json();
    if (release.draft || release.prerelease) {
      diga("A última versão publicada ainda é um rascunho.", true);
      return;
    }
    if (!isNewer(release.tag_name, state.boot.version)) {
      diga(`Você já está na versão mais nova (${state.boot.version}).`);
      return;
    }

    state.update = {
      tag: release.tag_name,
      page: release.html_url,
      // o .exe é o instalador; o .zip é a versão portátil, que não serve
      // pra atualizar uma instalação existente
      asset: (release.assets || []).find((a) => a.name.toLowerCase().endsWith(".exe")),
    };

    $("#update-card").hidden = false;
    $("#update-dismiss").replaceChildren(icon("x"));
    $("#update-dismiss").addEventListener("click", () => { $("#update-card").hidden = true; });
    $("#update-get").addEventListener("click", onUpdateAction);
    renderUpdate();
    maybeDownloadUpdate();
    diga(`Versão ${release.tag_name} disponível — veja o aviso na coluna da esquerda.`);
  } catch (err) {
    // Na checagem automática segue a vida em silêncio: sem internet não é
    // motivo pra atrapalhar quem só quer transmitir. No clique, fala.
    diga(`Não consegui falar com o GitHub (${err.name}). Sem internet?`, true);
  }
}

/**
 * Só baixa fora do ar. Puxar 80 MB no meio de uma transmissão disputaria
 * banda e disco justamente com o que a pessoa está fazendo — quando ela
 * encerra, o `stopScreen` chama isto de novo.
 */
function maybeDownloadUpdate() {
  const up = state.update;
  if (!up || !up.asset) return;              // sem instalador anexado na release
  if (!state.api?.start_update_download) return;  // aberto no navegador: só link
  if (state.screen) return;                  // transmitindo: fica pra depois
  if (up.status?.state === "downloading" || up.status?.state === "ready") return;

  state.api.start_update_download(up.asset.browser_download_url).then((status) => {
    up.status = status;
    renderUpdate();
    if (status.state === "downloading") pollUpdate();
  });
}

function pollUpdate() {
  clearInterval(state.updatePoll);
  state.updatePoll = setInterval(async () => {
    const status = await state.api.update_status();
    state.update.status = status;
    renderUpdate();
    if (status.state !== "downloading") clearInterval(state.updatePoll);
  }, 700);
}

function renderUpdate() {
  const up = state.update;
  if (!up) return;
  const st = up.status?.state;
  const versao = `${up.tag} · você está na ${state.boot.version}`;

  if (st === "downloading") {
    $("#update-version").textContent = `Baixando… ${up.status.percent}%`;
    $("#update-get").hidden = true;
  } else if (st === "ready") {
    $("#update-version").textContent = `${up.tag} · baixada, pronta pra instalar`;
    $("#update-get").hidden = false;
    $("#update-get").textContent = "Instalar";
  } else if (st === "error") {
    $("#update-version").textContent = `${versao} · o download falhou`;
    $("#update-get").hidden = false;
    $("#update-get").textContent = "Baixar";
  } else {
    $("#update-version").textContent = versao;
    $("#update-get").hidden = false;
    $("#update-get").textContent = "Baixar";
  }
}

/** O botão faz o que fizer sentido pro estado atual. */
function onUpdateAction() {
  const up = state.update;
  if (up?.status?.state === "ready") {
    if (state.screen && !confirm("Instalar agora encerra sua transmissão. Continuar?")) return;
    state.api.run_update();
    return;
  }
  if (state.api?.start_update_download && up?.asset) {
    maybeDownloadUpdate();
    return;
  }
  // navegador, ou release sem instalador anexado: manda pra página da versão
  const url = up?.page;
  if (!url) return;
  if (state.api?.open_url) state.api.open_url(url);
  else window.open(url, "_blank", "noopener");
}

/* ======================================================== bootstrap === */

const hostKey = new URLSearchParams(location.search).get("k") || "";

async function waitForBridge(ms = 1200) {
  if (window.pywebview?.api) return window.pywebview.api;
  return new Promise((resolve) => {
    const done = () => resolve(window.pywebview?.api || null);
    window.addEventListener("pywebviewready", done, { once: true });
    setTimeout(done, ms);
  });
}

async function boot() {
  const res = await fetch(`/api/bootstrap?k=${encodeURIComponent(hostKey)}`);
  if (!res.ok) {
    document.body.innerHTML =
      '<div class="empty" style="height:100vh">O painel do host precisa ser aberto pelo aplicativo.</div>';
    return;
  }
  state.boot = await res.json();

  state.api = await waitForBridge();
  state.desktop = !!state.api;
  $("#win-ctl").hidden = !state.desktop;

  if (state.api) {
    await refreshFromBridge();
  } else {
    state.settings = {
      display_name: state.boot.hostName,
      room_name: state.boot.roomName,
      resolution: state.boot.quality.resolution,
      framerate: state.boot.quality.framerate,
      bitrate_kbps: state.boot.quality.bitrateKbps,
      guests_can_talk: state.boot.guestsCanTalk,
      turn_provider: "manual", cf_turn_key_id: "", cf_turn_token: "",
      turn_urls: [], turn_user: "", turn_pass: "", turn_secret: "",
      force_relay: !!state.boot.forceRelay,
    };
    state.links = state.boot.links;
  }

  state.grid = new Grid($("#grid"));
  wireUi();
  fillSettings();
  pickBestScope();
  renderLinks();
  connect();
  loadMicDevices();
  checkUpdate();
  setInterval(tickStats, 1000);
  setInterval(tickClock, 500);
}

async function refreshFromBridge() {
  const s = await state.api.state();
  state.settings = s.settings;
  state.links = s.links;
  state.network = s.network;
  state.tunnel = s.tunnel;
  renderNetwork();
  return s;
}

/* ======================================================== sinalização = */

function connect() {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", state.boot.token);
  url.searchParams.set("name", state.settings.display_name || "Host");

  const sig = new Signal(url.toString());
  state.signal = sig;

  sig.on("open", () => setConn("ok", "no ar"));
  sig.on("reconnecting", () => setConn("", "reconectando…"));
  sig.on("dead", () => setConn("err", "sem conexão"));
  sig.on("close", () => setConn("", "reconectando…"));

  sig.on("welcome", (m) => {
    state.me = m.you;
    state.salas = m.room.salas || [];
    for (const l of m.room.live || []) state.live.set(l.id, l.startedAt);
    for (const p of m.room.peers) if (p.id !== m.you.id) addGuest(p);
    (m.chat || []).forEach(addChat);
    renderSalas();
    renderPeople();
  });

  sig.on("salas", (m) => {
    state.salas = m.salas || [];
    renderSalas();
    renderPeople();
  });

  // Alguém mudou de sala (por conta própria, ou pelo sorteio). É aqui que a
  // separação de áudio acontece de verdade: os encaminhamentos são refeitos.
  sig.on("sala-troca", (m) => {
    if (m.id === state.me?.id) state.me.sala = m.sala;
    const e = state.peers.get(m.id);
    if (e) e.info.sala = m.sala;
    applySalas();
    renderSalas();
  });

  sig.on("sorteio", () => {
    toast("Times sorteados.", "ok");
  });

  // Alguem (host ou convidado) comecou ou parou de transmitir. Guiar a saida
  // do card pela mensagem — e nao pelo fim de fato da faixa de video — e o
  // que evita a tela travada em "pausado" que so um sair-e-voltar resolvia.
  sig.on("live", (m) => {
    if (m.on) state.live.set(m.id, m.startedAt);
    else state.live.delete(m.id);
    if (!m.on && m.id !== state.me?.id) teardownGuestScreen(m.id);
    renderPeople();
  });

  sig.on("peer-join", (m) => {
    addGuest(m.peer);
    renderPeople();
    sysChat(`${m.peer.name} entrou`);
  });

  sig.on("peer-leave", (m) => {
    const entry = state.peers.get(m.id);
    if (entry) sysChat(`${entry.info.name} saiu`);
    teardownGuestScreen(m.id); // por garantia — o "live:false" já deveria ter feito isso
    state.live.delete(m.id);
    dropGuest(m.id);
    renderPeople();
  });

  sig.on("peer-update", (m) => {
    const e = state.peers.get(m.peer.id);
    if (e) { e.info = m.peer; renderPeople(); broadcastMap(); }
  });

  sig.on("state", (m) => {
    const e = state.peers.get(m.id);
    if (e) { e.info.muted = m.muted; renderPeople(); }
  });

  sig.on("signal", (m) => state.peers.get(m.from)?.peer.accept(m.payload));
  sig.on("chat", addChat);
  sig.on("replaced", () => {
    setConn("err", "painel movido");
    toast("O painel foi aberto em outra janela.", "err");
  });

  sig.connect();
}

function setConn(kind, text) {
  const pill = $("#conn-pill");
  pill.className = `pill ${kind === "ok" ? "ok" : ""}`;
  $("#conn-text").textContent = text;
}

/* ======================================================== convidados == */

function addGuest(info, { relayOnly = false } = {}) {
  if (state.peers.has(info.id)) return;

  const peer = new Peer({
    id: info.id,
    polite: false, // o host é o impaciente: em colisão, a oferta dele vence
    iceServers: state.boot.ice,
    relayOnly: relayOnly || !!state.settings?.force_relay,
    send: (payload) => state.signal.signal(info.id, payload),
  });

  // Linhas fixas: trocar a tela ou o microfone vira um replaceTrack, sem
  // renegociar. A voz do convidado — e, se ele decidir transmitir, a tela
  // dele — chegam em linhas que ELE cria; o host só recebe (ver trackRouter).
  const tx = {
    video: peer.pc.addTransceiver("video", { direction: "sendonly", streams: [outScreen] }),
    sys: peer.pc.addTransceiver("audio", { direction: "sendonly", streams: [outScreen] }),
    voice: peer.pc.addTransceiver("audio", { direction: "sendonly", streams: [outVoice] }),
  };
  // antes da primeira oferta: manda o vídeo para o encoder da GPU
  state.codec = preferVideoCodecs(tx.video) || state.codec;

  const entry = { info, peer, tx, relay: new Map(), relayOnly };
  state.peers.set(info.id, entry);

  // Envia o que já estiver rolando.
  if (state.screen) attachScreen(entry);
  if (state.mic) tx.voice.sender.replaceTrack(state.mic.getAudioTracks()[0]).catch(() => {});
  applyBitrate(entry);

  trackRouter(peer, {
    voice: (stream, ownerId, name, track) => onGuestVoice(entry, stream, track),
    screen: (stream, ownerId, name, track) => onGuestScreen(entry, stream, ownerId, name, track),
  });
  peer.on("negotiated", () => sendMap(entry));
  peer.on("state", (st) => {
    entry.conn = st;
    renderPeople();
    if (st === "connected") { sendMap(entry); applyBitrate(entry); }
    if (st === "failed") diagnoseFailure(entry);
  });
  peer.on("dead", () => retryOverRelay(entry));

  // Manda o que já estiver rolando (respeitando as salas) e avisa o mapa.
  applySalas();
}

/**
 * Última tentativa: refaz o par usando só o TURN.
 *
 * Sob CGNAT simétrico a negociação direta não fecha nunca — insistir nela é
 * repetir o mesmo erro. Aqui a conexão é reconstruída com
 * `iceTransportPolicy: "relay"`, e o convidado é avisado para refazer a dele
 * do zero (senão ele fica aplicando ofertas de uma conexão que já morreu).
 */
function retryOverRelay(entry) {
  const { info, relayOnly } = entry;
  if (relayOnly || entry.relayTried) return;   // já é o último recurso
  if (!state.boot.hasTurn && !state.settings?.turn_urls?.length) {
    entry.failReason = "sem rota direta e sem TURN configurado";
    renderPeople();
    return;
  }
  entry.relayTried = true;
  console.warn(`[sabor] ${info.name}: refazendo a conexão só pelo TURN`);
  state.signal?.signal(info.id, { control: "reset" });
  dropGuest(info.id);
  setTimeout(() => addGuest(info, { relayOnly: true }), 250);
}

function dropGuest(id) {
  const entry = state.peers.get(id);
  if (!entry) return;
  entry.peer.close();
  state.peers.delete(id);

  if (state.guestVoice.has(id)) {
    state.guestVoice.delete(id);
    for (const other of state.peers.values()) removeRelayKey(other, `voice:${id}`);
  }
  teardownGuestScreen(id);
  state.audioEls.get(id)?.remove();
  state.audioEls.delete(id);
  broadcastMap();
}

/** Voz de um convidado chegou: o host escuta e repassa para os demais. */
function onGuestVoice(entry, stream, track) {
  state.guestVoice.set(entry.info.id, { track, stream });

  // O host ouve.
  let audio = state.audioEls.get(entry.info.id);
  if (!audio) {
    audio = el("audio", { autoplay: "", playsinline: "" });
    document.body.append(audio);
    state.audioEls.set(entry.info.id, audio);
  }
  audio.srcObject = stream;
  audio.play().catch(() => {});

  track.onended = () => dropVoice(entry.info.id);
  applySalas(); // quem ouve quem depende da sala
}

function dropVoice(id) {
  state.guestVoice.delete(id);
  for (const other of state.peers.values()) removeRelayKey(other, `voice:${id}`);
  broadcastMap();
}

/**
 * Tela de um convidado chegou: o host mostra na própria grade e retransmite
 * para todo mundo — exatamente o mesmo papel de "servidor" que já fazia com a
 * voz, agora também com vídeo. É isso que deixa duas pessoas transmitindo ao
 * mesmo tempo, na mesma sala, sem ninguém trocar de link.
 */
function onGuestScreen(entry, stream, ownerId, name, track) {
  let g = state.guestScreen.get(ownerId);
  if (!g) { g = { stream, tracks: [], name }; state.guestScreen.set(ownerId, g); }
  if (!g.tracks.includes(track)) g.tracks.push(track);

  g.name = name || entry.info.name;
  track.onended = () => teardownGuestScreen(ownerId);
  applySalas(); // quem vê essa tela depende da sala
}

function teardownGuestScreen(id) {
  if (!state.guestScreen.has(id)) return;
  state.guestScreen.delete(id);
  for (const other of state.peers.values()) removeRelayKey(other, `screen:${id}`);
  state.grid.remove(id);
  updateEmptyState();
}

/** Repassa uma faixa (voz OU tela) de `key` para `target`. Transceiver
 *  explícito: addTrack poderia reaproveitar uma linha alheia e embaralhar
 *  quem fala/transmite pra quem. */
function relayTrack(target, key, track, stream) {
  const set = target.relay.get(key) || new Set();
  if ([...set].some((tx) => tx.sender.track === track)) return; // já relayado
  try {
    const tx = target.peer.pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    set.add(tx);
    target.relay.set(key, set);
  } catch (err) {
    console.error("relay", err);
  }
}

function removeRelayKey(target, key) {
  const set = target.relay.get(key);
  if (!set) return;
  for (const tx of set) { try { tx.stop(); } catch {} }
  target.relay.delete(key);
}

/**
 * Quando um convidado nao conecta, guarda POR QUE. Sem isso o painel so diz
 * "falhou", e nao da para saber se o remedio e TURN ou outra coisa.
 */
async function diagnoseFailure(entry) {
  try {
    const stats = await entry.peer.pc.getStats();
    const local = new Set();
    const remote = new Set();
    stats.forEach((r) => {
      if (r.type === "local-candidate") local.add(r.candidateType);
      if (r.type === "remote-candidate") remote.add(r.candidateType);
    });

    let why;
    if (!remote.size) {
      why = "não recebi candidatos dele (rede bloqueando UDP?)";
    } else if (!local.has("relay") && !remote.has("relay")) {
      why = "sem rota direta — este é o caso que TURN resolve";
    } else {
      why = "o TURN também não fechou";
    }
    entry.failReason = why;
    console.warn(`[sabor] ${entry.info.name} falhou: ${why}`,
                 { local: [...local], remote: [...remote] });
    renderPeople();
    toast(`${entry.info.name}: ${why}`, "err");
  } catch {
    /* getStats pode falhar se a conexão já foi fechada */
  }
}

function sendMap(entry) {
  state.signal?.signal(entry.info.id, { streams: streamMap() });
}
function broadcastMap() {
  for (const e of state.peers.values()) sendMap(e);
}

/* ======================================================== captura ===== */

/* ------------------------------------------- escolher a qualidade ----- */

/** Abre o diálogo de qualidade. É por aqui que toda transmissão começa. */
function askQuality() {
  const s = state.settings;
  markChips("#q-res", s.resolution);
  markChips("#q-fps", String(s.framerate));
  $("#q-nopreview").checked = !state.previewOn;
  updateQualityHint();
  $("#quality-modal").hidden = false;
}

function markChips(seletor, valor) {
  $$(`${seletor} .chip`).forEach((c) => c.classList.toggle("on", c.dataset.value === valor));
}

function chosenChip(seletor) {
  return $(`${seletor} .chip.on`)?.dataset.value;
}

/** Diz, em números, o que a escolha custa — é a informação que falta pra
 *  decidir entre "bonito" e "o jogo não engasga". */
function updateQualityHint() {
  const res = chosenChip("#q-res");
  const fps = Number(chosenChip("#q-fps"));
  const kbps = recommendedBitrate(res, fps);
  const n = Math.max(1, state.peers.size);
  $("#q-hint").textContent =
    `Teto de ${(kbps / 1000).toFixed(1)} Mb/s por pessoa` +
    (n > 1 ? ` · ~${((kbps * n) / 1000).toFixed(1)} Mb/s de upload com ${n} assistindo` : "") +
    (res === "nativa" ? " · nativa captura sua tela inteira, é a mais pesada pro jogo" : "");
}

async function startScreen() {
  const s = state.settings;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(
      displayConstraints(Number(s.framerate), s.resolution)
    );
    setScreen(stream);
  } catch (err) {
    if (err?.name === "NotAllowedError") {
      $("#capture-hint").textContent = "Captura cancelada.";
      return;
    }
    captureFailed(err);
  }
}

function captureFailed(err) {
  const hint = $("#capture-hint");
  hint.classList.add("warn");
  hint.textContent = "Esta janela não conseguiu abrir o seletor de tela — use “Abrir painel no navegador”, em Ajustes.";
  toast("Captura indisponível nesta janela.", "err");
  console.error(err);
}

/** Id usado pra própria transmissão do host na grade — o mesmo id que os
 *  outros veem como dono do card, então tem que bater com `state.me.id`. */
function myId() {
  return state.me?.id || "self";
}

function setScreen(stream) {
  stopScreen(true);
  state.screen = stream;

  const video = stream.getVideoTracks()[0];
  video.onended = () => stopScreen();

  // "motion": prioriza manter a taxa de quadros e sacrifica nitidez em cenas
  // paradas. O padrão de uma captura de tela é o oposto ("text"/detalhe), que
  // é bom para slides e péssimo para jogo — é o que causa o engasgo.
  video.contentHint = "motion";
  const sysAudio = stream.getAudioTracks()[0];
  if (sysAudio) {
    sysAudio.contentHint = "music"; // som de jogo, não voz
  } else {
    // Falar agora, que é quando ainda dá pra corrigir escolhendo a fonte de
    // novo. Descobrir isso pelo amigo dizendo "não tô ouvindo nada" no meio
    // da partida é tarde demais.
    toast("Esta fonte veio sem áudio — marque “compartilhar áudio” ao escolher a fonte.", "err");
  }
  renderAudioShare();

  state.grid.ensure(myId(), state.settings.display_name || "Você", { muted: true });
  setPreview(state.previewOn);
  updateEmptyState();
  $("#preview-badge").hidden = false;
  $("#btn-source").disabled = false;
  $("#btn-live-label").textContent = "Encerrar";
  $("#btn-live").classList.remove("btn-primary");
  $("#btn-live").classList.add("btn-danger");
  $("#live-pill").hidden = false;
  state.liveSince = Date.now();
  state.signal?.send({ t: "live", on: true });

  for (const entry of state.peers.values()) attachScreen(entry);
  broadcastMap(); // avisa quem já estava conectado que o card da sua tela agora é de verdade
  updateBadge();
}

/* ---------------------------------------------------------- salas ----- */

function minhaSala() {
  return state.me?.sala || state.salas[0]?.id || "geral";
}

/** Em que sala está fulano — inclusive eu. */
function salaDe(id) {
  if (id === myId()) return minhaSala();
  return state.peers.get(id)?.info.sala ?? null;
}

/**
 * Recalcula TUDO que depende de quem está em qual sala: o que eu envio, o
 * que eu retransmito entre os outros, o que eu escuto e o que eu vejo.
 *
 * Centralizado de propósito. Espalhar "só se for da mesma sala" por cada
 * ponto que mexe em faixa é como se esquece um — e esquecer um aqui é o Time
 * A ouvindo o Time B, que é justamente o que a separação existe pra evitar.
 */
function applySalas() {
  const eu = minhaSala();

  for (const entry of state.peers.values()) {
    const comigo = entry.info.sala === eu;

    // minha tela e minha voz só saem pra quem está na minha sala
    const v = comigo && state.screen ? state.screen.getVideoTracks()[0] : null;
    const a = comigo && state.screen ? state.screen.getAudioTracks()[0] : null;
    const mic = comigo && state.mic ? state.mic.getAudioTracks()[0] : null;
    entry.tx.video.sender.replaceTrack(v || null).catch(() => {});
    entry.tx.sys.sender.replaceTrack(a || null).catch(() => {});
    entry.tx.voice.sender.replaceTrack(mic || null).catch(() => {});
    if (v) applyBitrate(entry);

    // e o que eu repasso dos outros: só entre quem divide a sala com ele
    for (const [gid, voz] of state.guestVoice) {
      const chave = `voice:${gid}`;
      if (gid !== entry.info.id && salaDe(gid) === entry.info.sala) {
        relayTrack(entry, chave, voz.track, voz.stream);
      } else {
        removeRelayKey(entry, chave);
      }
    }
    for (const [gid, tela] of state.guestScreen) {
      const chave = `screen:${gid}`;
      if (gid !== entry.info.id && salaDe(gid) === entry.info.sala) {
        for (const t of tela.tracks) relayTrack(entry, chave, t, tela.stream);
      } else {
        removeRelayKey(entry, chave);
      }
    }
  }

  // o que EU escuto: silencia a voz de quem não está na minha sala
  for (const [gid, audio] of state.audioEls) {
    audio.muted = salaDe(gid) !== eu;
  }

  // e o que EU vejo: tela de quem saiu da minha sala sai da grade
  for (const [gid, tela] of state.guestScreen) {
    if (salaDe(gid) === eu) {
      state.grid.attach(gid, tela.stream, tela.name || state.peers.get(gid)?.info.name);
    } else {
      state.grid.remove(gid);
    }
  }

  updateEmptyState();
  broadcastMap();
  renderPeople();
}

function attachScreen(entry) {
  if (!state.screen) return;
  applySalas();
}

function stopScreen(silent = false) {
  if (state.screen) {
    state.screen.getTracks().forEach((t) => t.stop());
    state.screen = null;
  }
  for (const entry of state.peers.values()) {
    entry.tx.video.sender.replaceTrack(null).catch(() => {});
    entry.tx.sys.sender.replaceTrack(null).catch(() => {});
  }
  if (silent) return;

  state.grid.remove(myId());
  updateEmptyState();
  $("#preview-badge").hidden = true;
  $("#btn-source").disabled = true;
  $("#btn-live-label").textContent = "Transmitir";
  $("#btn-live").classList.add("btn-primary");
  $("#btn-live").classList.remove("btn-danger");
  $("#live-pill").hidden = true;
  state.liveSince = null;
  renderAudioShare();
  state.signal?.send({ t: "live", on: false });
  broadcastMap();
  maybeDownloadUpdate(); // ficou pendente enquanto estava no ar
}

function applyBitrate(entry) {
  entry.peer.setBitrate(entry.tx.video.sender, Number(state.settings.bitrate_kbps), Number(state.settings.framerate), state.settings.resolution);
}

/** Mostra ou esconde o card vazio ("Sua tela, sua sala"): só aparece quando
 *  ninguém — nem você, nem nenhum convidado — está transmitindo. */
function updateEmptyState() {
  $("#preview").classList.toggle("streaming", state.grid.count > 0);
}

function updateBadge() {
  const track = state.screen?.getVideoTracks()[0];
  if (!track) return;
  const st = track.getSettings();
  $("#badge-res").textContent = st.width ? `${st.width}×${st.height}` : "—";
  $("#badge-fps").textContent = `${Math.round(st.frameRate || 0)} fps`;
}

/* ======================================================== microfone === */

async function toggleMic() {
  if (state.micOn) return setMic(false);
  try {
    const constraints = { audio: { ...MIC_CONSTRAINTS.audio } };
    const deviceId = $("#set-mic").value;
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.mic = stream;
    const track = stream.getAudioTracks()[0];
    outVoice.getTracks().forEach((t) => outVoice.removeTrack(t));
    outVoice.addTrack(track);
    for (const entry of state.peers.values()) {
      entry.tx.voice.sender.replaceTrack(track).catch(() => {});
    }
    state.meter?.stop();
    state.meter = createVoiceMeter(stream, (lvl) => {
      $("#mic-level").style.width = `${Math.round(lvl * 100)}%`;
    });
    setMic(true);
    loadMicDevices();
  } catch (err) {
    toast("Não consegui acessar o microfone.", "err");
    console.error(err);
  }
}

function setMic(on) {
  state.micOn = on;
  if (!on) {
    state.mic?.getTracks().forEach((t) => t.stop());
    state.mic = null;
    state.meter?.stop();
    state.meter = null;
    $("#mic-level").style.width = "0%";
    for (const entry of state.peers.values()) {
      entry.tx.voice.sender.replaceTrack(null).catch(() => {});
    }
  }
  const btn = $("#btn-mic");
  btn.replaceChildren(icon(on ? "mic" : "micOff"));
  btn.classList.toggle("active", on);
  btn.classList.toggle("danger", !on);
  state.signal?.send({ t: "state", muted: !on });
}

async function loadMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const select = $("#set-mic");
    const current = select.value;
    select.replaceChildren(el("option", { value: "" }, "Padrão do sistema"));
    devices
      .filter((d) => d.kind === "audioinput")
      .forEach((d, i) => select.append(el("option", { value: d.deviceId }, d.label || `Microfone ${i + 1}`)));
    if (current) select.value = current;
  } catch {}
}

/* ======================================================== métricas ==== */

async function tickStats() {
  let out = 0, rtt = [], loss = 0, fps = 0, enc = null, codec = null;
  await Promise.all(
    [...state.peers.values()].map(async (e) => {
      const s = await e.peer.stats();
      e.stats = s;
      out += s.outBits;
      if (s.rtt != null) rtt.push(s.rtt);
      loss = Math.max(loss, s.loss);
      fps = Math.max(fps, s.fps);
      if (s.encoder) enc = s;
      if (s.codec) codec = s.codec;
    })
  );
  renderEncoder(enc, codec);

  $("#s-viewers").textContent = state.peers.size;
  $("#s-bitrate").textContent = fmtRate(out);
  $("#s-rtt").textContent = rtt.length ? `${Math.round(rtt.reduce((a, b) => a + b, 0) / rtt.length)} ms` : "—";
  $("#s-loss").textContent = state.peers.size ? `${loss}%` : "—";
  if (fps) $("#badge-fps").textContent = `${fps} fps`;
  $("#tab-count").textContent = state.peers.size;
}

/**
 * Deixa o botão de áudio dizer a verdade sobre o que está sendo enviado.
 *
 * Antes ele mostrava o ícone de "som ligado" em qualquer situação — inclusive
 * quando a captura tinha vindo sem faixa de áudio nenhuma. Quem marcava
 * "compartilhar áudio" e mesmo assim não era ouvido não tinha como saber
 * onde estava o problema; o painel afirmava que estava tudo certo.
 */
function renderAudioShare() {
  const btn = $("#btn-audio-share");
  if (!btn) return;
  const track = state.screen?.getAudioTracks()[0];
  const ligado = !!track && track.enabled;
  const semAudio = !!state.screen && !track;

  btn.replaceChildren(icon(ligado ? "volume" : "volumeOff"));
  btn.classList.toggle("active", ligado);
  btn.classList.toggle("danger", semAudio);
  btn.title = !state.screen
    ? "Áudio do sistema (comece a transmitir primeiro)"
    : semAudio
    ? "Esta fonte veio SEM áudio — troque a fonte e marque “compartilhar áudio”"
    : ligado
    ? "Áudio do sistema indo junto — clique pra silenciar"
    : "Áudio do sistema silenciado — clique pra voltar";
}

/**
 * Liga/desliga a prévia local. Ela não afeta o que os espectadores recebem —
 * é só a sua janela desenhando 1080p60 enquanto o jogo quer a mesma GPU.
 */
function setPreview(on) {
  state.previewOn = on;
  state.grid.setSource(myId(), on && state.screen ? state.screen : null);
  state.grid.setLabel(myId(), (state.settings.display_name || "Você") + (on ? "" : " · prévia desligada"));
  const btn = $("#btn-preview");
  btn.replaceChildren(icon(on ? "eye" : "eyeOff"));
  btn.classList.toggle("active", !on);
}

/** Mostra no selo do preview qual codec e qual encoder estão em uso. */
function renderEncoder(s, codec) {
  const badge = $("#badge-codec");
  if (!badge) return;
  const nome = (codec || state.codec || "").split("/")[1];
  if (!nome) { badge.hidden = true; return; }

  badge.hidden = false;
  const hw = s?.hwEncoder === true;
  const sw = s?.hwEncoder === false;
  badge.textContent = hw ? `${nome} · GPU` : sw ? `${nome} · CPU` : nome;
  badge.className = hw ? "ok" : sw ? "warn" : "";
  badge.title = hw
    ? "Codificando no encoder da GPU — impacto mínimo no jogo."
    : sw
    ? "Codificando na CPU. Baixe a resolução ou a taxa se o jogo engasgar."
    : "";

  if (s?.limitation && s.limitation !== "none") {
    const motivo = { cpu: "CPU no limite", bandwidth: "banda no limite" }[s.limitation];
    if (motivo) badge.textContent += ` · ${motivo}`;
  }

  // Aviso único: codificando em software E sem dar conta é exatamente o que
  // faz o jogo engasgar. Sugerimos, mas não mexemos na qualidade sozinhos.
  if (sw && s.limitation === "cpu" && !state.encoderWarned) {
    state.encoderWarned = true;
    toast("Codificando na CPU e no limite — desligue a prévia ou baixe para 1080p30.", "err");
  }
}

function tickClock() {
  const t = state.liveSince ? fmtDuration(Date.now() - state.liveSince) : "00:00";
  $("#s-uptime").textContent = t;
  $("#live-time").textContent = t;
}

/* ======================================================== interface === */

function wireUi() {
  // janela
  $$(".win-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const a = b.dataset.win;
      if (a === "min") state.api?.minimize();
      else if (a === "max") state.api?.toggle_maximize();
      else state.api?.close();
    })
  );

  $("#btn-live").addEventListener("click", () => (state.screen ? stopScreen() : askQuality()));
  $("#go-live-hero").addEventListener("click", askQuality);
  $("#btn-source").addEventListener("click", askQuality);

  // diálogo de qualidade
  $$("#q-res .chip, #q-fps .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      markChips(chip.parentElement.id === "q-res" ? "#q-res" : "#q-fps", chip.dataset.value);
      updateQualityHint();
    });
  });
  $("#q-cancel").addEventListener("click", () => { $("#quality-modal").hidden = true; });
  $("#quality-modal").addEventListener("click", (e) => {
    if (e.target.id === "quality-modal") $("#quality-modal").hidden = true;
  });
  $("#q-go").addEventListener("click", () => {
    const resolution = chosenChip("#q-res");
    const framerate = Number(chosenChip("#q-fps"));
    save({ resolution, framerate });
    $("#set-res").value = resolution;
    $("#set-fps").value = String(framerate);
    applyRecommendedBitrate({ quiet: true });
    state.previewOn = !$("#q-nopreview").checked;
    $("#quality-modal").hidden = true;
    startScreen();
  });
  $("#btn-mic").replaceChildren(icon("micOff"));
  $("#btn-mic").classList.add("danger");
  $("#btn-mic").addEventListener("click", toggleMic);
  $("#btn-audio-share").addEventListener("click", () => {
    const a = state.screen?.getAudioTracks()[0];
    if (!a) {
      toast(state.screen
        ? "Esta fonte veio sem áudio. Encerre e escolha de novo, marcando “compartilhar áudio”."
        : "Comece a transmitir primeiro.", "err");
      return;
    }
    a.enabled = !a.enabled;
    renderAudioShare();
  });
  renderAudioShare();
  $("#btn-update-check").replaceChildren(icon("refresh"));
  $("#btn-update-check").addEventListener("click", () => checkUpdate({ manual: true }));
  $("#btn-preview").replaceChildren(icon("eye"));
  $("#btn-preview").addEventListener("click", () => setPreview(!state.previewOn));
  $("#btn-settings").replaceChildren(icon("gear"));
  $("#btn-settings").addEventListener("click", () => showTab("settings"));
  $("#chat-form button").replaceChildren(icon("send"));

  // abas
  $$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

  // link
  $("#btn-copy").addEventListener("click", async () => {
    const value = $("#link-value").value;
    if (!value) return;
    (await copyText(value)) ? toast("Link copiado", "ok") : toast("Não consegui copiar", "err");
  });
  $("#btn-rotate").addEventListener("click", async () => {
    if (!confirm("Gerar um link novo? Quem estiver com o link antigo não entra mais.")) return;
    if (state.api) {
      const s = await state.api.rotate_link();
      state.links = s.links;
      renderLinks();
      toast("Link renovado", "ok");
    } else {
      toast("Só pelo aplicativo.", "err");
    }
  });

  // assistir uma transmissão (a sua ou de outra pessoa) sem sair do app
  $("#btn-watch-open").addEventListener("click", openWatchModal);
  $("#watch-cancel").addEventListener("click", closeWatchModal);
  $("#watch-go").addEventListener("click", goWatch);
  $("#watch-link-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") goWatch();
    if (e.key === "Escape") closeWatchModal();
  });
  $("#watch-modal").addEventListener("click", (e) => {
    if (e.target.id === "watch-modal") closeWatchModal();
  });

  // chat
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text) return;
    state.signal.send({ t: "chat", text });
    input.value = "";
  });

  // salas
  $("#btn-sortear").addEventListener("click", () => {
    const times = state.salas.filter((s) => s.id !== state.salas[0]?.id).slice(0, 2);
    if (times.length < 2) return toast("Precisa de duas salas além da primeira pra sortear.", "err");
    if (state.peers.size < 1) return toast("Ninguém pra sortear ainda.", "err");
    state.signal.send({ t: "admin", action: "sortear", a: times[0].id, b: times[1].id });
  });
  $("#btn-reunir").addEventListener("click", () => {
    state.signal.send({ t: "admin", action: "reunir", id: state.salas[0]?.id });
  });
  $("#btn-nova-sala").addEventListener("click", () => {
    const name = prompt("Nome da sala nova:");
    if (name?.trim()) state.signal.send({ t: "admin", action: "sala-criar", name: name.trim() });
  });

  $("#btn-mute-all").addEventListener("click", () => {
    state.signal.send({ t: "admin", action: "mute-all" });
    toast("Todos silenciados", "ok");
  });
  $("#lock-room").addEventListener("change", (e) => {
    state.signal.send({ t: "admin", action: "lock", value: e.target.checked });
  });

  // ajustes
  const save = (patch) => {
    Object.assign(state.settings, patch);
    state.api?.save_settings(patch);
  };
  $("#set-name").addEventListener("change", (e) => {
    save({ display_name: e.target.value });
    state.signal.send({ t: "rename", name: e.target.value });
    if (state.grid.has(myId())) state.grid.setLabel(myId(), e.target.value + (state.previewOn ? "" : " · prévia desligada"));
  });
  $("#set-room").addEventListener("change", (e) => save({ room_name: e.target.value }));
  $("#set-res").addEventListener("change", (e) => {
    save({ resolution: e.target.value });
    // A resolução é só um teto aplicado sobre o que já foi capturado (ver
    // rtc.js) — não precisa reiniciar a captura, então já vale na hora.
    applyRecommendedBitrate();
  });
  $("#set-fps").addEventListener("change", (e) => {
    save({ framerate: Number(e.target.value) });
    applyRecommendedBitrate();
  });
  $("#set-bitrate").addEventListener("input", (e) => {
    $("#bitrate-out").textContent = `${(e.target.value / 1000).toFixed(1)} Mb/s`;
    updateBitrateHint(Number(e.target.value));
  });
  $("#set-bitrate").addEventListener("change", (e) => {
    save({ bitrate_kbps: Number(e.target.value) });
    for (const entry of state.peers.values()) applyBitrate(entry);
  });
  $("#set-mic").addEventListener("change", () => { if (state.micOn) { setMic(false); toggleMic(); } });
  $("#set-talk").addEventListener("change", (e) => save({ guests_can_talk: e.target.checked }));
  $("#set-autotunnel").addEventListener("change", (e) => save({ auto_tunnel: e.target.checked }));
  $("#set-forcerelay").addEventListener("change", (e) => {
    save({ force_relay: e.target.checked });
    if (state.settings) state.settings.force_relay = e.target.checked;
  });
  $("#turn-provider").addEventListener("change", (e) => showTurnFields(e.target.value));
  $("#btn-test-turn").addEventListener("click", testTurn);
  $("#btn-save-turn").addEventListener("click", () => {
    const urls = $("#turn-urls").value.split("\n").map((u) => u.trim()).filter(Boolean);
    const provider = $("#turn-provider").value;
    save({
      turn_provider: provider,
      cf_turn_key_id: $("#cf-key").value.trim(),
      cf_turn_token: $("#cf-token").value.trim(),
      turn_urls: urls,
      turn_url: "",                    // o campo único não é mais usado
      turn_secret: $("#turn-secret").value,
      turn_user: $("#turn-user").value.trim(),
      turn_pass: $("#turn-pass").value,
    });
    if (state.settings) {
      state.settings.turn_urls = urls;
      state.settings.turn_provider = provider;
    }
    toast("TURN salvo — vale para quem entrar a partir de agora.", "ok");
  });
  $("#versao-atual").textContent = `Sabor DC ${state.boot.version}`;
  $("#btn-checar-update").addEventListener("click", () => checkUpdate({ manual: true }));
  $("#btn-nettest").addEventListener("click", runNetTest);
  $("#btn-open-browser").addEventListener("click", () => state.api?.open_in_browser());
  $("#btn-tunnel").addEventListener("click", toggleTunnel);

  window.addEventListener("sabor:tunnel", async () => {
    await refreshFromBridge();
    const t = state.tunnel;
    if (t?.error) toast(t.error, "err");
    else if (t?.url && !t.ready) {
      state.scope = "public";
      toast("Endereço criado — propagando DNS…");
    } else if (t?.ready) {
      state.scope = "public";
      toast("Link público no ar", "ok");
    }
    renderLinks();
  });

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "m") { e.preventDefault(); toggleMic(); }
  });

  window.addEventListener("beforeunload", () => stopScreen(true));
}

function fillSettings() {
  const s = state.settings;
  $("#set-name").value = s.display_name || "";
  $("#set-room").value = s.room_name || "";
  $("#set-res").value = s.resolution;
  $("#set-fps").value = String(s.framerate);
  $("#set-bitrate").value = s.bitrate_kbps;
  $("#bitrate-out").textContent = `${(s.bitrate_kbps / 1000).toFixed(1)} Mb/s`;
  $("#set-talk").checked = !!s.guests_can_talk;
  $("#set-autotunnel").checked = !!s.auto_tunnel;
  $("#turn-provider").value = s.turn_provider || "manual";
  showTurnFields(s.turn_provider || "manual");
  $("#cf-key").value = s.cf_turn_key_id || "";
  $("#cf-token").value = s.cf_turn_token || "";
  const urls = s.turn_urls?.length ? s.turn_urls : (s.turn_url ? [s.turn_url] : []);
  $("#turn-urls").value = urls.join("\n");
  $("#turn-secret").value = s.turn_secret || "";
  $("#turn-user").value = s.turn_user || "";
  $("#turn-pass").value = s.turn_pass || "";
  $("#set-forcerelay").checked = !!s.force_relay;
  updateBitrateHint(s.bitrate_kbps);
}

function showTurnFields(provider) {
  $("#turn-cf").hidden = provider !== "cloudflare";
  $("#turn-manual").hidden = provider === "cloudflare";
}

/**
 * Pede uma credencial de verdade e tenta juntar um candidato de relay com ela.
 * As duas metades importam: a credencial pode sair certinha e o relay ainda não
 * fechar (UDP bloqueado aqui), e é útil saber qual das duas quebrou.
 */
async function testTurn() {
  const btn = $("#btn-test-turn");
  const out = $("#turn-status");
  if (!state.api) return toast("Só pelo aplicativo.", "err");
  btn.disabled = true;
  out.className = "hint";
  out.textContent = "Pedindo credencial…";

  const cred = await state.api.turn_check();
  if (!cred.ok) {
    out.className = "hint warn";
    out.textContent = `Credencial: ${cred.detail}`;
    btn.disabled = false;
    return;
  }

  out.textContent = `${cred.detail} Testando o relay…`;
  const fresh = await fetch(`/api/ice?k=${encodeURIComponent(hostKey)}`).then((r) => r.json());
  state.boot.ice = fresh.iceServers;   // vale já para o próximo convidado
  const relay = await probeTurn();

  out.className = `hint ${relay.working ? "" : "warn"}`;
  out.textContent = relay.working
    ? `Funcionando: ${relay.relays} candidato(s) de relay. Convidados em CGNAT já conseguem entrar.`
    : "A credencial saiu, mas nenhum relay fechou — algo aqui está bloqueando UDP e a porta 443.";
  btn.disabled = false;
}

/**
 * Teto de banda recomendado por resolução × taxa. O motivo de existir: o
 * slider não se mexia sozinho quando a resolução mudava, então quem subia de
 * 1080p para 1440p sem lembrar de subir a banda ficava com banda insuficiente
 * pra qualidade nova — e isso aparece como queda de fps, não como imagem
 * borrada, porque o navegador prioriza manter os quadros ("maintain-framerate")
 * e sacrifica o resto. "nativa" usa o mesmo teto de 1440p por segurança, já
 * que a resolução real do monitor pode ser maior.
 */
const BITRATE_TABLE = {
  "720p":  { 30: 3000, 60: 4500 },
  "1080p": { 30: 6000, 60: 8000 },
  "1440p": { 30: 9000, 60: 13000 },
  nativa:  { 30: 9000, 60: 13000 },
};

function recommendedBitrate(resolution, framerate) {
  const tier = BITRATE_TABLE[resolution] || BITRATE_TABLE["1080p"];
  return tier[framerate] || tier[60];
}

/** Sobe o slider pro valor recomendado da qualidade atual — chamado sempre
 *  que resolução ou taxa mudam. Continua manual depois disso: a pessoa pode
 *  baixar de novo se preferir, isso só evita o esquecimento. */
function applyRecommendedBitrate({ quiet = false } = {}) {
  const kbps = recommendedBitrate(state.settings.resolution, Number(state.settings.framerate));
  $("#set-bitrate").value = kbps;
  $("#bitrate-out").textContent = `${(kbps / 1000).toFixed(1)} Mb/s`;
  Object.assign(state.settings, { bitrate_kbps: kbps });
  state.api?.save_settings({ bitrate_kbps: kbps });
  for (const entry of state.peers.values()) applyBitrate(entry);
  updateBitrateHint(kbps);
  if (!quiet) {
    toast(`Teto de banda ajustado para ${(kbps / 1000).toFixed(1)} Mb/s — recomendado pra essa qualidade.`, "");
  }
}

function updateBitrateHint(kbps) {
  const n = Math.max(1, state.peers.size);
  $("#bitrate-hint").textContent =
    `Com ${n} espectador${n > 1 ? "es" : ""} isso pede ~${((kbps * n) / 1000).toFixed(1)} Mb/s de upload.`;
}

function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
  if (name === "chat") { state.unread = 0; $("#chat-badge").hidden = true; }
}

/* --------------------------------------------------- assistir (modal) - */

function openWatchModal() {
  $("#watch-link-warn").hidden = true;
  $("#watch-link-input").value = "";
  $("#watch-modal").hidden = false;
  $("#watch-link-input").focus();
}

function closeWatchModal() {
  $("#watch-modal").hidden = true;
}

/** Aceita o link como a pessoa colar: com ou sem "https://" na frente. */
function normalizeWatchLink(raw) {
  const value = raw.trim();
  if (!value) return null;
  try {
    return new URL(value).href;
  } catch {
    try {
      return new URL(`https://${value}`).href;
    } catch {
      return null;
    }
  }
}

function goWatch() {
  const url = normalizeWatchLink($("#watch-link-input").value);
  const warn = $("#watch-link-warn");
  if (!url) {
    warn.textContent = "Esse link não parece válido.";
    warn.hidden = false;
    return;
  }
  // A janela é uma só: navegar pra outra sala derruba a SUA transmissão (o
  // JS desta página, com as conexões de todo mundo, morre junto). Confirma
  // antes só quando isso é de fato o caso.
  if (state.screen || state.peers.size) {
    const aviso = state.screen
      ? "Isso vai encerrar sua transmissão atual pra você entrar como espectador na outra sala. Continuar?"
      : "Isso vai fechar a conexão com quem já está na sua sala. Continuar?";
    if (!confirm(aviso)) return;
  }
  // Leva o caminho de volta pro SEU painel junto, na âncora do link — assim
  // a sala da outra pessoa (outro site, às vezes outro PC) ainda consegue
  // mostrar um jeito de voltar, mesmo sem saber nada sobre este servidor.
  const target = new URL(url);
  target.hash = `sabor_home=${encodeURIComponent(location.origin + "/")}`;
  location.href = target.href;
}

/* --------------------------------------------------------- links ------ */

function pickBestScope() {
  if (state.links.public) state.scope = "public";
  else if (state.links.lan) state.scope = "lan";
  else state.scope = "local";
}

function renderLinks() {
  const scopes = [
    { key: "public", label: "Internet", ic: "globe" },
    { key: "lan", label: "Rede local", ic: "wifi" },
    { key: "local", label: "Este PC", ic: "link" },
  ];
  const box = $("#linkscope");
  box.replaceChildren(
    ...scopes.map((s) => {
      const b = el("button", {
        class: `scope ${state.scope === s.key ? "active" : ""}`,
        "data-scope": s.key,
      }, icon(s.ic), s.label);
      b.disabled = !state.links[s.key];
      b.addEventListener("click", () => { state.scope = s.key; renderLinks(); });
      return b;
    })
  );
  $("#link-value").value = state.links[state.scope] || state.links.local || "";
  renderNetwork();
}

function renderNetwork() {
  const n = state.network;
  if (n) {
    $("#net-lan").textContent =
      `IP local ${n.lan} · http ${n.httpPort}${n.httpsPort ? ` · https ${n.httpsPort}` : " · https indisponível"}`;
  }
  const t = state.tunnel;
  if (!t) return;
  $("#btn-tunnel").textContent = t.running ? "Fechar link público" : "Abrir link público";
  $("#btn-tunnel").disabled = !t.available && !t.running;
  $("#tunnel-status").className =
    "hint" + (t.error || (t.url && !t.ready) ? " warn" : "");
  $("#tunnel-status").textContent = t.error
    ? t.error
    : t.url && t.unconfirmed
    ? `Não consegui confirmar ${t.url} daqui. O túnel provavelmente está no ar — `
      + "peça para alguém abrir. Se der “site não encontrado”, o DNS desta rede "
      + "guardou o nome como inexistente; rode o diagnóstico."
    : t.url && !t.ready
    ? "Endereço criado — aguarde o DNS propagar antes de mandar o link."
    : t.url
    ? `No ar: ${t.url}`
    : t.available
    ? "cloudflared encontrado."
    : "Instale o cloudflared para gerar um link de internet.";

  // Enquanto o DNS não propaga, copiar o link público só gera frustração.
  const pub = $('.scope[data-scope="public"]');
  if (pub) pub.classList.toggle("pending", !!t.url && !t.ready && !t.unconfirmed);
}

async function toggleTunnel() {
  if (!state.api) return toast("Só pelo aplicativo.", "err");
  $("#btn-tunnel").disabled = true;
  $("#tunnel-status").textContent = state.tunnel?.running ? "Fechando…" : "Abrindo túnel…";
  const s = state.tunnel?.running ? await state.api.stop_tunnel() : await state.api.start_tunnel();
  state.tunnel = s.tunnel;
  state.links = s.links;
  renderLinks();
}

/* ------------------------------------------------- diagnóstico de rede - */

/** Dois STUN de provedores diferentes — é a comparação entre eles que revela
 *  se o NAT é simétrico. Dois endereços do mesmo provedor não servem: podem
 *  cair no mesmo IP anycast e sempre "concordar". */
function stunPair() {
  const configured = (state.boot.ice || [])
    .flatMap((s) => [].concat(s.urls || []))
    .filter((u) => u.startsWith("stun:"));
  const provider = (u) => (u.split(":")[1] || "").split(".").slice(-2).join(".");
  const pair = [];
  for (const u of [...configured, "stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]) {
    if (!pair.some((p) => provider(p) === provider(u))) pair.push(u);
    if (pair.length === 2) break;
  }
  return pair;
}

/** O TURN configurado responde? Só um relay candidate prova que sim. */
async function probeTurn(timeoutMs = 9000) {
  const turn = (state.boot.ice || []).filter((s) =>
    [].concat(s.urls || []).some((u) => u.startsWith("turn"))
  );
  if (!turn.length) return { configured: false, working: false };

  const pc = new RTCPeerConnection({ iceServers: turn, iceTransportPolicy: "relay" });
  pc.createDataChannel("probe");
  let relays = 0;
  const errors = [];
  pc.onicecandidate = (e) => { if (e.candidate?.candidate.includes(" typ relay")) relays++; };
  pc.onicecandidateerror = (e) => errors.push(`${e.errorCode} ${e.url || ""}`.trim());
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((done) => {
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && done();
    setTimeout(done, timeoutMs);
  });
  pc.close();
  return { configured: true, working: relays > 0, relays, errors: [...new Set(errors)] };
}

async function runNetTest() {
  const btn = $("#btn-nettest");
  const box = $("#nettest");
  btn.disabled = true;
  btn.textContent = "Testando…";
  box.hidden = false;
  box.className = "nettest";
  box.replaceChildren(el("div", { class: "nt-line" }, "Medindo o NAT em dois servidores STUN…"));

  let nat, turn, dns = null;
  try {
    [nat, turn] = await Promise.all([natMapping(stunPair()), probeTurn()]);
    if (state.api?.dns_check) dns = await state.api.dns_check();
  } catch (err) {
    box.className = "nettest bad";
    box.replaceChildren(el("div", { class: "nt-line" }, `Falhou: ${err.message}`));
    btn.disabled = false;
    btn.textContent = "Testar minha rede";
    return;
  }

  const lines = [];
  let verdict, cls;

  if (!nat.reached) {
    cls = "bad";
    verdict = "Nenhum servidor STUN respondeu. Sem isso ninguém conecta em você — "
            + "algo está bloqueando UDP (firewall, antivírus ou a própria rede).";
  } else if (nat.symmetric) {
    cls = "bad";
    verdict = "NAT simétrico: os dois servidores STUN viram portas diferentes para o "
            + "mesmo socket. Cada destino ganha uma porta nova, então a conexão direta "
            + "não fecha para ninguém — aqui o TURN não é opcional.";
  } else {
    cls = "good";
    verdict = "Mapeamento independente do destino (tipo “cone”): os dois servidores STUN "
            + "viram a mesma porta, e a conexão direta deve fechar para quase todo mundo.";
  }

  lines.push(el("div", { class: "nt-verdict" }, verdict));

  if (nat.ip) {
    lines.push(el("div", { class: "nt-line" },
      `Endereço público visto de fora: ${nat.ip}`
      + (nat.ports.length > 1 ? ` · portas ${nat.ports.join(" e ")}` : "")));
  }
  if (nat.hasIpv6) {
    lines.push(el("div", { class: "nt-line" },
      "IPv6 disponível — com quem também tiver IPv6 a conexão é direta, sem NAT "
      + "no meio, mesmo que o IPv4 aqui seja simétrico."));
  }
  if (nat.cgnat) {
    lines.push(el("div", { class: "nt-line" },
      "Esse endereço está em 100.64.0.0/10 — faixa de NAT de operadora. "
      + "Você está atrás de CGNAT: não existe porta para abrir no roteador, e "
      + "sem TURN só conectam os amigos que também tiverem IPv6."));
  }

  if (turn.configured) {
    lines.push(el("div", { class: "nt-line" }, turn.working
      ? `TURN respondendo (${turn.relays} candidato(s) de relay).`
      : "O TURN configurado NÃO respondeu — confira endereço, porta e credenciais."));
    if (!turn.working) cls = "bad";
  } else if (nat.symmetric || nat.cgnat) {
    lines.push(el("div", { class: "nt-line" }, "Nenhum TURN configurado."));
  }

  if (dns && dns.verdict !== "ok") {
    cls = cls === "good" ? "warn" : cls;
    lines.push(el("div", { class: "nt-line" }, `DNS: ${dns.detail}`));
  } else if (dns?.servers?.length) {
    lines.push(el("div", { class: "nt-line dim" }, `DNS em uso: ${dns.servers.join(", ")}`));
  }

  if (nat.errors.length) {
    lines.push(el("div", { class: "nt-line dim" }, `Avisos: ${nat.errors.slice(0, 2).join(" · ")}`));
  }

  box.className = `nettest ${cls}`;
  box.replaceChildren(...lines);
  btn.disabled = false;
  btn.textContent = "Testar de novo";
}

/* --------------------------------------------------------- pessoas ---- */

/** A lista é agrupada por sala, como os canais de voz do Discord: cada sala
 *  com quem está dentro dela, e a sua em destaque. */
function renderPeople() {
  const list = $("#people-list");
  const me = {
    id: myId(),
    name: `${state.settings.display_name || "Você"} (você)`,
    role: "host",
    muted: !state.micOn,
    sala: minhaSala(),
  };
  const todos = [{ info: me, eu: true }, ...[...state.peers.values()].map((e) => ({ info: e.info, entry: e }))];
  const salas = state.salas.length ? state.salas : [{ id: minhaSala(), name: "Geral" }];

  const blocos = salas.map((sala) => {
    const dentro = todos.filter((p) => (p.info.sala || salas[0].id) === sala.id);
    const cabecalho = el("div", { class: `sala-hd ${sala.id === minhaSala() ? "aqui" : ""}` },
      icon("users"),
      el("span", { class: "sala-nome" }, sala.name),
      el("span", { class: "sala-count" }, String(dentro.length)));

    // clicar na sala move você pra ela — igual entrar num canal de voz
    cabecalho.addEventListener("click", () => {
      if (sala.id !== minhaSala()) state.signal?.send({ t: "sala", id: sala.id });
    });

    return el("div", { class: "sala-bloco" }, cabecalho,
      ...dentro.map((p) => rowFor(p.info, !!p.eu, p.entry)));
  });

  list.replaceChildren(...blocos);
  if (!state.peers.size) {
    list.append(
      el("div", { class: "empty" }, icon("users"),
        el("p", {}, "Ninguém aqui ainda. Copie o link e mande no grupo."))
    );
  }
  $("#tab-count").textContent = state.peers.size;
  renderUserbar();
  updateBitrateHint(Number(state.settings.bitrate_kbps));
}

/** As salas aparecem dentro da própria lista de pessoas. */
const renderSalas = renderPeople;

/** O rodapé da coluna da esquerda: quem você é e em que sala está. */
function renderUserbar() {
  const nome = state.settings?.display_name || "Você";
  const sala = state.salas.find((s) => s.id === minhaSala());
  $("#room-title").textContent = state.settings?.room_name || "Sala";
  $("#me-name").textContent = nome;
  $("#me-sala").textContent = sala ? sala.name : "—";
  const av = $("#me-avatar");
  av.textContent = initials(nome);
  av.style.background = `linear-gradient(140deg, ${colorFor(myId() + nome)}, ${colorFor(nome)})`;
}

function rowFor(info, isMe, entry) {
  const status = entry?.conn === "connected" ? "conectado"
    : entry?.conn === "failed" ? `falhou — ${entry.failReason || "sem rota"}`
    : entry ? "conectando…" : "host · servidor";

  const micState = el("div", { class: `mic-state ${info.muted ? "off" : "on"}` },
    icon(info.muted ? "micOff" : "mic"));

  const acts = el("div", { class: "acts" });
  if (!isMe && entry && state.salas.length > 1) {
    // Mover uma pessoa específica de sala. Um select em vez de menu próprio:
    // é o controle que já existe pronto e cabe na linha.
    const mover = el("select", { class: "sala-pick", title: "Mover de sala" },
      ...state.salas.map((s) => el("option", { value: s.id }, s.name)));
    mover.value = info.sala || state.salas[0].id;
    mover.addEventListener("click", (e) => e.stopPropagation());
    mover.addEventListener("change", (e) =>
      state.signal.send({ t: "admin", action: "mover", id: info.id, sala: e.target.value }));
    acts.append(mover);
  }
  if (!isMe && entry) {
    const mute = el("button", { class: "icon-btn", title: "Pedir silêncio" }, icon("micOff"));
    mute.addEventListener("click", () =>
      state.signal.send({ t: "admin", action: "mute", id: info.id }));
    const kick = el("button", { class: "icon-btn danger", title: "Remover" }, icon("kick"));
    kick.addEventListener("click", () => {
      if (confirm(`Remover ${info.name}?`)) state.signal.send({ t: "admin", action: "kick", id: info.id });
    });
    acts.append(mute, kick);
  }

  return el("div", { class: "person" },
    avatarFor(info),
    el("div", { class: "meta" },
      el("div", { class: "nm" }, info.name, state.live.has(info.id) && el("span", { class: "live-dot", title: "Transmitindo" })),
      el("div", { class: "sub" }, status)),
    acts, micState);
}

/* ----------------------------------------------------------- chat ----- */

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

  if (!$('.tab[data-tab="chat"]').classList.contains("active") && !mine) {
    $("#chat-badge").hidden = false;
  }
}

function sysChat(text) {
  const log = $("#chat-log");
  log.append(el("div", { class: "msg sys" }, el("div", { class: "text" }, text)));
  log.scrollTop = log.scrollHeight;
}

// Painel local: expor o estado ajuda a diagnosticar codec/encoder pelo console
// (ver "Desempenho" no README).
window.__sabor = state;

boot();
