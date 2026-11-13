// Pannello laterale (miniature, indice, segnalibri, ricerca, annotazioni) e gestione pagine.
import { $, ask, baseName, h, icon, iconBtn, promptText, toast } from './core.js';
import { toDisp } from './annots.js';
import { quadDisp } from './annots.js';
import { searchAll } from './text.js';
import { buildPdf, countPages, deletePages, extractPages, insertBlank, insertPdf, reorderPages, rotatePages } from './pdfio.js';

const LABELS = { ink: 'Disegno', hl: 'Evidenziato', ul: 'Sottolineato', so: 'Barrato', rect: 'Rettangolo', ellipse: 'Ellisse', line: 'Linea', arrow: 'Freccia', text: 'Testo', note: 'Nota', label: 'Nota invisibile', stamp: 'Timbro', sig: 'Firma visiva', image: 'Immagine', redact: 'Da oscurare' };

export class Panel {
  constructor(app) {
    this.app = app;
    this.mode = 'thumbs';
    this.el = h('aside', { id: 'panel' });
    $('#stage').insertBefore(this.el, $('#docs'));
    this.tabs = h('div', { class: 'panel-tabs', role: 'tablist' });
    this.body = h('div', { class: 'panel-body' });
    this.el.append(this.tabs, this.body);
    this.io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) this.loadThumb(e.target); }), { root: this.body, rootMargin: '300px' });
    this.queue = Promise.resolve();
  }

  show(on) { this.el.hidden = !on; }

  setMode(m) { this.mode = m; this.render(); }

  render() {
    const view = this.app.view;
    this.tabs.textContent = '';
    const items = [['thumbs', 'pages', 'Miniature'], ['outline', 'panel', 'Indice'], ['marks', 'bookmark', 'Segnalibri'], ['search', 'search', 'Cerca'], ['annots', 'note', 'Annotazioni']];
    for (const [m, ic, title] of items) {
      this.tabs.append(h('button', { class: `ib ${this.mode === m ? 'on' : ''}`, title, 'aria-label': title, html: icon(ic), onclick: () => this.setMode(m) }));
    }
    this.body.textContent = '';
    this.body.scrollTop = 0;
    if (!view) return;
    this[this.mode](view);
  }

  thumbs(view) {
    this.items = view.pages.map((p) => {
      const box = h('div', { class: 'tn-img', style: `aspect-ratio:${p.w}/${p.h}` });
      const it = h('button', { class: 'tn', 'data-i': p.i, onclick: () => view.goto(p.i) }, box, h('span', {}, String(p.i + 1)));
      this.body.append(it);
      this.io.observe(it);
      return it;
    });
    this.sync(view, view.current);
  }

  loadThumb(el) {
    const view = this.app.view;
    const i = +el.dataset.i;
    this.io.unobserve(el);
    this.queue = this.queue.then(async () => {
      if (!el.isConnected || !view) return;
      view.thumbs = view.thumbs || new Map();
      if (!view.thumbs.has(i)) view.thumbs.set(i, (await view.thumb(i, 130)).toDataURL('image/jpeg', 0.7));
      if (el.isConnected) { const box = el.firstChild; box.textContent = ''; box.append(h('img', { src: view.thumbs.get(i), alt: `Pagina ${i + 1}` })); }
    }).catch(() => {});
  }

  sync(view, page) {
    if (this.mode !== 'thumbs' || !this.items) return;
    this.items.forEach((it) => it.classList.remove('on'));
    const it = this.items[page];
    if (it) { it.classList.add('on'); it.scrollIntoView({ block: 'nearest' }); }
  }

  async outline(view) {
    const body = this.body;
    const tree = await view.pdf.getOutline();
    if (this.mode !== 'outline') return;
    if (!tree?.length) { body.append(h('p', { class: 'hint' }, 'Questo PDF non ha un indice.')); return; }
    const go = async (it) => {
      let { dest } = it;
      if (typeof dest === 'string') dest = await view.pdf.getDestination(dest);
      if (!dest) return;
      const i = typeof dest[0] === 'number' ? dest[0] : await view.pdf.getPageIndex(dest[0]);
      view.goto(i);
    };
    const add = (list, depth) => list.forEach((it) => {
      body.append(h('button', { class: 'row', style: `padding-left:${8 + depth * 14}px`, onclick: () => go(it) }, it.title));
      if (it.items?.length) add(it.items, depth + 1);
    });
    add(tree, 0);
  }

  marks(view) {
    const list = this.app.bookmarks(view);
    this.body.append(h('button', { class: 'row strong', html: `${icon('plus')} Segna la pagina ${view.current + 1}`, onclick: () => { this.app.toggleBookmark(view, view.current); this.render(); } }));
    if (!list.length) this.body.append(h('p', { class: 'hint' }, 'Nessun segnalibro in questo documento.'));
    for (const i of list) {
      this.body.append(h('div', { class: 'row-line' }, h('button', { class: 'row', onclick: () => view.goto(i) }, `Pagina ${i + 1}`),
        iconBtn('close', 'Togli segnalibro', () => { this.app.toggleBookmark(view, i); this.render(); })));
    }
  }

  search(view) {
    const input = h('input', { type: 'search', placeholder: 'Cerca nel documento…', 'aria-label': 'Cerca nel documento', value: view.lastSearch || '' });
    const count = h('p', { class: 'hint', 'data-role': 'count' });
    const results = h('div', {});
    const all = h('button', { class: 'lib-open', onclick: async () => { const { openLibrary } = await import('./library-ui.js'); openLibrary(this.app, input.value); } }, 'Cerca in tutti i PDF delle cartelle… (Ctrl+Maiusc+F)');
    this.body.append(input, all, count, results);
    let token = 0;
    const run = async () => {
      const t = (token += 1);
      const q = input.value;
      view.lastSearch = q;
      results.textContent = '';
      count.textContent = '';
      this.clearHits(view);
      if (q.trim().length < 2) return;
      let n = 0;
      count.textContent = 'Ricerca in corso…';
      await searchAll(view, q, (hit) => {
        n += 1;
        // Testo da OCR: va sempre confrontato con la pagina; le parole incerte lo dicono chiaramente.
        const tag = hit.ocr ? h('span', { class: `ocr-tag${hit.unsure.length ? ' unsure' : ''}`, title: 'Testo riconosciuto automaticamente: confrontalo con la pagina' }, hit.unsure.length ? 'OCR · da verificare' : 'OCR') : null;
        if (n <= 500) results.append(h('button', { class: 'row', onclick: () => this.showHit(view, hit) }, h('b', {}, `p. ${hit.page + 1}`), ` ${hit.snippet} `, tag));
      }, () => t !== token);
      const hint = view.ocr ? '' : ' Se il PDF è una scansione, usa «Riconosci il testo (OCR)» dal menu ⋯.';
      if (t === token) count.textContent = n ? `${n} risultat${n === 1 ? 'o' : 'i'}` : `Nessun risultato.${hint}`;
    };
    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    setTimeout(() => input.focus(), 30);
    if (input.value) run();
  }

  clearHits(view) { view.pages.forEach((p) => { if (p.selSvg) p.selSvg.innerHTML = ''; }); }

  async showHit(view, hit) {
    this.clearHits(view);
    await view.getPage(hit.page);
    const p = view.pages[hit.page];
    const layer = this.app.tools.selLayer(p);
    layer.innerHTML = hit.quads.map((q) => {
      const { tl, tr, bl, br } = quadDisp(p, q);
      return `<polygon points="${tl} ${tr} ${br} ${bl}" fill="#ff9d2e" fill-opacity=".45"/>`;
    }).join('') + (hit.unsure || []).map((q) => {
      const { tl, tr, bl, br } = quadDisp(p, q);
      return `<polygon class="ocr-unsure" points="${tl} ${tr} ${br} ${bl}" fill="none" stroke="#b3261e" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    }).join('');
    const c = quadDisp(p, hit.quads[0]).tl;
    view.reveal(hit.page, c[0], c[1]);
  }

  annots(view) {
    const list = [...view.annots].sort((a, b) => a.page - b.page);
    if (!list.length) { this.body.append(h('p', { class: 'hint' }, 'Nessuna annotazione.')); return; }
    for (const a of list) {
      this.body.append(h('button', { class: 'row', onclick: async () => {
        await view.getPage(a.page);
        const p = view.pages[a.page];
        const pt = a.a ? toDisp(p, ...a.a) : a.quads ? toDisp(p, a.quads[0][0], a.quads[0][1]) : toDisp(p, a.pts[0][0], a.pts[0][1]);
        view.reveal(a.page, pt[0], pt[1]);
      } }, h('b', {}, `p. ${a.page + 1}`), ` ${LABELS[a.type]}${a.text || a.label ? `: ${(a.text || a.label).slice(0, 60)}` : ''}`));
    }
  }
}

// Gestione pagine a schermo intero.
export class PageManager {
  constructor(app) { this.app = app; this.sel = new Set(); }

  async open() {
    const { view } = this.app;
    if (!view) return;
    this.close();
    this.view = view;
    this.sel = new Set([view.current]);
    this.grid = h('div', { class: 'pm-grid' });
    this.io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { this.io.unobserve(e.target); this.load(e.target); } }), { rootMargin: '400px' });
    const act = (ic, label, fn, needSel = true) => h('button', { class: 'pm-act', 'data-act': label, html: `${icon(ic)}<span>${label}</span>`, onclick: () => { if (needSel && !this.sel.size) { toast('Seleziona almeno una pagina.'); return; } fn(); } });
    this.info = h('span', { class: 'pm-info' });
    this.el = h('div', { class: 'pm' },
      h('div', { class: 'pm-bar' },
        h('button', { class: 'pm-act', html: `${icon('close')}<span>Chiudi</span>`, onclick: () => this.close() }),
        this.info,
        act('rotate', 'Ruota', () => this.rotate(90)),
        act('up', 'Sposta prima', () => this.shift(-1)),
        act('down', 'Sposta dopo', () => this.shift(1)),
        act('trash', 'Elimina', () => this.remove()),
        act('copy', 'Estrai', () => this.extract()),
        act('more', 'Dividi', () => this.split(), false),
        act('plus', 'Pagina vuota', () => this.blank(), false),
        act('open', 'Unisci PDF', () => this.merge(), false),
        act('undo', 'Annulla', () => this.undoOp(), false)),
      this.grid);
    $('#stage').append(this.el);
    this.renderGrid();
  }

  close() { this.io?.disconnect(); this.el?.remove(); this.el = null; }

  renderGrid() {
    const { view } = this;
    this.grid.textContent = '';
    view.pages.forEach((p) => {
      const it = h('button', { class: `pm-item ${this.sel.has(p.i) ? 'on' : ''}`, 'data-i': p.i, onclick: () => this.toggle(p.i, it), ondblclick: () => { this.close(); view.goto(p.i); } },
        h('div', { class: 'tn-img', style: `aspect-ratio:${p.w}/${p.h}` }), h('span', {}, String(p.i + 1)));
      this.grid.append(it);
      this.io.observe(it);
    });
    this.updateInfo();
  }

  updateInfo() { this.info.textContent = `${this.sel.size} selezionat${this.sel.size === 1 ? 'a' : 'e'} su ${this.view.pages.length}`; }

  toggle(i, it) {
    if (this.sel.has(i)) this.sel.delete(i); else this.sel.add(i);
    it.classList.toggle('on');
    this.updateInfo();
  }

  async load(el) {
    const i = +el.dataset.i;
    const { view } = this;
    view.thumbs = view.thumbs || new Map();
    if (!view.thumbs.has(i)) view.thumbs.set(i, (await view.thumb(i, 170)).toDataURL('image/jpeg', 0.75));
    if (el.isConnected) el.firstChild.append(h('img', { src: view.thumbs.get(i), alt: '' }));
  }

  guard() {
    if (this.view.readonly) { toast('Questo PDF è protetto: le pagine non si possono modificare.', 'error'); return false; }
    return true;
  }

  async run(fn, mapping, nextSel) {
    if (!this.guard() || this.busy) return;
    this.busy = true;
    try {
      await this.app.pageOp(this.view, fn, mapping);
      this.sel = new Set(nextSel);
      this.renderGrid();
    } finally { this.busy = false; }
  }

  rotate(deg) {
    const list = [...this.sel];
    return this.run((b) => rotatePages(b, list, deg), (i) => i, list);
  }

  shift(dir) {
    const n = this.view.pages.length;
    const order = [...Array(n).keys()];
    const picked = [...this.sel].sort((a, b) => (dir < 0 ? a - b : b - a));
    for (const i of picked) {
      const at = order.indexOf(i); const to = at + dir;
      if (to < 0 || to >= n || this.sel.has(order[to])) continue;
      [order[at], order[to]] = [order[to], order[at]];
    }
    if (order.every((v, i) => v === i)) return undefined;
    return this.run((b) => reorderPages(b, order), (i) => order.indexOf(i), picked.map((i) => order.indexOf(i)));
  }

  async remove() {
    const n = this.view.pages.length;
    if (this.sel.size >= n) { toast('Il documento deve conservare almeno una pagina.', 'error'); return; }
    const ok = await ask('Eliminare le pagine?', `Verranno tolte ${this.sel.size} pagine da questo documento aperto. Il file sul disco cambia solo quando salvi.`, [{ label: 'Annulla', value: false }, { label: 'Elimina', value: true, primary: true }]);
    if (!ok) return;
    const list = [...this.sel];
    const kept = [...Array(n).keys()].filter((i) => !this.sel.has(i));
    await this.run((b) => deletePages(b, list), (i) => kept.indexOf(i), []);
  }

  async writeNew(bytes, suggested) {
    const dest = await host.pickSave(suggested);
    if (!dest) return null;
    await host.writeFile(dest, bytes);
    return dest;
  }

  async extract() {
    const { view } = this;
    const list = [...this.sel].sort((a, b) => a - b);
    const bytes = await extractPages(await buildPdf(view), list);
    const dest = await this.writeNew(bytes, `${view.tab.path.replace(/\.pdf$/i, '')} - pagine estratte.pdf`);
    if (dest) toast(`Creato ${baseName(dest)}`);
  }

  async split() {
    const { view } = this;
    const v = await promptText('Dividi il PDF', 'Quante pagine per ogni file?', '1', { okLabel: 'Dividi' });
    const n = parseInt(v, 10);
    if (!n || n < 1) return;
    const full = await buildPdf(view);
    const total = view.pages.length;
    const base = view.tab.path.replace(/\.pdf$/i, '');
    let count = 0;
    for (let i = 0; i < total; i += n) {
      const list = [...Array(Math.min(n, total - i)).keys()].map((k) => i + k);
      const dest = await host.uniquePath(`${base} - parte ${count + 1}.pdf`);
      await host.writeFile(dest, await extractPages(full, list));
      count += 1;
    }
    toast(`Creati ${count} file accanto al documento.`);
  }

  blank() {
    const at = this.sel.size ? Math.max(...this.sel) + 1 : this.view.pages.length;
    const p = this.view.pages[Math.max(0, at - 1)];
    return this.run((b) => insertBlank(b, at, [p.w, p.h]), (i) => (i >= at ? i + 1 : i), [at]);
  }

  async merge() {
    const files = await host.pickPdf();
    if (!files.length) return;
    let at = this.sel.size ? Math.max(...this.sel) + 1 : this.view.pages.length;
    for (const file of files) {
      const { data } = await host.readFile(file);
      const pos = at;
      const before = this.view.pages.length;
      try {
        const n = await countPages(data);
        await this.run((b) => insertPdf(b, data, pos), (i) => (i >= pos ? i + n : i), []);
      } catch { toast(`Non riesco a unire ${baseName(file)}: potrebbe essere protetto.`, 'error'); continue; }
      at += this.view.pages.length - before;
    }
  }

  async undoOp() {
    if (!(await this.app.undoPageOp(this.view))) { toast('Nessuna operazione sulle pagine da annullare.'); return; }
    this.sel = new Set();
    this.renderGrid();
  }
}
