// Malha entre convidados.
//
// Quando um convidado transmite, a imagem dele passava pelo PC do host: o
// host recebia, re-codificava e mandava de novo pra cada espectador. Com duas
// pessoas ao vivo isso vira o dobro de trabalho na máquina de quem só queria
// jogar — que é justamente o que a gente estava tentando evitar.
//
// Aqui cada espectador puxa a tela DIRETO de quem está transmitindo. O
// repasse do host continua existindo como reserva: a malha só toma o lugar
// dele depois que a conexão direta fecha de verdade (evento "connected"). Se
// a direta não fechar em LIMITE_MS, ou cair depois, o host volta a repassar e
// ninguém vê tela preta no meio.
//
// Cada ligação da malha é identificada pelo id de QUEM TRANSMITE (o "link").
// Sem isso, dois convidados transmitindo um pro outro teriam duas conexões
// entre o mesmo par de pessoas e nenhum jeito de saber a qual delas um sinal
// que chegou pertence.

import { Peer, preferVideoCodecs, trackRouter } from "./rtc.js";

// Tempo pra conexão direta fechar antes de desistirmos e ficarmos no repasse
// do host. Cobre um ICE completo, inclusive caindo pro TURN.
const LIMITE_MS = 9000;

export class Mesh {
  /**
   * @param {object} o
   * @param {string} o.meuId
   * @param {Array} o.iceServers
   * @param {boolean} [o.relayOnly]
   * @param {(to:string, payload:object)=>void} o.enviar
   * @param {(ownerId:string, stream:MediaStream, nome:string)=>void} o.onTela
   * @param {(ownerId:string)=>void} o.onFim    tira o quadro da grade
   * @param {(ownerId:string, direto:boolean)=>void} o.onDireto  avisa o host
   */
  constructor({ meuId, iceServers, relayOnly = false, enviar, onTela, onFim, onDireto }) {
    this.meuId = meuId;
    this.iceServers = iceServers;
    this.relayOnly = relayOnly;
    this.enviar = enviar;
    this.onTela = onTela;
    this.onFim = onFim;
    this.onDireto = onDireto;

    this.vendo = new Map();     // ownerId  -> ligação em que EU assisto
    this.enviando = new Map();  // viewerId -> ligação em que EU transmito
    // Quem já tentamos e não deu. Uma tentativa por transmissão: sem isso,
    // numa rede onde a direta nunca fecha, cada troca de sala recomeçaria a
    // mesma tentativa perdida — e o repasse do host, que funciona, ficaria
    // indo e voltando junto.
    this.desistiu = new Set();

    this.tela = null;           // o MediaStream que eu estou transmitindo
    this.nome = "";
    this.qualidade = null;      // { kbps, fps, resolucao }
  }

  /* ------------------------------------------------- eu como espectador */

  /** Pede a tela de `ownerId` direto pra ele. Idempotente. */
  assistir(ownerId, nome = "") {
    if (!ownerId || ownerId === this.meuId) return;
    if (this.vendo.has(ownerId) || this.desistiu.has(ownerId)) return;

    const peer = this._novoPeer(ownerId, true, ownerId); // espectador cede
    const lig = { peer, ok: false, timer: null, nome };
    this.vendo.set(ownerId, lig);

    trackRouter(peer, {
      screen: (stream, dono, nomeDono) => {
        if (dono !== ownerId) return;
        this.onTela?.(ownerId, stream, nomeDono || nome);
      },
    });

    peer.on("state", (st) => {
      if (st === "connected" && !lig.ok) {
        lig.ok = true;
        clearTimeout(lig.timer);
        // Só agora vale pedir ao host pra parar de repassar: o vídeo já está
        // chegando pelo caminho direto.
        this.onDireto?.(ownerId, true);
      }
      if (st === "failed" || st === "closed") this._desistir(ownerId);
    });
    peer.on("dead", () => this._desistir(ownerId));

    lig.timer = setTimeout(() => { if (!lig.ok) this._desistir(ownerId); }, LIMITE_MS);
    this.enviar(ownerId, { mesh: ownerId, hello: true });
  }

  /** Encerra a ligação direta com `ownerId` (ele parou, saiu ou mudou de sala). */
  parar(ownerId) {
    const lig = this.vendo.get(ownerId);
    if (!lig) return;
    clearTimeout(lig.timer);
    this.vendo.delete(ownerId);
    this.desistiu.delete(ownerId);   // se ele voltar a transmitir, tentamos de novo
    try { lig.peer.close(); } catch {}
    if (lig.ok) this.onDireto?.(ownerId, false); // host volta a repassar
    this.onFim?.(ownerId);
  }

  /** Deu errado: volta pro repasse do host sem barulho. */
  _desistir(ownerId) {
    const lig = this.vendo.get(ownerId);
    if (!lig) return;
    const tinhaImagem = lig.ok;
    clearTimeout(lig.timer);
    this.vendo.delete(ownerId);
    this.desistiu.add(ownerId);
    try { lig.peer.close(); } catch {}
    this.onDireto?.(ownerId, false);
    // Se a direta chegou a funcionar, o quadro na tela é dela e está
    // congelado: tira, que o repasse do host recoloca.
    if (tinhaImagem) this.onFim?.(ownerId);
  }

  /** Está pegando a tela desta pessoa direto com ela? */
  direto(ownerId) {
    return !!this.vendo.get(ownerId)?.ok;
  }

  /* ------------------------------------------------ eu como transmissor */

  /** Diz qual tela eu estou transmitindo (null quando paro). */
  publicar(stream, nome, qualidade) {
    this.tela = stream || null;
    if (nome) this.nome = nome;
    if (qualidade) this.qualidade = qualidade;

    if (!this.tela) {
      for (const viewerId of [...this.enviando.keys()]) this._fecharEnvio(viewerId);
      return;
    }
    for (const lig of this.enviando.values()) this._publicarNa(lig);
  }

  /** Reaplica o teto de qualidade em quem já está me assistindo direto. */
  ajustarQualidade(qualidade) {
    this.qualidade = qualidade;
    for (const lig of this.enviando.values()) {
      const tx = lig.txs[0];
      if (tx) lig.peer.setBitrate(tx.sender, qualidade.kbps, qualidade.fps, qualidade.resolucao);
    }
  }

  _atender(viewerId) {
    // Um "hello" novo é sempre um pedido novo: quem já tinha ligação comigo
    // e voltou (saiu e entrou na sala, por exemplo) precisa de uma conexão
    // do zero. Reaproveitar a antiga não funciona — do lado dele ela já foi
    // fechada, e do meu o ICE ainda levaria meio minuto pra perceber.
    this._fecharEnvio(viewerId);
    if (!this.tela) {
      // Nada pra mandar — o espectador desiste na hora em vez de esperar o
      // tempo todo do ICE.
      this.enviar(viewerId, { mesh: this.meuId, semTela: true });
      return;
    }
    const peer = this._novoPeer(viewerId, false, this.meuId); // quem transmite manda
    const lig = { peer, txs: [] };
    this.enviando.set(viewerId, lig);
    peer.on("state", (st) => { if (st === "failed" || st === "closed") this._fecharEnvio(viewerId); });
    peer.on("dead", () => this._fecharEnvio(viewerId));
    this._publicarNa(lig);
  }

  _publicarNa(lig) {
    const stream = this.tela;
    if (!stream || lig.txs.length) return;   // já publicado nesta ligação
    try {
      const video = stream.getVideoTracks()[0];
      if (!video) return;
      const tx = lig.peer.pc.addTransceiver(video, { direction: "sendonly", streams: [stream] });
      preferVideoCodecs(tx); // antes da 1a oferta: manda pro encoder da GPU
      lig.txs.push(tx);
      const som = stream.getAudioTracks()[0];
      if (som) lig.txs.push(lig.peer.pc.addTransceiver(som, { direction: "sendonly", streams: [stream] }));
      // O mapa é o que diz ao outro lado o que essa faixa é.
      this.enviar(lig.peer.id, {
        mesh: this.meuId,
        streams: { [stream.id]: { kind: "screen", owner: this.meuId, name: this.nome } },
      });
      if (this.qualidade) {
        lig.peer.setBitrate(tx.sender, this.qualidade.kbps, this.qualidade.fps, this.qualidade.resolucao);
      }
    } catch (err) {
      console.error("mesh", err);
    }
  }

  _fecharEnvio(viewerId) {
    const lig = this.enviando.get(viewerId);
    if (!lig) return;
    this.enviando.delete(viewerId);
    try { lig.peer.close(); } catch {}
  }

  /* ------------------------------------------------------- sinalização */

  /** Um sinal da malha chegou. `link` é o id de quem transmite naquela ligação. */
  aceitar(from, link, payload) {
    if (payload.hello) return this._atender(from);
    if (payload.semTela) return this._desistir(from);

    const lig = link === this.meuId ? this.enviando.get(from) : this.vendo.get(link);
    lig?.peer.accept(payload);
  }

  /** Alguém saiu da sala (ou da minha sala): esquece os dois lados. */
  esquecer(peerId) {
    this.parar(peerId);
    this._fecharEnvio(peerId);
  }

  fechar() {
    for (const id of [...this.vendo.keys()]) this.parar(id);
    for (const id of [...this.enviando.keys()]) this._fecharEnvio(id);
  }

  _novoPeer(to, polite, link) {
    return new Peer({
      id: to,
      polite,
      iceServers: this.iceServers,
      relayOnly: this.relayOnly,
      send: (payload) => this.enviar(to, { ...payload, mesh: link }),
    });
  }
}
