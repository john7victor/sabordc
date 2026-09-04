// Conexão par-a-par. A mídia sai daqui direto para o outro lado — o servidor
// Python só encaminhou o "aperto de mão". Usa negociação perfeita para que os
// dois lados possam renegociar (o host ao trocar a tela, o convidado ao ligar
// o microfone) sem colidir.

export class Peer extends EventTarget {
  /**
   * @param {object} o
   * @param {string} o.id        id do par remoto
   * @param {boolean} o.polite   quem cede em caso de colisão de ofertas
   * @param {Array} o.iceServers
   * @param {boolean} [o.relayOnly] só junta candidatos de TURN (ver abaixo)
   * @param {(payload:object)=>void} o.send
   */
  constructor({ id, polite, iceServers, relayOnly = false, send }) {
    super();
    this.id = id;
    this.polite = polite;
    this.relayOnly = relayOnly;
    this.send = send;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.closed = false;
    this.chain = Promise.resolve(); // serializa a negociação
    // id do MediaStream -> { kind, owner, name }. O host publica este mapa; é
    // como o convidado sabe se um áudio é o jogo ou a voz de fulano.
    this.streamMap = {};

    // `relay` descarta os candidatos host e srflx e só oferece o TURN. Sob
    // CGNAT simétrico a tentativa direta não tem como fechar: sem isto o
    // convidado espera o ICE inteiro estourar (~10 s de tela preta) para só
    // então cair no relay. Com isto ele entra direto pelo caminho que funciona.
    this.pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: relayOnly ? "relay" : "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.send({ desc: this.pc.localDescription });
        this.emit("negotiated");
      } catch (err) {
        this.emit("error", err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ candidate });
    };

    this.pc.ontrack = (ev) => {
      this.emit("track", ev);
    };

    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      this.emit("state", st);
      // Um restartIce refaz exatamente o mesmo caminho que acabou de falhar.
      // Vale uma vez (perda de rede momentânea); da segunda em diante quem
      // decide é o chamador, que pode refazer o par em modo relay.
      if (st === "failed") {
        if (this.restarted) { this.emit("dead"); return; }
        this.restarted = true;
        this.pc.restartIce();
      }
    };
  }

  /** Enfileira: duas mensagens nunca são aplicadas ao mesmo tempo. */
  accept(payload) {
    this.chain = this.chain.then(() => this._accept(payload)).catch(() => {});
    return this.chain;
  }

  async _accept(payload) {
    if (this.closed || !payload) return;
    const { desc, candidate, streams } = payload;

    if (streams) {
      this.streamMap = { ...this.streamMap, ...streams };
      this.emit("streams", this.streamMap);
      return;
    }

    try {
      if (desc) {
        const offerCollision =
          desc.type === "offer" &&
          (this.makingOffer || this.pc.signalingState !== "stable");

        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;

        await this.pc.setRemoteDescription(desc);
        if (desc.type === "offer") {
          await this.pc.setLocalDescription();
          this.send({ desc: this.pc.localDescription });
          this.emit("negotiated");
        }
      } else if (candidate) {
        try {
          await this.pc.addIceCandidate(candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.emit("error", err);
    }
  }

  /** Limita a banda de um sender — teto por espectador, em kbps.
   *  Só funciona depois que a negociação criou as encodings; antes disso o
   *  navegador recusa a mudança, então chamamos de novo ao conectar.
   *
   *  `framerate` fixa o teto de quadros do encoder — sem isso o navegador só
   *  tem o "maintain-framerate" como pista e ainda pode cortar fps num pico
   *  de congestionamento. `priority`/`networkPriority` "high" faz o vídeo
   *  vencer a briga por banda contra os relés de voz que passam pela mesma
   *  conexão — sem isso os dois competem em pé de igualdade e é o vídeo que
   *  engasga primeiro.
   *
   *  `resolution` é o teto de qualidade ("720p"/"1080p"/"1440p"/"nativa") e
   *  vira um `scaleResolutionDownBy` calculado a partir do tamanho REAL do
   *  que já está sendo capturado (`sender.track.getSettings()`) — nunca um
   *  width/height fixo pedido na captura. Isso importa: um alvo width+height
   *  fixo faz o Chrome CORTAR a imagem pra forcar aquela proporcao quando a
   *  fonte tem outra (ex: alguem jogando CS numa resolucao esticada, tipo
   *  4:3 num monitor 16:9) — reduzir depois, escalando o que já foi
   *  capturado, preserva a proporção original e nunca corta nada. */
  async setBitrate(sender, kbps, framerate, resolution) {
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const cap = resolution && RESOLUTION_LONG_EDGE[resolution];
    const settings = sender.track?.getSettings();
    const longEdge = settings && Math.max(settings.width || 0, settings.height || 0);
    for (const enc of params.encodings) {
      enc.maxBitrate = kbps * 1000;
      if (framerate) enc.maxFramerate = framerate;
      enc.priority = "high";
      enc.networkPriority = "high";
      enc.scaleResolutionDownBy = cap && longEdge > cap ? longEdge / cap : 1;
    }
    params.degradationPreference = "maintain-framerate";
    try { await sender.setParameters(params); } catch {}
  }

  /** Estatísticas resumidas do que estamos enviando/recebendo. */
  async stats() {
    const out = {
      outBits: 0, inBits: 0, fps: 0, width: 0, height: 0, rtt: null, loss: 0,
      encoder: null, hwEncoder: null, codec: null, limitation: null,
    };
    const now = await this.pc.getStats();
    const prev = this._prevStats;
    const stamp = performance.now();
    const codecs = {};
    now.forEach((r) => { if (r.type === "codec") codecs[r.id] = r.mimeType; });

    now.forEach((r) => {
      if (r.type === "outbound-rtp" && r.kind === "video") {
        out.fps = Math.round(r.framesPerSecond || 0);
        out.encoder = r.encoderImplementation || null;
        out.hwEncoder = r.powerEfficientEncoder ?? null;
        out.codec = codecs[r.codecId] || null;
        out.limitation = r.qualityLimitationReason || null;
        out.width = r.frameWidth || out.width;
        out.height = r.frameHeight || out.height;
        if (prev?.get(r.id)) {
          const dt = (stamp - this._prevAt) / 1000;
          out.outBits = ((r.bytesSent - prev.get(r.id).bytesSent) * 8) / Math.max(dt, 0.001);
        }
      }
      if (r.type === "inbound-rtp" && r.kind === "video") {
        out.fps = Math.round(r.framesPerSecond || out.fps);
        if (prev?.get(r.id)) {
          const dt = (stamp - this._prevAt) / 1000;
          out.inBits = ((r.bytesReceived - prev.get(r.id).bytesReceived) * 8) / Math.max(dt, 0.001);
        }
      }
      if (r.type === "track" || r.type === "media-source") {
        out.width = r.frameWidth || out.width;
        out.height = r.frameHeight || out.height;
      }
      if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated !== false) {
        out.rtt = r.currentRoundTripTime != null ? Math.round(r.currentRoundTripTime * 1000) : out.rtt;
      }
      if (r.type === "remote-inbound-rtp") {
        out.loss = Math.max(0, Math.round((r.fractionLost || 0) * 100));
      }
    });

    this._prevStats = now;
    this._prevAt = stamp;
    return out;
  }

  close() {
    this.closed = true;
    try { this.pc.close(); } catch {}
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    this.addEventListener(type, (e) => fn(e.detail));
    return this;
  }
}

/**
 * Casa cada faixa que chega numa conexão com o que o outro lado disse que ela
 * é ("screen" de fulano, "voice" de sicrano...). O mapa (`peer.streamMap`)
 * chega por um canal separado do `ontrack` — às vezes antes, às vezes depois
 * — então uma faixa pode chegar sem ninguém ainda saber o que ela é. Isso
 * serve tanto para o convidado (recebe a tela do host e a de quem mais
 * estiver transmitindo) quanto para o host (recebe a voz de cada convidado e
 * agora também a tela de quem decidir transmitir).
 *
 * `handlers` é um objeto { screen(stream, ownerId, name), voice(...) }: cada
 * chave é um "kind" que pode aparecer no streamMap.
 *
 * Guarda TODA faixa já vista, não só as ainda não resolvidas — de propósito.
 * `ontrack` só dispara uma vez por transceiver, na primeira negociação; uma
 * transmissão que para e volta depois não cria um transceiver novo, só troca
 * o conteúdo com `replaceTrack` (pra não precisar renegociar). Sem guardar a
 * faixa original, o segundo "começar" nunca teria um `ontrack` novo pra
 * disparar o handler de novo, e o card ficaria travado em "conectando" pra
 * sempre — reaplicar em toda faixa já vista, de novo a cada mapa que chega, é
 * o que faz o card voltar. Os handlers (grid.attach, attachVoice...) já são
 * seguros de chamar de novo com a mesma faixa.
 */
export function trackRouter(peer, handlers) {
  const seen = [];
  const drain = () => {
    const map = peer.streamMap || {};
    for (const ev of seen) {
      const stream = ev.streams[0];
      const info = stream && map[stream.id];
      if (info) handlers[info.kind]?.(stream, info.owner, info.name, ev.track);
    }
  };
  peer.on("track", (ev) => { seen.push(ev); drain(); });
  peer.on("streams", drain);
  return { drain };
}

/**
 * Reordena os codecs de vídeo da conexão.
 *
 * Por que isso importa: o padrão do Chrome/WebView2 é VP8, que no Windows NÃO
 * tem encoder de hardware — 1080p60 vira trabalho de CPU disputando com o
 * jogo, e o resultado é engasgo. H.264 cai no encoder dedicado da GPU
 * (NVENC / AMD VCE / Intel QuickSync), que custa quase nada.
 *
 * Precisa ser chamado ANTES da primeira oferta. Mantemos todos os codecs na
 * lista (inclusive RTX, red e ulpfec) e só mudamos a ordem: tirar qualquer um
 * quebraria retransmissão e correção de erro.
 */
export function preferVideoCodecs(transceiver, prefer = ["H264", "VP9", "VP8", "AV1"]) {
  const caps = typeof RTCRtpSender !== "undefined" && RTCRtpSender.getCapabilities
    ? RTCRtpSender.getCapabilities("video")
    : null;
  if (!caps || !transceiver?.setCodecPreferences) return null;

  const rank = (codec) => {
    const name = (codec.mimeType.split("/")[1] || "").toUpperCase();
    const idx = prefer.indexOf(name);
    const base = idx < 0 ? prefer.length : idx;
    // packetization-mode=1 é o modo que os encoders de hardware usam
    const pm = /packetization-mode=1/.test(codec.sdpFmtpLine || "") ? 0 : 0.5;
    return base + pm;
  };

  const ordered = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(ordered);
    return ordered[0]?.mimeType || null;
  } catch {
    return null; // navegador antigo: segue com o padrão dele
  }
}

/**
 * Teto de qualidade por resolução, em pixels do lado maior — usado só depois
 * da captura, como `scaleResolutionDownBy` (ver `Peer.setBitrate`). "nativa"
 * não tem entrada aqui de propósito: sem teto nenhum.
 */
export const RESOLUTION_LONG_EDGE = { "720p": 1280, "1080p": 1920, "1440p": 2560 };

/**
 * Constraints de captura de tela. De propósito SEM width/height: pedir uma
 * caixa fixa (mesmo só como "ideal") faz o Chrome CORTAR a imagem sempre que
 * a fonte escolhida — uma janela, ou a tela inteira — não tiver essa mesma
 * proporção. É um caso comum: alguém jogando numa resolução esticada (tipo
 * 4:3 num monitor 16:9, comum em FPS competitivo) tinha pedaços da tela
 * cortados. A resolução vira teto de qualidade DEPOIS, sobre o que já foi
 * capturado — nunca corta, só escala mantendo a proporção original.
 */
export function displayConstraints(framerate) {
  return {
    video: {
      frameRate: { ideal: framerate, max: framerate },
      cursor: "motion",
    },
    // `audio: true` e não um objeto de constraints: pedir coisas como
    // `channelCount` ou `echoCancellation: false` aqui é o caminho conhecido
    // pra captura de tela voltar SEM faixa de áudio nenhuma — a pessoa marca
    // "compartilhar áudio" no seletor e não sai som. O que a gente queria com
    // aquilo (não tratar o som como voz) já vem do `contentHint = "music"`,
    // aplicado na faixa depois que ela chega.
    audio: true,
    // Pede explicitamente que o seletor ofereça o áudio do sistema.
    systemAudio: "include",
    // E que compartilhar uma JANELA também leve som. Esse é o caso que mais
    // quebrava: ao escolher a janela do jogo, o áudio fica de fora por
    // padrão — "system" pede o som todo em vez de nenhum. (Windows não sabe
    // isolar o áudio de uma janela só, então o certo aqui é o som do
    // sistema, não "window".)
    windowAudio: "system",
    // Tira a própria janela do app da lista. Sem isso, no app de desktop a
    // única "aba" que aparece pra escolher é a do próprio Sabor DC — quem
    // escolhia caía num espelho infinito (a prévia dentro da prévia).
    selfBrowserSurface: "exclude",
    // Deixa trocar de fonte pelo botão do próprio Chrome, sem refazer tudo.
    surfaceSwitching: "include",
  };
}

export const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};


/**
 * Descobre como o NAT desta rede mapeia portas — o único teste que responde
 * "meus amigos vão conseguir conectar direto?".
 *
 * O método: **uma só** RTCPeerConnection, com dois servidores STUN de
 * provedores diferentes. Como é uma conexão só, as duas perguntas saem do
 * mesmo socket local — e é isso que torna a comparação válida:
 *
 * * Os dois STUN veem a mesma porta → o mapeamento é independente do destino
 *   ("cone"). O navegador nem repete o candidato: sai **um** srflx só, e a
 *   furação de buraco fecha.
 * * Cada STUN vê uma porta diferente → saem **dois** srflx com a mesma
 *   foundation, e o NAT é simétrico: cada destino ganha uma porta nova. O
 *   outro lado não tem para onde mandar e só TURN resolve. É o que acontece
 *   na maioria dos CGNAT.
 *
 * Dois RTCPeerConnection separados NÃO servem para esse teste: cada um abre o
 * seu próprio socket local, então as portas públicas seriam diferentes mesmo
 * num NAT "cone" — dá simétrico para todo mundo.
 *
 * Comparar a porta pública com a porta local também não serve: um NAT
 * simétrico pode preservar a porta na primeira conexão e trocar na segunda.
 */
export async function natMapping(stunUrls, timeoutMs = 9000) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrls }] });
  pc.createDataChannel("probe");

  const srflx = [];
  const errors = [];
  pc.onicecandidate = (e) => {
    const raw = e.candidate?.candidate;
    if (!raw) return;
    const p = raw.split(" ");
    if (p[p.indexOf("typ") + 1] !== "srflx") return;
    srflx.push({ foundation: p[0].split(":")[1], ip: p[4], port: p[5] });
  };
  pc.onicecandidateerror = (e) => errors.push(`${e.errorCode} ${e.url || ""}`.trim());

  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((done) => {
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && done();
    setTimeout(done, timeoutMs);
  });
  pc.close();

  const v4 = srflx.filter((c) => !c.ip.includes(":"));
  // Agrupa por foundation: candidatos com a mesma foundation nasceram do mesmo
  // socket local, e só entre eles a comparação de portas quer dizer alguma coisa.
  const byBase = new Map();
  for (const c of v4) {
    if (!byBase.has(c.foundation)) byBase.set(c.foundation, new Set());
    byBase.get(c.foundation).add(c.port);
  }
  const ports = [...(byBase.values().next().value || [])];

  return {
    reached: v4.length,
    ip: v4[0]?.ip || null,
    ports,
    hasIpv6: srflx.some((c) => c.ip.includes(":")),
    // Com um só candidato não dá para concluir: pode ser cone (os dois STUN
    // concordaram e o navegador deduplicou) ou um STUN que não respondeu.
    symmetric: ports.length > 1 ? true : null,
    cgnat: !!v4[0] && isCgnatRange(v4[0].ip),
    errors: [...new Set(errors)],
  };
}

export function isCgnatRange(ip) {
  const m = /^(\d+)\.(\d+)\./.exec(ip || "");
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 100 && b >= 64 && b <= 127;
}
