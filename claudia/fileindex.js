// Indice dei PDF del dispositivo: solo nomi, percorsi, dimensioni e date (mai il contenuto).
// Su Windows: Documenti, Desktop, Download, OneDrive e il disco P: (pCloud); sul tablet la memoria interna.
// Serve a Theresa per trovare un file «ovunque» con «apri …», senza doverlo prima aggiungere alla raccolta.
// L'indice resta sul dispositivo (database interno del programma) e si aggiorna in sottofondo.
import { baseName } from '../core.js';

const MAX = 120000;
const EVERY = 30 * 60e3; // aggiornamento periodico

// Database interno (IndexedDB): l'elenco può contenere decine di migliaia di file.
function store(mode, fn) {
  return new Promise((ok, ko) => {
    const r = indexedDB.open('postilla-indice', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => ko(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('kv', mode);
      const q = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); ok(q?.result); };
      tx.onerror = () => { db.close(); ko(tx.error); };
    };
  });
}

const entry = (path, size, mtime) => ({ path, title: baseName(path).replace(/\.pdf$/i, ''), size, mtime, indexed: true });

export class FileIndex {
  constructor() {
    this.files = [];
    this.at = 0;
    this.running = null;
    this.loaded = store('readonly', (s) => s.get('indice')).then((raw) => {
      if (raw?.v === 1 && Array.isArray(raw.f) && !this.at) { this.files = raw.f.map(([p, s, m]) => entry(p, s, m)); this.at = raw.at || 0; }
    }).catch(() => { /* indice assente: si ricostruisce */ });
  }

  // Ricostruisce l'indice (una sola scansione alla volta). Restituisce il numero di PDF trovati.
  refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const roots = (await host.indexRoots?.()) || [];
        if (!roots.length) return this.files.length;
        const found = await host.scanFolders(roots, { depth: 14, max: MAX, names: true });
        const seen = new Set();
        const files = [];
        for (const f of found) {
          const k = f.path.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          files.push(entry(f.path, f.size, f.mtime));
        }
        this.files = files;
        this.at = Date.now();
        store('readwrite', (s) => s.put({ v: 1, at: this.at, f: files.map((e) => [e.path, e.size, Math.round(e.mtime)]) }, 'indice')).catch(() => {});
        return files.length;
      } catch (e) { console.error('indice file', e); return this.files.length; } finally { this.running = null; }
    })();
    return this.running;
  }

  // Aggiornamento automatico: all'avvio se l'indice è vecchio, poi ogni mezz'ora.
  start() {
    if (this.timer) return;
    const tick = () => { if (Date.now() - this.at > EVERY - 5000) this.refresh(); };
    this.loaded.then(() => setTimeout(tick, 15000)); // dopo l'avvio, per non rallentare l'apertura
    this.timer = setInterval(tick, EVERY);
  }
}
