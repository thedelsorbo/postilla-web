// Modifiche al testo del documento: «Sostituisci» copre il testo scelto con il colore del fondo e scrive sopra
// il testo nuovo; «Aggiungi» scrive un testo nuovo accanto. Carattere, dimensione e colore sono ricavati dall'originale:
// si usa lo stesso carattere se è installato sul dispositivo, altrimenti il più simile fra quelli standard.
// Al salvataggio la modifica diventa parte della pagina (sempre in una copia); riaprendo con Postilla resta modificabile.
import { h, modal, toast, uid } from './core.js';
import { toDisp, toUser as toUserPt } from './annots.js';
import { pageText as pageTextFor } from './text.js';
import { logEntry, warningFor } from './thirdparty.js';

const { PDFDocument, StandardFonts, PDFName, PDFDict, PDFArray } = window.PDFLib;

// --- Caratteri -------------------------------------------------------------------
let installed = null; // [{name, key, file}]
const keyOf = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const fontBytes = new Map(); // file -> Promise<Uint8Array|null>
const faces = new Map(); // file -> nome CSS del carattere caricato per l'anteprima
let stdDoc = null;

async function fontTable() {
  if (!installed) installed = (await host.fontList?.().catch(() => []) || []).map((f) => ({ ...f, key: keyOf(f.name) }));
  return installed;
}

// Nome del carattere nel PDF → famiglia e stile. «ABCDEF+TimesNewRomanPS-BoldItalicMT» → Times New Roman, grassetto, corsivo.
export function parseFontName(raw = '', flags = {}) {
  const name = String(raw).replace(/^[A-Z]{6}\+/, '');
  const [famRaw, styleRaw = ''] = name.split(/[-,]/);
  const fam = famRaw.replace(/(PSMT|PS|MT)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  const st = `${styleRaw} ${famRaw}`.toLowerCase();
  const bold = !!flags.bold || /bold|black|heavy|semibold|demi/.test(st);
  const italic = !!flags.italic || /italic|oblique/.test(st);
  return { family: fam || 'Helvetica', bold, italic };
}

const ALIAS = { helvetica: 'Arial', arial: 'Arial', times: 'Times New Roman', timesroman: 'Times New Roman', courier: 'Courier New' };

function stdFor({ family, bold, italic }, serif, mono) {
  const k = keyOf(family);
  const kind = mono || /courier|mono|consol/.test(k) ? 'Courier' : (serif || /times|serif|roman|garamond|georgia|cambria|bookman/.test(k) ? 'Times' : 'Helvetica');
  const map = {
    Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
    Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
    Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
  }[kind];
  return { std: map[(bold ? 1 : 0) + (italic ? 2 : 0)], css: { Helvetica: 'Arial, Helvetica, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' }[kind] };
}

// Cerca il file del carattere installato: prima nome e stile esatti, poi la famiglia.
export async function matchFont(info, serif = false, mono = false) {
  const table = await fontTable();
  const fam = ALIAS[keyOf(info.family)] || info.family;
  const style = `${info.bold ? ' Bold' : ''}${info.italic ? ' Italic' : ''}`;
  const want = [keyOf(`${fam}${style}`), keyOf(`${fam}${style.replace('Italic', 'Oblique')}`)];
  if (!info.bold && !info.italic) want.push(keyOf(`${fam} Regular`), keyOf(fam));
  let hit = table.find((f) => want.includes(f.key));
  const std = stdFor({ ...info, family: fam }, serif, mono);
  if (hit) {
    const bytes = await loadBytes(hit.file);
    if (bytes && embeddable(bytes)) return { name: hit.name, file: hit.file, ...std, bold: info.bold, italic: info.italic, exact: true };
    hit = null;
  }
  return { name: std.std.replace(/([a-z])([A-Z])/g, '$1 $2'), file: null, ...std, bold: info.bold, italic: info.italic, exact: false, wanted: `${fam}${style}` };
}

function loadBytes(file) {
  if (!fontBytes.has(file)) fontBytes.set(file, host.readFile(file).then((r) => new Uint8Array(r.data)).catch(() => null));
  return fontBytes.get(file);
}

// Rispetta le licenze dei caratteri: quelli marcati «non incorporabili» non si usano.
function embeddable(bytes) {
  try { const f = window.fontkit.create(bytes); const t = f['OS/2']?.fsType ?? 0; return !(t & 0x0002) || !!(t & 0x000C); } catch { return false; }
}

export async function cssFamily(font) {
  if (!font?.file) return font?.css || 'Arial, sans-serif';
  if (!faces.has(font.file)) {
    faces.set(font.file, (async () => {
      const bytes = await loadBytes(font.file);
      const css = `pf_${keyOf(font.name)}_${faces.size}`;
      const face = new FontFace(css, bytes);
      await face.load();
      document.fonts.add(face);
      return `"${css}"`;
    })().catch(() => font.css));
  }
  return faces.get(font.file);
}

// Larghezza del testo in punti, con le misure vere del carattere.
export async function textWidth(font, text, size) {
  if (font.file) {
    const bytes = await loadBytes(font.file);
    try { const f = window.fontkit.create(bytes); return (f.layout(text).advanceWidth / f.unitsPerEm) * size; } catch { /* misura standard sotto */ }
  }
  stdDoc = stdDoc || PDFDocument.create();
  const doc = await stdDoc;
  const pf = await doc.embedFont(StandardFonts[font.std] || StandardFonts.Helvetica);
  try { return pf.widthOfTextAtSize(text, size); } catch { return text.length * size * 0.5; }
}

// Caratteri della pagina letti dal file (nome vero e riquadro dei glifi). PDF.js non espone più il nome:
// si riconosce il carattere confrontando il suo riquadro (FontBBox) con quelli dichiarati nel file.
async function pageFonts(view, i) {
  view.fontTable = view.fontTable || new Map();
  if (!view.fontTable.has(i)) {
    view.fontTable.set(i, (async () => {
      view.libDoc = view.libDoc || PDFDocument.load(await view.ensureBytes(), { updateMetadata: false });
      const doc = await view.libDoc;
      const page = doc.getPage(i);
      const fonts = page.node.Resources()?.lookup(PDFName.of('Font'));
      if (!(fonts instanceof PDFDict)) return [];
      const out = [];
      for (const [, ref] of fonts.entries()) {
        const fd = doc.context.lookup(ref);
        if (!(fd instanceof PDFDict)) continue;
        const base = fd.lookup(PDFName.of('BaseFont'))?.decodeText?.() || fd.lookup(PDFName.of('BaseFont'))?.asString?.().slice(1) || '';
        let desc = fd.lookup(PDFName.of('FontDescriptor'));
        const kids = fd.lookup(PDFName.of('DescendantFonts'));
        if (!desc && kids instanceof PDFArray) desc = doc.context.lookup(kids.get(0))?.lookup(PDFName.of('FontDescriptor'));
        const bb = desc instanceof PDFDict ? desc.lookup(PDFName.of('FontBBox')) : null;
        const flags = desc instanceof PDFDict ? desc.lookup(PDFName.of('Flags'))?.asNumber?.() || 0 : 0;
        out.push({ base: base.replace(/^\//, ''), bbox: bb instanceof PDFArray ? bb.asArray().map((n) => n.asNumber()) : null, serif: !!(flags & 2), mono: !!(flags & 1) });
      }
      return out;
    })().catch(() => []));
  }
  return view.fontTable.get(i);
}

async function realFontName(view, i, obj) {
  if (!obj) return null;
  if (obj.loadedName && !/^g_/.test(obj.loadedName)) return { base: obj.loadedName }; // caratteri standard non incorporati
  if (!obj.bbox) return null;
  const list = await pageFonts(view, i);
  const hit = list.find((f) => f.bbox && f.bbox.every((v, k) => Math.abs(v - obj.bbox[k]) <= 1.5));
  return hit || null;
}

// --- Stile del testo scelto ---------------------------------------------------------
// Dal testo selezionato: carattere, dimensione, direzione, linea di base, colori di testo e fondo.
export async function styleOf(view, p, words) {
  const pg = await view.getPage(p.i);
  const content = await pg.getTextContent();
  const first = words[0];
  const it = first.ocr ? null : content.items[first.item];
  let size; let u; let v; let fontInfo; let serif = false; let mono = false;
  if (it) {
    const [a, b, c, d] = it.transform;
    size = Math.hypot(c, d) || Math.hypot(a, b);
    const la = Math.hypot(a, b) || 1; const lc = Math.hypot(c, d) || 1;
    u = [a / la, b / la]; v = [c / lc, d / lc];
    let obj = null;
    try { if (pg.commonObjs.has(it.fontName)) obj = pg.commonObjs.get(it.fontName); } catch { obj = null; }
    const style = content.styles?.[it.fontName] || {};
    serif = /serif/.test(style.fontFamily || '') && !/sans/.test(style.fontFamily || '');
    mono = /monospace/.test(style.fontFamily || '');
    const real = await realFontName(view, p.i, obj);
    fontInfo = parseFontName(real?.base || style.fontFamily || 'Helvetica', { bold: obj?.bold || obj?.black, italic: obj?.italic });
    if (real?.serif) serif = true;
    if (real?.mono) mono = true;
    if (obj?.isSerifFont) serif = true;
    if (obj?.isMonospace) mono = true;
  } else {
    // Pagina scansionata (OCR): dimensione dall'altezza della parola, carattere comune.
    const q = first.quad;
    size = Math.max(4, Math.abs(q[1] - q[5]) / 1.16);
    u = [1, 0]; v = [0, 1];
    fontInfo = { family: 'Arial', bold: false, italic: false };
  }
  const font = await matchFont(fontInfo, serif, mono);
  const base = (q, corner) => [q[corner] + v[0] * size * 0.24, q[corner + 1] + v[1] * size * 0.24];
  const colors = sampleColors(p, words.map((w) => w.quad));
  return { size, u, v, font, origin: base(first.quad, 4), end: base(words[words.length - 1].quad, 6), ...colors };
}

const hex = (r, g, b) => `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;

// Colore del fondo (bordo intorno al testo) e del testo (pixel più lontani dal fondo), letti dalla pagina disegnata.
export function sampleColors(p, quads) {
  const cv = p.canvas;
  if (!cv || !p.rs) return { bg: '#ffffff', color: '#000000' };
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let x0 = 1e9; let y0 = 1e9; let x1 = -1e9; let y1 = -1e9;
  for (const q of quads) for (let k = 0; k < 8; k += 2) { const d = toDisp(p, q[k], q[k + 1]); x0 = Math.min(x0, d[0]); y0 = Math.min(y0, d[1]); x1 = Math.max(x1, d[0]); y1 = Math.max(y1, d[1]); }
  const s = p.rs; const pad = 2;
  const X0 = Math.max(0, Math.floor((x0 - pad) * s)); const Y0 = Math.max(0, Math.floor((y0 - pad) * s));
  const X1 = Math.min(cv.width, Math.ceil((x1 + pad) * s)); const Y1 = Math.min(cv.height, Math.ceil((y1 + pad) * s));
  if (X1 - X0 < 3 || Y1 - Y0 < 3) return { bg: '#ffffff', color: '#000000' };
  const img = ctx.getImageData(X0, Y0, X1 - X0, Y1 - Y0);
  const W = img.width; const H = img.height; const dt = img.data;
  const ring = []; const inner = [];
  const edge = Math.max(1, Math.round(pad * s * 0.6));
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const k = (y * W + x) * 4;
    const px = [dt[k], dt[k + 1], dt[k + 2]];
    if (x < edge || y < edge || x >= W - edge || y >= H - edge) ring.push(px); else inner.push(px);
  }
  const med = (arr, c) => { const v = arr.map((q) => q[c]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] ?? 255; };
  const bg = [0, 1, 2].map((c) => med(ring.length ? ring : inner, c));
  const far = inner.map((q) => ({ q, d: Math.hypot(q[0] - bg[0], q[1] - bg[1], q[2] - bg[2]) })).filter((o) => o.d > 90).sort((a, b) => b.d - a.d);
  const top = far.slice(0, Math.max(1, Math.floor(far.length * 0.4)));
  const fg = top.length && far.length ? [0, 1, 2].map((c) => top.reduce((n, o) => n + o.q[c], 0) / top.length) : [0, 0, 0];
  return { bg: hex(...bg), color: hex(...fg) };
}

// --- Costruzione della modifica -------------------------------------------------------
export async function makeEdit(view, p, words, mode, text, source = 'mano') {
  const st = await styleOf(view, p, words);
  const origin = mode === 'replace' ? st.origin : [st.end[0] + st.u[0] * st.size * 0.28, st.end[1] + st.u[1] * st.size * 0.28];
  const e = {
    id: uid(), type: 'edit', page: p.i, mode, text, before: mode === 'replace' ? words.map((w) => w.str).join(' ') : '',
    quads: mode === 'replace' ? words.map((w) => padQuad(w.quad, st.u, st.v, Math.max(0.8, st.size * 0.1), 0.4)) : [],
    bg: st.bg, color: st.color, size: +st.size.toFixed(2), a: origin, dir: st.u, up: st.v,
    font: { name: st.font.name, file: st.font.file, std: st.font.std, css: st.font.css, exact: st.font.exact, wanted: st.font.wanted || null, bold: st.font.bold, italic: st.font.italic },
    source, at: new Date().toISOString(),
  };
  return withText(e, text);
}

// Allarga un po' il riquadro della parola (le misure del testo nel PDF sono approssimate): mu lungo la riga, mv in altezza.
const padQuad = (q, u, v, mu, mv) => {
  const du = [u[0] * mu, u[1] * mu]; const dv = [v[0] * mv, v[1] * mv];
  return [q[0] - du[0] + dv[0], q[1] - du[1] + dv[1], q[2] + du[0] + dv[0], q[3] + du[1] + dv[1], q[4] - du[0] - dv[0], q[5] - du[1] - dv[1], q[6] + du[0] - dv[0], q[7] + du[1] - dv[1]];
};

// Aggiorna testo, larghezza e riquadro del testo nuovo.
export async function withText(e, text) {
  const w = await textWidth(e.font, text, e.size);
  const [ox, oy] = e.a; const [ux, uy] = e.dir; const [vx, vy] = e.up;
  const top = e.size * 0.92; const bot = -e.size * 0.24;
  const pt = (t, up) => [ox + ux * t + vx * up, oy + uy * t + vy * up];
  return { ...e, text, w: +w.toFixed(2), tquad: [...pt(0, top), ...pt(w, top), ...pt(0, bot), ...pt(w, bot)], css: await cssFamily(e.font) };
}

// Larghezza disponibile al posto del testo originale (per avvisare se il nuovo è più lungo).
export function coverWidth(e) {
  if (!e.quads.length) return Infinity;
  const [ux, uy] = e.dir;
  const proj = e.quads.flatMap((q) => [0, 2, 4, 6].map((k) => q[k] * ux + q[k + 1] * uy));
  return Math.max(...proj) - Math.min(...proj) - 0.8;
}

// Aggiunta in un punto toccato sulla pagina: stile della parola più vicina, linea di base nel punto toccato.
export async function makeEditAt(view, p, x, y, text, source = 'mano') {
  const pt = await pageTextFor(view, p.i);
  const u = toUserPt(p, x, y);
  let best = null; let bd = Infinity;
  for (const w of pt.words) { const q = w.quad; const cx = (q[0] + q[6]) / 2; const cy = (q[1] + q[7]) / 2; const d = Math.hypot(cx - u[0], (cy - u[1]) * 2); if (d < bd) { bd = d; best = w; } }
  if (!best) {
    const e = { id: uid(), type: 'edit', page: p.i, mode: 'add', text, before: '', quads: [], bg: '#ffffff', color: '#000000', size: 11, a: u, dir: [1, 0], up: [0, 1], font: { name: 'Helvetica', file: null, std: 'Helvetica', css: 'Arial, sans-serif', exact: false, bold: false, italic: false }, source, at: new Date().toISOString() };
    return withText(e, text);
  }
  const e = await makeEdit(view, p, [best], 'add', text, source);
  return withText({ ...e, a: u }, text);
}

// --- Finestra di modifica ----------------------------------------------------------------
// Mostra l'anteprima sulla pagina mentre si scrive; restituisce la modifica confermata oppure null.
export async function editDialog(app, view, draft, { title, warn, okLabel, strong } = {}) {
  const tools = app.tools;
  let cur = draft;
  const show = () => {
    view.annots = view.annots.filter((x) => x.id !== cur.id).concat(cur);
    tools.draw(view, cur.page);
  };
  show();
  const font = cur.font;
  const info = font.exact ? `Carattere: ${font.name}, ${cur.size.toFixed(1).replace('.', ',')} pt (lo stesso del documento)`
    : `Carattere: ${font.name}, ${cur.size.toFixed(1).replace('.', ',')} pt (il più simile disponibile${font.wanted ? ` a «${font.wanted}»` : ''})`;
  const result = await modal((box, done) => {
    const input = h('input', { type: 'text', value: cur.text, class: 'edit-input', 'aria-label': 'Testo nuovo' });
    const note = h('p', { class: 'hint edit-long' });
    const check = () => { const long = cur.w > coverWidth(cur) * 1.02; note.textContent = long ? 'Attenzione: il testo nuovo è più lungo di quello originale e può sovrapporsi al testo vicino.' : ''; };
    let seq = 0;
    input.addEventListener('input', async () => { const n = ++seq; const next = await withText(cur, input.value); if (n !== seq) return; cur = next; show(); check(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); });
    check();
    box.classList.add('edit-dialog');
    box.append(...[h('h2', {}, title || (cur.mode === 'replace' ? 'Sostituisci il testo' : 'Aggiungi testo')),
      cur.mode === 'replace' ? h('p', {}, `Testo originale: «${cur.before}»`) : null,
      h('label', {}, 'Testo nuovo', input), h('p', { class: 'hint' }, info), note,
      warn ? h('p', { class: `edit-warn${strong ? ' strong' : ''}` }, warn) : null,
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => done(false) }, 'Annulla'),
        h('button', { class: 'primary', onclick: () => done(true) }, okLabel || (cur.mode === 'replace' ? 'Sostituisci' : 'Aggiungi')))].filter(Boolean));
  });
  view.annots = view.annots.filter((x) => x.id !== cur.id);
  tools.draw(view, cur.page);
  if (!result || !cur.text.trim()) return null;
  return cur;
}

export async function startEdit(app, view, p, words, mode, { text: proposed, source = 'mano' } = {}) {
  if (!words.length) return null;
  if (!app.tools.guardEdit(view)) return null;
  const text = proposed ?? (mode === 'replace' ? words.map((w) => w.str).join(' ') : '');
  const draft = await makeEdit(view, p, words, mode, text, source);
  const done = await editDialog(app, view, draft, warningFor(app, view, mode) || {});
  if (!done) return null;
  app.tools.apply(view, { add: [done] });
  logEntry(app, view, { kind: mode === 'replace' ? 'sostituzione' : 'aggiunta', page: done.page, before: done.before, after: done.text, source });
  toast(mode === 'replace' ? 'Testo sostituito. L\'originale resta intatto: al salvataggio Postilla crea una copia.' : 'Testo aggiunto. Al salvataggio Postilla crea una copia.');
  return done;
}

// Dopo la riapertura (o il recupero di una bozza) le modifiche ritrovano il carattere per l'anteprima.
export async function hydrateEdits(app, view) {
  const list = view.annots.filter((a) => a.type === 'edit' && a.font?.file);
  if (!list.length) return;
  for (const a of list) a.css = await cssFamily(a.font);
  [...new Set(list.map((a) => a.page))].forEach((i) => app.tools.draw(view, i));
}

// Modifica di nuovo una sostituzione o un'aggiunta già fatta.
export async function reEdit(app, view, a) {
  if (a.lines) { const m = await import('./pro/paragraph.js'); return m.reEditParagraph(app, view, a); }
  view.annots = view.annots.filter((x) => x.id !== a.id); // durante la modifica si vede solo l'anteprima
  const done = await editDialog(app, view, { ...a, id: uid() }, { title: 'Modifica il testo', ...(warningFor(app, view, a.mode) || {}) });
  if (!done) { view.annots.push(a); app.tools.draw(view, a.page); return; }
  app.tools.apply(view, { remove: [a], add: [done] });
  if (done.text !== a.text) logEntry(app, view, { kind: 'correzione', page: done.page, before: a.text, after: done.text });
}
