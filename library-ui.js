// Finestra «Cerca in tutti i PDF»: cartelle scelte, stato dell'indice, ricerca immediata e apertura
// del documento alla pagina giusta con la parola evidenziata.
import { $, h, icon, iconBtn, modal, toast } from './core.js';
import { parseQuery } from './library.js';
import { searchAll } from './text.js';

const fmt = (n) => Number(n || 0).toLocaleString('it-IT');
const when = (t) => (t ? new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');

export function openLibrary(app, initial = '') {
  const lib = app.library;
  return modal((box, done) => {
    box.classList.add('lib-dialog');
    const folders = h('div', { class: 'lib-folders' });
    const status = h('p', { class: 'hint lib-status', 'aria-live': 'polite' });
    const input = h('input', { type: 'search', class: 'lib-input', placeholder: 'Parola o frase da cercare in tutti i PDF…', 'aria-label': 'Cerca in tutti i PDF', value: initial });
    const info = h('p', { class: 'hint lib-count' });
    const results = h('div', { class: 'lib-results' });

    const paintFolders = () => {
      folders.textContent = '';
      if (!lib.folders.length) {
        folders.append(h('p', { class: 'hint' }, 'Scegli le cartelle dove cercare: Postilla legge i PDF una volta e poi trova le parole in un attimo, senza internet.'));
        // Le «Cartelle dei documenti» della schermata iniziale sono la scelta più naturale.
        const home = (app.settings.folders || []).filter(Boolean);
        if (home.length) folders.append(h('button', { class: 'primary lib-use-home', onclick: async () => { await lib.setFolders(home); paintFolders(); lib.update().then(() => run()); } }, `Usa le cartelle dei documenti (${home.length})`));
      }
      for (const f of lib.folders) {
        folders.append(h('div', { class: 'lib-folder' }, h('span', { html: icon('folder') }), h('span', { class: 'lib-folder-path', title: f }, f),
          iconBtn('close', 'Togli questa cartella', async () => { await lib.removeFolder(f); paintFolders(); refresh(); lib.update().then(() => run()); })));
      }
      folders.append(h('div', { class: 'lib-folder-actions' },
        h('button', { class: 'lib-add', onclick: async () => { const p = await host.pickFolder(); if (!p) return; await lib.addFolder(p); paintFolders(); lib.update().then(() => run()); } }, '+ Aggiungi cartella'),
        h('button', { class: 'lib-refresh', onclick: () => lib.update().then(() => run()) }, 'Aggiorna ora')));
    };

    const refresh = () => {
      const s = lib.status;
      const parts = [];
      if (s.running) parts.push(s.todo ? `Leggo i PDF nuovi o cambiati: ${fmt(s.done)} di ${fmt(s.todo)}…` : 'Controllo le cartelle…');
      parts.push(`${fmt(s.files)} PDF, ${fmt(s.pages)} pagine nell'indice`);
      if (s.scan) parts.push(`${fmt(s.scan)} pagine scansionate senza testo (aprile e usa «Riconosci il testo» per includerle)`);
      if (s.errors) parts.push(`${fmt(s.errors)} PDF non leggibili o protetti da password`);
      if (s.updated && !s.running) parts.push(`aggiornato alle ${when(s.updated)}`);
      status.textContent = `${parts.join(' · ')}.`;
    };

    let token = 0;
    const run = async () => {
      const t = (token += 1);
      const q = input.value;
      results.textContent = '';
      if (parseQuery(q).length === 0) { info.textContent = 'Più parole: devono stare sulla stessa pagina. Tra virgolette, per esempio "lettera di credito", cerchi la frase esatta. Maiuscole e accenti non contano.'; return; }
      const r = await lib.search(q);
      if (t !== token) return;
      info.textContent = r.files.length ? `${fmt(r.pages)} pagin${r.pages === 1 ? 'a' : 'e'} in ${fmt(r.files.length)} PDF (${r.ms} ms)` : `Nessun risultato${lib.status.running ? ' finora: sto ancora leggendo i PDF' : ''}.`;
      for (const f of r.files) {
        const list = h('div', { class: 'lib-hits' });
        for (const hit of f.hits) {
          list.append(h('button', { class: 'row lib-hit', 'data-page': String(hit.page + 1), onclick: () => { done(true); openHit(app, f.path, hit.page, q); } },
            h('b', {}, `p. ${hit.page + 1}`), ' ', ...hit.snippet.parts.map(([t, m]) => (m ? h('mark', {}, t) : h('span', {}, t)))));
        }
        results.append(h('div', { class: 'lib-file', 'data-path': f.path },
          h('div', { class: 'lib-file-head', title: f.path }, h('span', { html: icon('pages') }), h('b', {}, f.name), h('span', { class: 'hint' }, ` · ${fmt(f.total)} volt${f.total === 1 ? 'a' : 'e'}${f.cut ? ' (mostrate le prime pagine)' : ''}`)),
          list));
      }
    };

    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { const first = results.querySelector('.lib-hit'); if (first) first.click(); } });
    const off = lib.on(() => { refresh(); if (!lib.status.running) run(); });
    box.append(h('h2', {}, 'Cerca in tutti i PDF'), folders, status, input, info, results,
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: () => done(false) }, 'Chiudi')));
    // La finestra si chiude: smetto di ascoltare l'indice (l'aggiornamento finisce comunque in sottofondo).
    new MutationObserver((_, obs) => { if (!box.isConnected) { off(); obs.disconnect(); } }).observe(document.body, { childList: true });
    paintFolders();
    lib.load().then(() => { refresh(); run(); if (lib.folders.length) lib.update(); });
    setTimeout(() => input.focus(), 30);
  });
}

// Apre il PDF alla pagina del risultato ed evidenzia la parola (ricerca nel documento nel pannello laterale).
export async function openHit(app, path, page, query) {
  const tab = await app.openNow(path);
  const view = tab?.view;
  if (!view) return false;
  await view.ready;
  const term = parseQuery(query)[0] || '';
  app.prefs.panel = true;
  app.panel.show(true);
  view.lastSearch = term;
  app.panel.setMode('search');
  let found = null;
  await searchAll(view, term, (hit) => { if (!found && hit.page === page) found = hit; }, () => !!found);
  if (found) await app.panel.showHit(view, found); else view.goto(page);
  return true;
}

// Ricerca nel documento aperto con il pulsante della lente (oppure, senza documenti, in tutti i PDF).
export function openSearch(app) {
  if (!app.view) { openLibrary(app); return; }
  app.prefs.panel = true;
  app.panel.show(true);
  app.panel.setMode('search');
  setTimeout(() => $('#panel input[type=search]')?.focus(), 40);
}
