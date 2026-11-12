// Strumenti di pagina: filigrana, intestazione e piè di pagina, numeri di pagina, numerazione Bates,
// colore di sfondo e ritaglio. Lavorano sui byte del documento aperto; il risultato si salva in una copia.
import { h, modal, toast, hexRgb } from '../core.js';
import { logEntry } from '../thirdparty.js';

const { PDFDocument, PDFName, StandardFonts } = window.PDFLib;
const f = (n) => +Number(n).toFixed(3);

// --- Geometria: posizioni "come si vedono" (anche su pagine ruotate) -------------------------------
function frame(page) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const x0 = box.x; const y0 = box.y; const x1 = box.x + box.width; const y1 = box.y + box.height;
  const W = rot % 180 ? box.height : box.width; const H = rot % 180 ? box.width : box.height;
  // Da coordinate visive (origine in basso a sinistra della pagina come appare) a coordinate PDF.
  const toUser = (vx, vy) => {
    if (rot === 90) return [x1 - vy, y0 + vx];
    if (rot === 180) return [x1 - vx, y1 - vy];
    if (rot === 270) return [x0 + vy, y1 - vx];
    return [x0 + vx, y0 + vy];
  };
  return { W, H, rot, toUser, box: [x0, y0, x1, y1] };
}

// Pagine scelte: "tutte", "questa" o un intervallo «1-3, 5».
export function parseRange(s, count, current) {
  const t = String(s || '').trim().toLowerCase();
  if (!t || t === 'tutte') return [...Array(count).keys()];
  if (t === 'questa') return [current];
  const out = new Set();
  for (const part of t.split(/[,;\s]+/)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Math.max(1, +m[1]); const b = Math.min(count, +(m[2] || m[1]));
    for (let i = a; i <= b; i += 1) out.add(i - 1);
  }
  return [...out].sort((a, b) => a - b);
}

// Scrive del testo su una pagina in coordinate visive, con rotazione e trasparenza. below = sotto il contenuto.
function textOps(doc, page, font, fontName, gsName, items) {
  let ops = 'q\n';
  if (gsName) ops += `${gsName} gs\n`;
  for (const it of items) {
    const [r, g, b] = hexRgb(it.color || '#000000');
    const safe = [...it.text].map((c) => { try { font.encodeText(c); return c; } catch { return '?'; } }).join('');
    const hex = font.encodeText(safe).toString();
    const ang = (it.angle * Math.PI) / 180;
    const ca = Math.cos(ang); const sa = Math.sin(ang);
    ops += `BT ${fontName} ${f(it.size)} Tf ${f(r)} ${f(g)} ${f(b)} rg ${f(ca)} ${f(sa)} ${f(-sa)} ${f(ca)} ${f(it.x)} ${f(it.y)} Tm ${hex} Tj ET\n`;
  }
  return `${ops}Q\n`;
}

function addStream(doc, page, ops, below) {
  const ref = doc.context.register(doc.context.flateStream(ops));
  if (!below) {
    const qRef = doc.context.register(doc.context.stream('q\n'));
    const QRef = doc.context.register(doc.context.stream('\nQ\n'));
    page.node.wrapContentStreams(qRef, QRef);
    page.node.addContentStream(ref);
    return;
  }
  const c = page.node.Contents();
  const list = c && c.asArray ? c.asArray() : (page.node.get(PDFName.of('Contents')) ? [page.node.get(PDFName.of('Contents'))] : []);
  page.node.set(PDFName.of('Contents'), doc.context.obj([ref, ...list]));
}

// Mette un testo in un punto visivo: rotazione `angle` (gradi, antiorario come appare), ancoraggio orizzontale.
function place(fr, font, text, size, vx, vy, angle, anchor) {
  const w = font.widthOfTextAtSize([...text].map((c) => { try { font.encodeText(c); return c; } catch { return '?'; } }).join(''), size);
  const a = (angle * Math.PI) / 180;
  const shift = anchor === 'center' ? w / 2 : anchor === 'right' ? w : 0;
  // Punto di partenza visivo: si arretra lungo la direzione del testo.
  const sx = vx - Math.cos(a) * shift + Math.sin(a) * size * 0.35 * (anchor === 'center' && angle ? 1 : 0);
  const sy = vy - Math.sin(a) * shift - Math.cos(a) * size * 0.35 * (anchor === 'center' && angle ? 1 : 0);
  const [x, y] = fr.toUser(sx, sy);
  return { x, y, angle: angle + fr.rot, size, text };
}

const fillTokens = (s, ctx) => String(s).replace(/\{(n|N|data|file)\}/g, (_m, k) => ({ n: ctx.n, N: ctx.N, data: ctx.date, file: ctx.file }[k]));

// --- Operazioni sui byte ---------------------------------------------------------------------------
// opts.kind: 'watermark' | 'header' | 'numbers' | 'bates'
export async function stampPages(bytes, opts, info = {}) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(opts.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  const pages = doc.getPages();
  const list = opts.pages || [...pages.keys()];
  const N = pages.length;
  const date = new Date().toLocaleDateString('it-IT');
  let k = 0;
  for (const i of list) {
    const page = pages[i];
    if (!page) continue;
    const fr = frame(page);
    const fontName = page.node.newFontDictionary('PostillaS', font.ref);
    let gsName = null;
    if (opts.opacity != null && opts.opacity < 1) gsName = page.node.newExtGState('PostillaG', doc.context.obj({ ca: opts.opacity, CA: opts.opacity }));
    const items = [];
    const m = opts.margin ?? 24;
    const size = opts.size || 10;
    if (opts.kind === 'watermark') {
      const angle = opts.angle ?? 45;
      // Dimensione automatica: il testo occupa circa il 70% della diagonale (o della larghezza se orizzontale).
      let sz = opts.size;
      if (!sz) {
        const len = angle ? Math.hypot(fr.W, fr.H) * 0.7 : fr.W * 0.75;
        sz = Math.min(160, (len / Math.max(1, font.widthOfTextAtSize(opts.text, 1))));
      }
      items.push(place(fr, font, opts.text, sz, fr.W / 2, fr.H / 2 - (angle ? 0 : sz * 0.35), angle, 'center'));
    } else {
      const ctx = { n: (opts.start ?? 1) + k, N: (opts.start ?? 1) + list.length - 1, date, file: info.file || '' };
      if (opts.kind === 'bates') ctx.n = `${opts.prefix || ''}${String((opts.start ?? 1) + k).padStart(opts.digits || 6, '0')}`;
      const text = opts.kind === 'numbers' ? fillTokens(opts.format || 'Pagina {n} di {N}', { ...ctx, N: opts.countAll ? N : ctx.N }) : opts.kind === 'bates' ? String(ctx.n) : fillTokens(opts.text, ctx);
      const pos = opts.position || 'bottom-center';
      const vy = pos.startsWith('top') ? fr.H - m - size * 0.8 : m;
      const anchor = pos.endsWith('left') ? 'left' : pos.endsWith('right') ? 'right' : 'center';
      const vx = anchor === 'left' ? m : anchor === 'right' ? fr.W - m : fr.W / 2;
      items.push(place(fr, font, text, size, vx, vy, 0, anchor));
    }
    items.forEach((it) => { it.color = opts.color; });
    addStream(doc, page, textOps(doc, page, font, fontName, gsName, items), opts.below);
    k += 1;
  }
  return doc.save({ useObjectStreams: false });
}

export async function backgroundPages(bytes, { color, pages }) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const all = doc.getPages();
  const [r, g, b] = hexRgb(color);
  for (const i of pages || [...all.keys()]) {
    const page = all[i];
    if (!page) continue;
    const box = page.getMediaBox();
    addStream(doc, page, `q ${f(r)} ${f(g)} ${f(b)} rg ${f(box.x)} ${f(box.y)} ${f(box.width)} ${f(box.height)} re f Q\n`, true);
  }
  return doc.save({ useObjectStreams: false });
}

// Ritaglio in millimetri dai bordi (come appare la pagina). reset = torna alla pagina intera.
export async function cropPages(bytes, { top = 0, bottom = 0, left = 0, right = 0, pages, reset = false }) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const all = doc.getPages();
  const mm = 72 / 25.4;
  for (const i of pages || [...all.keys()]) {
    const page = all[i];
    if (!page) continue;
    const mb = page.getMediaBox();
    if (reset) { page.setCropBox(mb.x, mb.y, mb.width, mb.height); continue; }
    const fr = frame(page);
    // Margini visivi → margini sui lati della pagina non ruotata.
    const vis = { top: top * mm, bottom: bottom * mm, left: left * mm, right: right * mm };
    const side = { 0: [vis.left, vis.bottom, vis.right, vis.top], 90: [vis.top, vis.left, vis.bottom, vis.right], 180: [vis.right, vis.top, vis.left, vis.bottom], 270: [vis.bottom, vis.right, vis.top, vis.left] }[fr.rot];
    const [x0, y0, x1, y1] = fr.box;
    const nx0 = x0 + side[0]; const ny0 = y0 + side[1]; const nx1 = x1 - side[2]; const ny1 = y1 - side[3];
    if (nx1 - nx0 < 36 || ny1 - ny0 < 36) throw new Error('Il ritaglio è troppo grande: la pagina resterebbe quasi vuota.');
    page.setCropBox(nx0, ny0, nx1 - nx0, ny1 - ny0);
  }
  return doc.save({ useObjectStreams: false });
}

// --- Finestre ------------------------------------------------------------------------------------
const field = (label, input) => h('label', { class: 'pro-field' }, h('span', {}, label), input);
const inp = (attrs) => { const i = h('input', attrs); i.addEventListener('keydown', (e) => e.stopPropagation()); return i; };
const sel = (options, value) => h('select', {}, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

async function run(app, view, label, fn, logText) {
  if (!app.tools.guardEdit(view)) return false;
  try {
    await app.pageOp(view, fn, (p) => p);
    logEntry(app, view, { kind: label, page: view.current, before: '', after: logText });
    toast(`${logText}. Si salva in una copia; Ctrl+Z per annullare.`);
    return true;
  } catch (e) {
    toast(e.message || String(e), 'error');
    return false;
  }
}

function rangeField(view) {
  return inp({ type: 'text', value: 'tutte', 'aria-label': 'Pagine', title: 'tutte, questa, oppure per esempio 1-3, 5' });
}

export async function watermarkDialog(app, view) {
  const opts = await modal((box, done) => {
    const text = inp({ type: 'text', value: 'BOZZA' });
    const color = inp({ type: 'color', value: '#c62828' });
    const opacity = inp({ type: 'range', min: '0.1', max: '1', step: '0.05', value: '0.25' });
    const angle = sel([['45', 'Diagonale'], ['0', 'Orizzontale']], '45');
    const layer = sel([['above', 'Sopra il contenuto'], ['below', 'Sotto il contenuto']], 'above');
    const pages = rangeField(view);
    box.append(h('h2', {}, 'Filigrana'), field('Testo', text), field('Colore', color), field('Trasparenza', opacity), field('Direzione', angle), field('Posizione', layer), field('Pagine', pages),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'), h('button', { class: 'primary', onclick: () => done({ kind: 'watermark', text: text.value.trim(), color: color.value, opacity: +opacity.value, angle: +angle.value, below: layer.value === 'below', bold: true, pages: parseRange(pages.value, view.pages.length, view.current) }) }, 'Applica')));
  });
  if (!opts?.text) return false;
  return run(app, view, 'filigrana', (b) => stampPages(b, opts), `Filigrana «${opts.text}» su ${opts.pages.length} pagine`);
}

export async function numbersDialog(app, view) {
  const opts = await modal((box, done) => {
    const kind = sel([['numbers', 'Numeri di pagina'], ['header', 'Testo libero (intestazione o piè di pagina)'], ['bates', 'Numerazione Bates (atti, allegati)']], 'numbers');
    const format = inp({ type: 'text', value: 'Pagina {n} di {N}' });
    const prefix = inp({ type: 'text', value: 'DOC-' });
    const start = inp({ type: 'number', value: '1', min: '0' });
    const position = sel([['bottom-center', 'In basso al centro'], ['bottom-right', 'In basso a destra'], ['bottom-left', 'In basso a sinistra'], ['top-center', 'In alto al centro'], ['top-right', 'In alto a destra'], ['top-left', 'In alto a sinistra']], 'bottom-center');
    const size = inp({ type: 'number', value: '10', min: '5', max: '40' });
    const color = inp({ type: 'color', value: '#000000' });
    const pages = rangeField(view);
    const hint = h('p', { class: 'hint' });
    const sync = () => {
      const k = kind.value;
      format.parentElement.hidden = k === 'bates';
      prefix.parentElement.hidden = k !== 'bates';
      hint.textContent = k === 'numbers' ? '{n} = numero della pagina, {N} = totale.' : k === 'header' ? 'Puoi usare {n}, {N}, {data} e {file}.' : 'Esempio: DOC-000001, DOC-000002…';
      if (k === 'header' && format.value === 'Pagina {n} di {N}') format.value = '{file} - {data}';
      if (k === 'numbers' && format.value === '{file} - {data}') format.value = 'Pagina {n} di {N}';
    };
    kind.addEventListener('change', sync);
    box.append(h('h2', {}, 'Numeri di pagina, intestazioni e piè di pagina'), field('Cosa aggiungere', kind), field('Testo', format), field('Prefisso', prefix), hint,
      field('Primo numero', start), field('Posizione', position), field('Dimensione', size), field('Colore', color), field('Pagine', pages),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'), h('button', {
        class: 'primary',
        onclick: () => done({ kind: kind.value, format: format.value, text: format.value, prefix: prefix.value, start: +start.value || 0, position: position.value, size: +size.value || 10, color: color.value, pages: parseRange(pages.value, view.pages.length, view.current) }),
      }, 'Applica')));
    sync();
  });
  if (!opts) return false;
  const what = { numbers: 'Numeri di pagina', header: 'Intestazione o piè di pagina', bates: 'Numerazione Bates' }[opts.kind];
  return run(app, view, 'numerazione', (b) => stampPages(b, opts, { file: view.tab.name.replace(/\.pdf$/i, '') }), `${what} su ${opts.pages.length} pagine`);
}

export async function backgroundDialog(app, view) {
  const opts = await modal((box, done) => {
    const color = inp({ type: 'color', value: '#fff8e1' });
    const pages = rangeField(view);
    box.append(h('h2', {}, 'Colore di sfondo'), h('p', { class: 'hint' }, 'Il colore va sotto il contenuto: il testo resta leggibile.'), field('Colore', color), field('Pagine', pages),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'), h('button', { class: 'primary', onclick: () => done({ color: color.value, pages: parseRange(pages.value, view.pages.length, view.current) }) }, 'Applica')));
  });
  if (!opts) return false;
  return run(app, view, 'sfondo', (b) => backgroundPages(b, opts), `Sfondo colorato su ${opts.pages.length} pagine`);
}

export async function cropDialog(app, view) {
  const opts = await modal((box, done) => {
    const mk = (v) => inp({ type: 'number', value: String(v), min: '0', max: '200', step: '1' });
    const top = mk(10); const bottom = mk(10); const left = mk(10); const right = mk(10);
    const pages = inp({ type: 'text', value: 'questa', 'aria-label': 'Pagine' });
    box.append(h('h2', {}, 'Ritaglia le pagine'), h('p', { class: 'hint' }, 'Quanto togliere da ogni bordo, in millimetri. Il contenuto tolto resta nel file ma non si vede né si stampa; «Pagina intera» lo fa tornare.'),
      field('Sopra', top), field('Sotto', bottom), field('Sinistra', left), field('Destra', right), field('Pagine', pages),
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => done(null) }, 'Annulla'),
        h('button', { onclick: () => done({ reset: true, pages: parseRange(pages.value, view.pages.length, view.current) }) }, 'Pagina intera'),
        h('button', { class: 'primary', onclick: () => done({ top: +top.value || 0, bottom: +bottom.value || 0, left: +left.value || 0, right: +right.value || 0, pages: parseRange(pages.value, view.pages.length, view.current) }) }, 'Ritaglia')));
  });
  if (!opts) return false;
  return run(app, view, 'ritaglio', (b) => cropPages(b, opts), opts.reset ? `Ritaglio tolto da ${opts.pages.length} pagine` : `Ritagliate ${opts.pages.length} pagine`);
}
