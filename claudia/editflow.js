// Theresa: modifiche al documento su comando (scritto o a voce).
// Regole fisse: mostra sempre l'anteprima sulla pagina con prima e dopo, applica solo dopo il «sì» dell'utente
// (per le sostituzioni sui documenti di terzi serve «confermo la sostituzione»), chiede quando i punti sono più d'uno.
import { h, icon } from '../core.js';
import { norm, pageText } from '../text.js';
import { fieldValue, setField } from '../forms.js';
import { makeEdit, makeEditAt } from '../edits.js';
import { isThirdParty, logEntry, warningFor } from '../thirdparty.js';
import { rank } from './catalog.js';
import { resolveEdit } from './editcmd.js';

// Il documento su cui lavorare: quello indicato nel comando (fra quelli aperti, poi nella raccolta) o quello aperto.
export async function targetView(panel, phrase) {
  const { app } = panel;
  if (!phrase) return app.view || null;
  // Un PDF indicato con il percorso completo: si apre (se già aperto si usa quella scheda).
  const pm = String(phrase).match(/((?:[a-z]:[\\/]|\\\\|\/)[^"«»]+?\.pdf)\b/i);
  if (pm) {
    const file = pm[1].trim();
    const open = app.tabs.find((t) => norm(t.path) === norm(file));
    if (open) return open.view;
    if (!panel.allowed(file) || !(await host.exists(file))) return null;
    const tab = await app.open(file);
    if (tab) { await tab.view.ready; return tab.view; }
    return null;
  }
  const want = norm(phrase);
  const tabs = [...app.tabs].sort((a, b) => (b === app.active) - (a === app.active));
  for (const t of tabs) {
    if (!panel.allowed(t.path)) continue;
    if (norm(t.name).includes(want)) return t.view;
    await t.view.ready;
    const first = await pageText(t.view, 0).catch(() => null);
    if (first && first.lower.includes(want)) return t.view;
  }
  if (Object.keys(panel.settings.docs || {}).length) {
    const r = rank(app, phrase).filter((x) => panel.allowed(x.entry.path));
    if (r.length) { const tab = await app.open(r[0].entry.path); if (tab) { await tab.view.ready; return tab.view; } }
  }
  return null;
}

async function drawn(view, page) {
  view.goto(page);
  for (let k = 0; k < 60; k += 1) {
    const p = view.pages[page];
    if (p?.canvas && p.rs && !view.pending) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  return view.pages[page];
}

function fieldInput(f, value) {
  if (f.type === 'Btn' && !f.radio) return /^(s[iì]|spunta\w*|vero|yes|x|on)$/i.test(String(value).trim()) ? f.exportValue : 'Off';
  if (f.type === 'Ch') { const o = f.options.find((x) => norm(x.displayValue ?? x.exportValue) === norm(value)); return o ? o.exportValue : value; }
  return value;
}

export async function runEdit(panel, spec, { voice = false, source } = {}) {
  const src = source || (voice ? 'voce' : 'scritto');
  panel.cancelPreview();
  let view = await targetView(panel, spec.doc);
  if (view && !panel.allowed(view.tab.path)) view = null;
  if (!view) { panel.say(spec.doc ? `Non trovo un documento aperto o nella raccolta che corrisponda a «${spec.doc}». Aggiungilo alla raccolta (cartella o singolo file), indicami il percorso completo oppure aprilo, e ripeti il comando.` : 'Quale documento devo modificare? Aprilo oppure indicalo nel comando.'); return { error: 'documento' }; }
  if (view.readonly) { panel.say('Questo PDF è protetto: si può leggere ma non modificare.'); return { error: 'protetto' }; }
  const sel = panel.app.tools.textSel?.view === view ? panel.app.tools.textSel : null;
  const r = await resolveEdit(view, spec, { selection: sel });
  if (r.kind === 'error') { panel.say(r.message); return { error: r.message }; }
  if (r.kind === 'choices') {
    panel.pending = { options: r.options, resolve: (o) => propose(panel, view, o, src) };
    panel.say(h('p', {}, r.question),
      h('ol', { class: 'claudia-choices' }, r.options.map((o, i) => h('li', {}, h('button', { onclick: () => panel.run(String(i + 1)) }, describe(o))))),
      h('p', { class: 'hint' }, 'Tocca una voce oppure di\' «il primo», «il secondo»…'));
    return { pending: true, count: r.options.length };
  }
  if (r.kind === 'exists') {
    panel.pending = { options: [{ kind: 'words', mode: 'replace', page: r.page, words: r.words, value: spec.value, before: r.value }], resolve: (o) => propose(panel, view, o, src) };
    panel.say(h('p', {}, `Nel documento c'è già «${r.label} ${r.value}» (pagina ${r.page + 1}). Vuoi sostituire «${r.value}» con «${spec.value}»?`),
      h('div', { class: 'claudia-actions' }, h('button', { class: 'primary', onclick: () => panel.run('1') }, 'Sì, sostituisci'), h('button', { onclick: () => { panel.pending = null; panel.say('Va bene, non cambio nulla.'); } }, 'No')));
    return { pending: true, exists: true };
  }
  if (r.kind === 'place') {
    panel.say(h('p', {}, `${r.message} Tocca sulla pagina il punto dove vuoi scrivere «${r.value}».`));
    panel.app.tools.set('select');
    panel.app.tools.placeHook = (v, p, x, y) => propose(panel, v, { kind: 'at', page: p.i, x, y, value: r.value, mode: 'add' }, src);
    return { place: true };
  }
  return propose(panel, view, r, src);
}

function describe(o) {
  if (o.kind === 'field') return h('span', {}, h('b', {}, `Campo «${o.field.label || o.field.name}»`), ` — pagina ${o.field.page + 1}, valore attuale «${o.before || 'vuoto'}»`);
  return h('span', {}, h('b', {}, `Pagina ${o.page + 1}`), ` — ${o.context || o.before}`);
}

// Prepara la modifica, la mostra sulla pagina e chiede conferma. Nulla cambia finché l'utente non conferma.
export async function propose(panel, view, t, source) {
  const { app } = panel;
  if (app.view !== view) app.activate(view.tab);
  const mode = t.kind === 'field' ? 'field' : t.mode;
  const third = isThirdParty(app, view);
  const w = mode === 'field' ? null : warningFor(app, view, mode);
  let preview = null;
  if (t.kind === 'field') {
    const el = [...view.pagesEl.querySelectorAll('.pdf-field')].find((x) => x.dataset.name === t.field.name);
    el?.classList.add('claudia-field-preview');
    view.goto(t.field.page);
    preview = { field: t.field, value: fieldInput(t.field, t.value), el };
  } else {
    const p = await drawn(view, t.page);
    const draft = t.kind === 'at' ? await makeEditAt(view, p, t.x, t.y, t.value, source) : await makeEdit(view, p, t.words, t.mode, t.value, source);
    view.annots.push(draft);
    app.tools.draw(view, draft.page);
    const q = draft.tquad; const [cx, cy] = p.vp.convertToViewportPoint(q[0], q[1]);
    view.reveal(draft.page, cx, cy);
    preview = { draft };
  }
  const strong = !!w?.strong;
  panel.pendingEdit = { view, t, preview, strong, source };
  const what = t.kind === 'field' ? `Compilo il campo «${t.field.label || t.field.name}» (pagina ${t.field.page + 1}): «${t.before || 'vuoto'}» → «${t.value}».`
    : t.mode === 'replace' ? `Sostituisco «${t.before}» con «${preview.draft.text}» (pagina ${t.page + 1}).` : `Aggiungo «${preview.draft.text}» ${t.context || ''} (pagina ${t.page + 1}).`;
  const fontNote = preview.draft ? `Carattere: ${preview.draft.font.name}${preview.draft.font.exact ? ' (lo stesso del documento)' : ' (il più simile disponibile)'}.` : '';
  panel.say(h('p', {}, h('span', { html: icon('edit') }), ' ', what),
    fontNote ? h('p', { class: 'hint' }, fontNote) : null,
    w ? h('p', { class: `edit-warn${strong ? ' strong' : ''}` }, w.warn) : (third && t.kind === 'field' ? h('p', { class: 'edit-warn' }, 'Documento di terzi: stai modificando un campo del modulo.') : null),
    h('p', { class: 'hint' }, 'Anteprima sulla pagina. Nulla è ancora cambiato.'),
    h('div', { class: 'claudia-actions' },
      h('button', { class: 'primary', 'data-act': 'applica', onclick: () => panel.confirmEdit(strong ? 'conferma-forte' : 'si') }, strong ? 'Confermo la sostituzione' : 'Applica'),
      h('button', { 'data-act': 'annulla-modifica', onclick: () => panel.confirmEdit('no') }, 'Annulla')),
    h('p', { class: 'hint' }, strong ? 'Oppure di\' «confermo la sostituzione», o «no».' : 'Oppure di\' «sì» o «no».'));
  return { proposed: true, mode, strong, value: preview.draft?.text ?? preview.value, before: t.before ?? '', page: t.page ?? t.field?.page };
}

export function cancelPreview(panel) {
  const pe = panel.pendingEdit;
  if (!pe) return false;
  panel.pendingEdit = null;
  if (pe.preview.draft) {
    pe.view.annots = pe.view.annots.filter((a) => a.id !== pe.preview.draft.id);
    panel.app.tools.draw(pe.view, pe.preview.draft.page);
  }
  pe.preview.el?.classList.remove('claudia-field-preview');
  return true;
}

export async function confirmEdit(panel, kind) {
  const pe = panel.pendingEdit;
  if (!pe) { panel.say(kind === 'no' ? 'Va bene.' : 'Non c\'è nessuna modifica da confermare.'); return { none: true }; }
  if (kind === 'no') { cancelPreview(panel); panel.say('Modifica annullata: il documento non è cambiato.'); return { cancelled: true }; }
  if (pe.strong && kind !== 'conferma-forte') {
    panel.say('È un documento di terzi: per sostituire un dato di\' «confermo la sostituzione» oppure premi il pulsante.');
    return { needStrong: true };
  }
  const { view, t, preview, source } = pe;
  cancelPreview(panel);
  const { app } = panel;
  if (preview.field) {
    const before = fieldValue(view, preview.field);
    setField(app, view, preview.field.name, preview.value);
    const el = [...view.pagesEl.querySelectorAll('.pdf-field')].find((x) => x.dataset.name === preview.field.name);
    if (el) { if (el.type === 'checkbox') el.checked = preview.value !== 'Off'; else el.value = preview.value; }
    logEntry(app, view, { kind: 'campo', page: preview.field.page, field: preview.field.label || preview.field.name, before: String(before ?? ''), after: String(preview.value), source });
  } else {
    app.tools.apply(view, { add: [preview.draft] });
    logEntry(app, view, { kind: t.mode === 'replace' ? 'sostituzione' : 'aggiunta', page: preview.draft.page, before: preview.draft.before, after: preview.draft.text, source });
  }
  panel.lastEdit = { view };
  if (source === 'grok') {
    // Il bot non può premere «Salva»: la modifica chiesta da Grok viene salvata subito, sempre in una copia.
    const ok = await app.save(view);
    panel.say(ok ? `Fatto e salvato in una copia: ${view.tab.name}. L'originale resta intatto.` : 'Modifica fatta, ma salvataggio non riuscito.');
    return { applied: true, saved: ok ? view.tab.name : null };
  }
  panel.say('Fatto. L\'originale resta intatto: al salvataggio Postilla crea una copia. Di\' «annulla» per tornare indietro.');
  return { applied: true };
}
