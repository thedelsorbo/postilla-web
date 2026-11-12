// Stampa: le pagine scelte vengono disegnate come immagini ad alta risoluzione (con annotazioni, campi e modifiche,
// se richiesto) e passate alla finestra di stampa del sistema. Il file non cambia.
// 0.8.3: foglio A4 (verticale o orizzontale secondo la pagina) con un margine di sicurezza: le stampanti comuni
// non stampano gli ultimi 4-6 mm del foglio, quindi la pagina viene rimpicciolita quanto basta per starci dentro.
import { h, modal, toast } from './core.js';
import { openPdf } from './docview.js';
import { buildPdf } from './pdfio.js';

// «1-3, 5, 8-» → indici di pagina (da 0). Restituisce null se l'intervallo non è valido.
export function parseRange(text, total) {
  const out = new Set();
  for (const part of String(text).split(/[,;]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)?\s*-\s*(\d+)?$/) || part.match(/^(\d+)$/);
    if (!m) return null;
    let a; let b;
    if (m.length === 2) { a = +m[1]; b = a; } else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : total; }
    if (a < 1 || b > total || a > b) return null;
    for (let i = a; i <= b; i += 1) out.add(i - 1);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

// Margini del foglio, in millimetri.
export const MARGINS = [
  { mm: 8, label: 'Normali, 8 mm (consigliato: va bene per quasi tutte le stampanti)' },
  { mm: 15, label: 'Ampi, 15 mm (se la stampa esce ancora tagliata)' },
  { mm: 0, label: 'Nessuno (solo stampanti senza bordo)' },
];

// Regole di stampa per il foglio A4 con il margine scelto; la pagina sta tutta dentro l'area stampabile.
export function pageCss(mm) {
  const m = Math.max(0, Math.min(30, +mm || 0));
  const w = 210 - 2 * m - 0.5; const hgt = 297 - 2 * m - 0.5;
  return `@media print {
  @page { size: A4 portrait; margin: ${m}mm; }
  @page landscape { size: A4 landscape; margin: ${m}mm; }
  #print-root img.portrait { width: ${w}mm !important; height: ${hgt}mm !important; max-height: none !important; object-fit: contain; }
  #print-root img.landscape { page: landscape; width: ${hgt}mm !important; height: ${w}mm !important; max-height: none !important; object-fit: contain; }
}`;
}

function ask(view, margin = 8) {
  const total = view.pages.length;
  return modal((box, done) => {
    const radio = (v, label, checked) => { const r = h('input', { type: 'radio', name: 'pr', value: v }); r.checked = !!checked; return h('label', { class: 'check' }, r, ` ${label}`); };
    const range = h('input', { type: 'text', class: 'print-range', placeholder: 'per esempio 1-3, 5', 'aria-label': 'Pagine da stampare' });
    range.addEventListener('focus', () => { box.querySelector('input[value=range]').checked = true; });
    range.addEventListener('keydown', (e) => e.stopPropagation());
    const ann = h('input', { type: 'checkbox', class: 'print-annots' }); ann.checked = true;
    const quality = h('select', { class: 'print-quality', 'aria-label': 'Qualità' }, h('option', { value: '150' }, 'Normale (150 dpi)'), h('option', { value: '300' }, 'Alta (300 dpi, più lenta)'));
    const margins = h('select', { class: 'print-margins', 'aria-label': 'Margini del foglio' }, ...MARGINS.map((m) => h('option', { value: String(m.mm) }, m.label)));
    margins.value = String(MARGINS.some((m) => m.mm === +margin) ? +margin : 8);
    const go = () => {
      const kind = box.querySelector('input[name=pr]:checked').value;
      let pages = kind === 'all' ? [...Array(total).keys()] : kind === 'current' ? [view.current] : parseRange(range.value, total);
      if (!pages) { toast(`Intervallo non valido: usa numeri da 1 a ${total}, per esempio 1-3, 5.`, 'warn'); return; }
      if (pages.length > 300) pages = pages.slice(0, 300);
      done({ pages, annots: ann.checked, dpi: +quality.value, margin: +margins.value });
    };
    box.classList.add('print-dialog');
    box.append(h('h2', {}, 'Stampa'),
      h('div', { class: 'print-opts' }, radio('all', `Tutte le pagine (${total})`, true), radio('current', `Pagina corrente (${view.current + 1})`), h('div', { class: 'print-range-row' }, radio('range', 'Pagine:'), range)),
      h('label', { class: 'check' }, ann, ' Con annotazioni, campi compilati e modifiche al testo'),
      h('label', {}, 'Qualità', quality),
      h('label', {}, 'Margini', margins),
      h('p', { class: 'hint' }, 'Foglio A4. La pagina viene adattata per stare tutta dentro i margini, così la stampante non la taglia. Nella finestra di stampa lascia «Margini: predefiniti» e «Scala: predefinita».'),
      ...(total > 300 ? [h('p', { class: 'hint' }, 'Si stampano al massimo 300 pagine per volta.')] : []),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'), h('button', { class: 'primary', onclick: go }, 'Stampa…')));
  });
}

export async function printDoc(app, view, preset = null) {
  if (!view) return null;
  await view.ready;
  const opts = preset || await ask(view, app?.prefs?.printMargin ?? 8);
  if (!opts) return null;
  const margin = opts.margin ?? app?.prefs?.printMargin ?? 8;
  if (app?.prefs && !preset && app.prefs.printMargin !== margin) { app.prefs.printMargin = margin; app.savePrefs?.(); }
  document.getElementById('print-root')?.remove();
  document.getElementById('print-page-style')?.remove();
  document.head.append(h('style', { id: 'print-page-style' }, pageCss(margin)));
  let cancelled = false;
  const status = h('div', { class: 'toast print-progress' }, 'Preparo la stampa…', h('button', { onclick: () => { cancelled = true; } }, 'Annulla'));
  document.getElementById('toasts').append(status);
  const label = status.firstChild;
  let pdf = null;
  const root = h('div', { id: 'print-root', 'aria-hidden': 'true' });
  try {
    const bytes = opts.annots ? await buildPdf(view, { flatten: true }) : await view.ensureBytes();
    pdf = await openPdf(bytes.slice ? bytes.slice() : bytes);
    const scale = opts.dpi / 72;
    for (let k = 0; k < opts.pages.length; k += 1) {
      if (cancelled) throw new Error('annullata');
      label.textContent = `Preparo la stampa: pagina ${k + 1} di ${opts.pages.length}…`;
      const pg = await pdf.getPage(opts.pages[k] + 1);
      const vp = pg.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await pg.render({ canvas, viewport: vp }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
      canvas.width = 0;
      const img = h('img', { class: `print-page ${vp.width > vp.height ? 'landscape' : 'portrait'}`, src: URL.createObjectURL(blob), alt: '' });
      root.append(img);
      pg.cleanup();
    }
    document.body.append(root);
    await Promise.all([...root.querySelectorAll('img')].map((i) => (i.complete ? null : new Promise((res) => { i.onload = res; i.onerror = res; }))));
    status.remove();
    const cleanup = () => { root.querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src)); root.remove(); };
    if (host.printPage) {
      // Tablet: stampa di Android (anteprima e scelta della stampante); le immagini restano finché serve.
      await host.printPage(view.tab.name);
      setTimeout(cleanup, 10 * 60 * 1000);
    } else {
      window.addEventListener('afterprint', cleanup, { once: true });
      window.print();
    }
    return { pages: opts.pages.length };
  } catch (e) {
    status.remove();
    root.remove();
    if (String(e.message) !== 'annullata') { console.error(e); toast(`Stampa non riuscita: ${e.message || e}`, 'error'); }
    return null;
  } finally {
    pdf?.loadingTask.destroy().catch(() => {});
  }
}
