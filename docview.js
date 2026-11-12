// Visualizzatore: pagine continue, disegno solo di ciò che si vede, zoom immediato.
import * as pdfjs from './node_modules/pdfjs-dist/build/pdf.min.mjs';
import { h } from './core.js';
import { attachInput } from './input.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

const LIB = `${new URL('./node_modules/', import.meta.url).href}pdfjs-dist/`;
const GAP = 5;
const PAD = 3;
const MAX_CANVAS = window.POSTILLA_LIMITS?.canvas ?? 16e6; // pixel massimi per la pagina intera; oltre si usa il riquadro di dettaglio
const MAX_TOTAL = window.POSTILLA_LIMITS?.total ?? 160e6; // memoria totale delle pagine già disegnate
export const MIN_S = 0.2;
export const MAX_S = 10.7; // circa 800%
export const PCT = 96 / 72; // scala corrispondente al 100%

// Lettura a pezzi: il motore chiede solo la parte di file che gli serve.
class DiskRange extends pdfjs.PDFDataRangeTransport {
  constructor(meta) { super(meta.size, null); this.token = meta.token; }

  requestDataRange(begin, end) {
    host.readRange(this.token, begin, end).then((chunk) => this.onDataRange(begin, chunk)).catch((e) => console.error(e));
  }
}

// src: byte in memoria, oppure i dati del file su disco.
export async function openPdf(src, onPassword) {
  const task = pdfjs.getDocument({
    ...(src.token ? { range: new DiskRange(src), disableAutoFetch: true, rangeChunkSize: 524288 } : { data: src.slice() }),
    cMapUrl: `${LIB}cmaps/`, cMapPacked: true, standardFontDataUrl: `${LIB}standard_fonts/`,
    wasmUrl: `${LIB}wasm/`, iccUrl: `${LIB}iccs/`, isEvalSupported: false, enableHWA: true,
  });
  task.onPassword = onPassword;
  return task.promise;
}

export class DocView {
  constructor(app, tab) {
    this.app = app;
    this.tab = tab;
    this.pages = [];
    this.tops = [];
    this.s = PCT;
    this.fit = 'width';
    this.pending = null; // disegno in corso
    this.gesturing = false;
    this.scroller = h('div', { class: 'scroller', tabindex: '0' });
    this.pagesEl = h('div', { class: 'pages' });
    this.pagesEl.style.setProperty('--s', this.s);
    this.live = h('canvas', { class: 'live' });
    this.scroller.append(this.pagesEl);
    this.root = h('div', { class: 'docview' }, this.scroller, this.live);
    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.scroller);
    attachInput(this, app);
  }

  async setDoc(pdf) {
    const old = this.pdf;
    this.pdf = pdf;
    this.gen = (this.gen || 0) + 1;
    const gen = this.gen;
    this.textCache = new Map();
    this.linkCache = new Map(); // link e campi dipendono dalle pagine: si rileggono a ogni nuovo documento
    this.fieldCache = new Map();
    this.fontTable = new Map();
    this.libDoc = null;
    this.pagesEl.textContent = '';
    this.pending?.task?.cancel();
    this.pending = null;
    this.pages = [];
    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.pages = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < pdf.numPages; i += 1) {
      const el = h('div', { class: 'page', 'data-i': i });
      el.style.setProperty('--pw', vp.width);
      el.style.setProperty('--ph', vp.height);
      frag.append(el);
      this.pages.push({ i, el, w: vp.width, h: vp.height, vp: i === 0 ? vp : null, pdfPage: i === 0 ? first : null, canvas: null, rs: 0, tile: null });
    }
    this.pagesEl.append(frag);
    this.layout();
    this.applyFit();
    this.scroller.scrollTop = 0;
    this.centerX();
    this.schedule();
    // Se il documento viene chiuso o sostituito nel frattempo, le letture in corso falliscono: è previsto.
    this.loadSizes(gen).catch(() => {});
    if (old) old.loadingTask.destroy().catch(() => {});
  }

  // Le dimensioni reali arrivano in sottofondo: l'utente legge già la prima pagina.
  async loadSizes(gen) {
    for (let i = 1; i < this.pages.length; i += 1) {
      if (gen !== this.gen || this.closed) return;
      await this.getPage(i);
      if (i % 50 === 0) await new Promise((r) => setTimeout(r));
    }
    this.layout();
    // Con pagine di formati diversi l'area si allarga sulla più larga: la vista resta centrata (se non l'ha spostata l'utente).
    if (!this.movedX) this.centerX();
    this.schedule();
  }

  // Centra la vista in orizzontale: le pagine strette restano al centro anche se nel documento ce n'è una più larga.
  centerX() {
    this.scroller.scrollLeft = Math.max(0, (this.scroller.scrollWidth - this.scroller.clientWidth) / 2);
    this.lastAutoX = this.scroller.scrollLeft;
    this.movedX = false;
  }

  async getPage(i) {
    const p = this.pages[i];
    if (p.pdfPage) return p.pdfPage;
    const pg = await this.pdf.getPage(i + 1);
    if (!this.pages[i] || this.pages[i] !== p) return pg;
    p.pdfPage = pg;
    p.vp = pg.getViewport({ scale: 1 });
    if (Math.abs(p.vp.width - p.w) > 0.5 || Math.abs(p.vp.height - p.h) > 0.5) {
      p.w = p.vp.width; p.h = p.vp.height;
      p.el.style.setProperty('--pw', p.w);
      p.el.style.setProperty('--ph', p.h);
      this.topsDirty = true;
    }
    return pg;
  }

  layout() {
    let y = PAD;
    this.tops = this.pages.map((p) => { const t = y; y += p.h * this.s + GAP; return t; });
    this.topsDirty = false;
  }

  indexAtY(y) {
    if (this.topsDirty) this.layout();
    let lo = 0; let hi = this.tops.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.tops[m] <= y) lo = m; else hi = m - 1; }
    return lo;
  }

  range() {
    const top = this.scroller.scrollTop;
    return [this.indexAtY(top), this.indexAtY(top + this.scroller.clientHeight)];
  }

  get current() {
    if (!this.pages.length) return 0;
    return this.indexAtY(this.scroller.scrollTop + this.scroller.clientHeight * 0.4);
  }

  onScroll() {
    if (this.lastAutoX !== undefined && Math.abs(this.scroller.scrollLeft - this.lastAutoX) > 2 && !this.fitting) this.movedX = true;
    const c = this.current;
    if (c !== this.lastPage) { this.lastPage = c; this.app.onPageChange(this, c); }
    this.schedule();
  }

  onResize() {
    this.fitLive();
    if (this.fit && this.pages.length) { this.applyFit(); if (!this.movedX) this.centerX(); }
    this.schedule();
  }

  fitLive() {
    const dpr = devicePixelRatio;
    this.live.width = this.scroller.clientWidth * dpr;
    this.live.height = this.scroller.clientHeight * dpr;
  }

  fitScale(mode) {
    const p = this.pages[this.current] || this.pages[0];
    const w = (this.scroller.clientWidth - PAD * 2) / p.w;
    if (mode === 'width') return Math.min(w, MAX_S);
    return Math.min(w, (this.scroller.clientHeight - PAD * 2) / p.h);
  }

  applyFit() {
    if (this.fit) this.setScale(this.fitScale(this.fit), null, true);
  }

  setFit(mode) {
    this.fit = mode;
    const page = this.current;
    this.applyFit();
    this.goto(page);
    this.centerX();
  }

  // Cambia lo zoom tenendo fermo il punto sotto le dita. Il disegno nitido arriva dopo.
  setScale(s, focus, keepFit = false) {
    s = Math.max(MIN_S, Math.min(MAX_S, s));
    if (!keepFit) this.fit = null;
    if (Math.abs(s - this.s) < 1e-4) { this.app.onZoom(this); return; }
    const box = this.scroller.getBoundingClientRect();
    const fx = focus ? focus.x : box.left + box.width / 2;
    const fy = focus ? focus.y : box.top + box.height / 2;
    const idx = this.indexAtY(this.scroller.scrollTop + (fy - box.top));
    const el = this.pages[idx]?.el;
    let u = 0.5; let v = 0.5;
    if (el) { const r = el.getBoundingClientRect(); u = (fx - r.left) / r.width; v = (fy - r.top) / r.height; }
    this.s = s;
    this.pagesEl.style.setProperty('--s', s);
    this.layout();
    if (el) {
      const r = el.getBoundingClientRect();
      this.scroller.scrollLeft += r.left + u * r.width - fx;
      this.scroller.scrollTop += r.top + v * r.height - fy;
    }
    this.pages.forEach((p) => { if (p.tile) { p.tile.remove(); p.tile = null; } });
    this.app.onZoom(this);
    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => this.schedule(), 110);
  }

  animateScale(target, focus) {
    const from = this.s; const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 160);
      const e = 1 - (1 - k) ** 3;
      this.setScale(from * (target / from) ** e, focus);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  goto(i, offsetY = 0) {
    i = Math.max(0, Math.min(this.pages.length - 1, i));
    if (this.topsDirty) this.layout();
    this.scroller.scrollTop = this.tops[i] - PAD + offsetY;
    this.schedule();
  }

  // Mostra un punto della pagina (coordinate a scala 1) al centro dell'area visibile.
  reveal(i, x, y) {
    if (this.topsDirty) this.layout();
    this.scroller.scrollTop = this.tops[i] + y * this.s - this.scroller.clientHeight / 2;
    const r = this.pages[i].el.getBoundingClientRect();
    this.scroller.scrollLeft += r.left + x * this.s - (this.scroller.getBoundingClientRect().left + this.scroller.clientWidth / 2);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.pump(); });
  }

  targetFor(p) {
    const want = this.s * devicePixelRatio;
    const cap = Math.sqrt(MAX_CANVAS / (p.w * p.h));
    return { want, rs: Math.min(want, cap) };
  }

  pump() {
    if (!this.pdf || !this.pages.length || this.gesturing || !this.root.isConnected || this.hidden) return;
    const [a, b] = this.range();
    const order = [];
    for (let i = a; i <= b; i += 1) order.push(i);
    if (b + 1 < this.pages.length) order.push(b + 1);
    if (a > 0) order.push(a - 1);
    if (b + 2 < this.pages.length) order.push(b + 2);
    const next = order.find((i) => { const p = this.pages[i]; return Math.abs(p.rs - this.targetFor(p).rs) > 0.01; });
    if (this.pending) {
      // Una pagina in disegno che non serve più viene interrotta.
      if (!order.includes(this.pending.i) || this.pending.s !== this.s) this.pending.task?.cancel();
      return;
    }
    if (next !== undefined) { this.renderPage(next); return; }
    clearTimeout(this.tileTimer);
    this.tileTimer = setTimeout(() => this.renderTiles(), 90);
    this.app.onIdle?.(this);
  }

  async renderPage(i) {
    const job = { i, s: this.s, task: null };
    this.pending = job;
    const gen = this.gen;
    try {
      const pg = await this.getPage(i);
      if (gen !== this.gen) return;
      const p = this.pages[i];
      const { rs } = this.targetFor(p);
      const vp = pg.getViewport({ scale: rs });
      const canvas = document.createElement('canvas');
      canvas.className = 'pc';
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      job.task = pg.render({ canvas, viewport: vp, annotationMode: this.formMode(i) });
      await job.task.promise;
      if (gen !== this.gen) return;
      if (p.canvas) p.canvas.replaceWith(canvas); else p.el.prepend(canvas);
      p.canvas = canvas;
      p.rs = rs;
      p.used = performance.now();
      this.evict();
      this.app.onPageDrawn?.(this, i, canvas);
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') {
        this.pages[i].rs = this.targetFor(this.pages[i]).rs; // non riprovare all'infinito
        console.error(e);
      }
    } finally {
      if (this.pending === job) this.pending = null;
      this.schedule();
    }
  }

  evict() {
    const [a, b] = this.range();
    let total = this.pages.reduce((n, p) => n + (p.canvas ? p.canvas.width * p.canvas.height : 0), 0);
    if (total < MAX_TOTAL) return;
    const far = this.pages.filter((p) => p.canvas && (p.i < a - 2 || p.i > b + 3)).sort((x, y) => x.used - y.used);
    for (const p of far) {
      if (total < MAX_TOTAL * 0.7) break;
      total -= p.canvas.width * p.canvas.height;
      p.canvas.width = 0; p.canvas.remove(); p.canvas = null; p.rs = 0;
    }
  }

  // Oltre il limite della pagina intera si disegna ad alta definizione solo la zona visibile.
  async renderTiles() {
    if (this.gesturing || this.pending || !this.pages.length) return;
    const [a, b] = this.range();
    const box = this.scroller.getBoundingClientRect();
    for (let i = a; i <= b; i += 1) {
      const p = this.pages[i];
      if (!p) return;
      const { want, rs } = this.targetFor(p);
      if (rs >= want * 0.98) continue;
      const r = p.el.getBoundingClientRect();
      const vx0 = Math.max(box.left, r.left) - r.left; const vy0 = Math.max(box.top, r.top) - r.top;
      const vx1 = Math.min(box.right, r.right) - r.left; const vy1 = Math.min(box.bottom, r.bottom) - r.top;
      if (vx1 <= vx0 || vy1 <= vy0) continue;
      const k = devicePixelRatio;
      const x = Math.floor(Math.max(0, vx0 - 120) * k); const y = Math.floor(Math.max(0, vy0 - 120) * k);
      const w = Math.ceil((Math.min(r.width, vx1 + 120)) * k) - x; const hh = Math.ceil((Math.min(r.height, vy1 + 120)) * k) - y;
      const key = `${this.s}`;
      if (p.tile && p.tile.dataset.k === key && p.tile.dataset.x <= vx0 * k && p.tile.dataset.y <= vy0 * k
        && +p.tile.dataset.x + p.tile.width >= vx1 * k && +p.tile.dataset.y + p.tile.height >= vy1 * k) continue;
      const pg = await this.getPage(i);
      const canvas = document.createElement('canvas');
      canvas.className = 'tile';
      canvas.width = w; canvas.height = hh;
      Object.assign(canvas.dataset, { k: key, x, y });
      const job = { i, s: this.s, task: null };
      this.pending = job;
      try {
        job.task = pg.render({ canvas, viewport: pg.getViewport({ scale: want }), transform: [1, 0, 0, 1, -x, -y], annotationMode: this.formMode(i) });
        await job.task.promise;
        if (this.s !== +key) return;
        canvas.style.cssText = `left:${x / k}px;top:${y / k}px;width:${w / k}px;height:${hh / k}px`;
        p.tile?.remove();
        p.tile = canvas;
        (p.canvas || p.el.firstChild)?.after?.(canvas);
      } catch (e) {
        if (e?.name !== 'RenderingCancelledException') console.error(e);
        return;
      } finally {
        if (this.pending === job) this.pending = null;
      }
    }
    this.schedule();
  }

  // Con i campi compilabili disegnati sopra la pagina, il disegno della pagina non deve ripeterli.
  formMode() { return pdfjs.AnnotationMode.ENABLE_FORMS; }

  async thumb(i, width = 150) {
    const pg = await this.getPage(i);
    const scale = width / pg.getViewport({ scale: 1 }).width;
    const vp = pg.getViewport({ scale: scale * Math.min(2, devicePixelRatio) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    await pg.render({ canvas, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    return canvas;
  }

  async ensureBytes() {
    if (!this.cleanBytes) this.cleanBytes = (await host.readFile(this.sourcePath)).data;
    return this.cleanBytes;
  }

  destroy() {
    this.gen += 1;
    this.closed = true;
    if (this.token) host.closeDoc(this.token);
    this.ro.disconnect();
    this.pending?.task?.cancel();
    this.pdf?.loadingTask.destroy().catch(() => {});
    this.root.remove();
  }
}
