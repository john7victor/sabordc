// Grade de vídeos: um card por transmissão ativa (a do host, a de qualquer
// convidado que também ligar a câmera/tela). Usado tanto no painel do host
// quanto na sala do convidado — os dois podem ter mais de uma transmissão ao
// vivo ao mesmo tempo, na mesma sala, sem trocar de link.

import { el } from "./ui.js";

export class Grid {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    this.tiles = new Map(); // id -> { el, video, tag }
    this.focusId = null;

    // Clicar num card aumenta ele e encolhe os outros; clicar de novo desfaz.
    container.addEventListener("click", (e) => {
      const tile = e.target.closest(".vtile");
      if (!tile) return;
      const id = tile.dataset.id;
      this.focus(this.focusId === id ? null : id);
    });
  }

  get count() {
    return this.tiles.size;
  }

  has(id) {
    return this.tiles.has(id);
  }

  ensure(id, label, { muted = false } = {}) {
    let t = this.tiles.get(id);
    if (t) {
      if (label !== undefined) this.setLabel(id, label);
      return t;
    }
    // `muted` é pra própria transmissão de cada um: sem isso o áudio do
    // sistema (ou o jogo) toca duas vezes — uma direto, outra pelo elemento
    // de vídeo local. Quem assiste os outros continua ouvindo normal.
    const video = el("video", { autoplay: "", playsinline: "", muted: muted ? "" : null });
    video.muted = muted;
    const tag = el("div", { class: "vtile-tag" }, label || "");
    const node = el("div", { class: "vtile", "data-id": id }, video, tag);
    this.container.append(node);
    t = { el: node, video, tag };
    this.tiles.set(id, t);
    this.layout();
    return t;
  }

  /** Liga (ou troca) o stream mostrado num card, criando-o se precisar. */
  attach(id, stream, label, opts) {
    const t = this.ensure(id, label, opts);
    // Reatar também quando é o MESMO stream mas com outra quantidade de
    // faixas: o vídeo e o áudio da tela chegam em eventos separados, e o
    // elemento <video> nem sempre passa a tocar uma faixa de áudio que foi
    // adicionada ao stream depois que o srcObject já tinha sido definido —
    // é assim que uma transmissão fica muda mesmo com o áudio chegando.
    const faixas = stream ? stream.getTracks().length : 0;
    if (t.video.srcObject !== stream || t.faixas !== faixas) {
      t.video.srcObject = stream;
      t.faixas = faixas;
      t.video.play().catch(() => {});
    }
    return t;
  }

  /** Ajusta o volume de todos os cards (menos os marcados como próprios). */
  setVolume(volume) {
    for (const t of this.tiles.values()) {
      if (!t.video.muted) t.video.volume = volume;
    }
  }

  /** Liga/desliga o vídeo de um card sem tirá-lo da grade — usado pra prévia
   *  local: a transmissão continua normal, só a janela para de desenhar. */
  setSource(id, stream) {
    const t = this.tiles.get(id);
    if (!t) return;
    if (stream) {
      t.video.srcObject = stream;
      t.video.play().catch(() => {});
    } else {
      t.video.pause();
      t.video.srcObject = null;
      t.faixas = 0;
    }
  }

  setLabel(id, label) {
    const t = this.tiles.get(id);
    if (t) t.tag.textContent = label;
  }

  remove(id) {
    const t = this.tiles.get(id);
    if (!t) return;
    t.video.pause();
    t.video.srcObject = null;
    t.el.remove();
    this.tiles.delete(id);
    if (this.focusId === id) this.focusId = null;
    this.layout();
  }

  focus(id) {
    this.focusId = id && this.tiles.has(id) ? id : null;
    this.layout();
  }

  layout() {
    this.container.classList.toggle("has-focus", !!this.focusId);
    for (const [id, t] of this.tiles) {
      t.el.classList.toggle("focus", id === this.focusId);
    }
  }
}
