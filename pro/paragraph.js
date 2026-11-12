// Modifica di un paragrafo intero, come in Word (0.9.0): si sceglie una parola del paragrafo, Postilla
// trova tutte le sue righe, si riscrive il testo e le righe vanno a capo da sole dentro la stessa larghezza,
// con lo stesso carattere, la stessa interlinea e lo stesso allineamento (anche giustificato).
// Il testo originale si toglie davvero dalla pagina al salvataggio (come «Sostituisci»); se il paragrafo nuovo
// è più lungo, si può ridurre un po' il carattere per farlo stare nello spazio di prima.
// Limiti: testo orizzontale; tutto il paragrafo prende il carattere della prima parola (niente grassetti misti).
import { h, modal, toast, uid } from '../core.js';
import { styleOf, textWidth, cssFamily } from '../edits.js';
import { pageText } from '../text.js';
import { logEntry, warningFor } from '../thirdparty.js';

// Parola → riga di base e misure (coordinate del PDF, testo orizzontale).
function wordBox(w) {
  const q = w.quad;
  const top = Math.max(q[1], q[3]); const bot = Math.min(q[5], q[7]);
  const hgt = (top - bot) / 1.16;
  return { w, x0: Math.min(q[0], q[4]), x1: Math.max(q[2], q[6]), base: bot + 0.24 * hgt, size: hgt };
}

// Righe della pagina: parole sulla stessa linea di base, divise dove c'è un grande spazio (altra colonna).
export function pageLines(words) {
  const boxes = words.filter((w) => !w.ocr).map(wordBox).filter((b) => b.size > 1).sort((a, b) => b.base - a.base || a.x0 - b.x0);
  const lines = [];
  for (const b of boxes) {
    let ln = null;
    for (let k = lines.length - 1; k >= Math.max(0, lines.length - 6); k -= 1) if (Math.abs(lines[k].base - b.base) < 0.4 * Math.min(lines[k].size, b.size)) { ln = lines[k]; break; }
    if (!ln) { ln = { base: b.base, size: b.size, boxes: [] }; lines.push(ln); }
    ln.boxes.push(b);
  }
  const out = [];
  for (const ln of lines) {
    ln.boxes.sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const b of ln.boxes) {
      if (!cur || b.x0 - cur.x1 > Math.max(2.2 * ln.size, 18)) { cur = { base: ln.base, size: b.size, boxes: [], x0: b.x0, x1: b.x1 }; out.push(cur); }
      cur.boxes.push(b); cur.x1 = Math.max(cur.x1, b.x1); cur.size = Math.max(cur.size, b.size);
    }
  }
  return out.sort((a, b) => b.base - a.base || a.x0 - b.x0);
}

// Il paragrafo che contiene le parole scelte.
export function findParagraph(allWords, chosen, lines = pageLines(allWords)) {
  const has = (ln) => ln.boxes.some((b) => chosen.includes(b.w));
  const seed = lines.filter(has);
  if (!seed.length) return null;
  const size = seed[0].size;
  const same = (a, b) => Math.abs(a.size - b.size) < 0.18 * Math.max(a.size, b.size);
  const overlap = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
  const para = [...seed];
  let pitch = para.length > 1 ? (para[0].base - para[para.length - 1].base) / (para.length - 1) : null;
  const okGap = (gap) => gap > 0.85 * size && gap < 2.1 * size && (pitch == null || Math.abs(gap - pitch) < 0.3 * size);
  // Verso l'alto
  for (;;) {
    const top = para[0];
    const prev = lines.filter((l) => l.base > top.base && overlap(l, top) && same(l, top)).sort((a, b) => a.base - b.base)[0];
    if (!prev || !okGap(prev.base - top.base)) break;
    // La riga sopra finiva prima del margine destro: era la fine del paragrafo precedente.
    const right = Math.max(...para.map((l) => l.x1));
    if (prev.x1 < right - 4 * size) break;
    if (Math.abs(prev.x0 - top.x0) > 2.5 * size && para.length > 1 && Math.abs(top.x0 - para[1].x0) < 0.8 * size) break;
    para.unshift(prev); pitch = pitch ?? prev.base - top.base;
    if (Math.abs(prev.x0 - top.x0) > 0.8 * size) break; // rientro della prima riga: inizio del paragrafo
  }
  // Verso il basso
  for (;;) {
    const last = para[para.length - 1];
    const right = Math.max(...para.map((l) => l.x1));
    if (para.length > 1 && last.x1 < right - 4 * size) break; // riga corta: fine del paragrafo
    const next = lines.filter((l) => l.base < last.base && overlap(l, last) && same(l, last)).sort((a, b) => b.base - a.base)[0];
    if (!next || !okGap(last.base - next.base)) break;
    // Rientro: nuovo paragrafo. Con una sola riga finora, la riga sotto può iniziare più a sinistra (prima riga rientrata).
    if (para.length === 1 ? next.x0 > para[0].x0 + 0.8 * size : Math.abs(next.x0 - Math.min(...para.slice(1).map((l) => l.x0))) > 0.8 * size) break;
    para.push(next); pitch = pitch ?? last.base - next.base;
  }
  const rest = para.length > 1 ? para.slice(1) : para;
  const left = Math.min(...rest.map((l) => l.x0));
  const right = Math.max(...para.map((l) => l.x1));
  const indent = Math.max(0, para[0].x0 - left);
  let align = 'left';
  if (para.length >= 3) {
    const ends = para.slice(0, -1).map((l) => l.x1);
    if (Math.max(...ends) - Math.min(...ends) < 0.8 * size) align = 'justify';
  }
  if (align === 'left' && para.length >= 2) {
    const mids = para.map((l) => (l.x0 + l.x1) / 2);
    const lefts = para.map((l) => l.x0);
    if (Math.max(...mids) - Math.min(...mids) < 0.8 * size && Math.max(...lefts) - Math.min(...lefts) > 2 * size) align = 'center';
  }
  // Testo: righe unite, con le parole spezzate a fine riga riunite.
  let text = '';
  for (const [k, ln] of para.entries()) {
    const t = ln.boxes.map((b) => b.w.str).join(' ');
    if (k && /\p{L}-$/u.test(text) && /^\p{Ll}/u.test(t)) text = text.slice(0, -1) + t; else text += (k ? ' ' : '') + t;
  }
  return { lines: para, words: para.flatMap((l) => l.boxes.map((b) => b.w)), left, width: Math.max(20, right - left), indent, pitch: pitch || size * 1.2, align, size, first: para[0].base, text };
}

// Righe del testo nuovo dentro la larghezza del paragrafo.
export async function layout(font, size, text, { width, indent = 0, align = 'left' }) {
  const cache = new Map();
  const W = async (s) => { if (!cache.has(s)) cache.set(s, await textWidth(font, s, size)); return cache.get(s); };
  const space = await W(' ');
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let cur = []; let curW = 0;
    const avail = () => width - (out.length === 0 ? indent : 0);
    const flush = (last) => { out.push({ words: cur, w: curW, last }); cur = []; curW = 0; };
    for (const wd of words) {
      const ww = await W(wd);
      if (cur.length && curW + space + ww > avail()) flush(false);
      curW += (cur.length ? space : 0) + ww;
      cur.push({ s: wd, w: ww });
    }
    flush(true);
  }
  // Posizione di ogni riga e (giustificato) di ogni parola.
  return out.map((ln, k) => {
    const start = k === 0 ? indent : 0;
    const avail = width - start;
    let x = start;
    if (align === 'center') x = start + (avail - ln.w) / 2;
    else if (align === 'right') x = start + avail - ln.w;
    const text2 = ln.words.map((q) => q.s).join(' ');
    if (align === 'justify' && !ln.last && ln.words.length > 1) {
      const gap = (avail - ln.words.reduce((t, q) => t + q.w, 0)) / (ln.words.length - 1);
      let px = start; const pos = [];
      for (const q of ln.words) { pos.push([q.s, +px.toFixed(2)]); px += q.w + gap; }
      return { text: text2, dx: start, w: avail, words: pos };
    }
    return { text: text2, dx: +x.toFixed(2), w: +ln.w.toFixed(2) };
  });
}

const padQuad = (q, mu, mv) => [q[0] - mu, q[1] + mv, q[2] + mu, q[3] + mv, q[4] - mu, q[5] - mv, q[6] + mu, q[7] - mv];

// Annotazione «edit» con più righe (lines): la scrive pdfio.writeEdits e la disegna annots.annSvg.
async function buildEdit(base, text, { shrink }) {
  let size = base.size0; let pitch = base.pitch0;
  let lines = await layout(base.font, size, text, base);
  // «Fai stare nello spazio di prima»: carattere ridotto fino al 75% finché le righe non bastano.
  while (shrink && lines.length > base.nLines && size > base.size0 * 0.75) {
    size = +(size - 0.25).toFixed(2); pitch = base.pitch0 * (size / base.size0);
    lines = await layout(base.font, size, text, base);
  }
  const placed = lines.map((ln, k) => ({ ...ln, x: +(base.left + ln.dx).toFixed(2), y: +(base.first - k * pitch).toFixed(2) }));
  const yTop = base.first + size * 0.92; const yBot = base.first - (placed.length - 1) * pitch - size * 0.24;
  const x0 = base.left; const x1 = base.left + base.width;
  return {
    ...base.edit, text, size, pitch, lines: placed, w: base.width,
    tquad: [x0, yTop, x1, yTop, x0, yBot, x1, yBot], css: await cssFamily(base.font), shrunk: size < base.size0,
    para: { left: base.left, width: base.width, indent: base.indent, align: base.align, first: base.first, size0: base.size0, pitch0: base.pitch0, nLines: base.nLines },
  };
}

async function dialog(app, view, base, original, { warn, strong, title, okLabel } = {}) {
  const tools = app.tools;
  let cur = await buildEdit(base, original, { shrink: false });
  const show = () => { view.annots = view.annots.filter((x) => x.id !== cur.id).concat(cur); tools.draw(view, cur.page); };
  show();
  const ok = await modal((box, done) => {
    box.classList.add('edit-dialog', 'para-dialog');
    const ta = h('textarea', { class: 'para-input', rows: '7', 'aria-label': 'Testo del paragrafo' }, original);
    const shrink = h('input', { type: 'checkbox' });
    const note = h('p', { class: 'hint edit-long' });
    const info = h('p', { class: 'hint' });
    let seq = 0;
    const update = async () => {
      const n = ++seq;
      const next = await buildEdit(base, ta.value, { shrink: shrink.checked });
      if (n !== seq) return;
      cur = next; show();
      const extra = cur.lines.length - base.nLines;
      note.textContent = extra > 0 ? `Il paragrafo nuovo ha ${extra} ${extra === 1 ? 'riga' : 'righe'} in più e può coprire il testo sotto: accorcialo o spunta «Fai stare nello spazio di prima».` : '';
      info.textContent = `${base.font.name}, ${cur.size.toFixed(1).replace('.', ',')} pt${cur.shrunk ? ' (ridotto per stare nello spazio)' : ''} · ${{ left: 'allineato a sinistra', justify: 'giustificato', center: 'centrato', right: 'allineato a destra' }[base.align]} · ${cur.lines.length} righe`;
    };
    ta.addEventListener('input', update);
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    shrink.addEventListener('change', update);
    box.append(...[h('h2', {}, title || 'Modifica il paragrafo'),
      h('p', { class: 'hint' }, 'Scrivi liberamente: le righe vanno a capo da sole, come in Word. Con Invio vai a capo dove vuoi tu.'),
      ta, info, note,
      h('label', { class: 'pro-check' }, shrink, ' Fai stare nello spazio di prima (carattere un po\' più piccolo se serve)'),
      warn ? h('p', { class: `edit-warn${strong ? ' strong' : ''}` }, warn) : null,
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(false) }, 'Annulla'), h('button', { class: 'primary', onclick: () => done(true) }, okLabel || 'Applica'))].filter(Boolean));
    update();
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
  });
  view.annots = view.annots.filter((x) => x.id !== cur.id);
  tools.draw(view, cur.page);
  if (!ok || !cur.text.trim()) return null;
  return cur;
}

// Dalla selezione (o da una parola toccata) alla finestra di modifica del paragrafo.
export async function editParagraph(app, view, p, chosen) {
  if (!chosen?.length || !app.tools.guardEdit(view)) return null;
  const pt = await pageText(view, p.i);
  const words = chosen.filter((w) => !w.ocr);
  const horizontal = words.every((w) => Math.abs(w.quad[1] - w.quad[3]) < 0.5);
  if (!words.length || !horizontal) { toast('Qui la modifica del paragrafo non è possibile (testo scansionato o ruotato): usa «Sostituisci».'); return null; }
  const par = findParagraph(pt.words, words);
  if (!par) { toast('Non riesco a trovare il paragrafo di questo testo.'); return null; }
  const st = await styleOf(view, p, par.words.slice(0, 1));
  const pad = Math.max(0.8, par.size * 0.1);
  const edit = {
    id: uid(), type: 'edit', mode: 'replace', page: p.i, before: par.words.map((w) => w.str).join(' '),
    quads: par.words.map((w) => padQuad(w.quad, pad, 0.4)), bg: st.bg, color: st.color, a: [par.left, par.first], dir: [1, 0], up: [0, 1],
    font: { name: st.font.name, file: st.font.file, std: st.font.std, css: st.font.css, exact: st.font.exact, wanted: st.font.wanted || null, bold: st.font.bold, italic: st.font.italic },
    source: 'mano', at: new Date().toISOString(),
  };
  const base = { edit, font: edit.font, size0: +st.size.toFixed(2), pitch0: par.pitch, left: par.left, width: par.width, indent: par.indent, align: par.align, first: par.first, nLines: par.lines.length };
  const done = await dialog(app, view, base, par.text, warningFor(app, view, 'replace') || {});
  if (!done) return null;
  app.tools.apply(view, { add: [done] });
  logEntry(app, view, { kind: 'paragrafo', page: done.page, before: done.before, after: done.text, source: 'mano' });
  toast('Paragrafo modificato. Al salvataggio il testo vecchio si toglie davvero dalla pagina (in una copia).');
  return done;
}

// Modifica di nuovo un paragrafo già cambiato.
export async function reEditParagraph(app, view, a) {
  view.annots = view.annots.filter((x) => x.id !== a.id);
  const P = a.para;
  const base = { edit: { ...a, id: uid() }, font: a.font, size0: P.size0, pitch0: P.pitch0, left: P.left, width: P.width, indent: P.indent, align: P.align, first: P.first, nLines: P.nLines };
  const done = await dialog(app, view, base, a.text, { title: 'Modifica di nuovo il paragrafo', ...(warningFor(app, view, 'replace') || {}) });
  if (!done) { view.annots.push(a); app.tools.draw(view, a.page); return null; }
  app.tools.apply(view, { remove: [a], add: [done] });
  if (done.text !== a.text) logEntry(app, view, { kind: 'correzione', page: done.page, before: a.text, after: done.text });
  return done;
}
