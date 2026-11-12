// Theresa: chiamata a voce. Con l'interruttore acceso il microfono resta in ascolto mentre Postilla è in primo piano;
// quando qualcuno parla, Postilla trascrive sul dispositivo solo l'inizio della frase per sapere se comincia con
// «Theresa». Se sì, esegue il comando; se no, l'audio e il testo vengono scartati subito. Niente esce dal dispositivo.
// Si ferma da solo quando Postilla va in secondo piano e resta in pausa mentre Theresa legge ad alta voce.
import { encodeWav, HALLUCINATIONS } from './voice.js';

const RATE = 16000;
const NAME = /^\W*(?:ehi|ok|ciao|hey)?[\s,]*(?:theresa|teresa|tereza|terresa|teresia|therese|thérèse|tresa)\b[\s,.:;!?-]*(.*)$/i;
const PRE_ROLL = 0.45; // secondi prima dell'inizio della voce, per non perdere la prima sillaba
const END_SILENCE = 0.7;
const MAX_SEGMENT = 10;
const HEAD = 1.8; // secondi trascritti per controllare il nome
const SHORT_EXTRA = 1.7; // frasi fino a HEAD + PRE_ROLL + questo: trascritte in una volta sola
const ATTENTIVE = 7; // secondi di attesa del comando dopo «Theresa» da sola

export const wakeMatch = (text) => { const m = String(text || '').trim().match(NAME); return m ? { rest: m[1].trim() } : null; };

// Distanza fra due parole (numero di lettere da cambiare).
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Il nome detto da solo è difficile da trascrivere («Timesa», «Teressa»): se la frase è una sola parola molto simile
// a «Teresa», vale come chiamata. Mai dentro frasi più lunghe, per non scambiare altre parole per il nome.
export const lonelyName = (text) => {
  const words = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length === 1 && words[0].length >= 5 && words[0].length <= 8 && lev(words[0].replace(/^th/, 't'), 'teresa') <= 2;
};

export class WakeListener {
  constructor({ onCommand, onState = () => {}, isBusy = () => false }) {
    this.onCommand = onCommand;
    this.onState = onState;
    this.isBusy = isBusy; // per esempio mentre Theresa legge ad alta voce o si tiene premuto il pulsante
    this.native = !!window.PostillaNative?.voiceStart;
    this.enabled = false;
    this.state = 'off'; // off | listening | attentive | checking | paused
    this.stats = { segments: 0, checked: 0, wakes: 0 };
    this.focusOn = () => this.resume();
    this.focusOff = () => this.suspend();
  }

  set(s) { if (this.state !== s) { this.state = s; this.onState(s); } }

  async enable(on) {
    this.enabled = !!on;
    if (on) {
      window.addEventListener('focus', this.focusOn);
      window.addEventListener('blur', this.focusOff);
      document.addEventListener('visibilitychange', this.vis = () => (document.hidden ? this.suspend() : this.resume()));
      if (document.hasFocus() || !document.hidden) await this.open();
    } else {
      window.removeEventListener('focus', this.focusOn);
      window.removeEventListener('blur', this.focusOff);
      if (this.vis) document.removeEventListener('visibilitychange', this.vis);
      this.close();
      this.set('off');
    }
  }

  async resume() { if (this.enabled && !this.stream && !this.nativeLoop) await this.open(); }

  suspend() { if (this.enabled) { this.close(); this.set('paused'); } }

  // Un'apertura alla volta: accensione e ripresa possono arrivare insieme (0.9.1).
  open() {
    if (!this.opening) this.opening = this.openNow().finally(() => { this.opening = null; });
    return this.opening;
  }

  async openNow() {
    if (this.native) { this.nativeLoop = true; this.set('listening'); this.loopNative(); return; }
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { this.enabled = false; this.set('off'); this.onState('error', String(e.message || e)); return; }
    const ctx = new AudioContext({ sampleRate: RATE });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
    // Chiusa o sostituita nel frattempo (ascolto spento mentre si apriva): non si crea il nodo.
    if (this.ctx !== ctx || ctx.state === 'closed' || !this.stream) { try { ctx.close(); } catch { /* già chiusa */ } return; }
    this.node = new AudioWorkletNode(ctx, 'postilla-mic');
    this.ctx.createMediaStreamSource(this.stream).connect(this.node);
    this.ring = []; this.ringLen = 0; // ultimi istanti, per il pre-ascolto
    this.seg = null; this.floor = 0.006; this.speechRun = 0; this.silence = 0;
    this.node.port.onmessage = (e) => this.frame(e.data);
    this.set(this.attentiveUntil > performance.now() ? 'attentive' : 'listening');
  }

  close() {
    this.nativeLoop = false;
    if (this.native) { try { window.PostillaNative.voiceStop(); } catch { /* già fermo */ } }
    this.stream?.getTracks().forEach((t) => t.stop()); // qui il microfono si spegne
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.seg = null;
  }

  // Rilevamento della voce: soglia adattata al rumore di fondo.
  frame(c) {
    let sum = 0;
    for (let i = 0; i < c.length; i += 1) sum += c[i] * c[i];
    const rms = Math.sqrt(sum / c.length);
    const dt = c.length / RATE;
    const busy = this.isBusy();
    const speech = rms > Math.max(0.012, this.floor * 3.2);
    if (!speech) this.floor = this.floor * 0.995 + rms * 0.005;
    if (busy) { this.seg = null; this.speechRun = 0; this.ring = []; this.ringLen = 0; return; }
    if (!this.seg) {
      this.ring.push(c); this.ringLen += c.length;
      while (this.ringLen - this.ring[0].length > PRE_ROLL * RATE) this.ringLen -= this.ring.shift().length;
      this.speechRun = speech ? this.speechRun + dt : 0;
      if (this.speechRun >= 0.12) { this.seg = { chunks: [...this.ring], len: this.ringLen, voiced: this.speechRun }; this.ring = []; this.ringLen = 0; this.silence = 0; }
      if (this.state === 'attentive' && performance.now() > this.attentiveUntil) this.set('listening');
      return;
    }
    this.seg.chunks.push(c); this.seg.len += c.length;
    if (speech) { this.seg.voiced += dt; this.silence = 0; } else this.silence += dt;
    if (this.silence >= END_SILENCE || this.seg.len >= MAX_SEGMENT * RATE) { const s = this.seg; this.seg = null; this.speechRun = 0; this.handle(s); }
  }

  join(chunks, max = Infinity) {
    const n = Math.min(max, chunks.reduce((t, c) => t + c.length, 0));
    const out = new Float32Array(n); let o = 0;
    for (const c of chunks) { if (o >= n) break; out.set(c.subarray(0, n - o), o); o += Math.min(c.length, n - o); }
    return out;
  }

  async transcribe(samples, prompt) {
    const r = await host.voiceTranscribe(encodeWav(samples), { ...(prompt ? { prompt } : {}), fast: true });
    const text = (r?.text || '').trim();
    return HALLUCINATIONS.test(text) ? '' : text;
  }

  async handle(seg) {
    if (seg.voiced < 0.3 || this.checking) return; // troppo breve, oppure c'è già una frase in esame
    this.checking = true;
    this.stats.segments += 1;
    const attentive = this.attentiveUntil > performance.now();
    const prev = this.state;
    this.set('checking');
    try {
      const all = this.join(seg.chunks);
      if (attentive) {
        // Dopo «Theresa» da sola: la frase successiva è il comando, anche senza nome.
        const text = await this.transcribe(all);
        this.attentiveUntil = 0;
        if (text) { this.stats.wakes += 1; this.onCommand(wakeMatch(text) ? text : `Theresa, ${text}`, { wake: true }); }
        return;
      }
      // Prima solo l'inizio della frase: basta per sapere se comincia con il nome.
      this.stats.checked += 1;
      // Frase breve (fino a ~4 secondi): una sola trascrizione, così il comando parte prima.
      const short = all.length <= Math.round((HEAD + PRE_ROLL + SHORT_EXTRA) * RATE);
      const headLen = short ? all.length : Math.min(all.length, Math.round((HEAD + PRE_ROLL) * RATE));
      const head = await this.transcribe(all.subarray(0, headLen), 'Theresa. Theresa, apri il documento.');
      if (!wakeMatch(head) && !lonelyName(head)) return; // non era per Theresa: si scarta
      if (lonelyName(head) && all.length <= headLen) { this.stats.wakes += 1; this.attentiveUntil = performance.now() + ATTENTIVE * 1000; this.onState('called'); return; }
      this.stats.wakes += 1;
      const text = all.length > headLen ? await this.transcribe(all) : head;
      const m = wakeMatch(text) || wakeMatch(head);
      if (m && m.rest.split(/\s+/).filter(Boolean).length >= 1 && !/^(?:sei lì|ci sei|ascolta|ascoltami)\b/i.test(m.rest)) this.onCommand(text, { wake: true });
      else { this.attentiveUntil = performance.now() + ATTENTIVE * 1000; this.onState('called'); }
    } catch (e) {
      console.warn('Chiamata a voce: trascrizione non riuscita', e);
    } finally {
      this.checking = false;
      if (this.enabled && this.state === 'checking') this.set(this.attentiveUntil > performance.now() ? 'attentive' : (prev === 'paused' ? 'paused' : 'listening'));
    }
  }

  // Tablet: il riconoscitore di Android non ascolta in continuo; si riavvia dopo ogni frase.
  async loopNative() {
    while (this.nativeLoop && this.enabled) {
      if (this.isBusy()) { await new Promise((r) => setTimeout(r, 400)); continue; }
      const res = await new Promise((resolve) => { window.__pnVoice = (json) => resolve(JSON.parse(json)); window.PostillaNative.voiceStart(); });
      if (!this.nativeLoop) break;
      const text = (res?.text || '').trim();
      const attentive = this.attentiveUntil > performance.now();
      if (text && attentive) { this.attentiveUntil = 0; this.onCommand(wakeMatch(text) ? text : `Theresa, ${text}`, { wake: true }); } else if (text && wakeMatch(text)) {
        if (wakeMatch(text).rest) this.onCommand(text, { wake: true }); else { this.attentiveUntil = performance.now() + ATTENTIVE * 1000; this.onState('called'); }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
