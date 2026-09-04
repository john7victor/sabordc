// Efeitos de voz: o microfone entra cru de um lado e sai transformado do
// outro, ainda como um MediaStream — então o resto do app não muda nada,
// continua mandando uma faixa de áudio pela conexão como sempre fez.
//
// Tudo com os nós que o navegador já tem, sem biblioteca. O pitch (voz grave
// ou aguda) é a única parte que dá trabalho, porque o Web Audio não traz isso
// pronto: a saída é o truque clássico de duas linhas de atraso varridas por
// uma rampa e cruzadas em fade, que soa como um pitch shift sem precisar de
// FFT nem AudioWorklet.

const GRAO = 0.12;        // segundos de cada "grão" do pitch shift
const ATRASO_MAX = 0.25;

export const EFEITOS = [
  { id: "normal",   nome: "Sem efeito" },
  { id: "grave",    nome: "Grave" },
  { id: "monstro",  nome: "Monstro" },
  { id: "agudo",    nome: "Agudo" },
  { id: "esquilo",  nome: "Esquilo" },
  { id: "robo",     nome: "Robô" },
  { id: "radio",    nome: "Rádio velho" },
  { id: "caverna",  nome: "Caverna" },
];

/** Rampa de 0 a 1 repetida — varre o tempo de atraso de cada linha. */
function bufferRampa(ctx, duracao) {
  const n = Math.round(ctx.sampleRate * duracao);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = i / n;
  return buf;
}

/** Envelope que abre e fecha — é o que esconde o "pulo" entre os grãos. */
function bufferFade(ctx, duracao) {
  const n = Math.round(ctx.sampleRate * duracao);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    d[i] = t < 0.5 ? t * 2 : (1 - t) * 2;   // triângulo
  }
  return buf;
}

/** Curva de distorção suave — usada no monstro e no rádio. */
function curvaDistorcao(quantidade) {
  const n = 1024;
  const curva = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curva[i] = ((1 + quantidade) * x) / (1 + quantidade * Math.abs(x));
  }
  return curva;
}

/**
 * Monta o deslocador de tom. Devolve { entrada, saida, parar }.
 * `semitons` positivo deixa mais agudo, negativo mais grave.
 */
function pitchShift(ctx, semitons) {
  const entrada = ctx.createGain();
  const saida = ctx.createGain();
  const razao = Math.pow(2, semitons / 12);
  // Varrer o atraso nesta taxa é o que muda o tom: a rampa "estica" ou
  // "encolhe" o tempo do som enquanto ele passa.
  const taxa = Math.abs(1 - razao) / GRAO;

  const rampa = bufferRampa(ctx, 1 / taxa);
  const fade = bufferFade(ctx, 1 / taxa);
  const fontes = [];

  // Duas linhas idênticas, defasadas em meio ciclo: enquanto uma fecha, a
  // outra já abriu, e a emenda não aparece.
  for (const atrasoInicial of [0, 0.5 / taxa]) {
    const delay = ctx.createDelay(ATRASO_MAX);
    const ganho = ctx.createGain();
    ganho.gain.value = 0;

    const varredura = ctx.createBufferSource();
    varredura.buffer = rampa;
    varredura.loop = true;
    const escala = ctx.createGain();
    // Pra descer o tom o atraso cresce (0 → GRÃO); pra subir ele encolhe, e
    // aí precisa começar em GRÃO e ir a zero. A modulação SOMA ao valor base
    // do parâmetro — sem esse valor base, subir o tom pediria atraso
    // negativo, que o navegador corta em zero: o efeito simplesmente não
    // acontecia, e a "voz aguda" saía igual à voz normal.
    const subindo = razao > 1;
    delay.delayTime.value = subindo ? GRAO : 0;
    escala.gain.value = subindo ? -GRAO : GRAO;
    varredura.connect(escala).connect(delay.delayTime);

    const envelope = ctx.createBufferSource();
    envelope.buffer = fade;
    envelope.loop = true;
    envelope.connect(ganho.gain);

    entrada.connect(delay).connect(ganho).connect(saida);

    const t0 = ctx.currentTime + atrasoInicial;
    varredura.start(t0);
    envelope.start(t0);
    fontes.push(varredura, envelope);
  }

  return {
    entrada,
    saida,
    parar() {
      for (const f of fontes) { try { f.stop(); } catch {} }
    },
  };
}

export class Voz {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.destino = this.ctx.createMediaStreamDestination();
    this.origem = null;      // MediaStreamAudioSourceNode do microfone
    this.cadeia = [];        // nós do efeito atual, pra desmontar depois
    this.efeito = "normal";
  }

  /** O stream que sai daqui — é sempre o mesmo objeto, mesmo trocando de
   *  efeito. Assim ninguém precisa renegociar a conexão pra trocar de voz. */
  get stream() {
    return this.destino.stream;
  }

  /** Liga o microfone cru na entrada. */
  conectar(micStream) {
    this.desmontar();
    try { this.origem?.disconnect(); } catch {}
    this.origem = this.ctx.createMediaStreamSource(micStream);
    this.aplicar(this.efeito);
    // A política de autoplay pode deixar o contexto suspenso até um clique.
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  desmontar() {
    for (const no of this.cadeia) {
      try { no.parar ? no.parar() : no.disconnect(); } catch {}
    }
    this.cadeia = [];
    try { this.origem?.disconnect(); } catch {}
  }

  aplicar(id) {
    this.efeito = id;
    if (!this.origem) return;
    this.desmontar();

    const ctx = this.ctx;
    const nos = [];
    // `ponta` vai andando: cada efeito pendura o próximo nó no anterior.
    let ponta = this.origem;
    const liga = (no) => { ponta.connect(no); nos.push(no); ponta = no; return no; };

    const comPitch = (semitons) => {
      const ps = pitchShift(ctx, semitons);
      ponta.connect(ps.entrada);
      nos.push(ps);
      ponta = ps.saida;
    };

    switch (id) {
      case "grave":
        comPitch(-5);
        break;

      case "monstro": {
        comPitch(-9);
        const dist = ctx.createWaveShaper();
        dist.curve = curvaDistorcao(8);
        liga(dist);
        const grave = ctx.createBiquadFilter();
        grave.type = "lowpass";
        grave.frequency.value = 2200;
        liga(grave);
        break;
      }

      case "agudo":
        comPitch(5);
        break;

      case "esquilo":
        comPitch(9);
        break;

      case "robo": {
        // Modulação em anel: multiplica a voz por um tom fixo.
        const anel = ctx.createGain();
        anel.gain.value = 0;               // só o oscilador controla o ganho
        const osc = ctx.createOscillator();
        osc.frequency.value = 50;
        osc.connect(anel.gain);
        osc.start();
        ponta.connect(anel);
        nos.push(anel, { parar: () => { try { osc.stop(); } catch {} } });
        ponta = anel;
        break;
      }

      case "radio": {
        const banda = ctx.createBiquadFilter();
        banda.type = "bandpass";
        banda.frequency.value = 1400;
        banda.Q.value = 3;
        liga(banda);
        const dist = ctx.createWaveShaper();
        dist.curve = curvaDistorcao(15);
        liga(dist);
        break;
      }

      case "caverna": {
        const delay = ctx.createDelay(1);
        delay.delayTime.value = 0.16;
        const realim = ctx.createGain();
        realim.gain.value = 0.45;
        const seco = ctx.createGain();
        ponta.connect(seco);
        ponta.connect(delay);
        delay.connect(realim).connect(delay);   // eco que se repete
        const soma = ctx.createGain();
        seco.connect(soma);
        delay.connect(soma);
        nos.push(delay, realim, seco, soma);
        ponta = soma;
        break;
      }

      default: // "normal": segue direto
        break;
    }

    // Um ganho no fim segura o volume de efeitos que somam sinal (caverna).
    const saida = ctx.createGain();
    saida.gain.value = id === "caverna" ? 0.7 : 1;
    ponta.connect(saida);
    saida.connect(this.destino);
    nos.push(saida);

    this.cadeia = nos;
  }

  parar() {
    this.desmontar();
    try { this.ctx.close(); } catch {}
  }
}
