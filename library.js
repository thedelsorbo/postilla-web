// Ricerca in tutti i PDF delle cartelle scelte (0.8.5).
// Postilla legge una volta il testo di ogni PDF e lo conserva sul dispositivo (IndexedDB della finestra):
// le ricerche successive sono immediate e senza internet. A ogni aggiornamento si rileggono solo i file
// nuovi o cambiati (stessa dimensione e data = stesso file) e si tolgono quelli spariti.
// Pagine scansionate: se per quel file c'è già l'OCR fatto in Postilla, si usa quel testo; altrimenti
// la pagina si conta fra quelle «senza testo», e lo si dice nei risultati.
// Il testo dei documenti è solo un dato: non viene mai interpretato né inviato.
import { openPdf } from './docview.js';
import { MIN_NATIVE_CHARS, norm } from './text.js';

const DB = 'postilla-ricerca';
const STORE = 'docs';
const MAX_PAGES = 3000; // pagine lette al massimo per file
const MAX_FILES = 20000;
const MAX_RESULTS = 400; // pagine mostrate al massimo

function idb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'path' }); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((ok, no) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => ok(out?.result !== undefined ? out.result : out);
      t.onerror = () => no(t.error);
      t.onabort = () => no(t.error);
    });
  } finally { db.close(); }
}
const keyOf = (p) => String(p).toLowerCase();
const tick = () => new Promise((r) => setTimeout(r, 0));

// Testo di una pagina in una riga sola (gli a capo diventano spazi: le frasi spezzate si trovano lo stesso).
function pageString(content) {
  let s = '';
  for (const it of content.items) { if (it.str) s += it.str; s += it.hasEOL ? ' ' : (it.str && !/\s$/.test(it.str) ? ' ' : ''); }
  return s.replace(/\s+/g, ' ').trim();
}

// «"frase esatta" parola altra» → frasi e parole (tutte devono comparire sulla stessa pagina).
export function parseQuery(q) {
  const terms = [];
  const s = String(q || '');
  for (const m of s.matchAll(/"([^"]+)"|«([^»]+)»|(\S+)/g)) {
    const t = norm((m[1] || m[2] || m[3] || '').trim());
    if (t.length >= 2 || (m[1] || m[2])) if (t) terms.push(t);
  }
  return [...new Set(terms)];
}

export class Library {
  constructor(app) {
    this.app = app;
    this.mem = null; // path → { name, path, pages: [testo], low: [testo normalizzato], scan }
    this.busy = null;
    this.listeners = new Set();
    this.status = { files: 0, pages: 0, scan: 0, errors: 0, updated: null, running: false, done: 0, todo: 0 };
  }

  get folders() { return Array.isArray(this.app.settings.libraryFolders) ? this.app.settings.libraryFolders : []; }
  setFolders(list) { this.app.settings.libraryFolders = [...new Set(list)]; return host.settingsSet({ libraryFolders: this.app.settings.libraryFolders }); }
  async addFolder(p) { if (p && !this.folders.includes(p)) await this.setFolders([...this.folders, p]); }
  async removeFolder(p) { await this.setFolders(this.folders.filter((x) => x !== p)); }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) { try { fn(this.status); } catch { /* finestra chiusa */ } } }

  async load() {
    if (this.mem) return this.mem;
    const all = await tx('readonly', (s) => s.getAll()).catch(() => []);
    this.mem = new Map();
    for (const d of all || []) this.mem.set(d.path, { ...d, low: d.pages.map((t) => norm(t)) });
    this.count();
    return this.mem;
  }

  count() {
    let pages = 0; let scan = 0; let errors = 0;
    for (const d of this.mem.values()) { pages += d.pages.length; scan += d.scan || 0; if (d.err) errors += 1; }
    Object.assign(this.status, { files: this.mem.size, pages, scan, errors });
  }

  // Un file è «dentro» le cartelle scelte?
  inside(p) {
    const unify = (x) => keyOf(x).replace(/\\/g, '/').replace(/\/+$/, '');
    const k = unify(p);
    return this.folders.some((f) => { const fk = unify(f); return k === fk || k.startsWith(`${fk}/`); });
  }

  // Rilegge i file nuovi o cambiati; restituisce quanti ne ha letti.
  update() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      await this.load();
      Object.assign(this.status, { running: true, done: 0, todo: 0 });
      this.emit();
      let read = 0;
      try {
        const found = this.folders.length ? (await host.scanFolders(this.folders)).slice(0, MAX_FILES) : [];
        const seen = new Set(found.map((f) => f.path));
        // Spariti, oppure fuori dalle cartelle scelte: via dall'indice.
        const gone = [...this.mem.keys()].filter((p) => !seen.has(p));
        if (gone.length) { await tx('readwrite', (s) => gone.forEach((p) => s.delete(p))); gone.forEach((p) => this.mem.delete(p)); }
        const todo = found.filter((f) => { const d = this.mem.get(f.path); return !d || d.size !== f.size || Math.round(d.mtime) !== Math.round(f.mtime); });
        this.status.todo = todo.length;
        this.emit();
        for (const f of todo) {
          const doc = await this.readDoc(f);
          await tx('readwrite', (s) => s.put(doc)).catch(() => null);
          this.mem.set(doc.path, { ...doc, low: doc.pages.map((t) => norm(t)) });
          read += 1;
          this.status.done = read;
          if (read % 3 === 0) { this.count(); this.emit(); }
          await tick();
        }
        this.status.updated = Date.now();
      } finally {
        this.count();
        this.status.running = false;
        this.emit();
        this.busy = null;
      }
      return read;
    })();
    return this.busy;
  }

  async readDoc(f) {
    const doc = { path: f.path, name: f.name || f.path.split(/[\\/]/).pop(), size: f.size, mtime: f.mtime, pages: [], scan: 0, err: null };
    let meta = null; let pdf = null;
    try {
      meta = await host.openDoc(f.path);
      pdf = await openPdf(meta, (update) => update(new Error('protetto')));
      // OCR già fatto in Postilla per questo file (stessa dimensione e data)?
      let ocr = null;
      try { const hash = await host.ocrLookup?.({ path: f.path, size: f.size, mtime: f.mtime }); if (hash) ocr = await host.ocrGet(hash); } catch { ocr = null; }
      const n = Math.min(pdf.numPages, MAX_PAGES);
      for (let i = 1; i <= n; i += 1) {
        const pg = await pdf.getPage(i);
        let t = pageString(await pg.getTextContent());
        pg.cleanup();
        if (t.replace(/\s/g, '').length < MIN_NATIVE_CHARS) {
          const op = ocr?.pages?.[i - 1];
          if (op?.words?.length) t = op.words.map((w) => w.s).join(' ');
          else if (t.replace(/\s/g, '').length < 3) doc.scan += 1; // nessun testo: è una scansione
        }
        doc.pages.push(t);
        if (i % 20 === 0) await tick();
      }
    } catch (e) {
      doc.err = /protetto|password/i.test(String(e?.message || e?.name)) || e?.name === 'PasswordException' ? 'protetto da password' : 'non leggibile';
    } finally {
      try { await pdf?.destroy(); } catch { /* già chiuso */ }
      if (meta?.token) { try { host.closeDoc(meta.token); } catch { /* già chiuso */ } }
    }
    return doc;
  }

  // Risultati: per ogni file le pagine dove compaiono tutti i termini, con un estratto.
  async search(query, { limit = MAX_RESULTS } = {}) {
    const t0 = performance.now();
    await this.load();
    const terms = parseQuery(query);
    const files = [];
    let pages = 0;
    if (!terms.length) return { terms, files, pages, ms: 0 };
    const key = [...terms].sort((a, b) => b.length - a.length)[0];
    for (const d of this.mem.values()) {
      if (!this.inside(d.path)) continue;
      let hits = null;
      for (let i = 0; i < d.low.length; i += 1) {
        const low = d.low[i];
        if (!terms.every((t) => low.includes(t))) continue;
        // Quante volte: si conta il termine più lungo (le parole brevi come «di» non gonfiano il numero).
        let n = 0;
        for (let at = low.indexOf(key); at >= 0; at = low.indexOf(key, at + key.length)) n += 1;
        (hits = hits || []).push({ page: i, count: n, snippet: snippet(d.pages[i], low, key, terms) });
      }
      if (hits) { files.push({ path: d.path, name: d.name, hits, total: hits.reduce((a, h2) => a + h2.count, 0) }); pages += hits.length; }
    }
    files.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    // Limite di pagine mostrate (i file con più risultati prima).
    let left = limit;
    for (const f of files) { if (left <= 0) { f.hits = []; f.cut = true; continue; } if (f.hits.length > left) { f.hits = f.hits.slice(0, left); f.cut = true; } left -= f.hits.length; }
    return { terms, files: files.filter((f) => f.hits.length || f.cut), pages, ms: Math.round(performance.now() - t0) };
  }

  async clear() { await tx('readwrite', (s) => s.clear()).catch(() => null); this.mem = new Map(); this.count(); this.emit(); }
}

// Estratto di circa 160 caratteri attorno al termine principale, con tutti i termini segnati.
// norm() non cambia la lunghezza dei caratteri latini comuni, quindi le posizioni nel testo normalizzato
// valgono anche nell'originale. «parts» alterna testo normale e testo trovato; pre/hit/post restano per compatibilità.
function snippet(raw, low, term, terms = [term]) {
  const at = Math.max(0, low.indexOf(term));
  const a = Math.max(0, at - 60); const b = Math.min(raw.length, at + term.length + 100);
  const marks = [];
  for (const t of terms) {
    if (t.length < 3 && terms.length > 1) continue; // «di», «la»: non si segnano
    for (let i = low.indexOf(t, a); i >= 0 && i < b; i = low.indexOf(t, i + t.length)) marks.push([i, Math.min(b, i + t.length)]);
  }
  marks.sort((x, y) => x[0] - y[0]);
  const parts = [];
  let pos = a;
  for (const [s, e] of marks) { if (s < pos) continue; if (s > pos) parts.push([raw.slice(pos, s), false]); parts.push([raw.slice(s, e), true]); pos = e; }
  if (pos < b) parts.push([raw.slice(pos, b), false]);
  if (a > 0) parts.unshift(['…', false]);
  if (b < raw.length) parts.push(['…', false]);
  return { parts, pre: (a > 0 ? '…' : '') + raw.slice(a, at), hit: raw.slice(at, at + term.length), post: raw.slice(at + term.length, b) + (b < raw.length ? '…' : '') };
}
