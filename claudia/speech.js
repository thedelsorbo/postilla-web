// Claudia: lettura ad alta voce con le voci installate sul dispositivo (nessun servizio esterno).
// Windows: sintesi vocale di sistema (voci Elsa, Cosimo, Zira…); Android: TextToSpeech tramite l'app.
// La lettura procede a frasi: "pausa" ferma alla frase in corso, "riprendi" riparte da lì, "fermati" chiude.

const sentences = (t) => (t.match(/[^.;:!?]+[.;:!?]*(?:\s+|$)/g) || [t]).map((s) => s.trim()).filter(Boolean);

export const FEMALE = /\b(elsa|isabella|paola|alice|federica|giorgia|carla|chiara|bianca|fiamma|elena|irene|zira|aria|jenny|hazel|susan|libby|sonia|ava|emma|michelle|samantha|female|donna)\b/i;
export const MALE = /\b(cosimo|diego|giuseppe|benigno|calimero|cataldo|gianni|lisandro|rinaldo|luca|david|mark|guy|george|ryan|james|christopher|eric|male|uomo)\b/i;

export class Speaker {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.state = 'idle'; // idle | speaking | paused
    this.queue = [];
    this.index = 0;
    this.lang = 'it';
    this.gen = 0;
    if (window.PostillaNative?.ttsSpeak) {
      this.native = true;
      window.__pnTts = (id, ev) => this.nativeEvent(id, ev);
    }
  }

  get mock() { return Array.isArray(window.POSTILLA_TTS_MOCK) ? window.POSTILLA_TTS_MOCK : null; }

  set(state) { this.state = state; this.onChange(state, this); }

  // Theresa ha una voce femminile: fra le voci installate si preferiscono quelle femminili note
  // (Windows: Elsa, Isabella per l'italiano; Zira, Aria, Jenny, Hazel… per l'inglese) e si evitano quelle maschili note.
  voiceFor(lang) {
    const vs = window.speechSynthesis?.getVoices() || [];
    const want = lang === 'en' ? /^en/i : /^it/i;
    const all = vs.filter((v) => want.test(v.lang));
    const pick = (list) => list.find((v) => v.localService) || list[0] || null;
    return pick(all.filter((v) => FEMALE.test(v.name))) || pick(all.filter((v) => !MALE.test(v.name))) || pick(all);
  }

  speak(text, lang) {
    this.stop();
    this.queue = sentences(text);
    this.index = 0;
    this.lang = lang || 'it';
    this.set('speaking');
    this.next();
  }

  next() {
    if (this.state !== 'speaking') return;
    if (this.index >= this.queue.length) { this.set('idle'); return; }
    const gen = this.gen;
    const part = this.queue[this.index];
    const done = () => { if (gen !== this.gen || this.state !== 'speaking') return; this.index += 1; this.next(); };
    if (this.mock) { this.mock.push({ text: part, lang: this.lang }); setTimeout(done, 30); return; }
    if (this.native) { this.pendingDone = done; window.PostillaNative.ttsSpeak(`t${gen}-${this.index}`, part, this.lang); return; }
    const u = new SpeechSynthesisUtterance(part);
    u.lang = this.lang === 'en' ? 'en-US' : 'it-IT';
    const v = this.voiceFor(this.lang);
    if (v) u.voice = v;
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  }

  nativeEvent(_id, ev) { if (ev === 'done' && this.pendingDone) { const d = this.pendingDone; this.pendingDone = null; d(); } }

  halt() {
    this.gen += 1;
    if (this.mock) return;
    if (this.native) window.PostillaNative.ttsStop();
    else window.speechSynthesis?.cancel();
  }

  pause() { if (this.state !== 'speaking') return false; this.halt(); this.set('paused'); return true; }

  resume() { if (this.state !== 'paused') return false; this.set('speaking'); this.next(); return true; }

  stop() { const was = this.state !== 'idle'; this.halt(); this.queue = []; this.index = 0; if (this.state !== 'idle') this.set('idle'); return was; }

  // Voci disponibili sul dispositivo (per l'informazione nel pannello).
  static voices() { return (window.speechSynthesis?.getVoices() || []).filter((v) => /^(it|en)/i.test(v.lang)).map((v) => `${v.name} (${v.lang}${v.localService ? ', sul dispositivo' : ''})`); }
}
