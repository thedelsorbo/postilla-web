// Oscuramento definitivo: le zone segnate (strumento «Oscura» o «Cerca e oscura») diventano riquadri neri e
// tutto ciò che c'era sotto (testo, immagini, grafica, commenti) viene cancellato dal documento.
// Nel registro delle modifiche resta solo quante zone sono state oscurate, mai il testo cancellato.
import { h, modal, toast, uid } from '../core.js';
import { pageText, mergeQuads } from '../text.js';
import { norm } from '../text.js';
import { logEntry } from '../thirdparty.js';
import { openPdf } from '../docview.js';
import { redactPage, inv, apply as applyM } from './content.js';

const { PDFDocument, PDFName, PDFRawStream, PDFObjectCopier } = window.PDFLib;

export const pendingMarks = (view) => view.annots.filter((a) => a.type === 'redact');

// Disegna un'immagine del PDF in pixel con PDF.js (vale per tutti i formati che PDF.js sa leggere).
async function renderImage(doc, obj) {
  const w = obj.dict.lookup(PDFName.of('Width'))?.asNumber?.() || 0;
  const hh = obj.dict.lookup(PDFName.of('Height'))?.asNumber?.() || 0;
  if (!w || !hh) return null;
  const k = Math.min(1, Math.sqrt(24e6 / (w * hh)));
  const W = Math.max(1, Math.round(w * k)); const H = Math.max(1, Math.round(hh * k));
  const tmp = await PDFDocument.create();
  const copier = PDFObjectCopier.for(doc.context, tmp.context);
  const copied = copier.copy(obj);
  const ref = tmp.context.register(copied);
  const pg = tmp.addPage([W, H]);
  pg.node.set(PDFName.of('Resources'), tmp.context.obj({ XObject: { Im0: ref } }));
  pg.node.set(PDFName.of('Contents'), tmp.context.register(tmp.context.stream(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`)));
  const pdf = await openPdf(await tmp.save());
  try {
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    await page.render({ canvasContext: c, viewport: vp }).promise;
    return { width: W, height: H, data: c.getImageData(0, 0, W, H).data, kind: 'render' };
  } finally { pdf.loadingTask?.destroy?.(); }
}

// Ridipinge in nero le parti di un'immagine che cadono nelle zone da oscurare e restituisce il nuovo oggetto.
async function paintImage(doc, info, quads) {
  let mod = null;
  try { mod = await import('./images.js'); } catch { mod = null; }
  let img = null;
  if (mod?.decodeImage) img = await mod.decodeImage(doc, info.obj).catch(() => null);
  if (!img) img = await renderImage(doc, info.obj).catch(() => null);
  if (!img || !mod?.encodeImage) return null;
  const { width: W, height: H } = img;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.putImageData(new ImageData(new Uint8ClampedArray(img.data), W, H), 0, 0);
  const back = inv(info.ctm);
  c.fillStyle = '#000';
  for (const q of quads) {
    const pts = [[q[0], q[1]], [q[2], q[3]], [q[6], q[7]], [q[4], q[5]]].map(([x, y]) => { const [u, v] = applyM(back, x, y); return [u * W, (1 - v) * H]; });
    c.beginPath(); pts.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill();
  }
  const data = c.getImageData(0, 0, W, H).data;
  const filter = info.obj.dict.lookup(PDFName.of('Filter'));
  const jpeg = String(filter || '').includes('DCT');
  return mod.encodeImage(doc, data, W, H, { format: jpeg ? 'jpeg' : 'flate', quality: 0.9 });
}

// Applica davvero tutti gli oscuramenti segnati sul documento aperto (si salva poi in una copia).
export async function applyRedactions(app, view, { confirm = true } = {}) {
  const marks = pendingMarks(view);
  if (!marks.length) { toast('Non ci sono zone da oscurare. Usa lo strumento «Oscura» o «Cerca e oscura».'); return false; }
  if (!app.tools.guardEdit(view)) return false;
  const pages = [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b);
  if (confirm) {
    const ok = await modal((box, done) => box.append(
      h('h2', {}, 'Oscuramento definitivo'),
      h('p', {}, `Sto per oscurare ${marks.length} ${marks.length === 1 ? 'zona' : 'zone'} in ${pages.length === 1 ? 'pagina' : 'pagine'} ${pages.map((p) => p + 1).join(', ')}.`),
      h('p', {}, 'Testo, immagini, grafica e commenti sotto le zone vengono cancellati dal documento e al loro posto resta un riquadro nero. L\'originale non viene toccato: il risultato si salva in una copia.'),
      h('p', { class: 'hint' }, 'Finché non salvi puoi ancora annullare con Ctrl+Z.'),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(false) }, 'Annulla'), h('button', { class: 'primary danger', onclick: () => done(true) }, 'Oscura definitivamente'))));
    if (!ok) return false;
  }
  toast('Oscuramento in corso…');
  const report = { glyphs: 0, images: 0, repainted: 0, removedWhole: 0, annots: 0 };
  await app.pageOp(view, async (bytes) => {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    for (const i of pages) {
      const quads = marks.filter((m) => m.page === i).flatMap((m) => m.quads);
      const r = await redactPage(doc, i, quads, { paintImage: (info, q) => paintImage(doc, info, q) });
      report.glyphs += r.chars; report.images += r.images; report.repainted += r.repainted; report.removedWhole += r.removedWhole; report.annots += r.annots;
    }
    return doc.save({ useObjectStreams: false });
  }, (p) => p);
  view.annots = view.annots.filter((a) => a.type !== 'redact');
  app.tools.drawAll(view);
  pages.forEach((p) => app.tools.draw(view, p));
  for (const i of pages) logEntry(app, view, { kind: 'oscuramento', page: i, before: '(contenuto oscurato)', after: `${marks.filter((m) => m.page === i).length} zone oscurate` });
  app.markDirty(view);
  const parts = [`${report.glyphs} caratteri`];
  if (report.images || report.repainted) parts.push(`${report.images + report.repainted} immagini`);
  if (report.annots) parts.push(`${report.annots} commenti o campi`);
  toast(`Oscuramento fatto: tolti ${parts.join(', ')}. Salva per creare la copia oscurata.`);
  if (report.removedWhole) toast(`${report.removedWhole} immagini non modificabili toccavano le zone e sono state tolte per intero.`, 'warn');
  return true;
}

// Cerca una parola o frase (o un tipo di dato: IBAN, e-mail, codice fiscale…) in tutto il documento e segna le zone.
const PATTERNS = {
  iban: { label: 'IBAN', re: /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/ },
  email: { label: 'Indirizzi e-mail', re: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i },
  cf: { label: 'Codici fiscali', re: /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i },
  phone: { label: 'Numeri di telefono', re: /^\+?\d[\d\s./-]{7,}\d$/ },
};

export async function findMatches(view, query, kind) {
  const out = [];
  const qWords = norm(query || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < view.pages.length; i += 1) {
    const t = await pageText(view, i);
    const words = t.words;
    if (kind && PATTERNS[kind]) {
      for (let k = 0; k < words.length; k += 1) {
        // IBAN e telefoni possono essere spezzati in più "parole": si provano fino a 8 parole unite.
        for (let n = 1; n <= 8 && k + n <= words.length; n += 1) {
          const s = words.slice(k, k + n).map((w) => w.str).join(kind === 'iban' ? '' : ' ').replace(/[.,;:]$/, '');
          if (PATTERNS[kind].re.test(kind === 'iban' ? s.replace(/\s/g, '') : s)) { out.push({ page: i, words: words.slice(k, k + n), text: s }); k += n - 1; break; }
        }
      }
      continue;
    }
    if (!qWords.length) continue;
    for (let k = 0; k + qWords.length <= words.length; k += 1) {
      let ok = true;
      for (let m = 0; m < qWords.length && ok; m += 1) {
        const w = norm(words[k + m].str).replace(/[.,;:!?)"»]+$/, '').replace(/^[("«]+/, '');
        ok = qWords.length === 1 ? w.includes(qWords[0]) : (m === 0 ? w.endsWith(qWords[m]) : m === qWords.length - 1 ? w.startsWith(qWords[m]) : w === qWords[m]);
      }
      if (ok) { out.push({ page: i, words: words.slice(k, k + qWords.length), text: words.slice(k, k + qWords.length).map((w) => w.str).join(' ') }); k += qWords.length - 1; }
    }
  }
  return out;
}

export async function searchAndRedact(app, view) {
  if (!app.tools.guardEdit(view)) return;
  const res = await modal((box, done) => {
    const input = h('input', { type: 'text', placeholder: 'Parola o frase da oscurare', 'aria-label': 'Testo da oscurare' });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done({ query: input.value }); });
    const kinds = Object.entries(PATTERNS).map(([k, p]) => h('button', { onclick: () => done({ kind: k }) }, p.label));
    box.append(h('h2', {}, 'Cerca e oscura'), h('p', {}, 'Scrivi cosa cercare in tutto il documento, oppure scegli un tipo di dato.'), input,
      h('div', { class: 'pop-row wrap' }, ...kinds),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'), h('button', { class: 'primary', onclick: () => done({ query: input.value }) }, 'Cerca')));
    setTimeout(() => input.focus(), 30);
  });
  if (!res || (!res.kind && !res.query?.trim())) return;
  toast('Cerco nel documento…');
  const found = await findMatches(view, res.query, res.kind);
  if (!found.length) { toast('Non ho trovato nulla da oscurare.'); return; }
  const chosen = await modal((box, done) => {
    const checks = found.map((f) => { const c = h('input', { type: 'checkbox', checked: true }); return { c, f }; });
    box.append(h('h2', {}, `Trovati ${found.length} punti`), h('p', {}, 'Togli la spunta a quelli da lasciare. Le zone scelte vengono segnate in rosso: si oscurano davvero con «Applica gli oscuramenti».'),
      h('div', { class: 'redact-list' }, ...checks.map(({ c, f }) => h('label', { class: 'check' }, c, ` pag. ${f.page + 1}: ${f.text}`))),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'), h('button', { class: 'primary', onclick: () => done(checks.filter((x) => x.c.checked).map((x) => x.f)) }, 'Segna da oscurare')));
  });
  if (!chosen?.length) return;
  app.tools.apply(view, { add: chosen.map((f) => ({ id: uid(), type: 'redact', page: f.page, quads: mergeQuads(f.words), text: '' })) });
  view.goto(chosen[0].page);
  toast(`${chosen.length} zone segnate. Controllale e poi usa «Applica gli oscuramenti».`);
}

// Usata dalle prove: applica le zone a dei byte, senza interfaccia.
export async function redactBytes(bytes, marks) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = [...new Set(marks.map((m) => m.page))];
  const out = [];
  for (const i of pages) out.push(await redactPage(doc, i, marks.filter((m) => m.page === i).flatMap((m) => m.quads), { paintImage: (info, q) => paintImage(doc, info, q) }));
  void PDFRawStream;
  return { bytes: await doc.save({ useObjectStreams: false }), report: out };
}
