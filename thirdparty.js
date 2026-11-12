// Documenti di terzi (certificati, polizze…) e registro delle modifiche.
// Le modifiche sono permesse, con avviso: normale per le aggiunte, forte per le sostituzioni (decisione di Domenico).
// Il registro dice cosa è cambiato, dove, prima e dopo, quando e come; resta dentro la copia ed è esportabile.
import { h, modal, toast } from './core.js';
import { norm, pageText } from './text.js';

export const DEFAULT_TITLES = [
  'certificate of origin', "certificato d'origine", 'certificato di origine', 'health certificate', 'certificato sanitario',
  'veterinary certificate', 'certificato veterinario', 'phytosanitary certificate', 'certificato fitosanitario',
  'bill of lading', 'polizza di carico', 'insurance certificate', 'certificato di assicurazione', 'insurance policy',
  'air waybill', 'lettera di vettura', 'inspection certificate', 'certificato di ispezione', 'movement certificate', 'eur.1',
  'certificate of analysis', 'certificato di analisi', 'certificate of quality', 'certificato di qualità',
];

const key = (view) => (view?.tab?.path || '').replace(/\//g, '\\').toLowerCase();
const store = (app) => {
  app.settings.terzi = app.settings.terzi || { yes: [], no: [], titles: DEFAULT_TITLES.slice() };
  return app.settings.terzi;
};
const save = (app) => host.settingsSet({ terzi: store(app) });

export const isThirdParty = (app, view) => store(app).yes.includes(key(view));

export function setThirdParty(app, view, on) {
  const s = store(app); const k = key(view);
  s.yes = s.yes.filter((x) => x !== k); s.no = s.no.filter((x) => x !== k);
  (on ? s.yes : s.no).push(k);
  save(app);
  app.syncThirdParty?.(view);
}

// La copia salvata eredita il segno del documento da cui nasce.
export function carryOver(app, fromPath, toPath) {
  const s = store(app); const a = fromPath.replace(/\//g, '\\').toLowerCase(); const b = toPath.replace(/\//g, '\\').toLowerCase();
  if (s.yes.includes(a) && !s.yes.includes(b)) { s.yes.push(b); save(app); }
}

// All'apertura: se nel testo delle prime pagine c'è un titolo dell'elenco, propone il segno (una volta sola).
export async function proposeIfNeeded(app, view) {
  const s = store(app); const k = key(view);
  if (!k || s.yes.includes(k) || s.no.includes(k)) return null;
  let text = '';
  for (let i = 0; i < Math.min(2, view.pages.length); i += 1) text += ` ${(await pageText(view, i).catch(() => ({ lower: '' }))).lower}`;
  const title = s.titles.find((t) => text.includes(norm(t)));
  if (!title || view.closed) return null;
  const b = h('div', { class: 'banner terzi-banner', role: 'status' },
    h('span', {}, `Sembra un documento di terzi («${title}»). Segnarlo come tale? Le modifiche resteranno possibili, con un avviso.`),
    h('button', { class: 'primary', onclick: () => { setThirdParty(app, view, true); b.remove(); toast('Segnato come documento di terzi.'); } }, 'Sì, è di terzi'),
    h('button', { onclick: () => { setThirdParty(app, view, false); b.remove(); } }, 'No'));
  view.root.append(b);
  return title;
}

// Testi degli avvisi nella finestra di modifica.
export function warningFor(app, view, mode) {
  if (!isThirdParty(app, view)) return null;
  if (mode === 'add') return { warn: 'Documento di terzi: stai aggiungendo un dato a un documento emesso da altri.', okLabel: 'Aggiungi', strong: false };
  return {
    warn: 'Documento di terzi: stai sostituendo un dato scritto da chi ha emesso il documento. Per ISBP 821 (paragrafo A7) una banca può considerare discrepante una correzione non autenticata dall\'emittente. La modifica resta nel registro.',
    okLabel: 'Confermo la sostituzione', strong: true,
  };
}

// --- Registro delle modifiche -----------------------------------------------------------
export function logEntry(app, view, entry) {
  view.editLog = view.editLog || [];
  view.editLog.push({ at: new Date().toISOString(), terzi: isThirdParty(app, view), source: 'mano', ...entry });
}

const KIND = { sostituzione: 'Sostituzione', aggiunta: 'Aggiunta', correzione: 'Correzione', rimozione: 'Rimozione', campo: 'Campo del modulo', annullata: 'Annullata', ripristinata: 'Ripristinata' };
const SOURCE = { mano: 'a mano', voce: 'a voce', scritto: 'comando scritto', grok: 'Grok Bot', AI: 'assistente AI' };
const when = (iso) => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function logRows(view) {
  return (view.editLog || []).map((e) => ({
    quando: when(e.at), cosa: KIND[e.kind] || e.kind, pagina: e.page + 1, campo: e.field || '', prima: e.before ?? '', dopo: e.after ?? '',
    come: SOURCE[e.source] || e.source, terzi: e.terzi ? 'sì' : 'no',
  }));
}

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
export const logCsv = (view) => {
  const rows = logRows(view);
  const head = ['Quando', 'Cosa', 'Pagina', 'Campo', 'Prima', 'Dopo', 'Come', 'Documento di terzi'];
  return `﻿${[head, ...rows.map((r) => [r.quando, r.cosa, r.pagina, r.campo, r.prima, r.dopo, r.come, r.terzi])].map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;
};
export const logText = (view) => [`Registro delle modifiche di ${view.tab.name}`, '', ...logRows(view).map((r) => `${r.quando} · ${r.cosa} · pagina ${r.pagina}${r.campo ? ` · campo ${r.campo}` : ''} · prima: «${r.prima}» · dopo: «${r.dopo}» · ${r.come}${r.terzi === 'sì' ? ' · documento di terzi' : ''}`)].join('\r\n');

export function showLog(app, view) {
  modal((box, done) => {
    const rows = logRows(view);
    const table = rows.length ? h('table', { class: 'log-table' },
      h('thead', {}, h('tr', {}, ['Quando', 'Cosa', 'Pag.', 'Prima', 'Dopo', 'Come'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, [r.quando, r.cosa + (r.campo ? ` (${r.campo})` : ''), String(r.pagina), r.prima, r.dopo, r.come].map((t) => h('td', {}, t))))))
      : h('p', { class: 'hint' }, 'Nessuna modifica al testo o ai campi di questo documento.');
    const exp = async (kind) => {
      const base = view.tab.path.replace(/\.pdf$/i, '');
      const dest = await host.pickSave(`${base} - registro modifiche.${kind}`);
      if (!dest) return;
      await host.writeFile(dest, new TextEncoder().encode(kind === 'csv' ? logCsv(view) : logText(view)));
      toast(`Registro esportato: ${dest.split(/[\\/]/).pop()}`);
    };
    box.classList.add('log-dialog');
    box.append(...[h('h2', {}, 'Registro delle modifiche'),
      isThirdParty(app, view) ? h('p', { class: 'edit-warn' }, 'Documento segnato come documento di terzi.') : null,
      h('div', { class: 'log-wrap' }, table),
      h('div', { class: 'modal-actions' },
        rows.length ? h('button', { onclick: () => exp('csv') }, 'Esporta CSV (Excel)') : null,
        rows.length ? h('button', { onclick: () => exp('txt') }, 'Esporta testo') : null,
        h('button', { class: 'primary', onclick: () => done() }, 'Chiudi'))].filter(Boolean));
  });
}

// Elenco dei titoli riconosciuti come documenti di terzi, modificabile.
export function editTitles(app) {
  const s = store(app);
  modal((box, done) => {
    const ta = h('textarea', { rows: 12, class: 'titles-input' });
    ta.value = s.titles.join('\n');
    box.append(h('h2', {}, 'Titoli dei documenti di terzi'),
      h('p', { class: 'hint' }, 'Un titolo per riga. Se compare nelle prime due pagine, Postilla propone di segnare il documento come «di terzi».'),
      ta,
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => { ta.value = DEFAULT_TITLES.join('\n'); } }, 'Ripristina elenco iniziale'),
        h('button', { onclick: () => done() }, 'Annulla'),
        h('button', { class: 'primary', onclick: () => { s.titles = ta.value.split('\n').map((t) => t.trim()).filter(Boolean); save(app); done(); toast('Elenco aggiornato.'); } }, 'Salva')));
  });
}
