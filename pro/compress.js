// Compressione del PDF: immagini più leggere, oggetti inutili tolti, struttura compatta.
// Solo JavaScript (pdf-lib, fflate, canvas): funziona anche su Android. Il risultato è sempre una copia in memoria.
import { h, modal } from '../core.js';
import { listImages, decodeImage, analyzePixels, downscale, buildImageStream, registerImage, replaceImage } from './images.js';

const L = () => window.PDFLib;
const N = (s) => L().PDFName.of(s);

// Impostazioni dei tre livelli. density: byte per pixel oltre i quali un'immagine si ricomprime anche se non è grande.
export const LEVELS = {
  leggera: { maxSide: 2400, quality: 0.85, density: 1.2, label: 'Leggera', hint: 'Immagini quasi intatte, adatta alla stampa.' },
  media: { maxSide: 1600, quality: 0.72, density: 0.6, label: 'Media', hint: 'Buon equilibrio: si legge bene a schermo e in stampa.' },
  forte: { maxSide: 1100, quality: 0.6, density: 0.35, label: 'Forte', hint: 'File più piccolo possibile, per la posta e i portali.' },
};

const MIN_GAIN = 0.9; // si sostituisce solo se il nuovo è almeno il 10% più piccolo

const isStream = (o) => !!(o && o.dict instanceof L().PDFDict && o.contents);
const nameOf = (v) => (v instanceof L().PDFName ? v.decodeText() : null);

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

// Firma digitale: un dizionario /Sig (o /DocTimeStamp) con /Contents, oppure un campo /FT /Sig con un valore firmato.
export function hasSignature(doc) {
  const signed = (d) => d instanceof L().PDFDict && ['Sig', 'DocTimeStamp'].includes(nameOf(d.lookup(N('Type')))) && d.has(N('Contents'));
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof L().PDFDict)) continue;
    if (signed(obj)) return true;
    if (nameOf(obj.lookup(N('FT'))) === 'Sig') {
      const v = obj.lookup(N('V'));
      if (v instanceof L().PDFDict && (signed(v) || v.has(N('Contents')))) return true;
    }
  }
  return false;
}

// Tutto ciò che si raggiunge partendo dal trailer (Root, Info). Il resto si può togliere.
function reachable(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [];
  const { Root, Info } = ctx.trailerInfo;
  for (const r of [Root, Info]) if (r) stack.push(r);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof L().PDFRef) {
      const k = o.toString();
      if (seen.has(k)) continue;
      seen.add(k);
      const t = ctx.lookup(o);
      if (t) stack.push(t);
    } else if (o instanceof L().PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof L().PDFArray) {
      for (const v of o.asArray()) stack.push(v);
    } else if (isStream(o)) {
      stack.push(o.dict);
    }
  }
  return seen;
}

export function collectGarbage(doc) {
  const keep = reachable(doc);
  let removed = 0;
  for (const [ref] of doc.context.enumerateIndirectObjects()) {
    if (!keep.has(ref.toString())) { doc.context.delete(ref); removed += 1; }
  }
  return removed;
}

// Miniature delle pagine (/Thumb) e dati privati di altri programmi (/PieceInfo): non servono per leggere il documento.
// Le chiavi di Postilla (/PostillaData, /PostillaEdits, /PostillaLog, /PostillaAnnotated) restano dove sono.
function stripExtras(doc) {
  let n = 0;
  const del = (d, k) => { if (d.has(N(k))) { d.delete(N(k)); n += 1; } };
  del(doc.catalog, 'PieceInfo');
  for (const p of doc.getPages()) { del(p.node, 'Thumb'); del(p.node, 'PieceInfo'); }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (isStream(obj) && nameOf(obj.dict.lookup(N('Subtype'))) === 'Form') del(obj.dict, 'PieceInfo');
  }
  return n;
}

// Flussi salvati senza compressione (contenuti delle pagine, caratteri…): si comprimono con Flate.
function deflateRawStreams(doc) {
  let saved = 0;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!isStream(obj) || obj.dict.has(N('Filter')) || obj.contents.length < 512) continue;
    if (nameOf(obj.dict.lookup(N('Type'))) === 'Metadata') continue; // i metadati XML restano leggibili
    const z = window.fflate.zlibSync(obj.contents, { level: 9 });
    if (z.length >= obj.contents.length * MIN_GAIN) continue;
    const d = obj.dict.clone(doc.context);
    d.set(N('Filter'), N('FlateDecode'));
    d.delete(N('DecodeParms'));
    doc.context.assign(ref, L().PDFRawStream.of(d, z));
    saved += obj.contents.length - z.length;
  }
  return saved;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Ricomprime un'immagine se conviene. Restituisce true se è stata sostituita.
async function recompressImage(doc, it, cfg) {
  const img = await decodeImage(doc, it.ref);
  if (!img) return false;
  const big = Math.max(img.width, img.height) > cfg.maxSide;
  const smask = it.hasSMask ? doc.context.lookup(doc.context.lookup(it.ref).dict.get(N('SMask'))) : null;
  const oldBytes = it.bytes + (isStream(smask) ? smask.contents.length : 0);
  const dense = oldBytes / (img.width * img.height) > cfg.density;
  if (!big && !dense) return false;
  let { data, width, height } = img;
  if (big) {
    const k = cfg.maxSide / Math.max(width, height);
    const nw = Math.max(1, Math.round(width * k)); const nh = Math.max(1, Math.round(height * k));
    data = downscale(data, width, height, nw, nh);
    width = nw; height = nh;
  }
  const info = analyzePixels(data);
  // Trasparenza o grafica a pochi colori: sempre Flate (senza perdita), mai JPEG.
  const lossless = info.alpha || info.colors <= 256;
  const built = await buildImageStream(doc, data, width, height, lossless ? { format: 'flate', info } : { format: 'jpeg', quality: cfg.quality, info });
  if (built.bytes >= oldBytes * MIN_GAIN) return false;
  replaceImage(doc, it.ref, registerImage(doc, built));
  return true;
}

// compressPdf(bytes, { level, onProgress }) → { bytes, before, after, images: { total, recompressed, skipped }, removed }
// Errori: code = 'firmato' (PDF con firma digitale), 'protetto' (PDF cifrato), 'illeggibile'.
export async function compressPdf(bytes, { level = 'media', onProgress = () => {} } = {}) {
  const cfg = LEVELS[level];
  if (!cfg) throw fail('livello', `Livello di compressione sconosciuto: ${level}`);
  const before = bytes.length;
  let doc;
  try {
    doc = await L().PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e?.message || '')) throw fail('protetto', 'Il PDF è protetto da password: non si può comprimere.');
    throw fail('illeggibile', 'Il file non sembra un PDF valido.');
  }
  if (hasSignature(doc)) throw fail('firmato', 'Il PDF contiene una firma digitale: comprimendolo la firma non sarebbe più valida. Il file non è stato modificato.');
  onProgress(0.02, 'Pulizia della struttura');
  stripExtras(doc);
  collectGarbage(doc); // prima delle immagini: non si perde tempo con quelle che nessuno usa
  const all = listImages(doc);
  const work = all.filter((it) => !it.isMask);
  const stats = { total: work.length, recompressed: 0, skipped: 0 };
  for (let i = 0; i < work.length; i += 1) {
    const it = work[i];
    onProgress(0.05 + (0.85 * i) / Math.max(1, work.length), `Immagine ${i + 1} di ${work.length}`);
    await tick();
    let ok = false;
    // Maschere a stampo, maschere di colore e formati non gestiti restano come sono.
    if (!it.imageMask && !it.hasMask) {
      try { ok = await recompressImage(doc, it, cfg); } catch (e) { console.warn('Immagine non ricompressa:', e?.message || e); }
    }
    if (ok) stats.recompressed += 1; else stats.skipped += 1;
  }
  onProgress(0.92, 'Compattazione');
  deflateRawStreams(doc);
  const removed = collectGarbage(doc);
  const out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false, addDefaultPage: false });
  onProgress(1, 'Fatto');
  // Se per qualche motivo il risultato non è più piccolo, si restituisce l'originale.
  const result = out.length < before ? out : bytes;
  return { bytes: result, before, after: result.length, images: stats, removed, unchanged: result === bytes };
}

// --- Finestra -----------------------------------------------------------------
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(h('style', {}, `
.cmp-levels { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0; }
.cmp-level { flex: 1 1 160px; min-height: 76px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 10px 14px; border: 2px solid var(--line); border-radius: 12px; background: #fff; text-align: left; font-size: 16px; cursor: pointer; }
.cmp-level small { color: var(--soft); font-size: 13px; line-height: 1.3; }
.cmp-level.on { border-color: var(--accent); background: var(--accent-soft); }
.cmp-bar { height: 10px; background: var(--line); border-radius: 6px; overflow: hidden; margin: 12px 0 4px; }
.cmp-bar > div { height: 100%; width: 0; background: var(--accent); transition: width .15s; }
.cmp-result { font-size: 17px; line-height: 1.5; margin: 10px 0; }
.cmp-result b { color: var(--accent); }
.cmp-dialog .modal-actions button { min-height: 48px; min-width: 120px; font-size: 16px; }
`));
}

const mb = (b) => `${(b / 1048576).toFixed(2).replace('.', ',')} MB`;

// compressDialog(app, view) → Promise<Uint8Array | null>
// Fa scegliere il livello, comprime il documento con le annotazioni correnti (come al salvataggio) e mostra prima e dopo.
// Restituisce i byte compressi, oppure null se l'utente annulla. Il salvataggio lo fa chi chiama.
export async function compressDialog(app, view) {
  style();
  const { buildPdf } = await import('../pdfio.js');
  return modal((box, done) => {
    box.classList.add('cmp-dialog');
    let level = 'media';
    let result = null;
    let busy = false;
    const levelBtns = Object.entries(LEVELS).map(([k, c]) => h('button', {
      class: `cmp-level ${k === level ? 'on' : ''}`, 'data-level': k,
      onclick: () => { if (busy) return; level = k; levelBtns.forEach((b) => b.classList.toggle('on', b.dataset.level === k)); result = null; outcome.textContent = ''; useBtn.disabled = true; goBtn.disabled = false; },
    }, h('strong', {}, c.label), h('small', {}, c.hint)));
    const bar = h('div');
    const barBox = h('div', { class: 'cmp-bar', hidden: true }, bar);
    const status = h('div', { class: 'hint' });
    const outcome = h('div', { class: 'cmp-result' });
    const cancelBtn = h('button', { onclick: () => done(null) }, 'Annulla');
    const goBtn = h('button', { class: 'primary', onclick: () => run() }, 'Comprimi');
    const useBtn = h('button', { class: 'primary', disabled: true, onclick: () => done(result?.bytes || null) }, 'Usa il file compresso');
    async function run() {
      busy = true; goBtn.disabled = true; useBtn.disabled = true; barBox.hidden = false; outcome.textContent = '';
      try {
        const src = await buildPdf(view);
        result = await compressPdf(src, { level, onProgress: (f, msg) => { bar.style.width = `${Math.round(f * 100)}%`; status.textContent = msg; } });
        const pct = Math.round((1 - result.after / result.before) * 100);
        outcome.replaceChildren(
          h('div', {}, 'Prima: ', h('b', {}, mb(result.before))),
          h('div', {}, 'Dopo: ', h('b', {}, mb(result.after)), result.unchanged ? ' — il file era già compatto' : ` — ${pct}% in meno`),
          h('div', { class: 'hint' }, `Immagini: ${result.images.recompressed} alleggerite su ${result.images.total}.`));
        useBtn.disabled = result.unchanged;
        status.textContent = '';
      } catch (e) {
        outcome.textContent = e.code ? e.message : `Compressione non riuscita: ${e.message || e}`;
        status.textContent = '';
        goBtn.disabled = false;
      }
      busy = false;
    }
    box.append(
      h('h2', {}, 'Riduci le dimensioni del PDF'),
      h('p', {}, 'Le immagini vengono alleggerite e le parti inutili tolte. Testo, pagine e annotazioni restano uguali. Il file originale non viene toccato.'),
      h('div', { class: 'cmp-levels' }, levelBtns), barBox, status, outcome,
      h('div', { class: 'modal-actions' }, cancelBtn, goBtn, useBtn));
  }).then((v) => v || null);
}
