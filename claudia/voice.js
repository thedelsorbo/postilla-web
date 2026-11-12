// Claudia: comandi a voce con un pulsante da tenere premuto. Il microfono è acceso solo mentre il pulsante
// è premuto; l'audio resta in memoria, viene trascritto e poi scartato. Nessun ascolto nascosto.
// Windows: trascrizione sul PC con whisper.cpp (processo principale). Android: riconoscitore del tablet.

const RATE = 16000;
const MAX_SECONDS = 20;
// Frasi che i modelli di trascrizione "inventano" sul rumore o sul silenzio: non sono comandi.
// Anche le annotazioni fra parentesi («[musica]», «(applausi)») non sono parole pronunciate.
export const HALLUCINATIONS = /sottotitoli|amara\.org|grazie per la visione|iscriviti al canale|thanks for watching|^\W*$|^\s*[[(].*[\])]\s*[.!]?\s*$/i;

export function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return buf;
}

export class Voice {
  constructor({ onLevel = () => {}, onState = () => {} } = {}) {
    this.onLevel = onLevel;
    this.onState = onState;
    this.state = 'idle'; // idle | listening | transcribing
    this.native = !!window.PostillaNative?.voiceStart;
    this.gen = 0;
  }

  async available() {
    if (this.native) return window.PostillaNative.voiceAvailable();
    return !!navigator.mediaDevices?.getUserMedia && (await host.voiceAvailable?.());
  }

  engine() { return this.native ? 'riconoscitore vocale del tablet (sul dispositivo, se la lingua italiana è scaricata)' : 'whisper.cpp sul PC, modello «small» (più preciso in italiano)'; }

  set(s) { this.state = s; this.onState(s); }

  async start() {
    if (this.state !== 'idle') await this.cancel();
    this.gen += 1;
    if (this.native) {
      this.set('listening');
      this.nativeResult = new Promise((resolve) => { window.__pnVoice = (json) => resolve(JSON.parse(json)); });
      window.PostillaNative.voiceStart();
      return;
    }
    // Il contesto audio e il modulo di cattura restano pronti fra un comando e l'altro (senza microfono acceso):
    // così, premuto il pulsante, si ascolta subito e la prima parola non va persa.
    const micReady = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: RATE });
      this.moduleReady = this.ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
    }
    await this.moduleReady;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stream = await micReady;
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.src = src;
    this.node = new AudioWorkletNode(this.ctx, 'postilla-mic');
    this.chunks = [];
    this.peak = 0;
    this.loud = 0; // campioni sopra la soglia della voce
    this.node.port.onmessage = (e) => {
      const c = e.data;
      this.chunks.push(c);
      let sum = 0;
      for (let i = 0; i < c.length; i += 1) sum += c[i] * c[i];
      const rms = Math.sqrt(sum / c.length);
      this.peak = Math.max(this.peak, rms);
      if (rms > 0.02) this.loud += c.length;
      this.onLevel(Math.min(1, rms * 8));
      if (this.chunks.length * c.length > MAX_SECONDS * RATE) this.stop();
    };
    src.connect(this.node);
    this.set('listening');
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop()); // il microfono si spegne qui
    this.stream = null;
    try { this.src?.disconnect(); this.node?.disconnect(); } catch { /* già scollegati */ }
    if (this.node) this.node.port.onmessage = null;
    this.src = null; this.node = null;
    this.ctx?.suspend().catch(() => {});
    this.onLevel(0);
  }

  // Fine dell'ascolto: restituisce la trascrizione { text, words, confident, ms } oppure un motivo di scarto.
  async stop(opts = {}) {
    if (this.state !== 'listening') return null;
    const gen = this.gen;
    this.set('transcribing');
    try {
      if (this.native) {
        window.PostillaNative.voiceStop();
        const r = await this.nativeResult;
        if (gen !== this.gen) return null;
        if (r.error) return { discarded: r.error === 'no-match' || r.error === 'timeout' ? 'silenzio' : 'errore', error: r.error };
        return this.judge({ text: r.text || '', words: (r.text || '').split(/\s+/).map((t) => ({ text: t, p: r.confidence ?? 0.7 })), ms: r.ms || 0 });
      }
      const n = this.chunks.reduce((s, c) => s + c.length, 0);
      const all = new Float32Array(n);
      let o = 0;
      for (const c of this.chunks) { all.set(c, o); o += c.length; }
      const seconds = n / RATE;
      const voiced = this.loud / RATE;
      this.release();
      this.chunks = [];
      if (seconds < 0.3 || this.peak < 0.015 || voiced < 0.15) return { discarded: 'silenzio', seconds };
      const r = await host.voiceTranscribe(encodeWav(all), opts.prompt ? { prompt: opts.prompt } : {});
      if (gen !== this.gen) return null; // nel frattempo è arrivato un altro comando
      return this.judge(r);
    } catch (e) {
      if (gen !== this.gen) return null;
      return { discarded: 'errore', error: String(e.message || e) };
    } finally {
      if (gen === this.gen) this.set('idle');
    }
  }

  // Trascrizione affidabile? Se è incerta si chiede conferma; se è vuota o "inventata" si scarta.
  judge(r) {
    const text = (r.text || '').trim();
    if (!text || HALLUCINATIONS.test(text)) return { discarded: 'incomprensibile', text, ms: r.ms };
    const ws = (r.words || []).filter((w) => /\p{L}|\d/u.test(w.text));
    const mean = ws.length ? ws.reduce((s, w) => s + w.p, 0) / ws.length : 0;
    const weak = ws.filter((w) => w.text.trim().length > 3 && w.p < 0.2).map((w) => w.text.trim());
    return { text, ms: r.ms, mean: Math.round(mean * 100) / 100, weak, confident: mean >= 0.45 && !weak.length };
  }

  async cancel() {
    this.gen += 1;
    if (this.native) window.PostillaNative.voiceStop();
    else { this.release(); host.voiceCancel?.(); }
    this.set('idle');
  }
}
