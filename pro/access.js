// Controllo di accessibilità (0.9.0): verifica le cose che servono a chi usa un lettore di schermo o la
// sintesi vocale, e corregge quelle che si possono correggere in automatico (titolo, lingua, descrizioni dei
// campi e dei link, ordine di tabulazione). L'aggiunta dei «tag» di struttura (titoli, paragrafi, tabelle)
// richiede un lavoro manuale con strumenti specifici: Postilla lo segnala e non finge di farlo.
import { h, modal, toast } from '../core.js';
import { pageText, MIN_NATIVE_CHARS } from '../text.js';
import { logEntry } from '../thirdparty.js';

const L = () => window.PDFLib;
const N = (s) => L().PDFName.of(s);
const human = (s) => String(s || '').replace(/[_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();

export async function checkAccessibility(bytes, { scanPages = 0 } = {}) {
  const { PDFDocument, PDFDict, PDFArray } = L();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const cat = doc.catalog;
  const items = [];
  const add = (id, ok, label, detail, fixable) => items.push({ id, ok, label, detail, fixable: !ok && fixable });
  const title = doc.getTitle();
  const vp = cat.lookup(N('ViewerPreferences'));
  const showTitle = vp instanceof PDFDict && vp.lookup(N('DisplayDocTitle'))?.toString() === 'true';
  add('title', !!title && showTitle, 'Titolo del documento', title ? (showTitle ? `«${title}»` : `«${title}», ma la finestra mostra il nome del file`) : 'manca: il lettore di schermo legge solo il nome del file', true);
  const lang = cat.lookup(N('Lang'))?.decodeText?.();
  add('lang', !!lang, 'Lingua del documento', lang || 'non indicata: la sintesi vocale potrebbe leggere con la pronuncia sbagliata', true);
  const mark = cat.lookup(N('MarkInfo'));
  const tagged = mark instanceof PDFDict && mark.lookup(N('Marked'))?.toString() === 'true' && !!cat.get(N('StructTreeRoot'));
  add('tags', tagged, 'Struttura con tag (titoli, paragrafi, tabelle)', tagged ? 'presente' : 'assente: l\'ordine di lettura e le tabelle non sono descritti. Si aggiunge con strumenti specifici o rifacendo il PDF dal programma d\'origine (per esempio Word con «Salva come PDF accessibile»).', false);
  add('scan', !scanPages, 'Testo leggibile in tutte le pagine', scanPages ? `${scanPages} pagin${scanPages === 1 ? 'a è un\'immagine' : 'e sono immagini'} senza testo: usa «Riconosci il testo» (OCR)` : 'sì', false);
  // Campi e link senza descrizione, pagine senza ordine di tabulazione.
  let fields = 0; let fieldsNo = 0; let links = 0; let linksNo = 0; let tabsNo = 0;
  try { for (const f of doc.getForm().getFields()) { fields += 1; if (!f.acroField.dict.get(N('TU'))) fieldsNo += 1; } } catch { /* niente modulo */ }
  for (const pg of doc.getPages()) {
    const arr = pg.node.lookup(N('Annots'));
    if (!(arr instanceof PDFArray) || !arr.size()) continue;
    if (pg.node.lookup(N('Tabs'))?.toString() !== '/S') tabsNo += 1;
    for (let i = 0; i < arr.size(); i += 1) {
      const a = arr.lookup(i);
      if (!(a instanceof PDFDict) || a.lookup(N('Subtype'))?.toString() !== '/Link') continue;
      links += 1; if (!a.get(N('Contents'))) linksNo += 1;
    }
  }
  if (fields) add('fields', !fieldsNo, 'Descrizione dei campi del modulo', fieldsNo ? `${fieldsNo} su ${fields} senza descrizione` : 'tutti descritti', true);
  if (links) add('links', !linksNo, 'Descrizione dei link', linksNo ? `${linksNo} su ${links} senza descrizione` : 'tutti descritti', true);
  if (tabsNo) add('tabs', false, 'Ordine di tabulazione', `da impostare su ${tabsNo} pagin${tabsNo === 1 ? 'a' : 'e'} (si segue la struttura)`, true);
  const enc = !!doc.context.trailerInfo.Encrypt;
  if (enc) add('enc', false, 'Protezione', 'il PDF è protetto: alcuni lettori di schermo potrebbero non poter leggere il testo', false);
  return { items, tagged };
}

export async function fixAccessibility(bytes, { title, lang = 'it-IT' } = {}) {
  const { PDFDocument, PDFDict, PDFArray, PDFHexString } = L();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const done = [];
  if (!doc.getTitle() && title) { doc.setTitle(title, { showInWindowTitleBar: true }); done.push('titolo'); } else {
    const vp = doc.catalog.lookup(N('ViewerPreferences'));
    const prefs = vp instanceof PDFDict ? vp : doc.context.obj({});
    if (prefs.lookup(N('DisplayDocTitle'))?.toString() !== 'true') { prefs.set(N('DisplayDocTitle'), doc.context.obj(true)); doc.catalog.set(N('ViewerPreferences'), prefs); done.push('titolo nella finestra'); }
  }
  if (!doc.catalog.get(N('Lang'))) { doc.catalog.set(N('Lang'), PDFHexString.fromText(lang)); done.push('lingua'); }
  try { for (const f of doc.getForm().getFields()) if (!f.acroField.dict.get(N('TU'))) { f.acroField.dict.set(N('TU'), PDFHexString.fromText(human(f.getName()))); if (!done.includes('campi')) done.push('campi'); } } catch { /* niente modulo */ }
  for (const pg of doc.getPages()) {
    const arr = pg.node.lookup(N('Annots'));
    if (!(arr instanceof PDFArray) || !arr.size()) continue;
    if (pg.node.lookup(N('Tabs'))?.toString() !== '/S') { pg.node.set(N('Tabs'), N('S')); if (!done.includes('ordine di tabulazione')) done.push('ordine di tabulazione'); }
    for (let i = 0; i < arr.size(); i += 1) {
      const a = arr.lookup(i);
      if (!(a instanceof PDFDict) || a.lookup(N('Subtype'))?.toString() !== '/Link' || a.get(N('Contents'))) continue;
      const act = a.lookup(N('A'));
      const uri = act instanceof PDFDict ? act.lookup(N('URI'))?.decodeText?.() || act.lookup(N('URI'))?.asString?.() : null;
      a.set(N('Contents'), PDFHexString.fromText(uri ? `Collegamento a ${uri}` : 'Collegamento interno al documento'));
      if (!done.includes('link')) done.push('link');
    }
  }
  return { bytes: await doc.save({ useObjectStreams: false, updateFieldAppearances: false }), done };
}

export async function accessibilityDialog(app, view) {
  view = view || app.view;
  if (!view) return null;
  await view.ready;
  let scan = 0;
  for (let i = 0; i < view.pages.length; i += 1) { const pt = await pageText(view, i); if (!pt.ocr && pt.text.replace(/\s/g, '').length < MIN_NATIVE_CHARS) scan += 1; }
  const res = await checkAccessibility(await view.ensureBytes(), { scanPages: scan });
  const fixable = res.items.some((x) => x.fixable);
  const go = await modal((box, done) => {
    box.classList.add('access-dialog');
    box.append(h('h2', {}, 'Controllo di accessibilità'),
      h('ul', { class: 'access-list' }, ...res.items.map((it) => h('li', { class: it.ok ? 'ok' : 'no', 'data-id': it.id }, h('b', {}, `${it.ok ? '✓' : '!'} ${it.label}: `), it.detail, it.fixable ? h('span', { class: 'hint' }, ' (si corregge da solo)') : ''))),
      h('p', { class: 'hint' }, 'Le correzioni automatiche vanno in una copia del documento, come le altre modifiche.'),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(false) }, 'Chiudi'), fixable ? h('button', { class: 'primary', onclick: () => done(true) }, 'Correggi quello che si può') : ''));
  });
  if (!go) return res;
  if (!app.tools.guardEdit(view)) return res;
  let doneList = [];
  await app.pageOp(view, async (b) => { const r = await fixAccessibility(b, { title: view.tab.name.replace(/\.pdf$/i, '') }); doneList = r.done; return r.bytes; }, (p) => p);
  logEntry(app, view, { kind: 'accessibilità', page: 0, before: '', after: `Corretti: ${doneList.join(', ')}` });
  toast(doneList.length ? `Corretti: ${doneList.join(', ')}. Si salva in una copia.` : 'Niente da correggere in automatico.');
  return { ...res, fixed: doneList };
}
