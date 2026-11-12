// Motore del contenuto delle pagine: legge e riscrive gli operatori PDF che disegnano testo, immagini e grafica.
// Serve per le modifiche "vere": il testo sostituito viene tolto dal file (non solo coperto), l'oscuramento
// cancella davvero ciò che sta sotto, e le immagini della pagina si possono spostare, ridimensionare o eliminare.
// Tutto avviene su un PDFDocument di pdf-lib già caricato; chi chiama poi salva in una copia.
const { PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFNumber, StandardFonts, PDFDocument, decodePDFRawStream } = window.PDFLib;

// --- Matrici (convenzione PDF: punto × matrice) ---------------------------------------------
export const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
export const apply = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
export function inv(m) {
  const d = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
const ID = [1, 0, 0, 1, 0, 0];

// --- Geometria: quadrilateri nel formato di Postilla [tl, tr, bl, br] -------------------------
const poly = (q) => [[q[0], q[1]], [q[2], q[3]], [q[6], q[7]], [q[4], q[5]]];
export function inQuad(q, x, y) {
  const P = poly(q);
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const [ax, ay] = P[i]; const [bx, by] = P[(i + 1) % 4];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(c) < 1e-9) continue;
    const s = c > 0 ? 1 : -1;
    if (!sign) sign = s; else if (s !== sign) return false;
  }
  return true;
}
export const rectQuad = ([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0];
export function boxOf(points) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of points) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
const quadBox = (q) => boxOf(poly(q));
const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// --- Lettura degli operatori --------------------------------------------------------------------
const isWS = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const latin = (b, s, e) => { let r = ''; for (let i = s; i < e; i += 1) r += String.fromCharCode(b[i]); return r; };

export function parseContent(b) {
  const ops = [];
  let operands = [];
  const stack = []; // contenitori aperti: array e dizionari
  const push = (v) => { if (stack.length) stack[stack.length - 1].items.push(v); else operands.push(v); };
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (isWS(c)) { i += 1; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i += 1; continue; } // commento
    if (c === 47) { // nome
      let j = i + 1;
      while (j < n && !isWS(b[j]) && !isDelim(b[j])) j += 1;
      push({ t: 'name', v: latin(b, i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_m, x) => String.fromCharCode(parseInt(x, 16))) });
      i = j; continue;
    }
    if (c === 40) { // stringa letterale
      const out = [];
      let depth = 1; let j = i + 1;
      while (j < n && depth) {
        const d = b[j];
        if (d === 92) {
          const e = b[j + 1];
          const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
          if (map[e] !== undefined) { out.push(map[e]); j += 2; continue; }
          if (e >= 48 && e <= 55) {
            let k = j + 1; let v = 0;
            while (k < j + 4 && b[k] >= 48 && b[k] <= 55) { v = v * 8 + (b[k] - 48); k += 1; }
            out.push(v & 255); j = k; continue;
          }
          if (e === 13) { j += b[j + 2] === 10 ? 3 : 2; continue; }
          if (e === 10) { j += 2; continue; }
          j += 1; continue;
        }
        if (d === 40) depth += 1;
        if (d === 41) { depth -= 1; if (!depth) { j += 1; break; } }
        out.push(d); j += 1;
      }
      push({ t: 'str', v: Uint8Array.from(out) });
      i = j; continue;
    }
    if (c === 60) {
      if (b[i + 1] === 60) { stack.push({ t: 'dict', items: [] }); i += 2; continue; }
      let j = i + 1; let hex = '';
      while (j < n && b[j] !== 62) { if (!isWS(b[j])) hex += String.fromCharCode(b[j]); j += 1; }
      if (hex.length % 2) hex += '0';
      const v = new Uint8Array(hex.length / 2);
      for (let k = 0; k < v.length; k += 1) v[k] = parseInt(hex.substr(k * 2, 2), 16) || 0;
      push({ t: 'str', v, hex: true });
      i = j + 1; continue;
    }
    if (c === 62 && b[i + 1] === 62) {
      const d = stack.pop();
      const entries = [];
      for (let k = 0; k + 1 < (d?.items.length || 0); k += 2) entries.push([d.items[k].v, d.items[k + 1]]);
      push({ t: 'dict', v: entries });
      i += 2; continue;
    }
    if (c === 91) { stack.push({ t: 'arr', items: [] }); i += 1; continue; }
    if (c === 93) { const a = stack.pop(); push({ t: 'arr', v: a ? a.items : [] }); i += 1; continue; }
    if (c === 123 || c === 125 || c === 41 || c === 62) { i += 1; continue; }
    let j = i;
    while (j < n && !isWS(b[j]) && !isDelim(b[j])) j += 1;
    const word = latin(b, i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push({ t: 'num', v: parseFloat(word), raw: word }); continue; }
    if (word === 'true' || word === 'false' || word === 'null') { push({ t: 'kw', v: word }); continue; }
    if (stack.length) { push({ t: 'kw', v: word }); continue; }
    if (word === 'BI') {
      // Immagine in linea: coppie chiave/valore fino a ID, poi dati binari fino a EI.
      const dictOps = parseContentUntilID(b, i);
      ops.push({ op: 'BI', args: [], dict: dictOps.entries, data: b.subarray(dictOps.dataStart, dictOps.dataEnd) });
      i = dictOps.next;
      operands = [];
      continue;
    }
    ops.push({ op: word, args: operands });
    operands = [];
  }
  return ops;
}

function parseContentUntilID(b, i) {
  let j = i;
  const n = b.length;
  // Trova la parola ID come operatore a sé.
  while (j < n - 1) {
    if (b[j] === 73 && b[j + 1] === 68 && (j === 0 || isWS(b[j - 1]) || isDelim(b[j - 1])) && (j + 2 >= n || isWS(b[j + 2]))) break;
    j += 1;
  }
  const entries = [];
  // Gli operandi fra BI e ID sono coppie chiave/valore.
  const tmp = parseOperandsOnly(b.subarray(i, j));
  for (let k = 0; k + 1 < tmp.length; k += 2) entries.push([tmp[k].v, tmp[k + 1]]);
  const dataStart = j + 3;
  let k = dataStart;
  while (k < n - 1) {
    if (b[k] === 69 && b[k + 1] === 73 && isWS(b[k - 1]) && (k + 2 >= n || isWS(b[k + 2]) || isDelim(b[k + 2]))) break;
    k += 1;
  }
  return { entries, dataStart, dataEnd: Math.max(dataStart, k - 1), next: Math.min(n, k + 2) };
}

function parseOperandsOnly(b) {
  const ops = parseContent(Uint8Array.from([...b, 32, 81, 81, 81]));
  return ops.length ? ops[0].args : [];
}

// --- Scrittura degli operatori ------------------------------------------------------------------
const fmt = (x) => (Number.isInteger(x) ? String(x) : (Math.abs(x) < 1e-6 ? '0' : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')));
const nameOut = (s) => `/${[...s].map((ch) => { const c = ch.charCodeAt(0); return c < 33 || c > 126 || '#()<>[]{}/%'.includes(ch) ? `#${c.toString(16).padStart(2, '0')}` : ch; }).join('')}`;
function strOut(v) {
  let s = '(';
  for (const c of v) {
    if (c === 40 || c === 41 || c === 92) s += `\\${String.fromCharCode(c)}`;
    else if (c < 32 || c > 126) s += `\\${c.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(c);
  }
  return `${s})`;
}
function valOut(v) {
  switch (v.t) {
    case 'num': return v.raw && !v.changed ? v.raw : fmt(v.v);
    case 'name': return nameOut(v.v);
    case 'str': return strOut(v.v);
    case 'arr': return `[${v.v.map(valOut).join(' ')}]`;
    case 'dict': return `<<${v.v.map(([k, x]) => `${nameOut(k)} ${valOut(x)}`).join(' ')}>>`;
    default: return String(v.v);
  }
}

export function writeContent(ops) {
  const chunks = [];
  let text = '';
  const flush = () => { if (text) { chunks.push(Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 255)); text = ''; } };
  for (const o of ops) {
    if (o.op === 'BI') {
      text += `BI ${o.dict.map(([k, x]) => `${nameOut(k)} ${valOut(x)}`).join(' ')} ID `;
      flush();
      chunks.push(o.data);
      text += '\nEI\n';
      continue;
    }
    text += o.args.length ? `${o.args.map(valOut).join(' ')} ${o.op}\n` : `${o.op}\n`;
    if (text.length > 65536) flush();
  }
  flush();
  const len = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

const num = (v) => ({ t: 'num', v, changed: true });

// --- Flussi ---------------------------------------------------------------------------------------
export function streamBytes(stream) {
  if (!stream) return new Uint8Array(0);
  if (stream instanceof PDFRawStream) {
    try { return decodePDFRawStream(stream).decode(); } catch { return stream.getContents(); }
  }
  if (typeof stream.getUnencodedContents === 'function') return stream.getUnencodedContents();
  if (typeof stream.getContents === 'function') return stream.getContents();
  return new Uint8Array(0);
}

export function pageContentBytes(doc, page) {
  const c = page.node.Contents();
  const parts = [];
  if (!c) return new Uint8Array(0);
  if (c instanceof PDFArray) {
    for (let k = 0; k < c.size(); k += 1) parts.push(streamBytes(c.lookup(k)));
  } else parts.push(streamBytes(c));
  const len = parts.reduce((s, x) => s + x.length + 1, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; out[p] = 10; p += 1; }
  return out;
}

// --- Caratteri e larghezze dei glifi --------------------------------------------------------------
const WINANSI = { 128: 0x20ac, 130: 0x201a, 131: 0x192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x2c6, 137: 0x2030, 138: 0x160, 139: 0x2039, 140: 0x152, 142: 0x17d, 145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x2dc, 153: 0x2122, 154: 0x161, 155: 0x203a, 156: 0x153, 158: 0x17e, 159: 0x178 };
const STD = {
  Helvetica: 'Helvetica', 'Helvetica-Bold': 'HelveticaBold', 'Helvetica-Oblique': 'HelveticaOblique', 'Helvetica-BoldOblique': 'HelveticaBoldOblique',
  'Times-Roman': 'TimesRoman', 'Times-Bold': 'TimesRomanBold', 'Times-Italic': 'TimesRomanItalic', 'Times-BoldItalic': 'TimesRomanBoldItalic',
  Courier: 'Courier', 'Courier-Bold': 'CourierBold', 'Courier-Oblique': 'CourierOblique', 'Courier-BoldOblique': 'CourierBoldOblique',
};
let stdWidths = null; // nome standard -> Float32Array(256) in millesimi

export async function ensureStdMetrics() {
  if (stdWidths) return;
  const doc = await PDFDocument.create();
  const out = {};
  for (const [pdfName, key] of Object.entries(STD)) {
    const f = await doc.embedFont(StandardFonts[key]);
    const w = new Float32Array(256).fill(500);
    for (let c = 32; c < 256; c += 1) {
      const ch = String.fromCharCode(WINANSI[c] || c);
      try { w[c] = f.widthOfTextAtSize(ch, 1000); } catch { /* carattere senza glifo */ }
    }
    out[pdfName] = w;
  }
  stdWidths = out;
}

function stdFor(base) {
  const b = String(base || '').replace(/^[A-Z]{6}\+/, '');
  const k = b.toLowerCase().replace(/[^a-z]/g, '');
  const bold = /bold|black|heavy/.test(k); const ital = /italic|oblique/.test(k);
  let fam = 'Helvetica';
  if (/times|roman|serif|georgia|garamond/.test(k)) fam = 'Times';
  else if (/courier|mono/.test(k)) fam = 'Courier';
  const suffix = fam === 'Times' ? (bold && ital ? 'BoldItalic' : bold ? 'Bold' : ital ? 'Italic' : 'Roman') : (bold && ital ? 'BoldOblique' : bold ? 'Bold' : ital ? 'Oblique' : '');
  return stdWidths?.[suffix ? `${fam}-${suffix}` : fam] || stdWidths?.Helvetica;
}

const numOf = (o) => (o instanceof PDFNumber ? o.asNumber() : (typeof o?.asNumber === 'function' ? o.asNumber() : NaN));
const nameStr = (o) => (o ? (typeof o.decodeText === 'function' ? o.decodeText() : String(o.asString?.() ?? o).replace(/^\//, '')) : '');

// Informazioni su un carattere: come dividere i codici e quanto avanza ogni glifo (in unità di testo, 1 = dimensione).
function fontInfo(doc, dict, cache) {
  if (!dict) return { codes: (bytes) => [...bytes].map((c) => ({ code: c, len: 1 })), width: () => 0.5, ok: false };
  const key = dict;
  if (cache.has(key)) return cache.get(key);
  const L = (k) => dict.lookup(PDFName.of(k));
  const sub = nameStr(L('Subtype'));
  let info;
  if (sub === 'Type0') {
    const kids = L('DescendantFonts');
    const desc = kids instanceof PDFArray ? kids.lookup(0) : null;
    const W = new Map();
    let DW = 1000;
    if (desc instanceof PDFDict) {
      const dw = numOf(desc.lookup(PDFName.of('DW')));
      if (Number.isFinite(dw)) DW = dw;
      const w = desc.lookup(PDFName.of('W'));
      if (w instanceof PDFArray) {
        const arr = w.asArray().map((x) => doc.context.lookup(x));
        for (let k = 0; k < arr.length;) {
          const first = numOf(arr[k]);
          const next = arr[k + 1];
          if (next instanceof PDFArray) {
            next.asArray().forEach((v, m) => W.set(first + m, numOf(doc.context.lookup(v))));
            k += 2;
          } else {
            const last = numOf(next); const v = numOf(arr[k + 2]);
            if (last - first < 70000) for (let c = first; c <= last; c += 1) W.set(c, v);
            k += 3;
          }
        }
      }
    }
    // Spazio dei codici: Identity e quasi tutte le CMap usano 2 byte; quelle incorporate dichiarano i loro intervalli.
    let ranges = null;
    const enc = L('Encoding');
    if (enc && !(enc instanceof PDFName)) {
      try {
        const txt = latin(streamBytes(enc), 0, streamBytes(enc).length);
        const blocks = [...txt.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)];
        const rr = [];
        for (const bl of blocks) for (const m of bl[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) rr.push({ len: m[1].length / 2, lo: parseInt(m[1], 16), hi: parseInt(m[2], 16) });
        if (rr.length) ranges = rr;
      } catch { ranges = null; }
    }
    const encName = enc instanceof PDFName ? nameStr(enc) : '';
    const known = !ranges && /^Identity-[HV]$/.test(encName);
    info = {
      ok: known || !!ranges || /-(H|V)$/.test(encName),
      codes(bytes) {
        const out = [];
        for (let i = 0; i < bytes.length;) {
          if (ranges) {
            let hit = null;
            for (let len = 1; len <= 4 && !hit; len += 1) {
              if (i + len > bytes.length) break;
              let v = 0; for (let k = 0; k < len; k += 1) v = v * 256 + bytes[i + k];
              if (ranges.some((r) => r.len === len && v >= r.lo && v <= r.hi)) hit = { code: v, len };
            }
            if (!hit) hit = { code: bytes[i], len: 1 };
            out.push(hit); i += hit.len;
          } else { out.push({ code: (bytes[i] << 8) | (bytes[i + 1] ?? 0), len: 2 }); i += 2; }
        }
        return out;
      },
      width: (code) => (W.has(code) ? W.get(code) : DW) / 1000,
    };
  } else {
    const first = numOf(L('FirstChar'));
    const widths = L('Widths');
    const fd = L('FontDescriptor');
    const missing = fd instanceof PDFDict ? numOf(fd.lookup(PDFName.of('MissingWidth'))) : NaN;
    let scale = 1 / 1000;
    if (sub === 'Type3') { const fm = L('FontMatrix'); if (fm instanceof PDFArray) scale = numOf(fm.lookup(0)) || 0.001; }
    const arr = widths instanceof PDFArray ? widths.asArray().map((x) => numOf(doc.context.lookup(x))) : null;
    const std = !arr ? stdFor(nameStr(L('BaseFont'))) : null;
    info = {
      ok: !!arr || !!std,
      codes: (bytes) => [...bytes].map((c) => ({ code: c, len: 1 })),
      width(code) {
        if (arr) {
          const w = arr[code - (Number.isFinite(first) ? first : 0)];
          if (Number.isFinite(w)) return w * scale;
          return (Number.isFinite(missing) ? missing : 0) * scale;
        }
        if (std) return std[code & 255] / 1000;
        return 0.5;
      },
    };
  }
  cache.set(key, info);
  return info;
}

// --- Interprete --------------------------------------------------------------------------------
// Percorre gli operatori di un contenuto (pagina o modulo), segue lo stato grafico e quello del testo e,
// tramite i "giudici" in `judge`, decide cosa togliere o cambiare. Restituisce i nuovi operatori.
//   judge.glyph(g)  -> true per togliere il glifo (g: {x, y} centro, quad, ch: codice)
//   judge.image(i)  -> 'keep' | 'remove' | {matrix} (avvolge con una nuova trasformazione) | {replaceName}
//   judge.path(box) -> true per togliere il disegno (riempimento o tratto) interamente nella zona
//   judge.inline(box) -> true per togliere un'immagine in linea
const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);

class Run {
  constructor(doc, judge, ctx) {
    this.doc = doc; this.judge = judge; this.ctx = ctx;
    this.fonts = ctx.fonts; this.stats = ctx.stats;
  }

  lookupRes(res, kind, name) {
    const d = res?.lookup(PDFName.of(kind));
    if (!(d instanceof PDFDict)) return { dict: null, ref: null, obj: null };
    const ref = d.get(PDFName.of(name));
    return { dict: d, ref, obj: ref instanceof PDFRef ? this.doc.context.lookup(ref) : ref };
  }

  // Interpreta e (se serve) riscrive. ctm0: matrice iniziale; res: risorse attive.
  run(ops, res, ctm0, depth = 0) {
    const out = [];
    let changed = false;
    let gs = { ctm: ctm0, Tc: 0, Tw: 0, Th: 1, TL: 0, font: null, fs: 0, rise: 0 };
    const gstack = [];
    let Tm = ID; let Tlm = ID;
    let path = [];
    const ptAdd = (x, y) => path.push(apply(gs.ctm, x, y));
    for (const o of ops) {
      const a = o.args;
      const N = (k) => (a[k]?.t === 'num' ? a[k].v : 0);
      switch (o.op) {
        case 'q': gstack.push({ ...gs }); out.push(o); continue;
        case 'Q': if (gstack.length) gs = gstack.pop(); out.push(o); continue;
        case 'cm': gs.ctm = mul([N(0), N(1), N(2), N(3), N(4), N(5)], gs.ctm); out.push(o); continue;
        case 'BT': Tm = ID; Tlm = ID; out.push(o); continue;
        case 'ET': out.push(o); continue;
        case 'Tc': gs.Tc = N(0); out.push(o); continue;
        case 'Tw': gs.Tw = N(0); out.push(o); continue;
        case 'Tz': gs.Th = N(0) / 100; out.push(o); continue;
        case 'TL': gs.TL = N(0); out.push(o); continue;
        case 'Ts': gs.rise = N(0); out.push(o); continue;
        case 'Tf': {
          gs.fs = N(1);
          const { obj } = this.lookupRes(res, 'Font', a[0]?.v);
          gs.font = fontInfo(this.doc, obj instanceof PDFDict ? obj : null, this.fonts);
          out.push(o); continue;
        }
        case 'Td': Tlm = mul([1, 0, 0, 1, N(0), N(1)], Tlm); Tm = Tlm; out.push(o); continue;
        case 'TD': gs.TL = -N(1); Tlm = mul([1, 0, 0, 1, N(0), N(1)], Tlm); Tm = Tlm; out.push(o); continue;
        case 'Tm': Tlm = [N(0), N(1), N(2), N(3), N(4), N(5)]; Tm = Tlm; out.push(o); continue;
        case 'T*': Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm; out.push(o); continue;
        case 'Tj': case 'TJ': case "'": case '"': {
          const pre = [];
          let items;
          if (o.op === "'" || o.op === '"') {
            if (o.op === '"') { gs.Tw = N(0); gs.Tc = N(1); pre.push({ op: 'Tw', args: [num(gs.Tw)] }, { op: 'Tc', args: [num(gs.Tc)] }); }
            Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm;
            pre.push({ op: 'T*', args: [] });
            items = [a[a.length - 1]];
          } else items = o.op === 'TJ' ? (a[0]?.v || []) : [a[0]];
          const res2 = this.showText(items, gs, Tm);
          Tm = res2.Tm;
          if (res2.changed) {
            changed = true;
            out.push(...pre, { op: 'TJ', args: [{ t: 'arr', v: res2.items }] });
          } else out.push(o);
          continue;
        }
        case 'Do': {
          const name = a[0]?.v;
          const { obj } = this.lookupRes(res, 'XObject', name);
          if (!obj || typeof obj.dict?.lookup !== 'function') { out.push(o); continue; }
          const st = nameStr(obj.dict.lookup(PDFName.of('Subtype')));
          if (st === 'Image') {
            const corners = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)];
            const info = { index: this.ctx.imageIndex, name, ctm: gs.ctm, box: boxOf(corners), corners, obj, res, depth, ctx: this.ctx };
            this.ctx.imageIndex += 1;
            this.ctx.images.push(info);
            const r = this.judge.image ? this.judge.image(info) : 'keep';
            if (r === 'remove') { changed = true; this.stats.images += 1; continue; }
            if (r && r.matrix) { changed = true; out.push({ op: 'q', args: [] }, { op: 'cm', args: r.matrix.map(num) }, o, { op: 'Q', args: [] }); continue; }
            if (r && r.replaceName) { changed = true; out.push({ op: 'Do', args: [{ t: 'name', v: r.replaceName }] }); this.stats.images += 1; continue; }
            out.push(o); continue;
          }
          if (st === 'Form' && depth < 12 && !this.ctx.stack.includes(obj)) {
            const m = obj.dict.lookup(PDFName.of('Matrix'));
            const M = m instanceof PDFArray ? m.asArray().map((x) => numOf(this.doc.context.lookup(x))) : ID;
            const fres = obj.dict.lookup(PDFName.of('Resources'));
            const useRes = fres instanceof PDFDict ? fres : res;
            // Copia di lavoro delle risorse del modulo: vi finiscono i nomi degli oggetti nuovi (moduli o immagini).
            const workRes = useRes instanceof PDFDict ? useRes.clone(this.doc.context) : this.doc.context.obj({});
            this.ctx.stack.push(obj);
            const inner = this.run(parseContent(streamBytes(obj)), workRes, mul(M, gs.ctm), depth + 1);
            this.ctx.stack.pop();
            if (inner.changed) {
              // Il modulo modificato diventa un oggetto nuovo, usato solo da questa pagina.
              changed = true;
              const newName = this.ctx.newForm(obj, inner.ops, workRes, depth === 0 ? null : res);
              out.push({ op: 'Do', args: [{ t: 'name', v: newName }] });
            } else out.push(o);
            continue;
          }
          out.push(o); continue;
        }
        case 'BI': {
          const corners = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)];
          if (this.judge.inline && this.judge.inline(boxOf(corners))) { changed = true; this.stats.inline += 1; continue; }
          out.push(o); continue;
        }
        case 'm': case 'l': ptAdd(N(0), N(1)); out.push(o); continue;
        case 'c': ptAdd(N(0), N(1)); ptAdd(N(2), N(3)); ptAdd(N(4), N(5)); out.push(o); continue;
        case 'v': case 'y': ptAdd(N(0), N(1)); ptAdd(N(2), N(3)); out.push(o); continue;
        case 're': { const x = N(0); const y = N(1); const w = N(2); const hh = N(3); ptAdd(x, y); ptAdd(x + w, y); ptAdd(x, y + hh); ptAdd(x + w, y + hh); out.push(o); continue; }
        case 'n': path = []; out.push(o); continue;
        default:
          if (PAINT.has(o.op)) {
            if (path.length && this.judge.path && this.judge.path(boxOf(path))) {
              changed = true; this.stats.paths += 1;
              out.push({ op: 'n', args: [] });
            } else out.push(o);
            path = [];
            continue;
          }
          out.push(o);
      }
    }
    return { ops: out, changed };
  }

  // Mostra il testo: calcola la posizione di ogni glifo e, se il giudice lo chiede, lo toglie
  // sostituendolo con uno spostamento equivalente (così il resto della riga non si muove).
  showText(items, gs, Tm0) {
    let Tm = Tm0;
    const font = gs.font || fontInfo(this.doc, null, this.fonts);
    const fs = gs.fs; const Th = gs.Th;
    const out = [];
    let changed = false;
    let pendingNum = 0;
    let curStr = [];
    const flushStr = () => { if (curStr.length) { if (pendingNum) { out.push(num(pendingNum)); pendingNum = 0; } out.push({ t: 'str', v: Uint8Array.from(curStr) }); curStr = []; } };
    for (const it of items) {
      if (!it) continue;
      if (it.t === 'num') {
        flushStr();
        pendingNum += it.v;
        Tm = mul([1, 0, 0, 1, (-it.v / 1000) * fs * Th, 0], Tm);
        continue;
      }
      if (it.t !== 'str') continue;
      const bytes = it.v;
      let pos = 0;
      for (const g of font.codes(bytes)) {
        const raw = bytes.subarray(pos, pos + g.len);
        pos += g.len;
        const w0 = font.width(g.code);
        const space = g.len === 1 && g.code === 32 ? gs.Tw : 0;
        const adv = (w0 * fs + gs.Tc + space) * Th;
        const trm = mul(mul([fs * Th, 0, 0, fs, 0, gs.rise], Tm), gs.ctm);
        const ww = Math.max(w0, 0.05);
        const quad = [...apply(trm, 0, 0.8), ...apply(trm, ww, 0.8), ...apply(trm, 0, -0.2), ...apply(trm, ww, -0.2)];
        const pts = [0.25, 0.5, 0.75].map((t) => apply(trm, ww * t, 0.3));
        const [cx, cy] = pts[1];
        const remove = fs !== 0 && font.ok !== false && this.judge.glyph && this.judge.glyph({ x: cx, y: cy, pts, quad, code: g.code });
        this.ctx.glyphs += 1;
        if (remove) {
          flushStr();
          pendingNum += -(adv / (fs * Th)) * 1000;
          changed = true;
          this.stats.glyphs += 1;
          if (g.code !== 32) this.stats.chars += 1;
        } else {
          if (pendingNum && !curStr.length) { out.push(num(pendingNum)); pendingNum = 0; }
          curStr.push(...raw);
        }
        Tm = mul([1, 0, 0, 1, adv, 0], Tm);
      }
    }
    flushStr();
    if (pendingNum) out.push(num(pendingNum));
    return { items: out, Tm, changed };
  }
}

// Prepara un contesto di lavoro per una pagina: risorse proprie (copiate), nuovi moduli e immagini.
function pageCtx(doc, page) {
  const ctx = { fonts: new Map(), stats: { glyphs: 0, chars: 0, images: 0, inline: 0, paths: 0 }, images: [], imageIndex: 0, glyphs: 0, stack: [], n: 0 };
  let ownRes = null;
  const pageRes = () => {
    if (ownRes) return ownRes;
    const r = page.node.Resources();
    ownRes = r ? r.clone(doc.context) : doc.context.obj({});
    page.node.set(PDFName.of('Resources'), ownRes);
    return ownRes;
  };
  ctx.pageRes = pageRes;
  // Registra un oggetto nelle risorse XObject (di pagina o di un modulo nuovo) con un nome nuovo.
  ctx.addXObject = (res, ref) => {
    let xo = res.lookup(PDFName.of('XObject'));
    xo = xo instanceof PDFDict ? xo.clone(doc.context) : doc.context.obj({});
    res.set(PDFName.of('XObject'), xo);
    let name;
    do { ctx.n += 1; name = `PostillaX${ctx.n}`; } while (xo.has(PDFName.of(name)));
    xo.set(PDFName.of(name), ref);
    return name;
  };
  // Modulo modificato: nuovo oggetto con le risorse di lavoro, registrato nel contenitore (pagina o modulo padre).
  ctx.newForm = (formObj, ops, workRes, parentRes) => {
    const dict = {};
    for (const [k, v] of formObj.dict.entries()) {
      const key = k.asString().slice(1);
      if (['Length', 'Filter', 'DecodeParms'].includes(key)) continue;
      dict[key] = v;
    }
    dict.Resources = workRes;
    const ref = doc.context.register(doc.context.flateStream(writeContent(ops), dict));
    return ctx.addXObject(parentRes || pageRes(), ref);
  };
  ctx.resFor = (info) => (info.depth === 0 ? pageRes() : info.res);
  return ctx;
}

// Esegue un giudizio su una pagina e, se qualcosa cambia, sostituisce il contenuto con uno nuovo.
export async function processPage(doc, pageIndex, judge) {
  await ensureStdMetrics();
  const page = doc.getPage(pageIndex);
  const ctx = pageCtx(doc, page);
  const r = new Run(doc, judge, ctx);
  const res = page.node.Resources();
  const result = r.run(parseContent(pageContentBytes(doc, page)), res, ID, 0);
  if (result.changed) {
    // Le risorse vanno copiate prima di cambiare i nomi; le operazioni che le usano sono già nel risultato.
    ctx.pageRes();
    const ref = doc.context.register(doc.context.flateStream(writeContent(result.ops)));
    page.node.set(PDFName.of('Contents'), ref);
  }
  return { changed: result.changed, stats: ctx.stats, images: ctx.images, glyphs: ctx.glyphs };
}

// --- Funzioni per il resto del programma ---------------------------------------------------------

// Toglie dal contenuto della pagina i glifi il cui centro cade nei quadrilateri indicati.
// Restituisce quanti caratteri (spazi esclusi) sono stati tolti.
export async function removeTextAt(doc, pageIndex, quads) {
  if (!quads?.length) return { chars: 0, glyphs: 0 };
  const boxes = quads.map(quadBox);
  const r = await processPage(doc, pageIndex, {
    glyph: (g) => quads.some((q, k) => g.x >= boxes[k][0] - 1 && g.x <= boxes[k][2] + 1 && inQuad(q, g.x, g.y)),
  });
  return { chars: r.stats.chars, glyphs: r.stats.glyphs };
}

// Oscuramento definitivo di zone (quadrilateri) di una pagina: testo, immagini, grafica e annotazioni sotto le zone
// vengono tolti; le immagini toccate solo in parte vengono ridipinte (funzione `paintImage` fornita da chi chiama).
export async function redactPage(doc, pageIndex, quads, { paintImage, color = [0, 0, 0] } = {}) {
  const boxes = quads.map(quadBox);
  const hitPt = (x, y) => quads.some((q, k) => x >= boxes[k][0] && x <= boxes[k][2] && y >= boxes[k][1] && y <= boxes[k][3] && inQuad(q, x, y));
  const inside = (b) => quads.some((q) => [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].every(([x, y]) => inQuad(q, x, y)));
  const touches = (b) => boxes.some((z) => overlap(z, b));
  const partial = [];
  const r = await processPage(doc, pageIndex, {
    glyph: (g) => g.pts.some(([x, y]) => hitPt(x, y)),
    image: (info) => {
      if (!touches(info.box)) return 'keep';
      if (inside(info.box)) return 'remove';
      partial.push(info);
      return 'keep';
    },
    path: (b) => inside(b),
    inline: (b) => touches(b),
  });
  // Immagini coperte solo in parte: si ridipingono le zone e si sostituiscono (solo su questa pagina).
  let repainted = 0; let removedWhole = 0;
  if (partial.length) {
    const replacements = new Map();
    for (const info of partial) {
      const ref = paintImage ? await paintImage(info, quads).catch(() => null) : null;
      if (ref) { replacements.set(info.index, ref); repainted += 1; } else { replacements.set(info.index, null); removedWhole += 1; }
    }
    // Seconda passata: gli indici delle immagini sono gli stessi della prima (le immagini tolte del tutto
    // non ci sono più, quindi si confrontano le posizioni invece degli indici).
    const key = (i) => `${i.name}|${i.box.map((v) => v.toFixed(1)).join(',')}`;
    const byKey = new Map(partial.map((i) => [key(i), replacements.get(i.index)]));
    await processPage(doc, pageIndex, {
      image: (info) => {
        if (!byKey.has(key(info))) return 'keep';
        const ref = byKey.get(key(info));
        if (!ref) return 'remove';
        return { replaceName: info.ctx.addXObject(info.ctx.resFor(info), ref) };
      },
    });
  }
  // Annotazioni nella zona (commenti, campi): vengono tolte, perché potrebbero contenere il dato oscurato.
  let annots = 0;
  const page = doc.getPage(pageIndex);
  const arr = page.node.Annots();
  if (arr) {
    for (let k = arr.size() - 1; k >= 0; k -= 1) {
      const d = arr.lookup(k);
      if (!(d instanceof PDFDict)) continue;
      const rect = d.lookup(PDFName.of('Rect'));
      if (!(rect instanceof PDFArray)) continue;
      const v = rect.asArray().map((x) => numOf(doc.context.lookup(x)));
      const b = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
      const sub = nameStr(d.lookup(PDFName.of('Subtype')));
      if (sub === 'Link' || sub === 'Popup') { if (!touches(b)) continue; }
      if (touches(b)) {
        if (sub === 'Widget') { d.delete(PDFName.of('V')); const parent = d.lookup(PDFName.of('Parent')); if (parent instanceof PDFDict) parent.delete(PDFName.of('V')); }
        arr.remove(k); annots += 1;
      }
    }
  }
  // Riquadri pieni sopra le zone: si vede che lì c'era qualcosa di oscurato.
  const [cr, cg, cb] = color;
  let ops = `q ${fmt(cr)} ${fmt(cg)} ${fmt(cb)} rg\n`;
  for (const q of quads) ops += `${fmt(q[0])} ${fmt(q[1])} m ${fmt(q[2])} ${fmt(q[3])} l ${fmt(q[6])} ${fmt(q[7])} l ${fmt(q[4])} ${fmt(q[5])} l h f\n`;
  ops += 'Q\n';
  const qRef = doc.context.register(doc.context.stream('q\n'));
  const QRef = doc.context.register(doc.context.stream('\nQ\n'));
  page.node.wrapContentStreams(qRef, QRef);
  page.node.addContentStream(doc.context.register(doc.context.flateStream(ops)));
  return { ...r.stats, repainted, removedWhole, annots };
}

// Elenco delle immagini disegnate su una pagina (anche dentro i moduli), con il riquadro in coordinate PDF.
export async function listPageImages(doc, pageIndex) {
  const r = await processPage(doc, pageIndex, {});
  return r.images.map((i) => {
    const w = numOf(i.obj.dict.lookup(PDFName.of('Width'))); const hh = numOf(i.obj.dict.lookup(PDFName.of('Height')));
    return { index: i.index, name: i.name, box: i.box, corners: i.corners, width: w, height: hh, depth: i.depth };
  });
}

// Sposta e ridimensiona (newBox = [x0,y0,x1,y1]) o elimina (newBox = null) l'immagine numero `index` della pagina.
export async function transformImage(doc, pageIndex, index, newBox) {
  let done = false;
  await processPage(doc, pageIndex, {
    image: (info) => {
      if (info.index !== index) return 'keep';
      done = true;
      if (!newBox) return 'remove';
      const R = info.box;
      const sx = (newBox[2] - newBox[0]) / ((R[2] - R[0]) || 1); const sy = (newBox[3] - newBox[1]) / ((R[3] - R[1]) || 1);
      const T = [sx, 0, 0, sy, newBox[0] - R[0] * sx, newBox[1] - R[1] * sy];
      const C = info.ctm;
      return { matrix: mul(mul(C, T), inv(C)) };
    },
  });
  return done;
}

// Conta i glifi di una pagina (per le prove e per capire se una pagina ha testo vero).
export async function countGlyphs(doc, pageIndex) {
  const r = await processPage(doc, pageIndex, {});
  return r.glyphs;
}
