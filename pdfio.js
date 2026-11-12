// Scrittura del PDF: annotazioni standard con aspetto proprio, leggibili anche da altri programmi.
// Ogni annotazione conserva i suoi dati in /PostillaData, così resta modificabile alla riapertura.
import { dispRect, arrowHead, labelParts, quadDisp, sigPaths, stampFont, strokeOutline, toDisp, wrapLines } from './annots.js';
import { hexRgb } from './core.js';
import { applyFormEdits } from './forms.js';
import { removeTextAt } from './pro/content.js';
import { createFields } from './pro/formbuilder.js';

const { PDFDocument, PDFName, PDFHexString, PDFDict, StandardFonts, degrees, ParseSpeeds } = window.PDFLib;
const KEY = 'PostillaData';
const MARK = PDFName.of('PostillaAnnotated'); // segnale nelle proprietà del file: si legge senza scaricarlo tutto
const f = (n) => +n.toFixed(3);

const loadOpts = { updateMetadata: false, parseSpeed: ParseSpeeds.Fastest };
const saveOpts = { useObjectStreams: false, updateFieldAppearances: false };

const EDITS = PDFName.of('PostillaEdits');
const LOG = PDFName.of('PostillaLog');
const pdfRgb = (c) => hexRgb(c || '#000000').map((v) => f(v)).join(' ');

// Le modifiche al testo sono un flusso di contenuto separato, aggiunto in fondo alla pagina (con q/Q intorno al
// contenuto originale). Se il file resta "di Postilla", i loro dati restano anche in /PostillaEdits per poterle togliere.
async function writeEdits(pdf, pages, edits, flatten, w) {
  if (!edits.length) return;
  pdf.registerFontkit(window.fontkit);
  const fonts = new Map();
  const fontFor = async (e) => {
    const k = e.font?.file || e.font?.std || 'Helvetica';
    if (!fonts.has(k)) {
      fonts.set(k, (async () => {
        if (e.font?.file) {
          try { const { data } = await host.readFile(e.font.file); return await pdf.embedFont(new Uint8Array(data), { subset: true }); } catch (x) { console.warn('Carattere non incorporato, uso quello standard', x); }
        }
        return pdf.embedFont(StandardFonts[e.font?.std] || StandardFonts.Helvetica);
      })());
    }
    return fonts.get(k);
  };
  const byPage = new Map();
  for (const e of edits) { if (!byPage.has(e.page)) byPage.set(e.page, []); byPage.get(e.page).push(e); }
  const { context } = pdf;
  for (const [i, list] of byPage) {
    const pg = pages[i];
    if (!pg) continue;
    // Testo sostituito: si toglie davvero dal contenuto della pagina. Se non è possibile (pagina scansionata,
    // testo disegnato come grafica) resta la copertura con il colore del fondo.
    const removed = new Set();
    for (const e of list) {
      if (e.mode !== 'replace' || !e.quads.length) continue;
      if (e.removed) { removed.add(e.id); continue; }
      try {
        const r = await removeTextAt(pdf, i, e.quads);
        const want = (e.before || '').replace(/\s/g, '').length;
        if (r.chars > 0 && r.chars >= want * 0.6) removed.add(e.id);
      } catch (x) { console.warn('Testo originale non rimosso, resta coperto', x); }
    }
    let ops = 'q\n';
    for (const e of list) {
      if (e.quads.length && !removed.has(e.id)) {
        ops += `${pdfRgb(e.bg)} rg
`;
        for (const q of e.quads) ops += `${f(q[0])} ${f(q[1])} m ${f(q[2])} ${f(q[3])} l ${f(q[6])} ${f(q[7])} l ${f(q[4])} ${f(q[5])} l h f
`;
      }
      if (!e.text) continue;
      const font = await fontFor(e);
      if (e.lines) {
        // Paragrafo riscritto: ogni riga (o parola, se giustificato) nella sua posizione.
        const name = pg.node.newFontDictionary('PostillaE', font.ref);
        ops += `BT ${name} ${f(e.size)} Tf ${pdfRgb(e.color)} rg
`;
        for (const ln of e.lines) {
          const parts = ln.words ? ln.words.map(([wd, dx]) => [wd, ln.x - ln.dx + dx]) : [[ln.text, ln.x]];
          for (const [t, x] of parts) ops += `1 0 0 1 ${f(x)} ${f(ln.y)} Tm ${w.str(font, t).hex} Tj
`;
        }
        ops += 'ET' + String.fromCharCode(10);
        continue;
      }
      const name = pg.node.newFontDictionary('PostillaE', font.ref);
      const { hex } = w.str(font, e.text);
      const [ux, uy] = e.dir; const [vx, vy] = e.up; const [ox, oy] = e.a;
      ops += `BT ${name} ${f(e.size)} Tf ${pdfRgb(e.color)} rg ${f(ux)} ${f(uy)} ${f(vx)} ${f(vy)} ${f(ox)} ${f(oy)} Tm ${hex} Tj ET
`;
    }
    ops += 'Q\n';
    const qRef = context.register(context.stream('q\n'));
    const QRef = context.register(context.stream('\nQ\n'));
    const ref = context.register(context.flateStream(ops));
    pg.node.wrapContentStreams(qRef, QRef);
    pg.node.addContentStream(ref);
    if (!flatten) {
      const keep = list.map((e) => { const c = { ...e, removed: e.removed || removed.has(e.id) || undefined }; delete c.page; delete c.css; return c; });
      pg.node.set(EDITS, context.obj({ Streams: [qRef, QRef, ref], Data: PDFHexString.fromText(JSON.stringify(keep)) }));
    }
  }
}

// Toglie dalla pagina le modifiche al testo fatte da Postilla e le restituisce come oggetti modificabili.
function extractEdits(pdf, page, i, out) {
  const pe = page.node.lookup(EDITS);
  if (!(pe instanceof PDFDict)) return;
  try {
    const refs = pe.lookup(PDFName.of('Streams')).asArray();
    const nums = new Set(refs.map((r) => r.objectNumber));
    const contents = page.node.Contents();
    if (contents && contents.asArray) {
      for (let k = contents.size() - 1; k >= 0; k -= 1) if (nums.has(contents.get(k)?.objectNumber)) contents.remove(k);
    }
    refs.forEach((r) => pdf.context.delete(r));
    for (const e of JSON.parse(pe.lookup(PDFName.of('Data')).decodeText())) out.push({ ...e, page: i });
  } catch (x) { console.error(x); }
  page.node.delete(EDITS);
}

// Toglie dal file le annotazioni di Postilla: tornano oggetti modificabili in memoria.
export async function extractOwn(bytes) {
  const pdf = await PDFDocument.load(bytes, loadOpts);
  const annots = [];
  pdf.getPages().forEach((page, i) => {
    extractEdits(pdf, page, i, annots);
    const arr = page.node.Annots();
    if (!arr) return;
    for (let k = arr.size() - 1; k >= 0; k -= 1) {
      const d = arr.lookup(k);
      if (!(d instanceof PDFDict)) continue;
      const data = d.lookup(PDFName.of(KEY));
      if (!data) continue;
      try { annots.unshift({ ...JSON.parse(data.decodeText()), page: i }); } catch { continue; }
      const ref = arr.get(k);
      const ap = d.lookup(PDFName.of('AP'));
      const form = ap instanceof PDFDict ? ap.get(PDFName.of('N')) : null;
      arr.remove(k);
      if (form?.objectNumber !== undefined) pdf.context.delete(form);
      if (ref?.objectNumber !== undefined) pdf.context.delete(ref);
    }
  });
  pdf.getInfoDict().delete(MARK);
  let log = [];
  try { const l = pdf.catalog.lookup(LOG); if (l) log = JSON.parse(l.decodeText()); } catch { log = []; }
  pdf.catalog.delete(LOG);
  return { bytes: await pdf.save(saveOpts), annots, log };
}

const mul = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Da coordinate di pagina a schermo (y verso l'alto) allo spazio del PDF.
function displayMatrix(p) {
  const H = p.h;
  const o = p.vp.convertToPdfPoint(0, H); const ex = p.vp.convertToPdfPoint(1, H); const ey = p.vp.convertToPdfPoint(0, H - 1);
  return [ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]];
}

class Writer {
  constructor(pdf, flatten) { this.pdf = pdf; this.flatten = flatten; this.fonts = {}; this.n = 0; }

  async font(name) {
    this.fonts[name] = this.fonts[name] || await this.pdf.embedFont(name);
    return this.fonts[name];
  }

  str(font, s) {
    const safe = [...s].map((c) => { try { font.encodeText(c); return c; } catch { return '?'; } }).join('');
    return { hex: font.encodeText(safe).toString(), safe };
  }

  // Crea il disegno: contenuto in coordinate "schermo con y in alto" e riquadro bbox.
  form(p, M, box, content, resources = {}) {
    const { context } = this.pdf;
    return context.register(context.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: box.map(f), Matrix: M.map((v) => +v.toFixed(6)), Resources: resources }));
  }

  rectOf(M, box) {
    const pts = [mul(M, box[0], box[1]), mul(M, box[2], box[1]), mul(M, box[0], box[3]), mul(M, box[2], box[3])];
    return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))].map(f);
  }

  async add(pdfPage, p, a) {
    const H = p.h;
    const Y = (y) => H - y;
    const M = displayMatrix(p);
    const [r, g, b] = hexRgb(a.color || '#000000');
    const fill = `${f(r)} ${f(g)} ${f(b)} rg\n`; const stroke = `${f(r)} ${f(g)} ${f(b)} RG\n`;
    const pathOf = (o) => o.map((q, i) => `${f(q[0])} ${f(Y(q[1]))} ${i ? 'l' : 'm'}`).join('\n').concat('\nh f\n');
    const d = (pt) => toDisp(p, pt[0], pt[1]);
    let content = ''; let box; let resources = {}; const extra = {}; let subtype = 'Stamp';
    const pad = (x0, y0, x1, y1, m) => [x0 - m, Y(y1) - m, x1 + m, Y(y0) + m];

    switch (a.type) {
      case 'ink': {
        subtype = 'Ink';
        const pts = a.pts.map(([x, y, pr]) => [...d([x, y]), pr]);
        const o = strokeOutline(pts, a.size, a.pressure);
        const xs = o.map((q) => q[0]); const ys = o.map((q) => q[1]);
        box = pad(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 1);
        content = fill + pathOf(o);
        extra.InkList = [a.pts.flatMap(([x, y]) => [f(x), f(y)])];
        extra.BS = { W: a.size };
        break;
      }
      case 'hl': case 'ul': case 'so': {
        subtype = { hl: 'Highlight', ul: 'Underline', so: 'StrikeOut' }[a.type];
        const quads = a.quads.map((q) => quadDisp(p, q));
        const xs = quads.flatMap((q) => [q.tl[0], q.tr[0], q.bl[0], q.br[0]]); const ys = quads.flatMap((q) => [q.tl[1], q.tr[1], q.bl[1], q.br[1]]);
        box = pad(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 1);
        if (a.type === 'hl') {
          resources = { ExtGState: { G0: { BM: 'Multiply' } } };
          content = `/G0 gs\n${fill}${quads.map((q) => `${f(q.tl[0])} ${f(Y(q.tl[1]))} m ${f(q.tr[0])} ${f(Y(q.tr[1]))} l ${f(q.br[0])} ${f(Y(q.br[1]))} l ${f(q.bl[0])} ${f(Y(q.bl[1]))} l h f`).join('\n')}\n`;
        } else {
          const t = a.type === 'ul' ? 0.92 : 0.55;
          content = `${stroke}1.2 w\n${quads.map((q) => {
            const L = [q.tl[0] + (q.bl[0] - q.tl[0]) * t, q.tl[1] + (q.bl[1] - q.tl[1]) * t];
            const R = [q.tr[0] + (q.br[0] - q.tr[0]) * t, q.tr[1] + (q.br[1] - q.tr[1]) * t];
            return `${f(L[0])} ${f(Y(L[1]))} m ${f(R[0])} ${f(Y(R[1]))} l S`;
          }).join('\n')}\n`;
        }
        extra.QuadPoints = a.quads.flat().map(f);
        if (a.text) extra.Contents = PDFHexString.fromText(a.text);
        break;
      }
      case 'rect': case 'ellipse': {
        subtype = a.type === 'rect' ? 'Square' : 'Circle';
        const R = dispRect(p, a);
        box = pad(...R, a.size + 1);
        const [x0, y0, x1, y1] = [R[0], Y(R[3]), R[2], Y(R[1])];
        content = `${stroke}${a.size} w\n`;
        if (a.type === 'rect') content += `${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)} re S\n`;
        else {
          const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2; const rx = (x1 - x0) / 2; const ry = (y1 - y0) / 2; const k = 0.5523;
          content += `${f(cx + rx)} ${f(cy)} m ${f(cx + rx)} ${f(cy + k * ry)} ${f(cx + k * rx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ${f(cx - k * rx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + k * ry)} ${f(cx - rx)} ${f(cy)} c ${f(cx - rx)} ${f(cy - k * ry)} ${f(cx - k * rx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ${f(cx + k * rx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - k * ry)} ${f(cx + rx)} ${f(cy)} c h S\n`;
        }
        extra.BS = { W: a.size };
        break;
      }
      case 'line': case 'arrow': {
        subtype = 'Line';
        const [x0, y0] = d(a.a); const [x1, y1] = d(a.b);
        const head = a.type === 'arrow' ? arrowHead(x0, y0, x1, y1, a.size) : [];
        const xs = [x0, x1, ...head.map((q) => q[0])]; const ys = [y0, y1, ...head.map((q) => q[1])];
        box = pad(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), a.size + 1);
        content = `${stroke}${a.size} w 1 J\n${f(x0)} ${f(Y(y0))} m ${f(x1)} ${f(Y(y1))} l S\n`;
        if (head.length) content += fill + pathOf(head);
        extra.L = [...a.a, ...a.b].map(f);
        extra.BS = { W: a.size };
        if (head.length) extra.LE = ['None', 'ClosedArrow'];
        break;
      }
      case 'text': {
        subtype = 'FreeText';
        const R = dispRect(p, a);
        const font = await this.font(StandardFonts.Helvetica);
        const lines = wrapLines(a.text, a.fontSize, R[2] - R[0]);
        box = pad(...R, 1);
        content = `${fill}BT\n/F0 ${a.fontSize} Tf\n`;
        let prevY = 0; let first = true;
        lines.forEach((l, i) => {
          const y = Y(R[1] + a.fontSize * (1 + i * 1.2));
          content += first ? `${f(R[0])} ${f(y)} Td\n` : `0 ${f(y - prevY)} Td\n`;
          content += `${this.str(font, l).hex} Tj\n`;
          prevY = y; first = false;
        });
        content += 'ET\n';
        resources = { Font: { F0: font.ref } };
        extra.Contents = PDFHexString.fromText(a.text);
        extra.DA = PDFHexString.fromText(`${f(r)} ${f(g)} ${f(b)} rg /Helv ${a.fontSize} Tf`);
        break;
      }
      case 'note': {
        subtype = 'Text';
        const [x, y] = d(a.a);
        box = pad(x, y, x + 22, y + 20, 0);
        const bx = x; const by = Y(y + 20);
        content = `${fill}${f(bx)} ${f(by)} 22 20 re f\n1 1 1 RG 1.6 w\n${f(bx + 5)} ${f(by + 13)} m ${f(bx + 17)} ${f(by + 13)} l S\n${f(bx + 5)} ${f(by + 8)} m ${f(bx + 13)} ${f(by + 8)} l S\n`;
        extra.Contents = PDFHexString.fromText(a.text);
        extra.Name = 'Comment';
        break;
      }
      case 'stamp': {
        const R = dispRect(p, a);
        const font = await this.font(StandardFonts.HelveticaBold);
        const w = R[2] - R[0]; const hg = R[3] - R[1];
        const fs = stampFont(a.label, w, hg);
        const { hex, safe } = this.str(font, a.label);
        const tw = font.widthOfTextAtSize(safe, fs);
        box = pad(...R, 1);
        content = `${stroke}2 w\n${f(R[0] + 1)} ${f(Y(R[3]) + 1)} ${f(w - 2)} ${f(hg - 2)} re S\n${fill}BT\n/F0 ${f(fs)} Tf\n${f(R[0] + (w - tw) / 2)} ${f(Y(R[1] + hg / 2 + fs * 0.36))} Td\n${hex} Tj\nET\n`;
        resources = { Font: { F0: font.ref } };
        extra.Contents = PDFHexString.fromText(a.label);
        break;
      }
      case 'label': {
        // Pillola con fondo chiaro, bordo e testo del colore scelto (come a schermo).
        subtype = 'FreeText';
        const R = dispRect(p, a); const L = labelParts(R, a.text);
        const font = await this.font(StandardFonts.HelveticaBold);
        const { hex } = this.str(font, a.text);
        const light = [r, g, b].map((v) => f(1 - (1 - v) * 0.16)).join(' ');
        const x0 = R[0] + 0.7; const x1 = R[2] - 0.7; const yb = Y(R[3]) + 0.7; const yt = Y(R[1]) - 0.7;
        const rr = (yt - yb) / 2; const K = 0.5523 * rr; const ym = yb + rr;
        const pill = `${f(x0 + rr)} ${f(yb)} m ${f(x1 - rr)} ${f(yb)} l ${f(x1 - rr + K)} ${f(yb)} ${f(x1)} ${f(ym - K)} ${f(x1)} ${f(ym)} c ${f(x1)} ${f(ym + K)} ${f(x1 - rr + K)} ${f(yt)} ${f(x1 - rr)} ${f(yt)} c ${f(x0 + rr)} ${f(yt)} l ${f(x0 + rr - K)} ${f(yt)} ${f(x0)} ${f(ym + K)} ${f(x0)} ${f(ym)} c ${f(x0)} ${f(ym - K)} ${f(x0 + rr - K)} ${f(yb)} ${f(x0 + rr)} ${f(yb)} c h`;
        const [cx, cyD, cr] = L.dot; const cy = Y(cyD); const k = 0.5523 * cr;
        const dot = `${f(cx + cr)} ${f(cy)} m ${f(cx + cr)} ${f(cy + k)} ${f(cx + k)} ${f(cy + cr)} ${f(cx)} ${f(cy + cr)} c ${f(cx - k)} ${f(cy + cr)} ${f(cx - cr)} ${f(cy + k)} ${f(cx - cr)} ${f(cy)} c ${f(cx - cr)} ${f(cy - k)} ${f(cx - k)} ${f(cy - cr)} ${f(cx)} ${f(cy - cr)} c ${f(cx + k)} ${f(cy - cr)} ${f(cx + cr)} ${f(cy - k)} ${f(cx + cr)} ${f(cy)} c h f`;
        box = pad(...R, 1.5);
        content = `${light} rg\n${stroke}1.4 w\n${pill} B\n${fill}${dot}\nBT\n/F0 ${f(L.fs)} Tf\n${f(L.tx)} ${f(Y(R[1] + L.hg / 2 + L.fs * 0.36))} Td\n${hex} Tj\nET\n`;
        resources = { Font: { F0: font.ref } };
        extra.Contents = PDFHexString.fromText(a.text);
        extra.DA = PDFHexString.fromText(`${f(r)} ${f(g)} ${f(b)} rg /Helv ${f(L.fs)} Tf`);
        break;
      }
      case 'sig': {
        const R = dispRect(p, a);
        box = pad(...R, 1);
        if (a.png) {
          const img = await this.pdf.embedPng(a.png);
          content = `q ${f(R[2] - R[0])} 0 0 ${f(R[3] - R[1])} ${f(R[0])} ${f(Y(R[3]))} cm /I0 Do Q\n`;
          resources = { XObject: { I0: img.ref } };
        } else content = fill + sigPaths(a, R).map(pathOf).join('');
        extra.Contents = PDFHexString.fromText('Firma visiva');
        break;
      }
      case 'image': {
        // Immagine inserita dall'utente (PNG o JPEG), ridimensionabile e spostabile finché il file resta di Postilla.
        const R = dispRect(p, a);
        box = pad(...R, 0);
        const bytes = Uint8Array.from(atob(a.src.slice(a.src.indexOf(',') + 1)), (c) => c.charCodeAt(0));
        const img = /^data:image\/jpe?g/i.test(a.src) ? await this.pdf.embedJpg(bytes) : await this.pdf.embedPng(bytes);
        content = `q ${f(R[2] - R[0])} 0 0 ${f(R[3] - R[1])} ${f(R[0])} ${f(Y(R[3]))} cm /I0 Do Q\n`;
        resources = { XObject: { I0: img.ref } };
        extra.Contents = PDFHexString.fromText('Immagine');
        break;
      }
      case 'redact': {
        // Zona da oscurare non ancora applicata: si salva come annotazione di oscuramento (contorno rosso).
        // Il contenuto sotto resta finché non si applica l'oscuramento.
        subtype = 'Redact';
        const quads = a.quads.map((q) => quadDisp(p, q));
        const xs = quads.flatMap((q) => [q.tl[0], q.tr[0], q.bl[0], q.br[0]]); const ys = quads.flatMap((q) => [q.tl[1], q.tr[1], q.bl[1], q.br[1]]);
        box = pad(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 1);
        content = `0.8 0 0 RG 1.2 w\n${quads.map((q) => `${f(q.tl[0])} ${f(Y(q.tl[1]))} m ${f(q.tr[0])} ${f(Y(q.tr[1]))} l ${f(q.br[0])} ${f(Y(q.br[1]))} l ${f(q.bl[0])} ${f(Y(q.bl[1]))} l h S`).join('\n')}\n`;
        extra.QuadPoints = a.quads.flat().map(f);
        break;
      }
      case 'measure': {
        // Misura: linea con i trattini alle estremità e l'etichetta («3,25 m») sopra il centro.
        subtype = 'Line';
        const [x0, y0] = d(a.a); const [x1, y1] = d(a.b);
        const font = await this.font(StandardFonts.HelveticaBold);
        const fs = 9; const { hex, safe } = this.str(font, a.label || '');
        const tw = font.widthOfTextAtSize(safe, fs);
        const ang = Math.atan2(y1 - y0, x1 - x0); const nx = -Math.sin(ang) * 4; const ny = Math.cos(ang) * 4;
        const mx = (x0 + x1) / 2; const my = (y0 + y1) / 2;
        box = pad(Math.min(x0, x1, mx - tw / 2), Math.min(y0, y1, my - fs - 6), Math.max(x0, x1, mx + tw / 2), Math.max(y0, y1, my), a.size + 6);
        const seg = (ax, ay, bx, by) => `${f(ax)} ${f(Y(ay))} m ${f(bx)} ${f(Y(by))} l S\n`;
        content = `${stroke}${a.size} w 1 J\n${seg(x0, y0, x1, y1)}${seg(x0 + nx, y0 + ny, x0 - nx, y0 - ny)}${seg(x1 + nx, y1 + ny, x1 - nx, y1 - ny)}`;
        content += `1 1 1 rg ${f(mx - tw / 2 - 2)} ${f(Y(my - 1.5))} ${f(tw + 4)} ${f(fs + 2)} re f\n${fill}BT /F0 ${fs} Tf ${f(mx - tw / 2)} ${f(Y(my - 4))} Td ${hex} Tj ET\n`;
        resources = { Font: { F0: font.ref } };
        extra.L = [...a.a, ...a.b].map(f);
        extra.BS = { W: a.size };
        extra.IT = PDFName.of('LineDimension');
        extra.Contents = PDFHexString.fromText(a.label || '');
        break;
      }
      case 'area': {
        subtype = 'Polygon';
        const pts = a.pts.map((q) => d(q));
        const font = await this.font(StandardFonts.HelveticaBold);
        const fs = 9; const { hex, safe } = this.str(font, a.label || '');
        const tw = font.widthOfTextAtSize(safe, fs);
        const cx = pts.reduce((t, q) => t + q[0], 0) / pts.length; const cy = pts.reduce((t, q) => t + q[1], 0) / pts.length;
        const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
        box = pad(Math.min(...xs, cx - tw / 2), Math.min(...ys, cy - fs), Math.max(...xs, cx + tw / 2), Math.max(...ys, cy + 3), a.size + 2);
        const poly = `${pts.map((q, i) => `${f(q[0])} ${f(Y(q[1]))} ${i ? 'l' : 'm'}`).join(' ')} h`;
        resources = { ExtGState: { G0: { ca: 0.12 } }, Font: { F0: font.ref } };
        content = `q /G0 gs ${fill}${poly} f Q\n${stroke}${a.size} w 1 j\n${poly} S\n`;
        content += `1 1 1 rg ${f(cx - tw / 2 - 2)} ${f(Y(cy + 2.5))} ${f(tw + 4)} ${f(fs + 2)} re f\n${fill}BT /F0 ${fs} Tf ${f(cx - tw / 2)} ${f(Y(cy))} Td ${hex} Tj ET\n`;
        extra.Vertices = a.pts.flat().map(f);
        extra.BS = { W: a.size };
        extra.IT = PDFName.of('PolygonDimension');
        extra.Contents = PDFHexString.fromText(a.label || '');
        break;
      }
      default: return;
    }

    const { context } = this.pdf;
    const form = this.form(p, M, box, content, resources);
    if (this.flatten) {
      this.n += 1;
      const name = pdfPage.node.newXObject(`PostillaF${this.n}`, form);
      pdfPage.pushOperators(window.PDFLib.pushGraphicsState(), window.PDFLib.drawObject(name), window.PDFLib.popGraphicsState());
      return;
    }
    const dict = context.obj({
      Type: 'Annot', Subtype: subtype, Rect: this.rectOf(M, box), F: 4, C: [f(r), f(g), f(b)],
      NM: PDFHexString.fromText(a.id), T: PDFHexString.fromText('Postilla'), AP: { N: form }, ...extra,
    });
    const clean = { ...a }; delete clean.page;
    dict.set(PDFName.of(KEY), PDFHexString.fromText(JSON.stringify(clean)));
    pdfPage.node.addAnnot(context.register(dict));
  }
}

export async function buildPdf(view, { flatten = false } = {}) {
  const pdf = await PDFDocument.load(await view.ensureBytes(), loadOpts);
  const pages = pdf.getPages();
  const w = new Writer(pdf, flatten);
  // Sostituzioni e aggiunte di testo: entrano nel contenuto della pagina, prima delle annotazioni.
  await writeEdits(pdf, pages, view.annots.filter((a) => a.type === 'edit'), flatten, w);
  for (const a of view.annots) {
    if (a.type === 'edit') continue;
    await view.getPage(a.page);
    await w.add(pages[a.page], view.pages[a.page], a);
  }
  // Campi disegnati con «Crea modulo»: diventano campi veri del PDF.
  const newFields = view.annots.filter((a) => a.type === 'field');
  if (newFields.length) createFields(pdf, pages, newFields, await w.font(StandardFonts.Helvetica));
  // Campi compilabili: valori veri del modulo, con il loro aspetto rigenerato.
  const problems = await applyFormEdits(pdf, view.formEdits, await w.font(StandardFonts.Helvetica));
  if (problems.length) console.warn('Campi non aggiornati:', problems.join(', '));
  if (flatten && pdf.catalog.get(PDFName.of('AcroForm'))) {
    try {
      pdf.getForm().flatten();
      // pdf-lib lascia nelle pagine riferimenti ai riquadri dei campi tolti: si puliscono, e il modulo vuoto si elimina.
      for (const pg of pages) {
        const arr = pg.node.Annots();
        if (!arr) continue;
        for (let k = arr.size() - 1; k >= 0; k -= 1) if (!arr.lookup(k)) arr.remove(k);
        if (!arr.size()) pg.node.delete(PDFName.of('Annots'));
      }
      pdf.catalog.delete(PDFName.of('AcroForm'));
    } catch (e) { console.error(e); }
  }
  if (!flatten) pdf.getInfoDict().set(MARK, PDFHexString.fromText('1'));
  // Registro delle modifiche: resta dentro la copia (non nella versione definitiva).
  if (!flatten && view.editLog?.length) pdf.catalog.set(LOG, PDFHexString.fromText(JSON.stringify(view.editLog)));
  return pdf.save(saveOpts);
}

// --- Operazioni sulle pagine: restituiscono i nuovi byte e dove finisce ogni pagina ---
async function edit(bytes, fn) {
  const pdf = await PDFDocument.load(bytes, loadOpts);
  await fn(pdf);
  return pdf.save(saveOpts);
}

export const rotatePages = (bytes, list, deg) => edit(bytes, (pdf) => {
  list.forEach((i) => { const pg = pdf.getPage(i); pg.setRotation(degrees((pg.getRotation().angle + deg + 360) % 360)); });
});

export const deletePages = (bytes, list) => edit(bytes, (pdf) => {
  [...list].sort((a, b) => b - a).forEach((i) => pdf.removePage(i));
});

// order[n] = indice attuale della pagina che deve finire in posizione n
export const reorderPages = (bytes, order) => edit(bytes, (pdf) => {
  const pages = pdf.getPages();
  for (let i = pages.length - 1; i >= 0; i -= 1) pdf.removePage(i);
  order.forEach((o, n) => pdf.insertPage(n, pages[o]));
});

export const countPages = async (bytes) => (await PDFDocument.load(bytes, loadOpts)).getPageCount();

export const insertBlank = (bytes, at, size) => edit(bytes, (pdf) => { pdf.insertPage(at, size); });

export const insertPdf = (bytes, other, at) => edit(bytes, async (pdf) => {
  const src = await PDFDocument.load(other, loadOpts);
  const copied = await pdf.copyPages(src, src.getPageIndices());
  copied.forEach((pg, n) => pdf.insertPage(at + n, pg));
});

export async function extractPages(bytes, list) {
  const src = await PDFDocument.load(bytes, loadOpts);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, list);
  copied.forEach((pg) => out.addPage(pg));
  if (src.getInfoDict().has(MARK)) out.getInfoDict().set(MARK, PDFHexString.fromText('1'));
  return out.save(saveOpts);
}
