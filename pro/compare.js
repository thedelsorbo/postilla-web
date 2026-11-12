// Confronto fra due PDF: pagine allineate, differenze di testo parola per parola e differenze grafiche.
// Solo JavaScript (PDF.js, pdf-lib, canvas): funziona anche su Android. I documenti non vengono modificati.
import { h, toast } from '../core.js';
import { openPdf } from '../docview.js';
import { pageText } from '../text.js';

const VIS_WIDTH = 420; // larghezza in pixel delle pagine disegnate per il confronto visivo
const PIX_TOL = 48; // differenza di colore oltre la quale un pixel conta come diverso
const CELL = 6; // lato dei quadratini (pixel) con cui si cercano le zone diverse
const MATCH_MIN = 0.2; // somiglianza minima perché due pagine si considerino "la stessa"

// --- Testo della pagina ---------------------------------------------------------
// Parole con riquadro [x0, y0, x1, y1] in coordinate PDF (punti, origine in basso a sinistra).
async function pageWords(pdf, i) {
  const fake = { textCache: new Map(), getPage: (k) => pdf.getPage(k + 1), ocr: null };
  const t = await pageText(fake, i);
  const raw = t.words.map((w) => {
    const q = w.quad;
    const xs = [q[0], q[2], q[4], q[6]]; const ys = [q[1], q[3], q[5], q[7]];
    return { str: w.str, item: w.item, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], base: Math.min(...ys) };
  });
  // Parole spezzate in più pezzi dal programma che ha creato il PDF ("Certi" + "ficato"): si riuniscono.
  const out = [];
  for (const w of raw) {
    const last = out[out.length - 1];
    if (last && w.item !== last.item) {
      const hgt = Math.max(1, last.box[3] - last.box[1]);
      const gap = w.box[0] - last.box[2];
      if (Math.abs(w.base - last.base) < hgt * 0.3 && gap > -hgt * 0.3 && gap < hgt * 0.1) {
        last.str += w.str;
        last.box = [Math.min(last.box[0], w.box[0]), Math.min(last.box[1], w.box[1]), Math.max(last.box[2], w.box[2]), Math.max(last.box[3], w.box[3])];
        last.item = w.item;
        continue;
      }
    }
    out.push({ ...w });
  }
  return out.map((w) => ({ str: w.str.normalize('NFC'), box: w.box }));
}

// --- Differenze fra sequenze di parole (algoritmo di Myers) -----------------------
// Restituisce le operazioni: { t: '=', i, j } uguale, { t: '-', i } tolta da A, { t: '+', j } aggiunta in B.
export function diffWords(a, b, maxD = 2500) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let ea = a.length; let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea -= 1; eb -= 1; }
  const A = a.slice(s, ea); const B = b.slice(s, eb);
  const mid = myers(A, B, maxD);
  const ops = [];
  for (let k = 0; k < s; k += 1) ops.push({ t: '=', i: k, j: k });
  for (const o of mid) ops.push(o.t === '=' ? { t: '=', i: o.i + s, j: o.j + s } : o.t === '-' ? { t: '-', i: o.i + s } : { t: '+', j: o.j + s });
  for (let k = 0; k < a.length - ea; k += 1) ops.push({ t: '=', i: ea + k, j: eb + k });
  return ops;
}

function myers(a, b, maxD) {
  const n = a.length; const m = b.length;
  if (!n) return b.map((_x, j) => ({ t: '+', j }));
  if (!m) return a.map((_x, i) => ({ t: '-', i }));
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d += 1) {
    if (d > maxD) return [...a.map((_x, i) => ({ t: '-', i })), ...b.map((_x, j) => ({ t: '+', j }))]; // troppo diversi: tutto sostituito
    trace.push(v.slice(off - d - 1, off + d + 2)); // solo la parte utile: indice di k = k + d + 1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return [];
}

function backtrack(trace, n, m) {
  const ops = [];
  let x = n; let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d];
    const at = (k) => v[k + d + 1];
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = d === 0 ? 0 : at(pk);
    const py = px - pk;
    while (x > px && y > py) { x -= 1; y -= 1; ops.push({ t: '=', i: x, j: y }); }
    if (d > 0) { if (x === px) ops.push({ t: '+', j: y - 1 }); else ops.push({ t: '-', i: x - 1 }); }
    x = px; y = py;
  }
  return ops.reverse();
}

// --- Riquadri ----------------------------------------------------------------------
// Unisce i riquadri delle parole vicine sulla stessa riga.
function mergeBoxes(boxes) {
  const out = [];
  for (const b of boxes) {
    const last = out[out.length - 1];
    const hgt = Math.max(1, b[3] - b[1]);
    if (last && Math.abs(last[1] - b[1]) < hgt * 0.4 && b[0] - last[2] < hgt * 1.5 && b[0] >= last[0] - 1) {
      last[0] = Math.min(last[0], b[0]); last[1] = Math.min(last[1], b[1]); last[2] = Math.max(last[2], b[2]); last[3] = Math.max(last[3], b[3]);
    } else out.push([...b]);
  }
  return out;
}

// Riquadro PDF → riquadro sullo schermo [x0, y0, x1, y1] (ordinato), con le pagine anche ruotate.
function toViewport(vp, [x0, y0, x1, y1]) {
  const a = vp.convertToViewportPoint(x0, y0); const b = vp.convertToViewportPoint(x1, y1);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

const cut = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Raggruppa le operazioni in cambiamenti leggibili.
function groupChanges(ops, wa, wb) {
  const changes = [];
  let del = []; let ins = [];
  const flush = () => {
    if (!del.length && !ins.length) return;
    const before = del.map((i) => wa[i].str).join(' ');
    const after = ins.map((j) => wb[j].str).join(' ');
    const kind = del.length && ins.length ? 'modifica' : ins.length ? 'aggiunta' : 'rimozione';
    const label = kind === 'modifica' ? `«${cut(before)}» → «${cut(after)}»` : kind === 'aggiunta' ? `aggiunto «${cut(after)}»` : `tolto «${cut(before)}»`;
    changes.push({ kind, before, after, label, boxesA: mergeBoxes(del.map((i) => wa[i].box)), boxesB: mergeBoxes(ins.map((j) => wb[j].box)) });
    del = []; ins = [];
  };
  for (const o of ops) {
    if (o.t === '=') flush();
    else if (o.t === '-') del.push(o.i);
    else ins.push(o.j);
  }
  flush();
  return changes;
}

// --- Allineamento delle pagine ----------------------------------------------------
function bag(words) { const m = new Map(); for (const w of words) m.set(w.str, (m.get(w.str) || 0) + 1); return m; }
function similarity(ba, na, bb, nb) {
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  let common = 0;
  const [small, big] = ba.size < bb.size ? [ba, bb] : [bb, ba];
  for (const [k, c] of small) { const o = big.get(k); if (o) common += Math.min(c, o); }
  return (2 * common) / (na + nb);
}

// Restituisce le coppie { a, b } (indici da 0, oppure null per una pagina aggiunta o tolta).
export function alignPages(wordsA, wordsB) {
  const na = wordsA.length; const nb = wordsB.length;
  if (na === nb) return wordsA.map((_x, i) => ({ a: i, b: i }));
  const ba = wordsA.map(bag); const bb = wordsB.map(bag);
  const noText = wordsA.every((w) => !w.length) && wordsB.every((w) => !w.length);
  if (noText) {
    // Niente testo (scansioni): pagine in ordine, quelle in più alla fine.
    const pairs = [];
    for (let i = 0; i < Math.max(na, nb); i += 1) pairs.push({ a: i < na ? i : null, b: i < nb ? i : null });
    return pairs;
  }
  // Programmazione dinamica: massimizza la somiglianza totale delle pagine abbinate.
  const W = nb + 1;
  const score = new Float64Array((na + 1) * W);
  const move = new Uint8Array((na + 1) * W); // 1 = abbinate, 2 = pagina tolta da A, 3 = pagina aggiunta in B
  for (let i = 1; i <= na; i += 1) move[i * W] = 2;
  for (let j = 1; j <= nb; j += 1) move[j] = 3;
  for (let i = 1; i <= na; i += 1) {
    for (let j = 1; j <= nb; j += 1) {
      const sim = similarity(ba[i - 1], wordsA[i - 1].length, bb[j - 1], wordsB[j - 1].length);
      let best = score[(i - 1) * W + j]; let mv = 2;
      if (score[i * W + j - 1] > best) { best = score[i * W + j - 1]; mv = 3; }
      if (sim >= MATCH_MIN && score[(i - 1) * W + j - 1] + sim > best) { best = score[(i - 1) * W + j - 1] + sim; mv = 1; }
      score[i * W + j] = best; move[i * W + j] = mv;
    }
  }
  const pairs = [];
  let i = na; let j = nb;
  while (i > 0 || j > 0) {
    const mv = move[i * W + j];
    if (mv === 1) { pairs.push({ a: i - 1, b: j - 1 }); i -= 1; j -= 1; } else if (mv === 2) { pairs.push({ a: i - 1, b: null }); i -= 1; } else { pairs.push({ a: null, b: j - 1 }); j -= 1; }
  }
  return pairs.reverse();
}

// --- Confronto visivo ---------------------------------------------------------------
async function renderSmall(pdf, i, scale) {
  const pg = await pdf.getPage(i + 1);
  const vp = pg.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width)); canvas.height = Math.max(1, Math.round(vp.height));
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
  await pg.render({ canvas, canvasContext: g, viewport: vp }).promise;
  return { data: g.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height, vp };
}

// Zone diverse che non si spiegano col testo: pixel diversi fuori dai riquadri delle parole, raggruppati.
function visualDiff(ra, rb, textBoxesA, textBoxesB) {
  const w = Math.max(ra.w, rb.w); const hh = Math.max(ra.h, rb.h);
  const px = (r, x, y, o) => (x < r.w && y < r.h ? r.data[(y * r.w + x) * 4 + o] : 255);
  // Maschera del testo (riquadri allargati di 2 pixel), in coordinate di A e di B.
  const mask = new Uint8Array(w * hh);
  const paint = (boxes, vp) => {
    for (const b of boxes) {
      const [x0, y0, x1, y1] = toViewport(vp, b);
      const l = Math.max(0, Math.floor(Math.min(x0, x1)) - 2); const r = Math.min(w - 1, Math.ceil(Math.max(x0, x1)) + 2);
      const t = Math.max(0, Math.floor(Math.min(y0, y1)) - 2); const btm = Math.min(hh - 1, Math.ceil(Math.max(y0, y1)) + 2);
      for (let y = t; y <= btm; y += 1) mask.fill(1, y * w + l, y * w + r + 1);
    }
  };
  paint(textBoxesA, ra.vp); paint(textBoxesB, rb.vp);
  const cw = Math.ceil(w / CELL); const ch = Math.ceil(hh / CELL);
  const cells = new Uint16Array(cw * ch);
  let diff = 0;
  for (let y = 0; y < hh; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = Math.max(Math.abs(px(ra, x, y, 0) - px(rb, x, y, 0)), Math.abs(px(ra, x, y, 1) - px(rb, x, y, 1)), Math.abs(px(ra, x, y, 2) - px(rb, x, y, 2)));
      if (d > PIX_TOL) {
        diff += 1;
        if (!mask[y * w + x]) cells[Math.floor(y / CELL) * cw + Math.floor(x / CELL)] += 1;
      }
    }
  }
  // Zone: quadratini "caldi" vicini (anche con un quadratino di distanza) uniti insieme.
  const hot = (c) => cells[c] >= 3;
  const seen = new Uint8Array(cw * ch);
  const zones = [];
  for (let c = 0; c < cw * ch; c += 1) {
    if (!hot(c) || seen[c]) continue;
    let x0 = cw; let y0 = ch; let x1 = 0; let y1 = 0; let count = 0; let pixels = 0;
    const stack = [c]; seen[c] = 1;
    while (stack.length) {
      const k = stack.pop();
      const cx = k % cw; const cy = (k - cx) / cw;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy); count += 1; pixels += cells[k];
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = cx + dx; const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const nk = ny * cw + nx;
          if (!seen[nk] && hot(nk)) { seen[nk] = 1; stack.push(nk); }
        }
      }
    }
    if (pixels < 16) continue; // puntini isolati: bordi sfumati, non contano
    const box = [x0 * CELL, y0 * CELL, Math.min(w, (x1 + 1) * CELL), Math.min(hh, (y1 + 1) * CELL)];
    const toPdf = (vp) => { const [ax, ay] = vp.convertToPdfPoint(box[0], box[1]); const [bx, by] = vp.convertToPdfPoint(box[2], box[3]); return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]; };
    zones.push({ boxA: toPdf(ra.vp), boxB: toPdf(rb.vp), pixels, cells: count });
  }
  return { percent: (100 * diff) / (w * hh), zones };
}

// --- Confronto completo ---------------------------------------------------------------
async function compareDocs(pdfA, pdfB, { onProgress = () => {}, visual = true } = {}) {
  const t0 = performance.now();
  const na = pdfA.numPages; const nb = pdfB.numPages;
  const total = na + nb + (visual ? Math.min(na, nb) : 0);
  let done = 0;
  const step = (msg) => { done += 1; onProgress(Math.min(1, done / total), msg); };
  const wordsA = []; const wordsB = [];
  for (let i = 0; i < na; i += 1) { wordsA.push(await pageWords(pdfA, i)); step(`Testo del primo documento, pagina ${i + 1}`); }
  for (let i = 0; i < nb; i += 1) { wordsB.push(await pageWords(pdfB, i)); step(`Testo del secondo documento, pagina ${i + 1}`); }
  const pairs = alignPages(wordsA, wordsB).map((p, idx) => ({ ...p, idx, status: 'uguale', changes: [], visual: null }));
  const changes = [];
  const add = (pair, c) => { c.id = changes.length; c.pair = pair.idx; c.pageA = pair.a === null ? null : pair.a + 1; c.pageB = pair.b === null ? null : pair.b + 1; changes.push(c); pair.changes.push(c.id); };
  for (const pair of pairs) {
    if (pair.a === null) { pair.status = 'aggiunta'; add(pair, { kind: 'pagina-aggiunta', before: '', after: '', label: `pagina aggiunta (pagina ${pair.b + 1} del secondo documento)`, boxesA: [], boxesB: [] }); continue; }
    if (pair.b === null) { pair.status = 'tolta'; add(pair, { kind: 'pagina-tolta', before: '', after: '', label: `pagina tolta (pagina ${pair.a + 1} del primo documento)`, boxesA: [], boxesB: [] }); continue; }
    const wa = wordsA[pair.a]; const wb = wordsB[pair.b];
    const ops = diffWords(wa.map((w) => w.str), wb.map((w) => w.str));
    for (const c of groupChanges(ops, wa, wb)) add(pair, c);
    if (visual) {
      const pa = await pdfA.getPage(pair.a + 1);
      const scale = VIS_WIDTH / pa.getViewport({ scale: 1 }).width;
      const [ra, rb] = [await renderSmall(pdfA, pair.a, scale), await renderSmall(pdfB, pair.b, scale)];
      const vd = visualDiff(ra, rb, wa.map((w) => w.box), wb.map((w) => w.box));
      pair.visual = { percent: Math.round(vd.percent * 100) / 100, zones: vd.zones };
      for (const z of vd.zones) add(pair, { kind: 'grafica', before: '', after: '', label: 'differenza grafica (immagine, timbro, firma o disegno)', boxesA: [z.boxA], boxesB: [z.boxB], pixels: z.pixels });
      step(`Confronto visivo, pagina ${pair.a + 1}`);
    }
    if (pair.changes.length) pair.status = 'diversa';
  }
  const textKinds = ['modifica', 'aggiunta', 'rimozione'];
  const textChanges = changes.filter((c) => textKinds.includes(c.kind));
  const graphic = changes.filter((c) => c.kind === 'grafica');
  const counts = {
    text: textChanges.length,
    textPages: new Set(textChanges.map((c) => c.pair)).size,
    graphic: graphic.length,
    pagesAdded: changes.filter((c) => c.kind === 'pagina-aggiunta').length,
    pagesRemoved: changes.filter((c) => c.kind === 'pagina-tolta').length,
  };
  return { pagesA: na, pagesB: nb, pairs, changes, counts, identical: !changes.length, summary: summarize(changes, counts), ms: Math.round(performance.now() - t0) };
}

const pageRef = (c) => (c.pageA && c.pageB ? (c.pageA === c.pageB ? `${c.pageA}` : `${c.pageA} (nel secondo: ${c.pageB})`) : `${c.pageA || c.pageB}`);
const listIt = (arr) => (arr.length < 2 ? arr.join('') : `${arr.slice(0, -1).join(', ')} e ${arr[arr.length - 1]}`);

function summarize(changes, k) {
  if (!changes.length) return 'Nessuna differenza: i due documenti sono uguali.';
  const parts = [];
  if (k.text) parts.push(`${k.text} ${k.text === 1 ? 'cambiamento' : 'cambiamenti'} di testo in ${k.textPages} ${k.textPages === 1 ? 'pagina' : 'pagine'}`);
  if (k.graphic) {
    const pages = [...new Set(changes.filter((c) => c.kind === 'grafica').map(pageRef))];
    parts.push(`${k.graphic} ${k.graphic === 1 ? 'differenza grafica' : 'differenze grafiche'} ${pages.length === 1 ? 'a pagina' : 'alle pagine'} ${listIt(pages)}`);
  }
  if (k.pagesAdded) parts.push(`${k.pagesAdded} ${k.pagesAdded === 1 ? 'pagina aggiunta' : 'pagine aggiunte'}`);
  if (k.pagesRemoved) parts.push(`${k.pagesRemoved} ${k.pagesRemoved === 1 ? 'pagina tolta' : 'pagine tolte'}`);
  return `${listIt(parts)}.`;
}

// comparePdfs(bytesA, bytesB, { onProgress, visual }) → Promise<report>
// report: { pagesA, pagesB, pairs, changes, counts, identical, summary, ms }
//   pairs[]: { idx, a, b (indici da 0 o null), status: 'uguale'|'diversa'|'aggiunta'|'tolta', changes: [id], visual: { percent, zones } }
//   changes[]: { id, pair, kind: 'modifica'|'aggiunta'|'rimozione'|'grafica'|'pagina-aggiunta'|'pagina-tolta',
//                pageA, pageB (da 1, o null), before, after, label, boxesA, boxesB ([x0, y0, x1, y1] in punti PDF) }
export async function comparePdfs(bytesA, bytesB, opts = {}) {
  const [pdfA, pdfB] = await Promise.all([openPdf(new Uint8Array(bytesA)), openPdf(new Uint8Array(bytesB))]);
  try { return await compareDocs(pdfA, pdfB, opts); } finally { pdfA.loadingTask.destroy(); pdfB.loadingTask.destroy(); }
}

// --- Rapporto in PDF ---------------------------------------------------------------------
const KIND_LABEL = { modifica: 'Modifica', aggiunta: 'Aggiunta', rimozione: 'Rimozione', grafica: 'Grafica', 'pagina-aggiunta': 'Pagina aggiunta', 'pagina-tolta': 'Pagina tolta' };

// buildReportPdf(report, nameA, nameB) → Promise<Uint8Array>: elenco dei cambiamenti con i numeri di pagina.
export async function buildReportPdf(report, nameA, nameB) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle('Rapporto di confronto');
  doc.setProducer('Postilla');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const okChar = new Map();
  // I caratteri standard non hanno tutti i simboli: quelli mancanti si sostituiscono.
  const clean = (s) => [...String(s).replace(/→/g, '->').replace(/\s+/g, ' ')].map((c) => {
    if (!okChar.has(c)) { try { font.widthOfTextAtSize(c, 10); bold.widthOfTextAtSize(c, 10); okChar.set(c, true); } catch { okChar.set(c, false); } }
    return okChar.get(c) ? c : '?';
  }).join('');
  const W = 595; const H = 842; const M = 50;
  let page; let y;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const wrap = (text, f, size, width) => {
    const words = clean(text).split(' ');
    const lines = []; let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(t, size) > width && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  };
  const write = (text, { f = font, size = 10.5, color = rgb(0.13, 0.19, 0.18), indent = 0, gap = 4 } = {}) => {
    for (const ln of wrap(text, f, size, W - 2 * M - indent)) {
      if (y < M + size) newPage();
      page.drawText(ln, { x: M + indent, y: y - size, size, font: f, color });
      y -= size * 1.35;
    }
    y -= gap;
  };
  newPage();
  write('Rapporto di confronto', { f: bold, size: 18, color: rgb(0.09, 0.34, 0.31), gap: 8 });
  write(`Data: ${new Date().toLocaleString('it-IT')}`, { size: 9.5 });
  write(`Primo documento (A): ${nameA} - ${report.pagesA} ${report.pagesA === 1 ? 'pagina' : 'pagine'}`);
  write(`Secondo documento (B): ${nameB} - ${report.pagesB} ${report.pagesB === 1 ? 'pagina' : 'pagine'}`, { gap: 10 });
  write('Riepilogo', { f: bold, size: 13 });
  write(report.summary, { gap: 12 });
  if (report.changes.length) {
    write('Elenco dei cambiamenti', { f: bold, size: 13 });
    report.changes.forEach((c, n) => {
      const where = c.pageA && c.pageB ? `pagina ${c.pageA}${c.pageA !== c.pageB ? ` (B: ${c.pageB})` : ''}` : c.pageA ? `pagina ${c.pageA} di A` : `pagina ${c.pageB} di B`;
      write(`${n + 1}. ${where} - ${KIND_LABEL[c.kind] || c.kind}`, { f: bold, size: 10.5, gap: 1 });
      const detail = c.kind === 'modifica' ? `Prima: "${cut(c.before, 300)}"  Dopo: "${cut(c.after, 300)}"` : c.kind === 'aggiunta' ? `Aggiunto: "${cut(c.after, 300)}"` : c.kind === 'rimozione' ? `Tolto: "${cut(c.before, 300)}"` : c.label;
      write(detail, { indent: 14, gap: 6 });
    });
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`Postilla - rapporto di confronto - pagina ${i + 1} di ${pages.length}`, { x: M, y: 24, size: 8, font, color: rgb(0.45, 0.48, 0.47) }));
  return doc.save();
}

// --- Finestra di confronto ----------------------------------------------------------------
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(h('style', {}, `
.cmpv { position: fixed; inset: 0; z-index: 40; display: flex; flex-direction: column; background: var(--desk, #55605e); color: var(--ink, #22302f); font-size: 15px; }
.cmpv button { min-height: 48px; min-width: 48px; font-size: 15px; border-radius: 10px; touch-action: manipulation; }
.cmpv-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--panel, #fbf9f4); border-bottom: 1px solid var(--line, #ddd6c8); flex-wrap: wrap; }
.cmpv-title { flex: 1 1 300px; min-width: 0; }
.cmpv-title h2 { margin: 0; font-size: 18px; }
.cmpv-sum { font-size: 14px; color: var(--soft, #667371); margin-top: 2px; }
.cmpv-body { flex: 1; display: flex; min-height: 0; }
.cmpv-list { width: 320px; flex: none; overflow-y: auto; background: var(--panel, #fbf9f4); border-right: 1px solid var(--line, #ddd6c8); padding: 6px; touch-action: pan-y; }
.cmpv-item { display: block; width: 100%; text-align: left; padding: 10px 12px; margin: 0 0 6px; border: 1.5px solid var(--line, #ddd6c8); background: #fff; line-height: 1.35; cursor: pointer; }
.cmpv-item.on { border-color: var(--accent, #17564f); background: var(--accent-soft, #d6e6e1); }
.cmpv-item small { display: block; color: var(--soft, #667371); font-size: 12.5px; margin-bottom: 2px; }
.cmpv-item .k-modifica, .cmpv-item .k-rimozione, .cmpv-item .k-pagina-tolta { color: #b3261e; }
.cmpv-item .k-aggiunta, .cmpv-item .k-pagina-aggiunta { color: #1e7a32; }
.cmpv-item .k-grafica { color: #c25a00; }
.cmpv-empty { padding: 16px; color: var(--soft, #667371); }
.cmpv-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.cmpv-nav { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px; background: #0002; color: #fff; }
.cmpv-nav .cmpv-pg { min-width: 220px; text-align: center; font-weight: 600; }
.cmpv-cols { flex: 1; display: flex; gap: 10px; padding: 10px; min-height: 0; }
.cmpv-col { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.cmpv-col-name { color: #fff; font-size: 13px; padding: 0 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cmpv-sheet-wrap { flex: 1; overflow: auto; display: flex; align-items: flex-start; justify-content: center; min-height: 0; }
.cmpv-sheet { position: relative; background: #fff; box-shadow: 0 2px 10px #0005; }
.cmpv-sheet canvas { display: block; }
.cmpv-missing { color: #fff; padding: 40px 10px; text-align: center; opacity: .85; }
.cmpv-box { position: absolute; pointer-events: none; border-radius: 2px; }
.cmpv-box.del { background: #e5393566; outline: 1.5px solid #c62828; }
.cmpv-box.ins { background: #43a04766; outline: 1.5px solid #2e7d32; }
.cmpv-box.gfx { outline: 3px solid #ef6c00; outline-offset: 2px; background: #ff980014; }
.cmpv-sheet.added { outline: 4px solid #2e7d32; }
.cmpv-sheet.removed { outline: 4px solid #c62828; }
.cmpv-box.flash { animation: cmpv-flash .45s ease-in-out 4; }
@keyframes cmpv-flash { 50% { transform: scale(1.25); box-shadow: 0 0 0 6px #ffeb3bcc; } }
@media (max-width: 900px) { .cmpv-body { flex-direction: column; } .cmpv-list { width: auto; max-height: 30vh; border-right: 0; border-bottom: 1px solid var(--line, #ddd6c8); } }
`));
}

const KIND_SHORT = { modifica: 'Modificato', aggiunta: 'Aggiunto', rimozione: 'Tolto', grafica: 'Grafica', 'pagina-aggiunta': 'Pagina aggiunta', 'pagina-tolta': 'Pagina tolta' };

// showComparison(app, nameA, bytesA, nameB, bytesB, { onExport }) → Promise<report> (si risolve alla chiusura).
// «Esporta il rapporto»: se c'è opts.onExport(bytes, nomeSuggerito) i byte del PDF di rapporto vanno lì
// (così il coordinatore decide dove salvare); altrimenti si chiede dove salvarlo con host.pickSave e si scrive con host.writeFile.
export async function showComparison(app, nameA, bytesA, nameB, bytesB, opts = {}) {
  style();
  const [pdfA, pdfB] = await Promise.all([openPdf(new Uint8Array(bytesA)), openPdf(new Uint8Array(bytesB))]);
  let resolveClose;
  const closed = new Promise((r) => { resolveClose = r; });
  const sum = h('div', { class: 'cmpv-sum' }, 'Confronto in corso…');
  const exportBtn = h('button', { class: 'primary cmpv-export', disabled: true, onclick: () => exportReport() }, 'Esporta il rapporto');
  const closeBtn = h('button', { class: 'cmpv-close', onclick: () => close() }, 'Chiudi');
  const list = h('div', { class: 'cmpv-list', role: 'list' }, h('div', { class: 'cmpv-empty' }, 'Sto confrontando i documenti…'));
  const prevBtn = h('button', { class: 'cmpv-prev', 'aria-label': 'Pagina precedente', title: 'Pagina precedente', onclick: () => go(cur - 1) }, '◀');
  const nextBtn = h('button', { class: 'cmpv-next', 'aria-label': 'Pagina successiva', title: 'Pagina successiva', onclick: () => go(cur + 1) }, '▶');
  const pgLabel = h('div', { class: 'cmpv-pg' }, '');
  const sheetA = h('div', { class: 'cmpv-sheet-wrap' }); const sheetB = h('div', { class: 'cmpv-sheet-wrap' });
  const root = h('div', { class: 'cmpv', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Confronto fra due PDF', tabindex: '-1' },
    h('div', { class: 'cmpv-head' },
      h('div', { class: 'cmpv-title' }, h('h2', {}, 'Confronto fra due PDF'), sum), exportBtn, closeBtn),
    h('div', { class: 'cmpv-body' }, list,
      h('div', { class: 'cmpv-main' },
        h('div', { class: 'cmpv-nav' }, prevBtn, pgLabel, nextBtn),
        h('div', { class: 'cmpv-cols' },
          h('div', { class: 'cmpv-col' }, h('div', { class: 'cmpv-col-name', title: nameA }, `A · ${nameA}`), sheetA),
          h('div', { class: 'cmpv-col' }, h('div', { class: 'cmpv-col-name', title: nameB }, `B · ${nameB}`), sheetB)))));
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(cur - 1);
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(cur + 1);
  });
  document.body.append(root);
  root.focus();

  let report = null;
  let cur = 0;
  let selected = null;
  let drawGen = 0;
  const ro = new ResizeObserver(() => { if (report) draw(); });

  try {
    report = await compareDocs(pdfA, pdfB, { onProgress: (f) => { sum.textContent = `Confronto in corso… ${Math.round(f * 100)}%`; } });
  } catch (e) {
    console.error(e);
    sum.textContent = `Confronto non riuscito: ${e.message || e}`;
    list.replaceChildren(h('div', { class: 'cmpv-empty' }, 'Non è stato possibile confrontare i due documenti.'));
    root.cmp = { report: null, done: Promise.resolve() };
    return closed;
  }
  sum.textContent = report.summary;
  exportBtn.disabled = false;
  list.replaceChildren(...(report.changes.length ? report.changes.map((c) => h('button', {
    class: 'cmpv-item', role: 'listitem', 'data-id': c.id, onclick: () => select(c.id),
  }, h('small', {}, `Pagina ${pageRef(c)} · `, h('span', { class: `k-${c.kind}` }, KIND_SHORT[c.kind])), c.label)) : [h('div', { class: 'cmpv-empty' }, 'Nessuna differenza: i due documenti sono uguali.')]));
  ro.observe(sheetA);
  // Per le prove automatiche: stato corrente e attesa del disegno.
  root.cmp = { report, get page() { return cur; }, done: draw() };

  function go(i) {
    if (!report) return;
    const n = Math.max(0, Math.min(report.pairs.length - 1, i));
    if (n === cur && root.cmp.done) return;
    cur = n;
    root.cmp.done = draw();
  }

  function select(id) {
    const c = report.changes[id];
    selected = id;
    list.querySelectorAll('.cmpv-item').forEach((b) => b.classList.toggle('on', +b.dataset.id === id));
    cur = c.pair;
    root.cmp.done = draw().then(() => {
      root.querySelectorAll(`.cmpv-box[data-id="${id}"]`).forEach((b) => { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); b.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); });
    });
  }

  async function drawSide(wrap, pdf, idx, pair, side) {
    const gen = drawGen;
    if (idx === null) { wrap.replaceChildren(h('div', { class: 'cmpv-missing' }, side === 'A' ? 'Questa pagina non c’è nel primo documento.' : 'Questa pagina non c’è nel secondo documento.')); return; }
    const pg = await pdf.getPage(idx + 1);
    const base = pg.getViewport({ scale: 1 });
    const availW = Math.max(120, wrap.clientWidth - 8); const availH = Math.max(160, wrap.clientHeight - 8);
    const s = Math.min(availW / base.width, availH / base.height, 3);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = pg.getViewport({ scale: s * dpr });
    const canvas = h('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    canvas.style.width = `${Math.round(vp.width / dpr)}px`; canvas.style.height = `${Math.round(vp.height / dpr)}px`;
    await pg.render({ canvas, viewport: vp }).promise;
    if (gen !== drawGen) return;
    const sheet = h('div', { class: `cmpv-sheet ${pair.status === 'aggiunta' ? 'added' : pair.status === 'tolta' ? 'removed' : ''}` }, canvas);
    const cssVp = pg.getViewport({ scale: s });
    for (const id of pair.changes) {
      const c = report.changes[id];
      const boxes = side === 'A' ? c.boxesA : c.boxesB;
      const cls = c.kind === 'grafica' ? 'gfx' : side === 'A' ? 'del' : 'ins';
      for (const b of boxes) {
        const [x0, y0, x1, y1] = toViewport(cssVp, b);
        const el = h('div', { class: `cmpv-box ${cls}`, 'data-id': id });
        el.style.cssText = `left:${Math.min(x0, x1) - 1}px;top:${Math.min(y0, y1) - 1}px;width:${Math.abs(x1 - x0) + 2}px;height:${Math.abs(y1 - y0) + 2}px`;
        sheet.append(el);
      }
    }
    wrap.replaceChildren(sheet);
  }

  async function draw() {
    drawGen += 1;
    const pair = report.pairs[cur];
    const n = report.pairs.length;
    const a = pair.a === null ? '—' : pair.a + 1; const b = pair.b === null ? '—' : pair.b + 1;
    pgLabel.textContent = `${cur + 1} di ${n}  ·  A: ${a}  ·  B: ${b}`;
    prevBtn.disabled = cur <= 0; nextBtn.disabled = cur >= n - 1;
    try {
      await Promise.all([drawSide(sheetA, pdfA, pair.a, pair, 'A'), drawSide(sheetB, pdfB, pair.b, pair, 'B')]);
    } catch (e) {
      if (!/cancel/i.test(e?.message || '')) console.error(e);
    }
    if (selected !== null && report.changes[selected]?.pair !== cur) {
      selected = null;
      list.querySelectorAll('.cmpv-item.on').forEach((x) => x.classList.remove('on'));
    }
  }

  async function exportReport() {
    try {
      const bytes = await buildReportPdf(report, nameA, nameB);
      const suggested = `${nameA.replace(/\.pdf$/i, '')} - confronto.pdf`;
      if (opts.onExport) { await opts.onExport(bytes, suggested); return; }
      const dest = await host.pickSave(suggested);
      if (!dest) return;
      await host.writeFile(dest, bytes);
      toast('Rapporto di confronto salvato.');
    } catch (e) {
      console.error(e);
      toast(`Rapporto non salvato: ${e.message || e}`, 'error');
    }
  }

  function close() {
    ro.disconnect();
    root.remove();
    pdfA.loadingTask.destroy(); pdfB.loadingTask.destroy();
    resolveClose(report);
  }

  return closed;
}
