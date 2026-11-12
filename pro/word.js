// Conversione Word.
// Da PDF a Word (.docx): tutto nel renderer, quindi funziona anche su Android. Il testo viene da PDF.js
// (righe, paragrafi, titoli, grassetto, corsivo, colori, allineamento, tabelle semplici); le pagine scansionate
// usano il testo riconosciuto (OCR) se c'è, altrimenti entrano come immagine, così nulla va perso.
// Da Word a PDF: sul PC lo fa il processo principale (Word, LibreOffice o il motore interno, vedi word-main.js);
// senza processo principale (Android) c'è un motore semplice scritto qui con mammoth e pdf-lib.
// Il PDF originale e il file Word originale non vengono mai modificati.
import { OPS } from '../node_modules/pdfjs-dist/build/pdf.min.mjs';
import { openPdf } from '../docview.js';
import { h, toast, ask, baseName } from '../core.js';
import { parseFontName } from '../edits.js';
import { MIN_NATIVE_CHARS } from '../text.js';

const TW = 20; // twip per punto
const EMU = 12700; // EMU per punto
const ASC = 0.9; // parte della riga sopra la linea di base (in proporzione alla dimensione del carattere)
const DESC = 0.22; // parte sotto la linea di base
const BULLET = /^\s*([•●▪■◦○\-–—*·]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s/;

// --- Piccole utilità ---------------------------------------------------------------------------
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const tw = (pt) => Math.max(0, Math.round(pt * TW));
const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Testo sicuro per l'XML: niente caratteri di controllo né metà di coppie surrogate.
function esc(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hexColor(c) {
  if (!c) return null;
  let hx = null;
  if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) hx = c.slice(1);
  else if (c.length === 3) hx = [...c].map((v) => Math.round(clamp(v <= 1 ? v * 255 : v, 0, 255)).toString(16).padStart(2, '0')).join('');
  if (!hx) return null;
  const v = [0, 2, 4].map((k) => parseInt(hx.slice(k, k + 2), 16));
  if (Math.max(...v) < 48) return null; // nero o quasi: colore automatico
  return hx.toUpperCase();
}

// Nome del carattere nel PDF → nome del carattere in Word.
const FAMILY = { helvetica: 'Arial', arial: 'Arial', helveticaneue: 'Helvetica Neue', times: 'Times New Roman', timesroman: 'Times New Roman', timesnewroman: 'Times New Roman', courier: 'Courier New', couriernew: 'Courier New', symbol: 'Symbol', zapfdingbats: 'Wingdings' };
function wordFamily(family, generic) {
  const k = String(family || '').toLowerCase().replace(/[^a-z]/g, '');
  if (FAMILY[k]) return FAMILY[k];
  if (!k || /^(f\d*|t\d*|cidfont|font|g d\d*)$/.test(k) || /^g_/.test(family)) return generic === 'serif' ? 'Times New Roman' : (generic === 'monospace' ? 'Courier New' : 'Arial');
  return family;
}

// --- Lettura di una pagina ---------------------------------------------------------------------
// Caratteri incorporati: il nome vero si legge dal file (come in edits.js) confrontando il riquadro dei glifi.
async function libFonts(state, i) {
  if (!state.libDoc) {
    state.libDoc = (async () => {
      const bytes = await state.getBytes();
      if (!bytes) return null;
      return window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    })().catch(() => null);
  }
  const doc = await state.libDoc;
  if (!doc) return [];
  const { PDFName, PDFDict, PDFArray } = window.PDFLib;
  try {
    const fonts = doc.getPage(i).node.Resources()?.lookup(PDFName.of('Font'));
    if (!(fonts instanceof PDFDict)) return [];
    const out = [];
    for (const [, ref] of fonts.entries()) {
      const fd = doc.context.lookup(ref);
      if (!(fd instanceof PDFDict)) continue;
      const bf = fd.lookup(PDFName.of('BaseFont'));
      const base = String(bf?.decodeText?.() || bf?.asString?.() || '').replace(/^\//, '');
      let desc = fd.lookup(PDFName.of('FontDescriptor'));
      const kids = fd.lookup(PDFName.of('DescendantFonts'));
      if (!desc && kids instanceof PDFArray) desc = doc.context.lookup(kids.get(0))?.lookup(PDFName.of('FontDescriptor'));
      const bb = desc instanceof PDFDict ? desc.lookup(PDFName.of('FontBBox')) : null;
      out.push({ base, bbox: bb instanceof PDFArray ? bb.asArray().map((n) => n.asNumber?.() ?? 0) : null });
    }
    return out;
  } catch { return []; }
}

async function fontStyle(state, pg, i, fontName, styles) {
  const key = `${i}|${fontName}`;
  if (state.fontCache.has(key)) return state.fontCache.get(key);
  let obj = null;
  try { if (pg.commonObjs.has(fontName)) obj = pg.commonObjs.get(fontName); } catch { obj = null; }
  const generic = styles?.[fontName]?.fontFamily || 'sans-serif';
  let base = null;
  if (obj?.loadedName && !/^g_/.test(obj.loadedName)) base = obj.loadedName; // caratteri standard non incorporati
  else if (obj?.bbox) {
    const list = await libFonts(state, i);
    const hit = list.find((f) => f.bbox && f.bbox.length === 4 && f.bbox.every((v, k) => Math.abs(v - obj.bbox[k]) <= 1.5));
    if (hit) base = hit.base;
  }
  const info = parseFontName(base || '', { bold: obj?.bold || obj?.black, italic: obj?.italic });
  const res = { font: wordFamily(base ? info.family : '', generic), bold: !!info.bold, italic: !!info.italic };
  state.fontCache.set(key, res);
  return res;
}

// Dalla lista delle operazioni di disegno: colore di ogni carattere e posizione delle immagini.
async function drawingInfo(pg, vp) {
  const ol = await pg.getOperatorList();
  const chars = [];
  const images = [];
  let graphics = false;
  let ctm = [1, 0, 0, 1, 0, 0];
  let color = null;
  const stack = [];
  const asMatrix = (a) => Array.from(a.length === 1 ? a[0] : a).slice(0, 6);
  for (let k = 0; k < ol.fnArray.length; k += 1) {
    const fn = ol.fnArray[k];
    const a = ol.argsArray[k];
    switch (fn) {
      case OPS.save: stack.push([ctm, color]); break;
      case OPS.restore: if (stack.length) [ctm, color] = stack.pop(); break;
      case OPS.transform: ctm = mul(ctm, asMatrix(a)); break;
      case OPS.paintFormXObjectBegin: stack.push([ctm, color]); if (a?.[0]) ctm = mul(ctm, Array.from(a[0]).slice(0, 6)); break;
      case OPS.paintFormXObjectEnd: if (stack.length) [ctm, color] = stack.pop(); break;
      case OPS.setFillRGBColor: color = typeof a?.[0] === 'string' ? a[0] : Array.from(a || []); break;
      case OPS.setFillGray: color = [a[0], a[0], a[0]]; break;
      case OPS.showText:
      case OPS.showSpacedText:
        for (const g of a?.[0] || []) if (g && typeof g === 'object' && g.unicode) for (const ch of g.unicode) if (!/\s/.test(ch)) chars.push([ch, color]);
        break;
      case OPS.constructPath: graphics = true; break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageXObjectRepeat: {
        graphics = true;
        const m = mul(vp.transform, ctm);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
        const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
        images.push({ x0: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) });
        break;
      }
      default: break;
    }
  }
  return { chars, images, graphics };
}

// Abbina il colore ai pezzi di testo: i caratteri arrivano nello stesso ordine in tutte e due le letture.
function colorize(items, chars) {
  const arr = chars.map((c) => c[0]);
  let pos = 0;
  for (const it of items) {
    const s = [...String(it.str || '').replace(/\s+/g, '')];
    if (!s.length) continue;
    const n = Math.min(s.length, 12);
    let at = -1;
    for (let k = pos; k <= Math.min(arr.length - n, pos + 600); k += 1) {
      let ok = true;
      for (let j = 0; j < n; j += 1) if (arr[k + j] !== s[j]) { ok = false; break; }
      if (ok) { at = k; break; }
    }
    if (at >= 0) { it.color = hexColor(chars[at][1]); pos = at + s.length; }
  }
}

async function renderCanvas(pg, scale) {
  const vp = pg.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  await pg.render({ canvas, viewport: vp }).promise;
  return canvas;
}

async function canvasBytes(canvas, jpeg) {
  const type = jpeg ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((res) => canvas.toBlob(res, type, 0.85));
  if (blob) return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: jpeg ? 'jpeg' : 'png' };
  const url = canvas.toDataURL(type, 0.85); // riserva per WebView che non hanno toBlob
  const bin = atob(url.split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k += 1) out[k] = bin.charCodeAt(k);
  return { bytes: out, ext: jpeg ? 'jpeg' : 'png' };
}

async function readPage(state, pdf, i) {
  const pg = await pdf.getPage(i + 1);
  const vp = pg.getViewport({ scale: 1 });
  const page = { i, w: vp.width, h: vp.height, kind: 'text', pieces: [], images: [], scan: null };
  const content = await pg.getTextContent();
  const draw = await drawingInfo(pg, vp).catch(() => ({ chars: [], images: [], graphics: false }));
  const native = content.items.reduce((n, it) => n + String(it.str || '').replace(/\s/g, '').length, 0);
  const ocr = state.ocr?.pages?.[i];
  if (native < MIN_NATIVE_CHARS) {
    if (ocr?.words?.length) {
      page.kind = 'ocr';
      for (const w of ocr.words) {
        if (!w.s) continue;
        const pts = [0, 2, 4, 6].map((k) => vp.convertToViewportPoint(w.q[k], w.q[k + 1]));
        const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
        const hgt = Math.max(2, Math.max(...ys) - Math.min(...ys));
        const size = clamp(hgt / 1.16, 4, 72);
        page.pieces.push({ text: w.s, x0: Math.min(...xs), x1: Math.max(...xs), y: Math.max(...ys) - hgt * 0.18, size, bold: false, italic: false, font: 'Arial', color: null, line: w.l });
      }
    } else if (native > 0 || draw.graphics) {
      // Scansione senza testo riconosciuto: la pagina entra come immagine.
      page.kind = 'scan';
      if (state.noImages) return page; // Excel e traduzione: le immagini non servono
      const scale = Math.min(150 / 72, Math.sqrt(6e6 / (vp.width * vp.height)));
      const canvas = await renderCanvas(pg, scale);
      page.scan = { ...(await canvasBytes(canvas, true)), wPt: vp.width, hPt: vp.height };
      canvas.width = 0;
    } else page.kind = 'blank';
    return page;
  }
  colorize(content.items, draw.chars);
  for (const it of content.items) {
    const str = String(it.str || '');
    if (!str.trim() || !it.transform) continue;
    const t = mul(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]);
    if (!(size > 0.5)) continue;
    const st = await fontStyle(state, pg, i, it.fontName, content.styles);
    const x0 = t[4];
    const width = Math.abs(it.width || 0) || str.length * size * 0.5;
    page.pieces.push({ text: str, x0, x1: x0 + width, y: t[5], size, ...st, color: it.color || null });
  }
  // Immagini dentro le pagine con testo: si ritagliano dalla pagina disegnata.
  const area = vp.width * vp.height;
  const keep = draw.images.filter((b) => {
    const bw = Math.min(b.x1, vp.width) - Math.max(b.x0, 0); const bh = Math.min(b.bottom, vp.height) - Math.max(b.top, 0);
    return bw >= 16 && bh >= 16 && bw * bh < area * 0.7; // le immagini a tutta pagina sono sfondi o scansioni con testo nascosto
  });
  if (keep.length && !state.noImages) {
    const scale = Math.min(2, Math.sqrt(8e6 / area));
    const canvas = await renderCanvas(pg, scale);
    for (const b of keep.slice(0, 40)) {
      const x0 = Math.max(0, b.x0); const y0 = Math.max(0, b.top);
      const x1 = Math.min(vp.width, b.x1); const y1 = Math.min(vp.height, b.bottom);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((x1 - x0) * scale)); c.height = Math.max(1, Math.round((y1 - y0) * scale));
      c.getContext('2d').drawImage(canvas, x0 * scale, y0 * scale, c.width, c.height, 0, 0, c.width, c.height);
      page.images.push({ x0, x1, top: y0, bottom: y1, ...(await canvasBytes(c, c.width * c.height > 250000)) });
    }
    canvas.width = 0;
  }
  return page;
}

// --- Righe, paragrafi e tabelle -----------------------------------------------------------------
const sameStyle = (a, b) => a.bold === b.bold && a.italic === b.italic && a.font === b.font && a.color === b.color && Math.abs(a.size - b.size) < 0.6;

function pushRun(runs, text, st) {
  const last = runs[runs.length - 1];
  if (last && sameStyle(last, st)) last.text += text;
  else runs.push({ text, bold: st.bold, italic: st.italic, font: st.font, color: st.color, size: st.size });
}

function dominantSize(pieces) {
  const w = new Map();
  for (const p of pieces) { const k = Math.round(p.size * 2) / 2; w.set(k, (w.get(k) || 0) + p.text.replace(/\s/g, '').length + 0.01); }
  let best = 0; let bw = -1;
  for (const [k, v] of w) if (v > bw) { bw = v; best = k; }
  return best || 11;
}

function buildLines(pieces) {
  const sorted = [...pieces].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines = [];
  for (const p of sorted) {
    let ln = null;
    if (p.line != null) ln = lines.find((l) => l.key === p.line) || null;
    else {
      for (let k = lines.length - 1; k >= Math.max(0, lines.length - 4); k -= 1) {
        const l = lines[k];
        if (Math.abs(l.y - p.y) <= Math.min(l.size, p.size) * 0.45) { ln = l; break; }
      }
    }
    if (!ln) { ln = { key: p.line, y: p.y, size: p.size, pieces: [] }; lines.push(ln); }
    // Testo disegnato due volte quasi nello stesso punto (finto grassetto): si tiene una volta sola.
    if (ln.pieces.some((q) => q.text === p.text && Math.abs(q.x0 - p.x0) < 1.2)) continue;
    ln.pieces.push(p);
  }
  for (const ln of lines) {
    ln.pieces.sort((a, b) => a.x0 - b.x0);
    ln.size = dominantSize(ln.pieces);
    const main = ln.pieces.filter((p) => Math.abs(p.size - ln.size) < 0.6);
    ln.y = (main.length ? main : ln.pieces).reduce((s, p) => s + p.y, 0) / (main.length || ln.pieces.length);
    ln.segs = [];
    let cur = null;
    for (const p of ln.pieces) {
      const gap = cur ? p.x0 - cur.x1 : 0;
      if (cur && gap > Math.max(1.8 * ln.size, 14)) cur = null; // grande distanza: un'altra colonna
      if (!cur) { cur = { x0: p.x0, x1: p.x1, runs: [] }; ln.segs.push(cur); pushRun(cur.runs, p.text.replace(/^\s+/, ''), p); continue; }
      const prev = cur.runs[cur.runs.length - 1];
      if (gap > 0.12 * p.size && !/\s$/.test(prev.text) && !/^\s/.test(p.text)) pushRun(cur.runs, ' ', prev);
      pushRun(cur.runs, p.text, p);
      cur.x1 = Math.max(cur.x1, p.x1);
    }
    for (const s of ln.segs) { const r = s.runs[s.runs.length - 1]; r.text = r.text.replace(/\s+$/, ''); s.text = s.runs.map((r2) => r2.text).join(''); }
    ln.segs = ln.segs.filter((s) => s.text.trim());
    ln.x0 = ln.segs[0]?.x0 ?? 0;
    ln.x1 = ln.segs[ln.segs.length - 1]?.x1 ?? 0;
    ln.text = ln.segs.map((s) => s.text).join(' ');
    ln.allBold = ln.segs.every((s) => s.runs.every((r) => r.bold || !r.text.trim()));
  }
  return lines.filter((l) => l.segs.length).sort((a, b) => a.y - b.y);
}

const isCentered = (ln, g) => {
  const li = ln.x0 - g.left; const ri = g.right - ln.x1;
  return li > 0.06 * g.width && ri > 0.06 * g.width && Math.abs(li - ri) < Math.max(0.04 * g.width, 1.2 * ln.size);
};
const isRight = (ln, g) => Math.abs(g.right - ln.x1) < Math.max(0.015 * g.width, 0.6 * ln.size) && ln.x0 - g.left > 0.3 * g.width;

function continues(para, b, g) {
  const a = para[para.length - 1];
  const gap = b.y - a.y;
  if (gap <= 0.3 * a.size || gap > 1.75 * a.size) return false;
  if (b.size / a.size > 1.15 || a.size / b.size > 1.15) return false;
  if (a.allBold && !b.allBold) return false; // riga in grassetto (titoletto) seguita da testo normale
  if (BULLET.test(b.text)) return false;
  if (isCentered(a, g) || isCentered(b, g) || isRight(a, g)) return false;
  // La prima parola della riga dopo ci stava nella riga prima: il paragrafo era finito.
  const first = (b.text.match(/^\S+/) || [''])[0];
  if (a.x1 + (first.length + 1) * 0.5 * b.size < g.right - 0.5 * a.size) return false;
  if (para.length === 1 && b.x0 > a.x0 + 0.8 * a.size) return false;
  if (para.length >= 2) {
    if (Math.abs(b.x0 - a.x0) > 0.8 * a.size) return false;
    const pitch = a.y - para[para.length - 2].y;
    if (Math.abs(gap - pitch) > 0.35 * a.size) return false;
  }
  return true;
}

function makeTable(lines) {
  // Colonne: le zone orizzontali occupate dal testo, unite se si toccano.
  const iv = lines.flatMap((l) => l.segs.map((s) => [s.x0, s.x1])).sort((a, b) => a[0] - b[0]);
  const size = dominantSize(lines.flatMap((l) => l.pieces));
  const cols = [];
  for (const [a, b] of iv) {
    const last = cols[cols.length - 1];
    if (last && a <= last[1] + 0.5 * size) last[1] = Math.max(last[1], b);
    else cols.push([a, b]);
  }
  if (cols.length < 2 || cols.length > 20) return null;
  const rows = lines.map((l) => {
    const cells = cols.map(() => ({ runs: [], segs: [] }));
    for (const s of l.segs) {
      const c = cols.findIndex(([a, b]) => s.x0 >= a - 0.5 && s.x1 <= b + 0.5);
      const cell = cells[c < 0 ? 0 : c];
      if (cell.runs.length) pushRun(cell.runs, ' ', cell.runs[cell.runs.length - 1]);
      for (const r of s.runs) pushRun(cell.runs, r.text, r);
      cell.segs.push(s);
    }
    return { y: l.y, size: l.size, cells };
  });
  const filled = rows.flatMap((r) => r.cells.filter((c) => c.runs.length));
  const avg = filled.reduce((n, c) => n + c.runs.map((r) => r.text).join('').length, 0) / (filled.length || 1);
  if (avg > 60) return null; // testo lungo su due colonne: non è una tabella
  // Allineamento di ogni colonna: a destra se i bordi destri coincidono meglio di quelli sinistri.
  const align = cols.map((_c, k) => {
    const segs = rows.flatMap((r) => r.cells[k].segs);
    if (segs.length < 2) return 'left';
    const spread = (f) => Math.max(...segs.map(f)) - Math.min(...segs.map(f));
    const l = spread((s) => s.x0); const r = spread((s) => s.x1); const c = spread((s) => (s.x0 + s.x1) / 2);
    if (r + 1 < l && r <= c) return 'right';
    if (c + 1 < l && c < r) return 'center';
    return 'left';
  });
  const pitches = rows.slice(1).map((r, k) => r.y - rows[k].y);
  const pitch = pitches.length ? pitches.reduce((s, v) => s + v, 0) / pitches.length : size * 1.4;
  return { type: 'tbl', cols, rows, align, size, pitch, top: rows[0].y - ASC * size - Math.max(0, pitch - 1.15 * size) / 2, bottom: rows[rows.length - 1].y + DESC * size + Math.max(0, pitch - 1.15 * size) / 2 };
}

function makePara(lines, g, body) {
  const size = dominantSize(lines.flatMap((l) => l.pieces));
  const runs = [];
  const tabs = [];
  if (lines.length === 1 && lines[0].segs.length > 1) {
    // Una riga con blocchi lontani (es. «Luogo .... Data ....»): tabulazioni nelle posizioni del PDF.
    const ln = lines[0];
    ln.segs.forEach((s, k) => {
      if (k > 0) {
        const last = k === ln.segs.length - 1 && isRight({ x0: s.x0, x1: s.x1, size }, g);
        tabs.push(last ? { kind: 'right', pos: tw(s.x1 - g.left) } : { kind: 'left', pos: tw(s.x0 - g.left) });
        pushRun(runs, '\t', s.runs[0]);
      }
      for (const r of s.runs) pushRun(runs, r.text, r);
    });
  } else {
    lines.forEach((ln, k) => {
      const seg = ln.segs[0];
      if (k > 0) {
        const prev = runs[runs.length - 1];
        // Parola divisa a fine riga con il trattino: si riunisce.
        if (/\p{L}-$/u.test(prev.text) && /^\p{Ll}/u.test(seg.text)) prev.text = prev.text.slice(0, -1);
        else pushRun(runs, ' ', prev);
      }
      for (const r of seg.runs) pushRun(runs, r.text, r);
    });
  }
  const first = lines[0]; const last = lines[lines.length - 1];
  let align = 'left';
  if (lines.length === 1) {
    if (isCentered(first, g)) align = 'center';
    else if (isRight(first, g)) align = 'right';
  } else if (lines.every((l) => isCentered(l, g))) align = 'center';
  else if (lines.length >= 3) {
    // Giustificato: tutte le righe tranne l'ultima finiscono allo stesso punto, sul margine destro.
    const ends = lines.slice(0, -1).map((l) => l.x1);
    if (Math.max(...ends) - Math.min(...ends) < 0.6 * size && Math.abs(g.right - Math.max(...ends)) < Math.max(0.015 * g.width, 0.6 * size)) align = 'both';
  }
  const rest = lines.length > 1 ? lines[1].x0 : first.x0;
  const ind = align === 'left' || align === 'both' ? { left: Math.max(0, rest - g.left), first: first.x0 - rest } : { left: 0, first: 0 };
  const text = runs.map((r) => r.text).join('');
  let style = null;
  if (text.length <= 160 && lines.length <= 3 && body) {
    if (size >= body * 1.5) style = 'Heading1';
    else if (size >= body * 1.2) style = 'Heading2';
  }
  let pitch = null;
  if (lines.length > 1) pitch = (last.y - first.y) / (lines.length - 1);
  const lineH = pitch ? (pitch >= 1.15 * size ? pitch : Math.max(pitch, 1.02 * size)) : null;
  const top = first.y - (lineH ? lineH - DESC * size : ASC * size);
  return { type: 'p', runs, tabs, align, ind, style, size, pitch: lineH, rule: pitch && pitch >= 1.15 * size ? 'atLeast' : 'exact', top, bottom: last.y + DESC * size };
}

function pageBlocks(page, g, body) {
  const lines = buildLines(page.pieces);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].segs.length >= 2) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].segs.length >= 2 && lines[j + 1].y - lines[j].y < 3.2 * lines[j].size) j += 1;
      const tbl = j > i ? makeTable(lines.slice(i, j + 1)) : null;
      if (tbl) { blocks.push(tbl); i = j + 1; continue; }
      blocks.push(makePara([lines[i]], g, body));
      i += 1;
      continue;
    }
    const para = [lines[i]];
    let k = i + 1;
    while (k < lines.length && lines[k].segs.length === 1 && continues(para, lines[k], g)) { para.push(lines[k]); k += 1; }
    blocks.push(makePara(para, g, body));
    i = k;
  }
  for (const im of page.images) blocks.push({ type: 'img', ...im });
  return blocks.sort((a, b) => a.top - b.top);
}

// --- Scrittura dell'OOXML -----------------------------------------------------------------------
function runXml(r, opts = {}) {
  const rpr = [];
  if (r.font) rpr.push(`<w:rFonts w:ascii="${esc(r.font)}" w:hAnsi="${esc(r.font)}" w:cs="${esc(r.font)}"/>`);
  if (r.bold) rpr.push('<w:b/><w:bCs/>'); else if (opts.heading) rpr.push('<w:b w:val="0"/><w:bCs w:val="0"/>');
  if (r.italic) rpr.push('<w:i/><w:iCs/>');
  if (r.color) rpr.push(`<w:color w:val="${r.color}"/>`);
  const hp = clamp(Math.round(r.size * 2), 2, 3276);
  rpr.push(`<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`);
  const parts = String(r.text).replace(/[\r\n]+/g, ' ').split('\t');
  const body = parts.map((t, k) => `${k ? '<w:tab/>' : ''}${t ? `<w:t xml:space="preserve">${esc(t)}</w:t>` : ''}`).join('');
  return `<w:r><w:rPr>${rpr.join('')}</w:rPr>${body}</w:r>`;
}

function pXml({ style, tabs, before = 0, line, rule, ind, align, runs = [], extra = '', sect = '', markSize }) {
  const ppr = [];
  if (style) ppr.push(`<w:pStyle w:val="${style}"/>`);
  if (tabs?.length) ppr.push(`<w:tabs>${tabs.map((t) => `<w:tab w:val="${t.kind}" w:pos="${t.pos}"/>`).join('')}</w:tabs>`);
  ppr.push(`<w:spacing w:before="${tw(before)}" w:after="0"${line ? ` w:line="${Math.max(20, tw(line))}" w:lineRule="${rule || 'exact'}"` : ''}/>`);
  if (ind && (ind.left > 2 || Math.abs(ind.first) > 2)) {
    const f = Math.abs(ind.first) > 2 ? (ind.first > 0 ? ` w:firstLine="${tw(ind.first)}"` : ` w:hanging="${tw(Math.min(-ind.first, ind.left))}"`) : '';
    ppr.push(`<w:ind w:left="${tw(ind.left)}"${f}/>`);
  }
  if (align && align !== 'left') ppr.push(`<w:jc w:val="${align}"/>`);
  if (markSize) ppr.push(`<w:rPr><w:sz w:val="${markSize}"/><w:szCs w:val="${markSize}"/></w:rPr>`);
  if (sect) ppr.push(sect);
  return `<w:p><w:pPr>${ppr.join('')}</w:pPr>${runs.map((r) => runXml(r, { heading: !!style })).join('')}${extra}</w:p>`;
}

function drawingXml(rid, id, wPt, hPt, name) {
  const cx = Math.round(wPt * EMU); const cy = Math.round(hPt * EMU);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="${esc(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function tblXml(t, g, before) {
  const k = t.cols.length;
  // Ogni colonna comincia poco prima del suo testo; l'ultima è larga almeno quanto la media delle altre.
  const bounds = t.cols.map((c) => c[0] - 3);
  const avg = k > 1 ? (bounds[k - 1] - bounds[0]) / (k - 1) : 0;
  bounds.push(Math.max(t.cols[k - 1][1] + 3, Math.min(bounds[k - 1] + avg, g.right + 3)));
  const widths = t.cols.map((_c, c) => Math.max(240, tw(bounds[c + 1] - bounds[c])));
  const total = widths.reduce((s, v) => s + v, 0);
  const brd = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('');
  const indent = Math.round((bounds[0] - g.left) * TW);
  const rowH = Math.max(tw(t.pitch), tw(t.size * 1.15));
  const rows = t.rows.map((r) => `<w:tr><w:trPr><w:trHeight w:val="${rowH}" w:hRule="atLeast"/></w:trPr>${r.cells.map((cell, c) => `<w:tc><w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${pXml({ runs: cell.runs, align: t.align[c] })}</w:tc>`).join('')}</w:tr>`).join('');
  const spacer = before > 2 ? pXml({ before: 0, line: before, rule: 'exact', markSize: 2 }) : '';
  return `${spacer}<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblInd w:w="${indent}" w:type="dxa"/><w:tblBorders>${brd}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="57" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
}

function sectXml(sec, margins, withType) {
  const W = clamp(Math.round(sec.w * TW), 1440, 31680); const H = clamp(Math.round(sec.h * TW), 1440, 31680);
  const m = margins;
  return `<w:sectPr>${withType ? '<w:type w:val="nextPage"/>' : ''}<w:pgSz w:w="${W}" w:h="${H}"${W > H ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${tw(m.top)}" w:right="${tw(m.right)}" w:bottom="${tw(m.bottom)}" w:left="${tw(m.left)}" w:header="${Math.min(708, tw(m.top / 2))}" w:footer="${Math.min(708, tw(m.bottom / 2))}" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>`;
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function stylesXml() {
  const brd = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('');
  return `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="it-IT" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:tblPr><w:tblBorders>${brd}</w:tblBorders></w:tblPr></w:style>`
    + '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style></w:styles>';
}

function packageDocx(bodyXml, media, title) {
  const { zipSync, strToU8 } = window.fflate;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const rels = ['<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>']
    .concat(media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`));
  const files = {
    '[Content_Types].xml': strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    '_rels/.rels': strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'word/document.xml': strToU8(`${XML}<w:document ${NS}><w:body>${bodyXml}</w:body></w:document>`),
    'word/styles.xml': strToU8(stylesXml()),
    'word/_rels/document.xml.rels': strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`),
    'docProps/core.xml': strToU8(`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title || '')}</dc:title><dc:creator>Postilla</dc:creator><cp:lastModifiedBy>Postilla</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`),
  };
  for (const m of media) files[`word/media/${m.name}`] = [m.bytes, { level: 0 }];
  return zipSync(files, { level: 6 });
}

// --- Da PDF a Word ----------------------------------------------------------------------------
// source: un DocView aperto oppure i byte di un PDF. Restituisce { bytes, report }.
export async function convertPdfToDocx(source, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const cancelled = opts.isCancelled || (() => false);
  const view = source && source.pdf && typeof source.pdf.getPage === 'function' ? source : null;
  let pdf = view?.pdf;
  let bytes = null;
  if (!view) { bytes = toU8(source); pdf = await openPdf(bytes); }
  const state = {
    ocr: opts.ocr !== undefined ? opts.ocr : view?.ocr,
    fontCache: new Map(),
    libDoc: null,
    getBytes: async () => bytes || view?.cleanBytes || (view?.ensureBytes ? view.ensureBytes() : null),
  };
  const report = { pages: pdf.numPages, textPages: 0, ocrPages: 0, imagePages: 0, blankPages: 0, images: 0, tables: 0, headings: 0, ms: 0 };
  const t0 = performance.now();
  try {
    const pages = [];
    for (let i = 0; i < pdf.numPages; i += 1) {
      if (cancelled()) throw new Error('annullato');
      onProgress(i / pdf.numPages * 0.92, `Lettura della pagina ${i + 1} di ${pdf.numPages}`);
      const page = await readPage(state, pdf, i);
      pages.push(page);
      report[{ text: 'textPages', ocr: 'ocrPages', scan: 'imagePages', blank: 'blankPages' }[page.kind]] += 1;
    }
    if (cancelled()) throw new Error('annullato');
    onProgress(0.94, 'Creazione del file Word…');
    // Margini comuni a tutto il documento, ricavati dalla posizione del testo.
    let L = Infinity; let R = Infinity; let T = Infinity; let B = Infinity;
    const allPieces = [];
    for (const p of pages) {
      for (const q of p.pieces) {
        L = Math.min(L, q.x0); R = Math.min(R, p.w - q.x1);
        T = Math.min(T, q.y - q.size); B = Math.min(B, p.h - q.y - q.size * 0.3);
        allPieces.push(q);
      }
      for (const im of p.images) { L = Math.min(L, im.x0); R = Math.min(R, p.w - im.x1); T = Math.min(T, im.top); B = Math.min(B, p.h - im.bottom); }
    }
    const fix = (v) => (Number.isFinite(v) ? clamp(v, 9, 144) : 56.7);
    L = fix(L); R = fix(R); T = fix(T); B = fix(B);
    // Un po' di margine in più a destra e in basso: in Word le righe non devono andare a capo né sforare la pagina.
    const margins = { left: L, right: Math.max(9, R * 0.75), top: T, bottom: Math.max(9, B * 0.4) };
    const body = allPieces.length ? dominantSize(allPieces) : 11;
    const media = [];
    let drawId = 1;
    const out = [];
    for (let pi = 0; pi < pages.length; pi += 1) {
      const p = pages[pi];
      const g = { left: L, right: p.w - R, width: Math.max(50, p.w - R - L) };
      const avail = { w: p.w - margins.left - margins.right, h: p.h - margins.top - margins.bottom - 4 };
      const parts = []; // { xml, kind }
      const addImage = (imgBytes, ext, wPt, hPt, before, indent, name) => {
        const k = Math.min(1, avail.w / wPt, avail.h / hPt);
        const rid = `rIdImg${media.length + 1}`;
        media.push({ rid, name: `immagine${media.length + 1}.${ext}`, bytes: imgBytes });
        report.images += 1;
        const id = drawId; drawId += 1;
        parts.push({ kind: 'p', xml: (sect, brk) => pXml({ before, ind: { left: Math.max(0, Math.min(indent, avail.w - wPt * k)), first: 0 }, extra: drawingXml(rid, id, wPt * k, hPt * k, name) + brk, sect }) });
      };
      if (p.kind === 'scan') {
        addImage(p.scan.bytes, p.scan.ext, p.scan.wPt, p.scan.hPt, 0, 0, `Pagina ${pi + 1}`);
        report.images -= 1;
      } else if (p.kind === 'text' || p.kind === 'ocr') {
        let prevBottom = margins.top;
        // Con l'OCR le dimensioni sono stimate: i titoli si cercano solo rispetto al testo della stessa pagina.
        const pageBody = p.kind === 'ocr' ? dominantSize(p.pieces) : body;
        for (const b of pageBlocks(p, g, pageBody)) {
          const before = clamp(b.top - prevBottom, 0, 1500);
          if (b.type === 'p') {
            if (b.style) report.headings += 1;
            parts.push({ kind: 'p', xml: (sect, brk) => pXml({ style: b.style, tabs: b.tabs, before, line: b.pitch, rule: b.rule, ind: b.ind, align: b.align, runs: b.runs, extra: brk, sect }) });
          } else if (b.type === 'tbl') {
            report.tables += 1;
            parts.push({ kind: 'tbl', xml: () => tblXml(b, g, before) });
          } else if (b.type === 'img') {
            addImage(b.bytes, b.ext, b.x1 - b.x0, b.bottom - b.top, before, b.x0 - L, `Immagine pagina ${pi + 1}`);
          }
          prevBottom = Math.max(prevBottom, b.bottom);
        }
      }
      // Fine pagina: interruzione di pagina, oppure nuova sezione se la pagina dopo ha un'altra dimensione.
      const next = pages[pi + 1];
      const sameSize = next && Math.abs(next.w - p.w) < 1 && Math.abs(next.h - p.h) < 1;
      const brk = next && sameSize ? '<w:r><w:br w:type="page"/></w:r>' : '';
      const sect = next && !sameSize ? sectXml(p, margins, false) : '';
      const last = parts[parts.length - 1];
      if (last && last.kind === 'p') parts[parts.length - 1] = { kind: 'p', xml: () => last.xml(sect, brk) };
      else if (next) parts.push({ kind: 'p', xml: () => pXml({ line: 1, rule: 'exact', markSize: 2, extra: brk, sect }) });
      out.push(...parts.map((x) => x.xml('', '')));
    }
    const lastPage = pages[pages.length - 1] || { w: 595.3, h: 841.9 };
    if (!out.length) out.push(pXml({}));
    out.push(sectXml(lastPage, margins, false));
    const title = view?.tab?.name?.replace(/\.pdf$/i, '') || '';
    const zip = packageDocx(out.join(''), media, title);
    report.ms = Math.round(performance.now() - t0);
    onProgress(1, 'Fatto');
    return { bytes: zip, report };
  } finally {
    if (!view) pdf.loadingTask.destroy().catch(() => {});
  }
}

export async function pdfToDocx(source, opts = {}) {
  return (await convertPdfToDocx(source, opts)).bytes;
}

// --- Da Word a PDF nel renderer (riserva per Android) ------------------------------------------
// Dimensioni della pagina e margini scritti nel documento Word (in punti); A4 con 2 cm se mancano.
export function docxGeometry(u8) {
  const geo = { w: 595.3, h: 841.9, top: 56.7, right: 56.7, bottom: 56.7, left: 56.7 };
  try {
    const files = window.fflate.unzipSync(u8, { filter: (f) => f.name === 'word/document.xml' });
    const xml = window.fflate.strFromU8(files['word/document.xml']);
    const sz = [...xml.matchAll(/<w:pgSz\b[^>]*>/g)].pop()?.[0];
    const mar = [...xml.matchAll(/<w:pgMar\b[^>]*>/g)].pop()?.[0];
    const num = (tag, a) => { const m = tag && tag.match(new RegExp(`w:${a}="(-?\\d+)"`)); return m ? Math.abs(+m[1]) / TW : null; };
    if (num(sz, 'w') && num(sz, 'h')) { geo.w = num(sz, 'w'); geo.h = num(sz, 'h'); }
    for (const k of ['top', 'right', 'bottom', 'left']) { const v = num(mar, k); if (v != null) geo[k] = clamp(v, 14, geo.w / 3); }
  } catch { /* si usano i valori standard */ }
  return geo;
}

const isZip = (u8) => u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b;

function dataUriBytes(src) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src || '');
  if (!m || !m[2]) return null;
  const bin = atob(m[3]);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k += 1) out[k] = bin.charCodeAt(k);
  return { type: m[1], bytes: out };
}

class PdfLayout {
  constructor(doc, geo, fonts) {
    Object.assign(this, { doc, geo, fonts });
    this.width = geo.w - geo.left - geo.right;
    this.page = null;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([this.geo.w, this.geo.h]);
    this.y = this.geo.top; // dall'alto
    this.fresh = true;
  }

  ensure(hgt) { if (!this.fresh && this.y + hgt > this.geo.h - this.geo.bottom) this.newPage(); }

  font(st) { return this.fonts[(st.bold ? 1 : 0) + (st.italic ? 2 : 0)]; }

  // I caratteri standard del PDF conoscono solo l'alfabeto occidentale: gli altri diventano «?».
  clean(text, font) {
    if (!font._set) font._set = new Set(font.getCharacterSet());
    let s = '';
    for (const ch of String(text).replace(/\t/g, '    ')) {
      const cp = ch.codePointAt(0);
      if (font._set.has(cp)) s += ch;
      else if (/[‘’]/.test(ch)) s += "'";
      else if (/[“”]/.test(ch)) s += '"';
      else if (/[–—]/.test(ch)) s += '-';
      else if (/\s/.test(ch)) s += ' ';
      else s += '?';
    }
    return s;
  }

  // Spezza i pezzi di testo in righe che stanno nella larghezza data.
  wrap(runs, maxW) {
    const lines = [];
    let line = []; let w = 0;
    const flush = () => { while (line.length && line[line.length - 1].space) w -= line.pop().w; lines.push({ items: line, w }); line = []; w = 0; };
    for (const r of runs) {
      if (r.br) { flush(); continue; }
      const font = this.font(r);
      const size = r.size;
      for (const tok of this.clean(r.text, font).split(/(\s+)/)) {
        if (!tok) continue;
        const space = /^\s+$/.test(tok);
        if (space && !line.length) continue;
        const text = space ? ' ' : tok;
        let tw2 = font.widthOfTextAtSize(text, size);
        if (!space && w + tw2 > maxW && line.length) flush();
        if (!space && tw2 > maxW) {
          // Parola più lunga della riga: si spezza.
          let part = '';
          for (const ch of text) {
            const pw = font.widthOfTextAtSize(part + ch, size);
            if (pw > maxW && part) { line.push({ text: part, w: font.widthOfTextAtSize(part, size), r, font }); w += font.widthOfTextAtSize(part, size); flush(); part = ''; }
            part += ch;
          }
          tw2 = font.widthOfTextAtSize(part, size);
          line.push({ text: part, w: tw2, r, font }); w += tw2;
          continue;
        }
        line.push({ text, w: tw2, r, font, space }); w += tw2;
      }
    }
    if (line.length || !lines.length) flush();
    return lines;
  }

  drawLines(lines, x, maxW, align = 'left') {
    for (const ln of lines) {
      const size = Math.max(...ln.items.map((it) => it.r.size), 10);
      const lh = size * 1.28;
      this.ensure(lh);
      this.fresh = false;
      const base = this.geo.h - (this.y + size);
      let cx = x + (align === 'center' ? (maxW - ln.w) / 2 : align === 'right' ? maxW - ln.w : 0);
      const { rgb } = window.PDFLib;
      for (const it of ln.items) {
        if (!it.space) {
          const color = it.r.link ? rgb(0.1, 0.25, 0.65) : (it.r.color ? rgb(...it.r.color) : rgb(0, 0, 0));
          this.page.drawText(it.text, { x: cx, y: base, size: it.r.size, font: it.font, color });
          if (it.r.underline || it.r.link) this.page.drawLine({ start: { x: cx, y: base - 1.2 }, end: { x: cx + it.w, y: base - 1.2 }, thickness: 0.5, color });
        }
        cx += it.w;
      }
      this.y += lh;
    }
  }

  paragraph(runs, { indent = 0, before = 0, after = 6, align = 'left', bullet = null } = {}) {
    if (!runs.some((r) => r.br || String(r.text || '').trim())) return;
    this.y += this.fresh ? 0 : before;
    const x = this.geo.left + indent;
    const maxW = this.width - indent;
    const lines = this.wrap(runs, maxW);
    if (bullet) {
      const size = runs[0]?.size || 11;
      this.ensure(size * 1.28);
      const f = this.fonts[0];
      this.page.drawText(this.clean(bullet, f), { x: x - 14, y: this.geo.h - (this.y + size), size, font: f });
    }
    this.drawLines(lines, x, maxW, align);
    this.y += after;
  }

  async image(src, indent = 0) {
    const d = dataUriBytes(src);
    if (!d) return false;
    let img;
    try {
      if (/png/i.test(d.type)) img = await this.doc.embedPng(d.bytes);
      else if (/jpe?g/i.test(d.type)) img = await this.doc.embedJpg(d.bytes);
      else return false;
    } catch { return false; }
    const maxW = this.width - indent;
    const maxH = this.geo.h - this.geo.top - this.geo.bottom;
    let w = img.width * 0.75; let hh = img.height * 0.75;
    const k = Math.min(1, maxW / w, maxH / hh);
    w *= k; hh *= k;
    this.ensure(hh + 4);
    this.fresh = false;
    this.page.drawImage(img, { x: this.geo.left + indent, y: this.geo.h - this.y - hh, width: w, height: hh });
    this.y += hh + 6;
    return true;
  }

  table(rows) {
    const n = Math.max(...rows.map((r) => r.length));
    if (!n) return;
    const { rgb } = window.PDFLib;
    const colW = this.width / n;
    const pad = 4;
    this.y += this.fresh ? 0 : 4;
    for (const row of rows) {
      const cells = row.map((runs) => this.wrap(runs, colW - 2 * pad));
      const hgt = Math.max(...cells.map((ls) => ls.reduce((s, ln) => s + Math.max(...ln.items.map((it) => it.r.size), 10) * 1.28, 0))) + 2 * pad;
      this.ensure(hgt);
      this.fresh = false;
      const top = this.y;
      for (let c = 0; c < n; c += 1) {
        const x = this.geo.left + c * colW;
        this.page.drawRectangle({ x, y: this.geo.h - top - hgt, width: colW, height: hgt, borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.6 });
        if (!cells[c]) continue;
        this.y = top + pad;
        const saveEnsure = this.ensure; this.ensure = () => {}; // la riga non si spezza fra due pagine
        this.drawLines(cells[c], x + pad, colW - 2 * pad);
        this.ensure = saveEnsure;
      }
      this.y = top + hgt;
    }
    this.y += 8;
  }
}

function inlineRuns(node, st, out, images) {
  for (const ch of node.childNodes) {
    if (ch.nodeType === 3) { if (ch.nodeValue) out.push({ ...st, text: ch.nodeValue.replace(/\s+/g, ' ') }); continue; }
    if (ch.nodeType !== 1) continue;
    const tag = ch.tagName.toLowerCase();
    if (tag === 'br') out.push({ ...st, br: true, text: '' });
    else if (tag === 'img') images.push(ch.getAttribute('src'));
    else if (['ul', 'ol', 'table'].includes(tag)) continue; // blocchi annidati: li tratta il chiamante
    else {
      const s2 = { ...st };
      if (tag === 'strong' || tag === 'b') s2.bold = true;
      if (tag === 'em' || tag === 'i') s2.italic = true;
      if (tag === 'u') s2.underline = true;
      if (tag === 'a') s2.link = true;
      if (tag === 'sup' || tag === 'sub') s2.size = st.size * 0.75;
      inlineRuns(ch, s2, out, images);
    }
  }
  return out;
}

async function layoutBlocks(L, node, depth = 0) {
  const base = { size: 11, bold: false, italic: false };
  const HS = { h1: 20, h2: 16, h3: 14, h4: 12.5, h5: 12, h6: 11 };
  let loose = [];
  const flushLoose = async () => {
    if (!loose.length) return;
    const imgs = [];
    const runs = [];
    for (const n of loose) inlineRuns({ childNodes: [n] }, base, runs, imgs);
    L.paragraph(runs, { indent: depth * 18 });
    for (const src of imgs) await L.image(src, depth * 18);
    loose = [];
  };
  for (const el of node.childNodes) {
    if (el.nodeType === 3 || (el.nodeType === 1 && ['strong', 'b', 'em', 'i', 'u', 'a', 'span', 'br', 'img', 'sup', 'sub'].includes(el.tagName.toLowerCase()))) { loose.push(el); continue; }
    if (el.nodeType !== 1) continue;
    await flushLoose();
    const tag = el.tagName.toLowerCase();
    const imgs = [];
    if (HS[tag]) {
      L.paragraph(inlineRuns(el, { ...base, size: HS[tag], bold: true }, [], imgs), { before: 10, after: 5 });
    } else if (tag === 'p') {
      L.paragraph(inlineRuns(el, base, [], imgs), { indent: depth * 18 });
    } else if (tag === 'ul' || tag === 'ol') {
      let n = 0;
      for (const li of el.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        n += 1;
        const indent = (depth + 1) * 18;
        L.paragraph(inlineRuns(li, base, [], imgs), { indent, after: 3, bullet: tag === 'ol' ? `${n}.` : '•' });
        for (const sub of li.children) if (['ul', 'ol', 'table'].includes(sub.tagName.toLowerCase())) await layoutBlocks(L, { childNodes: [sub] }, depth + 1);
      }
      L.y += 3;
    } else if (tag === 'table') {
      const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => inlineRuns(td, { ...base, size: 9.5, bold: td.tagName.toLowerCase() === 'th' }, [], imgs)));
      if (rows.length) L.table(rows);
    } else {
      await layoutBlocks(L, el, depth);
    }
    for (const src of imgs) await L.image(src, depth * 18);
  }
  await flushLoose();
}

// Da .docx a PDF senza processo principale: leggibile e corretto, non identico all'originale.
export async function docxToPdfRenderer(bytes) {
  const u8 = toU8(bytes);
  if (!isZip(u8)) throw new Error('Il file non è un documento Word .docx. Il vecchio formato .doc si converte solo con Word o LibreOffice sul PC.');
  const geo = docxGeometry(u8);
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: ab });
  const dom = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  const { PDFDocument, StandardFonts } = window.PDFLib;
  const doc = await PDFDocument.create();
  const fonts = await Promise.all([StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique].map((f) => doc.embedFont(f)));
  const L = new PdfLayout(doc, geo, fonts);
  await layoutBlocks(L, dom.body);
  doc.setProducer('Postilla');
  doc.setCreator('Postilla');
  return doc.save();
}

// --- Interfaccia ------------------------------------------------------------------------------
let styled = false;
function addStyle() {
  if (styled) return;
  styled = true;
  document.head.append(h('style', {}, `
#word-progress { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 61; display: flex; align-items: center; gap: 12px; background: var(--ink, #22302f); color: #fff; padding: 8px 10px 8px 16px; border-radius: 12px; box-shadow: 0 6px 24px #0005; max-width: calc(100vw - 32px); }
#word-progress .wp-label { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#word-progress .wp-track { width: 160px; height: 6px; border-radius: 3px; background: #ffffff33; overflow: hidden; flex: none; }
#word-progress .wp-track i { display: block; height: 100%; width: 0; background: #ffe14d; transition: width .2s; }
#word-progress button { color: #fff; border-color: #ffffff66; min-height: 36px; }
`));
}

function progressBar(onCancel) {
  addStyle();
  document.getElementById('word-progress')?.remove();
  const label = h('span', { class: 'wp-label' }, '');
  const fill = h('i', {});
  const el = h('div', { id: 'word-progress', role: 'status', 'aria-live': 'polite' }, label, h('span', { class: 'wp-track' }, fill),
    onCancel ? h('button', { onclick: onCancel }, 'Annulla') : null);
  document.body.append(el);
  return {
    set: (text, frac) => { if (text) label.textContent = text; if (frac != null) fill.style.width = `${Math.round(clamp(frac, 0, 1) * 100)}%`; },
    remove: () => el.remove(),
  };
}

const ENGINE_NAME = { word: 'Microsoft Word', libreoffice: 'LibreOffice', interno: 'il motore interno di Postilla' };

// Esporta il documento aperto in Word. hostOverride serve solo alle prove automatiche.
export async function exportWordFlow(app, view, hostOverride) {
  const H = hostOverride || window.host;
  view = view || app?.view;
  if (!view?.pdf) { toast('Apri prima un PDF da esportare in Word.'); return null; }
  const srcPath = view.tab?.path || view.sourcePath || 'documento.pdf';
  const suggested = srcPath.replace(/\.pdf$/i, '') + '.docx';
  let dest = H.wordPickSave ? await H.wordPickSave(suggested) : await H.pickSave(suggested);
  if (!dest) return null;
  if (!/\.docx$/i.test(dest)) dest = dest.replace(/\.pdf$/i, '') + '.docx';
  const job = { cancelled: false };
  const bar = progressBar(() => { job.cancelled = true; });
  try {
    bar.set('Preparazione…', 0);
    const { bytes, report } = await convertPdfToDocx(view, { ocr: view.ocr, onProgress: (f, msg) => bar.set(msg, f), isCancelled: () => job.cancelled });
    bar.set('Salvataggio…', 1);
    await H.writeFile(dest, bytes);
    const lost = ['l\'impaginazione esatta (in Word il testo scorre e può andare a capo in punti diversi)', 'disegni, linee e forme vettoriali', 'firme digitali, moduli compilabili e link'];
    if (view.annots?.length) lost.unshift('le annotazioni di Postilla (penna, evidenziatore, note): esporta il PDF annotato se ti servono');
    const notes = [];
    if (report.imagePages) notes.push(`${report.imagePages} pagin${report.imagePages === 1 ? 'a scansionata è stata inserita' : 'e scansionate sono state inserite'} come immagine: il testo non è modificabile. Per averlo modificabile esegui prima «Riconosci il testo» (OCR).`);
    if (report.ocrPages) notes.push(`${report.ocrPages} pagin${report.ocrPages === 1 ? 'a usa' : 'e usano'} il testo riconosciuto con l'OCR: controlla le parole incerte.`);
    const choice = await ask('Documento Word creato', `${baseName(dest)} è pronto. ${notes.join(' ')} Non si conservano: ${lost.join('; ')}.`,
      [{ label: 'Mostra nella cartella', value: 'reveal' }, { label: 'OK', value: 'ok', primary: true }]);
    if (choice === 'reveal') H.reveal?.(dest);
    return { path: dest, report };
  } catch (e) {
    if (e?.message === 'annullato') toast('Esportazione in Word annullata.');
    else { console.error(e); toast(`Esportazione in Word non riuscita: ${e?.message || e}`, 'error'); }
    return null;
  } finally { bar.remove(); }
}

// Scelta di un file con il selettore del sistema dentro la pagina (Android o senza canali dedicati).
function pickWithInput() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword', style: 'display:none' });
    input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

// Converte un documento Word in PDF, lo salva accanto all'originale e lo apre. hostOverride: solo per le prove.
export async function importWordFlow(app, hostOverride) {
  const H = hostOverride || window.host;
  let bar = null;
  try {
    let src; let pdfBytes; let engine;
    if (H.wordPick && H.wordToPdf) {
      src = await H.wordPick();
      if (!src) return null;
      bar = progressBar(null);
      bar.set(`Conversione di ${baseName(src)} in PDF…`, 0.3);
      const r = await H.wordToPdf(src);
      pdfBytes = r.bytes; engine = r.engine;
    } else {
      const file = await pickWithInput();
      if (!file) return null;
      bar = progressBar(null);
      bar.set(`Conversione di ${file.name} in PDF…`, 0.3);
      src = H.pathForFile?.(file) || '';
      pdfBytes = await docxToPdfRenderer(new Uint8Array(await file.arrayBuffer()));
      engine = 'interno';
      if (!src) {
        bar.remove(); bar = null;
        src = await H.pickSave?.(file.name.replace(/\.docx?$/i, '') + '.pdf');
        if (!src) return null;
      }
    }
    bar?.set('Salvataggio…', 0.9);
    const want = /\.docx?$/i.test(src) ? src.replace(/\.docx?$/i, '.pdf') : (/\.pdf$/i.test(src) ? src : `${src}.pdf`);
    const dest = /\.pdf$/i.test(src) && !H.wordToPdf ? src : await H.uniquePath(want);
    await H.writeFile(dest, pdfBytes);
    bar?.remove(); bar = null;
    toast(`PDF creato con ${ENGINE_NAME[engine] || engine}: ${baseName(dest)}${engine === 'interno' ? ' (impaginazione semplificata)' : ''}.`);
    if (app?.open) await app.open(dest);
    return { path: dest, engine };
  } catch (e) {
    console.error(e);
    toast(`Conversione da Word non riuscita: ${e?.message || e}`, 'error');
    return null;
  } finally { bar?.remove(); }
}

// Usate anche da export.js (Excel, PowerPoint, immagini) e translate.js (traduzione con impaginazione).
export { readPage, buildLines, makeTable, makePara, pageBlocks, dominantSize, renderCanvas, canvasBytes, esc as xmlEsc, progressBar, ASC, DESC };
