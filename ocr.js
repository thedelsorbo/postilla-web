// Riconoscimento del testo (OCR) sulle pagine scansionate, sul dispositivo e senza internet.
// Il PDF originale non viene mai modificato: le parole riconosciute finiscono in un indice separato,
// legato all'impronta SHA-256 del file, con la posizione di ogni parola nelle coordinate del PDF.
import Tesseract from './node_modules/tesseract.js/dist/tesseract.esm.min.js';
import * as pdfjs from './node_modules/pdfjs-dist/build/pdf.min.mjs';

export const ENGINE = 'tesseract.js 7.0.0 / tessdata_fast ita+eng';
export const INDEX_VERSION = 1;
import { MIN_NATIVE_CHARS } from './text.js';

export { LOW_CONF, MIN_NATIVE_CHARS } from './text.js';

const { createWorker, OEM, PSM } = Tesseract;

const ORIGIN = location.origin;
const LANG_PATH = new URL('./ocr/lang', import.meta.url).href;
const MAX_PX = window.POSTILLA_LIMITS?.ocrPx ?? 3000; // lato lungo dell'immagine da riconoscere
const DPI = 300;

let workerP = null;
let logger = null;
let generation = 0; // cresce a ogni annullamento: le pagine in corso capiscono che devono fermarsi

function getWorker() {
  if (!workerP) {
    workerP = createWorker(['ita', 'eng'], OEM.LSTM_ONLY, {
      workerPath: `${new URL('./node_modules/', import.meta.url).href}tesseract.js/dist/worker.min.js`,
      corePath: `${new URL('./node_modules/', import.meta.url).href}tesseract.js-core/`,
      langPath: LANG_PATH,
      gzip: false,
      cacheMethod: 'none',
      workerBlobURL: false,
      logger: (m) => logger?.(m),
    }).then(async (w) => { await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1', debug_file: '/dev/null' }); return w; });
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

// Ferma subito il lavoro in corso: il motore viene chiuso e ricreato alla prossima richiesta.
export async function stopEngine() {
  const p = workerP;
  workerP = null;
  generation += 1;
  if (p) { try { (await p).terminate(); } catch { /* già chiuso */ } }
}

async function renderPage(view, i) {
  const pg = await view.getPage(i);
  const base = pg.getViewport({ scale: 1 });
  let scale = DPI / 72;
  const longest = Math.max(base.width, base.height) * scale;
  if (longest > MAX_PX) scale *= MAX_PX / longest;
  const vp = pg.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  // willReadFrequently: l'immagine resta nella memoria normale invece che in quella della scheda video.
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#fff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  await pg.render({ canvas, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  return { canvas, vp };
}

// Ruota l'immagine di 0, 90, 180 o 270 gradi in senso orario.
function rotated(src, angle) {
  if (!angle) return src;
  const W = src.width; const H = src.height;
  const out = document.createElement('canvas');
  out.width = angle === 180 ? W : H;
  out.height = angle === 180 ? H : W;
  const c = out.getContext('2d', { willReadFrequently: true });
  if (angle === 90) { c.translate(H, 0); c.rotate(Math.PI / 2); } else if (angle === 180) { c.translate(W, H); c.rotate(Math.PI); } else { c.translate(0, W); c.rotate(-Math.PI / 2); }
  c.drawImage(src, 0, 0);
  return out;
}

// Riporta un punto dell'immagine ruotata all'immagine originale.
function unrotate(angle, W, H, x, y) {
  if (angle === 90) return [y, H - x];
  if (angle === 180) return [W - x, H - y];
  if (angle === 270) return [W - y, x];
  return [x, y];
}

function shrink(src, longest) {
  const k = Math.min(1, longest / Math.max(src.width, src.height));
  const out = document.createElement('canvas');
  out.width = Math.round(src.width * k);
  out.height = Math.round(src.height * k);
  out.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, out.width, out.height);
  return out;
}

// Pulizia per le scansioni sporche: scala di grigi e filtro mediano 3x3, che toglie puntini e granulosità
// senza cancellare le lettere. Si usa solo quando la prima lettura è incerta.
function denoise(src) {
  const W = src.width; const H = src.height;
  const c = src.getContext('2d', { willReadFrequently: true });
  const img = c.getImageData(0, 0, W, H);
  const d = img.data;
  const g = new Uint8Array(W * H);
  for (let i = 0, j = 0; j < g.length; i += 4, j += 1) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  const out = new Uint8Array(g);
  const v = new Uint8Array(9);
  const sw = (a, b) => { if (v[a] > v[b]) { const t = v[a]; v[a] = v[b]; v[b] = t; } };
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      const p = y * W + x;
      v[0] = g[p - W - 1]; v[1] = g[p - W]; v[2] = g[p - W + 1]; v[3] = g[p - 1]; v[4] = g[p]; v[5] = g[p + 1]; v[6] = g[p + W - 1]; v[7] = g[p + W]; v[8] = g[p + W + 1];
      // rete di confronti che trova la mediana di 9 valori
      sw(1, 2); sw(4, 5); sw(7, 8); sw(0, 1); sw(3, 4); sw(6, 7); sw(1, 2); sw(4, 5); sw(7, 8);
      sw(0, 3); sw(5, 8); sw(4, 7); sw(3, 6); sw(1, 4); sw(2, 5); sw(4, 7); sw(4, 2); sw(6, 4); sw(4, 2);
      out[p] = v[4];
    }
  }
  const res = document.createElement('canvas');
  res.width = W; res.height = H;
  const rc = res.getContext('2d', { willReadFrequently: true });
  const o = rc.createImageData(W, H);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 1) { o.data[i] = o.data[i + 1] = o.data[i + 2] = out[j]; o.data[i + 3] = 255; }
  rc.putImageData(o, 0, 0);
  return res;
}

const score = (d) => (d.confidence || 0) * Math.min(1, (d.text || '').replace(/\s/g, '').length / 80);

// Trova l'orientamento giusto provando le quattro rotazioni su un'immagine ridotta.
async function orientation(rec, canvas) {
  // Immagine ridotta e ripulita: il rumore delle scansioni sporche non deve ingannare la scelta.
  const reduced = shrink(canvas, 1000);
  const small = denoise(reduced);
  reduced.width = 0;
  let best = { angle: 0, s: -1 };
  for (const angle of [0, 90, 180, 270]) {
    const img = rotated(small, angle);
    const { data } = await rec(img, { text: true });
    if (img !== small) img.width = 0;
    const s = score(data);
    if (s > best.s) best = { angle, s };
  }
  small.width = 0;
  return best.angle;
}

const RECOGNIZE_OUT = { blocks: true, text: true };

// Riconosce una pagina. Restituisce parole con fiducia e posizione nel PDF (quadrilatero come nel testo vero).
export async function recognizePage(view, i, onLog) {
  logger = onLog;
  const gen = generation;
  const tStart = performance.now();
  const worker = await getWorker();
  // Dopo un annullamento il motore è chiuso: nessuna nuova richiesta gli viene più inviata.
  const rec = (img, out) => { if (gen !== generation) throw new Error('OCR annullato'); return worker.recognize(img, {}, out); };
  const t0 = performance.now(); // il tempo per pagina non comprende l'avvio del motore
  const { canvas, vp } = await renderPage(view, i);
  const W = canvas.width; const H = canvas.height;
  let angle = 0;
  let cleaned = false;
  let img = canvas; // immagine effettivamente letta (eventualmente girata)
  // Le pagine leggermente storte vengono gestite dall'analisi della pagina di Tesseract stesso.
  let { data } = await rec(img, RECOGNIZE_OUT);
  const words0 = (data.text || '').trim().split(/\s+/).filter(Boolean).length;
  // Lettura quasi vuota o molto incerta: forse il foglio è girato. Si tiene la rotazione solo se legge meglio.
  if ((data.confidence || 0) < 65 || words0 < 8) {
    const a = await orientation(rec, canvas);
    if (a) {
      const im = rotated(canvas, a);
      const d2 = (await rec(im, RECOGNIZE_OUT)).data;
      if (score(d2) > score(data)) { angle = a; img = im; data = d2; } else im.width = 0;
    }
  }
  // Lettura incerta o quasi vuota (scansione sporca): si riprova sull'immagine ripulita e si tiene la migliore.
  // Una lettura senza parole può avere "fiducia" alta: per questo conta anche il numero di parole.
  const wordsNow = (data.text || '').trim().split(/\s+/).filter(Boolean).length;
  if ((data.confidence || 0) < 88 || wordsNow < 8) {
    const clean = denoise(img);
    const second = (await rec(clean, RECOGNIZE_OUT)).data;
    if (score(second) > score(data)) { data = second; cleaned = true; }
    clean.width = 0;
  }
  if (img !== canvas) img.width = 0;
  const toPdf = (x, y) => {
    const [ox, oy] = unrotate(angle, W, H, x, y);
    return vp.convertToPdfPoint(ox, oy).map((v) => Math.round(v * 100) / 100);
  };
  const words = [];
  let line = 0;
  for (const b of data.blocks || []) {
    for (const par of b.paragraphs || []) {
      for (const ln of par.lines || []) {
        for (const w of ln.words || []) {
          const str = (w.text || '').trim();
          if (!str) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          words.push({ s: str, c: Math.round(w.confidence), l: line, q: [...toPdf(x0, y0), ...toPdf(x1, y0), ...toPdf(x0, y1), ...toPdf(x1, y1)] });
        }
        line += 1;
      }
      line += 1; // fine paragrafo
    }
  }
  canvas.width = 0; // libera subito la memoria dell'immagine
  return { angle, cleaned, conf: Math.round(data.confidence || 0), ms: Math.round(performance.now() - t0), startMs: Math.round(t0 - tStart), words };
}

// Parole del testo vero della pagina: se sono troppo poche, la pagina è una scansione.
export async function nativeChars(view, i) {
  const pg = await view.getPage(i);
  const content = await pg.getTextContent();
  return content.items.reduce((n, it) => n + (it.str ? it.str.replace(/\s/g, '').length : 0), 0);
}

// Una pagina è una scansione se ha pochissimo testo vero E contiene un'immagine.
// Una pagina quasi vuota ma senza immagini (copertina, indice breve, pagina bianca) non va riconosciuta.
const IMAGE_OPS = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintInlineImageXObjectGroup].filter((x) => x != null));

export async function isScannedPage(view, i) {
  if ((await nativeChars(view, i)) >= MIN_NATIVE_CHARS) return false;
  const pg = await view.getPage(i);
  const ops = await pg.getOperatorList();
  return ops.fnArray.some((f) => IMAGE_OPS.has(f));
}

export async function pagesNeedingOcr(view, cancelled = () => false) {
  const out = [];
  for (let i = 0; i < view.pages.length; i += 1) {
    if (cancelled()) break;
    if (await isScannedPage(view, i)) out.push(i);
  }
  return out;
}
