// Schermata iniziale: i documenti del PC, subito apribili.
import { $, baseName, fmtDate, fmtSize, h, icon, iconBtn } from './core.js';

export class Home {
  constructor(app) {
    this.app = app;
    this.el = $('#home');
    this.files = [];
    this.query = '';
  }

  async refresh() {
    const { settings } = this.app;
    this.render();
    if (settings.folders.length) {
      this.files = await host.scanFolders(settings.folders);
      this.files.sort((a, b) => b.mtime - a.mtime);
      this.renderList();
    } else { this.files = []; this.renderList(); }
  }

  render() {
    const { app } = this;
    const search = h('input', { type: 'search', class: 'home-search', placeholder: 'Cerca un documento per nome…', 'aria-label': 'Cerca un documento', value: this.query });
    search.addEventListener('input', () => { this.query = search.value; this.renderList(); });
    this.listEl = h('div', { class: 'file-list' });
    this.recentEl = h('div', { class: 'recents' });
    this.el.textContent = '';
    this.el.append(
      h('div', { class: 'home-head' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-name' }, 'Postilla'), h('span', { class: 'brand-sub' }, (document.documentElement.classList.contains('web') ? 'I tuoi PDF, nel browser e sul tuo dispositivo' : `I tuoi PDF, sul tuo ${document.documentElement.classList.contains('android') ? (Math.min(innerWidth, innerHeight) < 600 ? 'telefono' : 'tablet') : 'computer'}`))),
        search,
        h('button', { class: 'big home-voice', html: `${icon('mic')} Apri a voce`, title: 'Di\' il nome del file e Postilla lo apre (Ctrl+Maiusc+O)', onclick: () => app.openByVoice() }),
        h('button', { class: 'big home-lib', html: `${icon('search')} Cerca dentro i PDF`, title: 'Cerca una parola o una frase in tutti i PDF delle cartelle che scegli (Ctrl+Maiusc+F)', onclick: () => import('./library-ui.js').then((m) => m.openLibrary(app)) }),
        h('button', { class: 'primary big', html: `${icon('open')} Apri PDF`, onclick: () => app.pickAndOpen() })),
      h('h2', {}, 'Recenti'), this.recentEl,
      h('div', { class: 'section-head' }, h('h2', {}, 'Cartelle dei documenti'),
        h('button', { html: `${icon('plus')} Aggiungi cartella`, onclick: () => this.addFolder() })),
      this.folderChips(), this.listEl,
      h('button', { class: 'about-link', onclick: () => app.openAbout() }, '© 2026 Domenico Del Sorbo · Informazioni'),
    );
    this.renderRecents();
  }

  folderChips() {
    const { settings } = this.app;
    if (!settings.folders.length) return h('p', { class: 'hint' }, 'Aggiungi una o più cartelle: Postilla ne elenca i PDF e li rende apribili con un tocco. Legge solo i nomi dei file e non sposta nulla.');
    return h('div', { class: 'chips' }, settings.folders.map((f) => h('span', { class: 'chip', title: f }, baseName(f) || f,
      iconBtn('close', `Togli ${f} dall'elenco`, () => this.removeFolder(f)))));
  }

  async addFolder() {
    const f = await host.pickFolder();
    const { settings } = this.app;
    if (!f || settings.folders.includes(f)) return;
    settings.folders.push(f);
    host.settingsSet({ folders: settings.folders });
    this.refresh();
  }

  removeFolder(f) {
    const { settings } = this.app;
    settings.folders = settings.folders.filter((x) => x !== f);
    host.settingsSet({ folders: settings.folders });
    this.refresh();
  }

  renderRecents() {
    if (!this.recentEl) return;
    const { settings } = this.app;
    this.recentEl.textContent = '';
    const list = settings.recents.filter((r) => this.match(r.name)).slice(0, 12);
    if (!list.length) { this.recentEl.append(h('p', { class: 'hint' }, this.query ? 'Nessun documento recente con questo nome.' : 'I documenti che apri compariranno qui.')); return; }
    for (const r of list) {
      const img = h('div', { class: 'thumb' });
      const card = h('button', { class: 'card', title: r.path, onclick: () => this.app.open(r.path) }, img,
        h('span', { class: 'card-name' }, r.name),
        h('span', { class: 'card-meta' }, `Pagina ${(r.page || 0) + 1}`));
      this.recentEl.append(card);
      host.thumbGet(r.path).then((u) => { if (u) img.append(h('img', { src: u, alt: '' })); });
    }
  }

  match(name) {
    const q = this.query.trim().toLowerCase();
    return !q || q.split(/\s+/).every((w) => name.toLowerCase().includes(w));
  }

  renderList() {
    if (!this.listEl) return;
    this.renderRecents();
    this.listEl.textContent = '';
    const all = this.files.filter((f) => this.match(f.name));
    for (const f of all.slice(0, 300)) {
      this.listEl.append(h('button', { class: 'file-row', title: f.path, onclick: () => this.app.open(f.path) },
        h('span', { class: 'file-name' }, f.name),
        h('span', { class: 'file-meta' }, `${fmtDate(f.mtime)} · ${fmtSize(f.size)}`)));
    }
    if (all.length > 300) this.listEl.append(h('p', { class: 'hint' }, `Mostrati 300 documenti su ${all.length}. Usa la ricerca per trovare gli altri.`));
  }
}
