// Scrittura a penna → testo stampato, in automatico.
// Quando si smette di scrivere per un attimo, i tratti appena fatti vengono letti dal riconoscitore
// del sistema (Windows: grafia di Windows; Android: ML Kit sul tablet) e sostituiti da un testo
// nello stesso punto, con lo stesso colore e una grandezza simile. «Annulla» riporta la scrittura a mano.
// Segni che non sono parole (righe, frecce, cerchi, spunte, una lettera sola) restano come sono.
import { toast, uid } from './core.js';
import { toDisp, toUser } from './annots.js';

const PAUSE = 1500; // millisecondi di pausa dopo l'ultimo tratto
const measure = document.createElement('canvas').getContext('2d');

// Un tratto solo e quasi dritto: sottolineatura, barra, freccia semplice.
function straight(pts) {
  if (pts.length < 2) return true;
  let len = 0;
  for (let i = 1; i < pts.length; i += 1) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const d = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]);
  return d > 0 && len / d < 1.15;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// Parole riconosciute (riquadri in coordinate di pagina) → righe di testo, dall'alto in basso.
export function layoutWords(words) {
  const ws = words.filter((w) => String(w.text || '').trim()).map((w) => ({ ...w, text: String(w.text).trim(), cy: w.y + w.h / 2 }));
  if (!ws.length) return null;
  const mh = median(ws.map((w) => w.h)) || 10;
  ws.sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const w of ws) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(w.cy - last.cy) < mh * 0.6) { last.words.push(w); last.cy = (last.cy * (last.words.length - 1) + w.cy) / last.words.length; } else lines.push({ cy: w.cy, words: [w] });
  }
  const text = lines.map((l) => l.words.sort((a, b) => a.x - b.x).map((w) => w.text).join(' ')).join('\n');
  const x0 = Math.min(...ws.map((w) => w.x)); const y0 = Math.min(...ws.map((w) => w.y));
  const x1 = Math.max(...ws.map((w) => w.x + w.w)); const y1 = Math.max(...ws.map((w) => w.y + w.h));
  return { text, lines: lines.length, mh, box: [x0, y0, x1, y1] };
}

// Il risultato sembra scritto (almeno due lettere o cifre)? Altrimenti è un segno e resta a mano.
export function looksLikeWriting(text, strokes) {
  const chars = (String(text).match(/[\p{L}\p{N}]/gu) || []).length;
  if (chars < 2) return false;
  if (strokes.length === 1 && straight(strokes[0])) return false;
  return true;
}

export class InkText {
  constructor(app) {
    this.app = app;
    this.pending = []; // { view, a } tratti fatti dall'ultima trasformazione
    this.timer = 0;
    this.busy = 0;
    this.lang = (document.documentElement.lang || navigator.language || 'it').slice(0, 2);
  }

  enabled() { return this.app.prefs.inkText !== false && typeof host.inkRecognize === 'function'; }

  // Si comincia un tratto: si aspetta (la parola non è finita). Se è su un'altra pagina, si trasforma subito quello di prima.
  hold(view, p) {
    clearTimeout(this.timer);
    if (!this.enabled()) return;
    if (!this.warm) {
      this.warm = true;
      Promise.resolve(host.inkAvailable?.(this.lang)).then((r) => {
        if (r?.downloading) toast('Preparo la lettura della scrittura a mano: la prima volta si scarica il modello per la lingua (circa 20 MB, serve internet). Poi funziona anche senza rete.');
        else if (!r) { this.warm = false; if (!this.warnedOff) { this.warnedOff = true; toast('La scrittura a penna resta a mano: il riconoscimento della grafia non è disponibile su questo dispositivo.'); } }
      }).catch(() => { this.warm = false; });
    }
    const first = this.pending[0];
    if (first && (first.view !== view || first.a.page !== p.i)) this.flush();
  }

  added(view, a) {
    if (!this.enabled()) return;
    this.pending.push({ view, a });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), PAUSE);
  }

  // Per le prove: trasforma subito, senza aspettare la pausa.
  async flushNow() { clearTimeout(this.timer); return this.flush(); }

  async flush() {
    clearTimeout(this.timer);
    const batch = this.pending; this.pending = [];
    if (!batch.length) return null;
    const { view } = batch[0];
    const p = view.pages[batch[0].a.page];
    if (!p?.vp) return null;
    const inks = batch.map((b) => b.a);
    // Tratti in coordinate di pagina (y verso il basso), ingranditi come li vedeva chi scriveva.
    const k = view.s || 1;
    const strokes = inks.map((a) => a.pts.map(([x, y]) => toDisp(p, x, y)));
    this.busy += 1;
    let words = null;
    try { words = await host.inkRecognize(strokes.map((s) => s.map(([x, y]) => [x * k, y * k])), this.lang); } catch { words = null; } finally { this.busy -= 1; }
    if (!Array.isArray(words) || !words.length) return null;
    const lay = layoutWords(words.map((w) => ({ ...w, x: w.x / k, y: w.y / k, w: w.w / k, h: w.h / k })));
    if (!lay || !looksLikeWriting(lay.text, strokes)) return null;
    // Nel frattempo i tratti sono stati cancellati o annullati: non si tocca nulla.
    if (!inks.every((a) => view.annots.includes(a))) return null;
    const fontSize = Math.max(7, Math.min(40, Math.round(lay.mh * 0.8)));
    measure.font = `${fontSize}px Arial`;
    const textW = Math.max(...lay.text.split('\n').map((l) => measure.measureText(l).width));
    const [x0, y0] = lay.box;
    const w = Math.min(p.w - x0, Math.max(lay.box[2] - x0, textW + 6));
    const hgt = lay.lines * fontSize * 1.2 + fontSize * 0.4;
    const t = { id: uid(), type: 'text', page: p.i, color: inks[inks.length - 1].color, fontSize, text: lay.text, fromInk: true, a: toUser(p, x0, y0), b: toUser(p, x0 + w, y0 + hgt) };
    this.app.tools.apply(view, { remove: inks, add: [t] });
    this.app.syncToolbar?.();
    if (!this.app.prefs.inkTextHint) {
      this.app.prefs.inkTextHint = true;
      this.app.savePrefs();
      toast('La scrittura a penna è diventata testo. Per riavere la scrittura a mano: Annulla (Ctrl+Z). Per spegnere: Menu → Impostazioni.');
    }
    return t;
  }
}
