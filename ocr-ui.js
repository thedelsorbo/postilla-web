// Comandi dell'OCR: avviso sulle pagine scansionate, avanzamento con "Annulla", indice separato.
import { $, h, toast } from './core.js';
import { ENGINE, INDEX_VERSION, LOW_CONF, isScannedPage, pagesNeedingOcr, recognizePage, stopEngine } from './ocr.js';

const where = (tab) => ({ path: tab.path, size: tab.size, mtime: tab.mtime });

export class OcrController {
  constructor(app) {
    this.app = app;
    this.job = null; // { view, cancelled }
  }

  get running() { return !!this.job; }

  // All'apertura: carica l'indice già fatto (senza rileggere il file) oppure segnala le pagine scansionate.
  async afterOpen(view) {
    const { tab } = view;
    try {
      const hash = await host.ocrLookup(where(tab));
      if (hash) {
        const idx = await host.ocrGet(hash);
        if (view.closed) return;
        if (this.valid(idx, view)) { view.hash = hash; this.attach(view, idx); }
      }
      const scanned = [];
      const n = Math.min(view.pages.length, 40);
      for (let i = 0; i < n && !view.closed; i += 1) if (await isScannedPage(view, i)) scanned.push(i);
      if (view.closed || !scanned.length) return;
      const missing = scanned.filter((i) => !view.ocr?.pages?.[i]);
      let what;
      if (view.pages.length > n) what = 'Alcune pagine sono scansioni senza testo';
      else if (scanned.length === view.pages.length) what = 'Il documento è una scansione senza testo';
      else if (scanned.length === 1) what = `La pagina ${scanned[0] + 1} è una scansione senza testo`;
      else what = `${scanned.length} pagine sono scansioni senza testo`;
      if (missing.length) this.offer(view, what);
    } catch (e) { console.error(e); }
  }

  valid(idx, view) {
    return idx && idx.version === INDEX_VERSION && idx.engine === ENGINE && idx.pageCount === view.pages.length;
  }

  attach(view, idx) {
    view.ocr = idx;
    view.textCache.clear();
  }

  offer(view, what) {
    view.root.querySelector('.banner.ocr-offer')?.remove();
    const b = h('div', { class: 'banner ocr-offer', role: 'status' },
      `${what}: per cercare e selezionare le parole serve il riconoscimento del testo (OCR).`,
      h('button', { class: 'primary', onclick: () => { b.remove(); this.run(view); } }, 'Riconosci il testo'),
      h('button', { onclick: () => b.remove(), 'aria-label': 'Chiudi avviso' }, 'Non ora'));
    view.root.append(b);
  }

  // Riconosce tutte le pagine senza testo che non sono già nell'indice. Si può annullare in ogni momento.
  async run(view) {
    if (this.job) { toast('Il riconoscimento del testo è già in corso.'); return; }
    const job = { view, cancelled: false };
    // Quando si annulla, l'attesa della pagina in corso finisce subito (il motore viene chiuso a parte).
    job.stopped = new Promise((resolve) => { job.stop = resolve; });
    this.job = job;
    const bar = this.progressBar(job);
    try {
      bar.set('Preparazione…', 0);
      if (!view.hash) view.hash = await host.fileHash(view.sourcePath);
      let idx = view.ocr;
      if (!this.valid(idx, view)) {
        const saved = await host.ocrGet(view.hash);
        idx = this.valid(saved, view) ? saved : { version: INDEX_VERSION, engine: ENGINE, hash: view.hash, pageCount: view.pages.length, created: Date.now(), pages: {}, errors: {} };
        this.attach(view, idx);
      }
      const todo = (await pagesNeedingOcr(view, () => job.cancelled || view.closed)).filter((i) => !idx.pages[i]);
      if (!todo.length && !job.cancelled) { toast(Object.keys(idx.pages).length ? 'Il testo di questo documento è già stato riconosciuto.' : 'Tutte le pagine hanno già testo: l\'OCR non serve.'); return; }
      let done = 0;
      let unsure = 0;
      for (const i of todo) {
        if (job.cancelled || view.closed) break;
        bar.set(`Riconoscimento del testo: pagina ${i + 1} (${done + 1} di ${todo.length})`, done / todo.length);
        try {
          const work = recognizePage(view, i, (m) => { if (m.status === 'recognizing text') bar.set(null, (done + m.progress) / todo.length); });
          work.catch(() => {}); // dopo un annullamento l'esito della pagina interrotta non interessa più
          const r = await Promise.race([work, job.stopped]);
          if (job.cancelled || view.closed || !r) break;
          idx.pages[i] = r;
          delete idx.errors[i];
          unsure += r.words.filter((w) => w.c < LOW_CONF).length;
        } catch (e) {
          if (job.cancelled || view.closed) break;
          console.error(e);
          idx.errors[i] = String(e?.message || e);
        }
        done += 1;
        view.textCache.delete(i);
        idx.updated = Date.now();
        await host.ocrSet(view.hash, idx, where(view.tab));
      }
      if (job.cancelled) toast(`Riconoscimento annullato. ${done ? `Le ${done} pagine già riconosciute restano disponibili.` : ''}`);
      else if (!view.closed) {
        const errs = Object.keys(idx.errors).length;
        toast(`Testo riconosciuto su ${done} pagin${done === 1 ? 'a' : 'e'}.${unsure ? ` ${unsure} parole sono incerte: nelle ricerche sono segnate "da verificare".` : ''}${errs ? ` ${errs} pagine non sono state lette.` : ''}`, errs ? 'error' : undefined);
      }
      if (this.app.panel.mode === 'search' && view === this.app.view && this.app.prefs.panel) this.app.panel.render();
    } catch (e) {
      console.error(e);
      if (!job.cancelled) toast(`Riconoscimento non riuscito: ${e.message || e}`, 'error');
    } finally {
      stopEngine(); // a lavoro finito il motore si chiude e libera la memoria
      bar.remove();
      if (this.job === job) this.job = null;
    }
  }

  async cancel() {
    if (!this.job) return;
    this.job.cancelled = true;
    this.job.stop(null);
    await stopEngine();
  }

  progressBar(job) {
    $('#ocr-progress')?.remove();
    const label = h('span', { class: 'ocr-label' }, '');
    const fill = h('i', {});
    const el = h('div', { id: 'ocr-progress', role: 'status', 'aria-live': 'polite' },
      label, h('span', { class: 'ocr-track' }, fill),
      h('button', { onclick: () => this.cancel() }, 'Annulla'));
    document.body.append(el);
    return {
      set: (text, frac) => { if (text) label.textContent = text; if (frac != null) fill.style.width = `${Math.round(Math.min(1, frac) * 100)}%`; },
      remove: () => el.remove(),
      job,
    };
  }

  // Dopo il salvataggio di una copia le pagine sono le stesse: l'indice passa anche alla copia.
  async afterSave(view, dest, st) {
    if (!view.ocr || !Object.keys(view.ocr.pages).length) return;
    try {
      const hash = await host.fileHash(dest);
      await host.ocrSet(hash, { ...view.ocr, hash }, { path: dest, size: st.size, mtime: st.mtime });
      if (dest === view.tab.path) view.hash = hash;
    } catch (e) { console.error(e); }
  }

  // Le pagine sono state spostate, ruotate o tolte: l'indice non corrisponde più.
  reset(view) {
    if (this.job?.view === view) this.cancel();
    view.ocr = null;
    view.hash = null;
  }

  async clear(view) {
    if (this.job?.view === view) await this.cancel();
    if (!view.hash) view.hash = await host.fileHash(view.sourcePath);
    await host.ocrDel(view.hash);
    view.ocr = null;
    view.textCache.clear();
    toast('Testo riconosciuto cancellato per questo documento. Il PDF non è stato modificato.');
  }

  closing(view) { if (this.job?.view === view) this.cancel(); }
}
