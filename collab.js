// Revisione condivisa (0.9.0): più persone commentano lo stesso PDF in una cartella condivisa (pCloud,
// OneDrive, Dropbox, una cartella di rete), senza server né servizi a pagamento.
// Ognuno scrive solo il proprio file «<documento>.commenti/<nome>.postilla.json» accanto al PDF; Postilla
// legge quelli degli altri ogni 15 secondi e li mostra sulla pagina con il nome dell'autore (in sola lettura).
// Il PDF non viene modificato; i commenti degli altri entrano nel documento solo se si sceglie di copiarli.
import { h, modal, toast, uid, baseName, fmtDate } from './core.js';

const SHARE = ['ink', 'hl', 'ul', 'so', 'rect', 'ellipse', 'line', 'arrow', 'text', 'note', 'label', 'stamp', 'measure', 'area'];
const EVERY = Number(window.POSTILLA_COLLAB_MS) || 15000;
const safe = (s) => String(s || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40);
const sep = (p) => (p.includes('\\') ? '\\' : '/');

export class Collab {
  constructor(app) { this.app = app; this.timers = new Map(); this.writes = new Map(); }

  get me() { return safe(this.app.prefs.reviewer); }
  key(view) { return view?.tab?.path; }
  binding(view) { return this.app.settings.collab?.[this.key(view)] || null; }
  active(view) { return !!this.binding(view); }
  myFile(view) { const b = this.binding(view); return b ? `${b.dir}${sep(b.dir)}${this.me}.postilla.json` : null; }

  async setActive(view, on) {
    const all = { ...(this.app.settings.collab || {}) };
    if (on) all[this.key(view)] = { dir: `${view.tab.path.replace(/\.pdf$/i, '')}.commenti` };
    else delete all[this.key(view)];
    this.app.settings.collab = all;
    await host.settingsSet({ collab: all });
    if (on) { await this.writeMine(view); this.start(view); await this.refresh(view); } else { this.stop(view); view.extAnnots = []; this.app.tools.drawAll(view); view.pages.forEach((p, i) => this.app.tools.draw(view, i)); }
  }

  // Il documento è stato salvato con un altro nome (copia annotata): la revisione resta legata alla stessa cartella.
  moved(oldPath, newPath) {
    const all = this.app.settings.collab || {};
    if (!all[oldPath] || oldPath === newPath) return;
    all[newPath] = all[oldPath];
    host.settingsSet({ collab: all });
  }

  opened(view) { if (this.active(view)) { this.start(view); this.refresh(view); } }

  start(view) {
    if (this.timers.has(view)) return;
    this.timers.set(view, setInterval(() => { if (view.closed || !this.active(view)) { this.stop(view); return; } this.refresh(view); }, EVERY));
  }

  stop(view) { clearInterval(this.timers.get(view)); this.timers.delete(view); }

  // I miei commenti cambiano: si scrivono (con un attimo di ritardo, per non scrivere a ogni tratto).
  changed(view) {
    if (!this.active(view) || !this.me) return;
    clearTimeout(this.writes.get(view));
    this.writes.set(view, setTimeout(() => this.writeMine(view).catch((e) => console.warn('Revisione condivisa: scrittura non riuscita', e)), 1200));
  }

  async writeMine(view) {
    const file = this.myFile(view);
    if (!file || !this.me) return;
    const annots = view.annots.filter((a) => SHARE.includes(a.type)).map((a) => { const c = { ...a }; delete c.css; return c; });
    const data = { author: this.app.prefs.reviewer, updated: Date.now(), document: view.tab.name, pages: view.pages.length, annots };
    await host.writeFile(file, new TextEncoder().encode(JSON.stringify(data)));
  }

  async readAll(view) {
    const b = this.binding(view);
    if (!b) return [];
    const files = await host.collabList?.(b.dir).catch(() => []) || [];
    const out = [];
    for (const f of files) {
      const who = baseName(f.path).replace(/\.postilla\.json$/i, '');
      if (who === this.me) continue;
      try {
        const { data } = await host.readFile(f.path);
        const j = JSON.parse(new TextDecoder().decode(data));
        out.push({ author: safe(j.author) || who, updated: j.updated || f.mtime, annots: (j.annots || []).filter((a) => SHARE.includes(a.type) && Number.isInteger(a.page)) });
      } catch { /* file in scrittura o rovinato: si riprova al prossimo giro */ }
    }
    return out;
  }

  async refresh(view) {
    if (!this.active(view)) return [];
    const people = await this.readAll(view);
    if (view.closed) return people;
    const ext = [];
    for (const p of people) for (const a of p.annots) if (a.page < view.pages.length) ext.push({ ...a, id: `x:${p.author}:${a.id}`, ext: p.author });
    const before = JSON.stringify((view.extAnnots || []).map((a) => a.id));
    view.extAnnots = ext;
    view.reviewers = people.map((p) => ({ author: p.author, updated: p.updated, count: p.annots.length }));
    if (before !== JSON.stringify(ext.map((a) => a.id)) || true) {
      const pages = new Set([...ext.map((a) => a.page), ...JSON.parse(before).map(() => -1)]);
      view.pages.forEach((_p, i) => { if (pages.has(i) || pages.has(-1) || view.extDrawn?.has(i)) this.app.tools.draw(view, i); });
      view.extDrawn = new Set(ext.map((a) => a.page));
    }
    return people;
  }

  // Copia nel documento i commenti degli altri (diventano miei e si salvano nel PDF).
  adopt(view) {
    const list = (view.extAnnots || []).map((a) => { const c = { ...a, id: uid(), from: a.ext }; delete c.ext; return c; });
    if (list.length) this.app.tools.apply(view, { add: list });
    return list.length;
  }
}

export async function collabDialog(app, view) {
  view = view || app.view;
  if (!view) return null;
  const c = app.collab;
  if (c.active(view)) await c.refresh(view);
  return modal((box, done) => {
    box.classList.add('collab-dialog');
    const name = h('input', { type: 'text', value: app.prefs.reviewer || '', 'aria-label': 'Il tuo nome', placeholder: 'Per esempio: Mario Rossi' });
    name.addEventListener('keydown', (e) => e.stopPropagation());
    const status = h('p', { class: 'collab-status' });
    const people = h('div', { class: 'collab-people' });
    const notes = h('div', { class: 'collab-notes' });
    const paint = () => {
      const on = c.active(view);
      status.textContent = on ? `Attiva. I commenti di tutti stanno nella cartella «${baseName(c.binding(view).dir)}» accanto al PDF.` : 'Non attiva per questo documento.';
      people.textContent = '';
      const list = view.reviewers || [];
      if (on) people.append(list.length ? h('ul', {}, ...list.map((r) => h('li', {}, h('b', {}, r.author), ` · ${r.count} comment${r.count === 1 ? 'o' : 'i'} · aggiornato ${fmtDate(r.updated)} ${new Date(r.updated).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`))) : h('p', { class: 'hint' }, 'Per ora nessun altro ha commentato.'));
      notes.textContent = '';
      const written = (view.extAnnots || []).filter((a) => (a.type === 'note' || a.type === 'text' || a.text) && String(a.text || '').trim());
      for (const a of written.slice(0, 60)) notes.append(h('div', { class: 'collab-note' }, h('b', {}, `${a.ext}, p. ${a.page + 1}: `), String(a.text).slice(0, 200), ' ', h('button', { onclick: () => { done(true); view.goto(a.page); } }, 'Vai')));
      toggle.textContent = on ? 'Disattiva' : 'Attiva per questo documento';
      toggle.className = on ? '' : 'primary';
      refreshBtn.hidden = !on; adoptBtn.hidden = !on || !(view.extAnnots || []).length;
    };
    const saveName = async () => { const v = name.value.trim(); if (v !== (app.prefs.reviewer || '')) { app.prefs.reviewer = v; app.savePrefs(); } return !!safe(v); };
    const toggle = h('button', { class: 'collab-toggle', onclick: async () => {
      if (!(await saveName())) { toast('Scrivi prima il tuo nome: gli altri vedranno i commenti con questo nome.'); name.focus(); return; }
      await c.setActive(view, !c.active(view)); paint();
    } });
    const refreshBtn = h('button', { class: 'collab-refresh', onclick: async () => { await saveName(); await c.refresh(view); paint(); } }, 'Aggiorna ora');
    const adoptBtn = h('button', { class: 'collab-adopt', onclick: () => { const n = c.adopt(view); toast(`${n} commenti copiati nel documento: si salvano nel PDF.`); paint(); } }, 'Copia nel documento i commenti degli altri');
    box.append(h('h2', {}, 'Revisione condivisa'),
      h('p', { class: 'hint' }, 'Per lavorare in più persone sullo stesso PDF in una cartella condivisa (pCloud, OneDrive, Dropbox, rete). Ognuno vede i commenti degli altri con il nome; nessun servizio esterno, il PDF non cambia.'),
      h('label', { class: 'pro-field' }, h('span', {}, 'Il tuo nome'), name), status, people, notes,
      h('div', { class: 'modal-actions' }, adoptBtn, refreshBtn, toggle, h('button', { onclick: () => done(false) }, 'Chiudi')));
    paint();
  });
}
