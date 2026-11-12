// Strumenti di annotazione: cosa succede quando penna, mouse o dito toccano la pagina.
import { h, icon, uid, toast } from './core.js';
import { annSvg, bbox, dispRect, hits, labelWidth, quadDisp, toDisp, toUser, translated, wrapLines } from './annots.js';
import { mergeQuads, nearestWord, pageText } from './text.js';
import { cachedLinkAt, followLink, linkAt } from './links.js';
import { reEdit, startEdit } from './edits.js';
import { FIELD_KINDS, fieldDialog, nextName } from './pro/formbuilder.js';
import { lengthLabel, areaLabel, polygonArea, dist, finishCalibration } from './pro/measure.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const SHAPES = ['rect', 'ellipse', 'line', 'arrow', 'redact', 'field', 'measure'];
const MARKS = ['hl', 'ul', 'so'];
const PLACED = ['text', 'note', 'label', 'stamp', 'sig'];

export class Tools {
  constructor(app) {
    this.app = app;
    this.tool = 'hand';
    this.act = null;
    this.selected = null; // {view, id}
    this.textSel = null;
    this.stamp = null;
    this.signature = null;
  }

  wantsPointer(e) {
    if (this.tool === 'hand') return false;
    return !(e && e.pointerType === 'mouse' && e.button === 1);
  }

  set(tool) {
    this.commitEditor();
    this.deselect();
    this.clearTextSel();
    if (this.tool === 'laser' && tool !== 'laser') this.laserOff();
    if (this.tool === 'area' && tool !== 'area' && this.area) { const v = this.area.view; this.area = null; this.clearLive(v); }
    if (tool !== 'measure') this.calibrating = false;
    this.tool = tool;
    this.app.syncToolbar();
  }

  // Il puntatore esce dalla pagina o si cambia strumento: il punto rosso sparisce.
  laserOff() {
    this.trail = []; this.laserHead = null;
    if (this.laserView && !this.laserRaf) this.laserRaf = requestAnimationFrame(() => this.laserFrame(this.laserView));
  }

  pageAt(view, x, y) {
    const el = document.elementFromPoint(x, y)?.closest?.('.page');
    if (el && view.pagesEl.contains(el)) return view.pages[+el.dataset.i];
    const box = view.scroller.getBoundingClientRect();
    const p = view.pages[view.indexAtY(view.scroller.scrollTop + y - box.top)];
    return p;
  }

  local(p, e) {
    const r = p.el.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * p.w, ((e.clientY - r.top) / r.height) * p.h];
  }

  // --- Livelli di disegno -------------------------------------------------
  layers(p) {
    if (!p.svg) {
      const mk = (cls) => { const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('class', cls); s.setAttribute('preserveAspectRatio', 'none'); return s; };
      p.hlSvg = mk('hl-layer'); p.svg = mk('an-layer');
      p.el.append(p.hlSvg, p.svg);
    }
    const vb = `0 0 ${p.w} ${p.h}`;
    p.svg.setAttribute('viewBox', vb); p.hlSvg.setAttribute('viewBox', vb);
    return p;
  }

  draw(view, i) {
    const p = view.pages[i];
    if (!p) return;
    const list = view.annots.filter((a) => a.page === i);
    // Revisione condivisa: commenti degli altri, in sola lettura, con il nome dell'autore.
    const ext = (view.extAnnots || []).filter((a) => a.page === i);
    if (!p.vp) { view.getPage(i).then(() => this.draw(view, i)); return; }
    if (!list.length && !ext.length && !p.svg) return;
    this.layers(p);
    const extSvg = (a) => `<g class="an-ext" data-author="${String(a.ext).replace(/[&<>"]/g, '')}"><title>${String(a.ext).replace(/[&<>"]/g, '')}</title>${annSvg(a, p)}</g>`;
    p.hlSvg.innerHTML = ext.filter((a) => a.type === 'hl').map(extSvg).join('') + list.filter((a) => a.type === 'hl').map((a) => annSvg(a, p)).join('');
    p.svg.innerHTML = ext.filter((a) => a.type !== 'hl').map(extSvg).join('') + list.filter((a) => a.type !== 'hl').map((a) => annSvg(a, p)).join('');
  }

  drawAll(view) {
    const set = new Set(view.annots.map((a) => a.page));
    set.forEach((i) => this.draw(view, i));
  }

  // --- Modifiche con annulla/ripeti ----------------------------------------
  apply(view, op, record = true) {
    const touched = new Set();
    for (const a of op.remove || []) { view.annots = view.annots.filter((x) => x.id !== a.id); touched.add(a.page); }
    for (const a of op.add || []) { view.annots.push(a); touched.add(a.page); }
    touched.forEach((i) => this.draw(view, i));
    if (record) { view.undoStack.push(op); view.redoStack.length = 0; }
    if (record) this.app.onEditOp?.(view, op, 'do');
    this.app.markDirty(view);
    this.app.collab?.changed(view);
  }

  undo(view) {
    const op = view.undoStack.pop();
    // Senza annotazioni da annullare: si annulla l'ultima operazione sul documento (pagine, oscuramento, filigrana…).
    if (!op) { if (view.pageHistory?.length) this.app.undoPageOp(view).then(() => this.app.syncToolbar()); return; }
    this.deselect();
    this.apply(view, { add: op.remove, remove: op.add }, false);
    this.app.onEditOp?.(view, op, 'undo');
    view.redoStack.push(op);
    this.app.syncToolbar();
  }

  redo(view) {
    const op = view.redoStack.pop();
    if (!op) return;
    this.deselect();
    this.apply(view, op, false);
    this.app.onEditOp?.(view, op, 'redo');
    view.undoStack.push(op);
    this.app.syncToolbar();
  }

  guardEdit(view) {
    if (view.readonly) { toast('Questo PDF è protetto: si può leggere ma non modificare.', 'error'); return false; }
    if (view.loading) { toast('Un attimo: sto caricando le annotazioni di questo documento.'); return false; }
    return true;
  }

  // --- Input ---------------------------------------------------------------
  down(view, e) {
    this.commitEditor();
    if (this.tool === 'laser') { this.laserMove(view, e); return undefined; }
    const p = this.pageAt(view, e.clientX, e.clientY);
    if (!p || !p.vp) return;
    const eraserEnd = e.pointerType === 'pen' && (e.buttons & 32 || e.button === 5);
    const tool = eraserEnd ? 'eraser' : this.tool;
    const [x, y] = this.local(p, e);
    this.act = { tool, p, x, y, e0: e, moved: false };
    if (tool === 'select') return this.selectDown(view, p, x, y, e);
    this.deselect();
    this.clearTextSel();
    if (!this.guardEdit(view)) { this.act = null; return undefined; }
    if (tool === 'pen') this.inkStart(view, p, e);
    else if (tool === 'eraser') { this.act.removed = []; this.eraseAt(view, p, x, y); }
    else if (MARKS.includes(tool)) this.markStart(view, p, x, y);
    else if (SHAPES.includes(tool)) { /* anteprima nel movimento */ }
    return undefined;
  }

  move(view, e) {
    if (this.tool === 'laser') { this.laserMove(view, e); return; }
    const act = this.act;
    if (!act) return;
    const [x, y] = this.local(act.p, e);
    act.moved = act.moved || Math.hypot(x - act.x, y - act.y) * view.s > 4;
    if (act.tool === 'pen') this.inkMove(view, e);
    else if (act.tool === 'eraser') this.eraseAt(view, act.p, x, y);
    else if (SHAPES.includes(act.tool)) this.shapePreview(view, act, e);
    else if (MARKS.includes(act.tool)) this.markMove(view, act, x, y);
    else if (act.tool === 'select') this.selectMove(view, act, x, y);
  }

  up(view, e) {
    const act = this.act;
    this.act = null;
    if (!act) return;
    const [x, y] = this.local(act.p, e);
    if (act.tool === 'pen') this.inkEnd(view, act);
    else if (act.tool === 'eraser') { if (act.removed.length) view.undoStack.push({ remove: act.removed }), view.redoStack.length = 0; this.app.syncToolbar(); }
    else if (SHAPES.includes(act.tool)) this.shapeEnd(view, act, x, y);
    else if (MARKS.includes(act.tool)) this.markEnd(view, act, x, y);
    else if (act.tool === 'select') this.selectUp(view, act, x, y);
    else if (PLACED.includes(act.tool)) this.place(view, act.p, x, y);
    else if (act.tool === 'area') { this.areaPoint(view, act.p, x, y, e); return; }
    this.clearLive(view);
    this.app.syncToolbar();
  }

  cancel(view) {
    this.act = null;
    this.clearLive(view);
  }

  // Tocco col dito o clic in modalità mano.
  tap(view, e) {
    const p = this.pageAt(view, e.clientX, e.clientY);
    if (!p?.vp) return;
    const [x, y] = this.local(p, e);
    if (this.placeHook) { const fn = this.placeHook; this.placeHook = null; fn(view, p, x, y); return; }
    if (PLACED.includes(this.tool)) { this.commitEditor(); if (this.guardEdit(view)) this.place(view, p, x, y); return; }
    if (this.tool === 'area') { if (this.guardEdit(view)) this.areaPoint(view, p, x, y, e); return; }
    const a = this.hit(view, p, x, y, 8);
    this.commitEditor();
    if (a?.type === 'note') { this.select(view, a); this.editNote(view, a); return; }
    if (a?.type === 'label' && this.tool === 'select') { this.select(view, a); this.editLabel(view, a); return; }
    if (a?.type === 'edit' && this.tool === 'select') { this.select(view, a); reEdit(this.app, view, a); return; }
    if (this.tool === 'select') { if (a) this.select(view, a); else this.deselect(); }
    if (!a && (this.tool === 'select' || this.tool === 'hand') && e.pointerType !== 'pen') this.linkTap(view, p, x, y);
  }

  // Tocco o clic su un link del PDF (mai con la penna).
  async linkTap(view, p, x, y) {
    const link = await linkAt(view, p, x, y);
    if (link) await followLink(this.app, view, link);
  }

  hover(view, e) {
    if (this.tool === 'area' && this.area) { this.areaPreview(view, e); return; }
    if (this.tool !== 'select' && this.tool !== 'hand') return;
    const p = this.pageAt(view, e.clientX, e.clientY);
    if (!p?.vp) return;
    const [x, y] = this.local(p, e);
    const link = cachedLinkAt(view, p, x, y);
    view.scroller.classList.toggle('on-link', !!link);
    view.scroller.title = link ? (link.url || 'Vai alla pagina indicata dal link') : '';
  }

  hit(view, p, x, y, tol) {
    const list = view.annots.filter((a) => a.page === p.i);
    for (let i = list.length - 1; i >= 0; i -= 1) if (hits(list[i], p, x, y, tol)) return list[i];
    return null;
  }

  // --- Puntatore virtuale: punto rosso netto e scia breve e sottile; niente viene scritto nel PDF ---
  // Si usano tutti i movimenti intermedi (più precisione) e si ridisegna solo la zona toccata (meno lavoro).
  laserMove(view, e) {
    const box = view.scroller.getBoundingClientRect();
    this.trail = this.trail || [];
    const evs = e.getCoalescedEvents?.() || [];
    const now = performance.now();
    // Nella scia, se si riprende dopo una pausa, la traccia ricomincia (non si unisce al tratto vecchio).
    const last = this.trail[this.trail.length - 1];
    if (last && (now - last.t > 400 || e.type === 'pointerdown')) this.trail.push({ x: NaN, y: NaN, t: now });
    // Nella scia si traccia solo tenendo premuto (penna appoggiata, dito, tasto del mouse); altrimenti si muove solo il punto.
    const drawing = this.app.laserPrefs?.().mode !== 'trail' || e.buttons > 0 || e.type === 'pointerdown';
    const pts = (evs.length ? evs : [e]).map((c) => ({ x: c.clientX - box.left, y: c.clientY - box.top, t: now }));
    if (drawing) this.trail.push(...pts);
    this.laserHead = pts[pts.length - 1];
    if (this.laserView !== view) {
      this.laserView = view;
      view.scroller.addEventListener('pointerleave', () => { if (this.tool === 'laser') this.laserOff(); });
    }
    if (!this.laserRaf) this.laserRaf = requestAnimationFrame(() => this.laserFrame(view));
  }

  laserFrame(view) {
    // Impostazioni: «Scia» (si disegna e la traccia svanisce) o «Punto»; colore, grandezza, durata, bagliore.
    const L = this.app.laserPrefs ? this.app.laserPrefs() : { mode: 'point', color: '#d61820', size: 2, fade: 1.2, glow: false };
    const trailMode = L.mode === 'trail';
    const LIFE = trailMode ? Math.max(300, L.fade * 1000) : 220; // millisecondi di scia
    const R = [3.5, 3.5, 4.5, 6.5][L.size] || 4.5; // raggio del punto
    const W = trailMode ? ([2, 2, 3.5, 6][L.size] || 3.5) : 2; // spessore della scia
    const HOLD = 1500; // il punto resta fermo così a lungo dopo l'ultimo movimento, poi sparisce
    const now = performance.now();
    if (this.laserHead && now - this.laserHead.t > HOLD) this.laserHead = null;
    this.trail = (this.trail || []).filter((p) => now - p.t < LIFE);
    const c = view.live.getContext('2d', { desynchronized: true });
    const dpr = devicePixelRatio;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.laserDirty) { const d = this.laserDirty; c.clearRect(d[0], d[1], d[2] - d[0], d[3] - d[1]); this.laserDirty = null; }
    this.laserRaf = 0;
    const head = this.laserHead;
    if (!head || this.tool !== 'laser') return;
    const col = /^#[0-9a-f]{6}$/i.test(L.color) ? L.color : '#d61820';
    const rgb = [1, 3, 5].map((i) => parseInt(col.slice(i, i + 2), 16)).join(',');
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (L.glow) { c.shadowColor = `rgba(${rgb},.6)`; c.shadowBlur = trailMode ? 8 : 6; }
    let x0 = head.x; let y0 = head.y; let x1 = head.x; let y1 = head.y;
    for (let i = 1; i < this.trail.length; i += 1) {
      const a = this.trail[i - 1]; const b = this.trail[i];
      const k = 1 - (now - b.t) / LIFE;
      // Nella scia la traccia resta piena quasi fino alla fine, poi si spegne.
      c.strokeStyle = `rgba(${rgb},${trailMode ? Math.min(1, k * 2.5) * 0.9 : k * 0.55})`;
      c.lineWidth = W;
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
    for (const p of this.trail) if (!Number.isNaN(p.x)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    // Il punto resta fermo dove si è fermato il puntatore; la scia si spegne da sola.
    c.fillStyle = col; c.strokeStyle = col === '#ffffff' ? '#333' : '#fff'; c.lineWidth = 1.2;
    c.beginPath(); c.arc(head.x, head.y, R, 0, Math.PI * 2); c.fill();
    c.shadowBlur = 0; c.stroke();
    const m = R + W + (L.glow ? 12 : 3);
    this.laserDirty = [x0 - m, y0 - m, x1 + m, y1 + m];
    if (this.trail.length) this.laserRaf = requestAnimationFrame(() => this.laserFrame(view));
    else { clearTimeout(this.laserHoldT); this.laserHoldT = setTimeout(() => { if (!this.laserRaf) this.laserRaf = requestAnimationFrame(() => this.laserFrame(view)); }, HOLD - (now - head.t) + 20); }
  }

  // --- Penna ----------------------------------------------------------------
  inkStart(view, p, e) {
    const c = view.live.getContext('2d', { desynchronized: true });
    const box = view.scroller.getBoundingClientRect();
    const { prefs } = this.app;
    const pressure = e.pointerType === 'pen';
    this.app.inkText?.hold(view, p);
    Object.assign(this.act, { c, box, pts: [], pressure, last: null, color: prefs.color, size: prefs.size });
    c.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    c.strokeStyle = prefs.color; c.lineCap = 'round'; c.lineJoin = 'round';
    this.inkPoint(view, e);
  }

  inkPoint(view, e) {
    const a = this.act;
    const [x, y] = this.local(a.p, e);
    const pr = a.pressure ? (e.pressure || 0.5) : 0.5;
    const u = toUser(a.p, x, y);
    a.pts.push([+u[0].toFixed(2), +u[1].toFixed(2), +pr.toFixed(3)]);
    const sx = e.clientX - a.box.left; const sy = e.clientY - a.box.top;
    if (a.last) {
      a.c.lineWidth = a.size * view.s * (a.pressure ? 0.42 + pr * 0.9 : 1);
      a.c.beginPath(); a.c.moveTo(a.last[0], a.last[1]); a.c.lineTo(sx, sy); a.c.stroke();
    }
    a.last = [sx, sy];
  }

  inkMove(view, e) {
    const evs = e.getCoalescedEvents?.() || [];
    if (evs.length) evs.forEach((c) => this.inkPoint(view, c)); else this.inkPoint(view, e);
  }

  inkEnd(view, act) {
    if (!act.pts.length) return;
    const pts = act.pts.length === 1 ? [act.pts[0], [act.pts[0][0] + 0.3, act.pts[0][1] + 0.3, act.pts[0][2]]] : act.pts;
    const ink = { id: uid(), type: 'ink', page: act.p.i, color: act.color, size: act.size, pressure: act.pressure, pts };
    this.apply(view, { add: [ink] });
    this.app.inkText?.added(view, ink);
  }

  clearLive(view) {
    const c = view.live.getContext('2d', { desynchronized: true });
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, view.live.width, view.live.height);
  }

  eraseAt(view, p, x, y) {
    const a = this.hit(view, p, x, y, 6);
    if (!a) return;
    this.act.removed.push(a);
    this.apply(view, { remove: [a] }, false);
  }

  // --- Forme ----------------------------------------------------------------
  shapePreview(view, act, e) {
    const c = view.live.getContext('2d', { desynchronized: true });
    const dpr = devicePixelRatio;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, view.live.width, view.live.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const box = view.scroller.getBoundingClientRect();
    const x0 = act.e0.clientX - box.left; const y0 = act.e0.clientY - box.top;
    const x1 = e.clientX - box.left; const y1 = e.clientY - box.top;
    c.strokeStyle = act.tool === 'redact' ? '#c62828' : this.app.prefs.color; c.lineWidth = act.tool === 'redact' ? 1.5 : this.app.prefs.size * view.s;
    if (act.tool === 'field') {
      c.strokeStyle = '#2b6cb0'; c.lineWidth = 1.2; c.setLineDash([5, 3]);
      c.fillStyle = 'rgba(43,108,176,.10)'; c.fillRect(x0, y0, x1 - x0, y1 - y0); c.strokeRect(x0, y0, x1 - x0, y1 - y0); c.setLineDash([]);
      return;
    }
    if (act.tool === 'measure') {
      c.strokeStyle = this.calibrating ? '#b5541c' : this.app.prefs.color; c.lineWidth = Math.max(1, this.app.prefs.size * view.s * 0.6);
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      const len = Math.hypot(x1 - x0, y1 - y0) / view.s;
      const label = this.calibrating ? 'misura nota' : lengthLabel(this.app, this.ptLen(act.p, act.e0, e, view));
      c.font = '600 13px Arial'; c.lineWidth = 4; c.strokeStyle = '#fff'; c.fillStyle = '#1f2a44';
      const mx = (x0 + x1) / 2; const my = (y0 + y1) / 2 - 8;
      if (len > 2) { c.strokeText(label, mx + 6, my); c.fillText(label, mx + 6, my); }
      return;
    }
    c.beginPath();
    if (act.tool === 'redact') { c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(x0, y0, x1 - x0, y1 - y0); c.rect(x0, y0, x1 - x0, y1 - y0); } else if (act.tool === 'rect') c.rect(x0, y0, x1 - x0, y1 - y0);
    else if (act.tool === 'ellipse') c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, 7);
    else { c.moveTo(x0, y0); c.lineTo(x1, y1); }
    c.stroke();
  }

  // Lunghezza in punti del PDF fra due eventi del puntatore (sulla stessa pagina).
  ptLen(p, e0, e1) {
    const a = toUser(p, ...this.local(p, e0)); const b = toUser(p, ...this.local(p, e1));
    return dist(a, b);
  }

  async shapeEnd(view, act, x, y) {
    const p = act.p;
    if (act.tool === 'field') {
      // Campo del modulo: un tocco senza trascinare mette un campo della misura solita.
      const kind = this.fieldKind || 'text';
      const [dw, dh] = FIELD_KINDS[kind].size;
      const [x0, y0, x1, y1] = act.moved ? [Math.min(act.x, x), Math.min(act.y, y), Math.max(act.x, x), Math.max(act.y, y)] : [x, y - dh / 2, x + dw, y + dh / 2];
      const a = { id: uid(), type: 'field', page: p.i, kind, name: nextName(view, kind), a: toUser(p, x0, y0), b: toUser(p, x1, y1) };
      const props = await fieldDialog(a);
      if (!props) return;
      this.apply(view, { add: [{ ...a, ...props }] });
      return;
    }
    if (!act.moved) return;
    if (act.tool === 'measure') {
      const a = toUser(p, act.x, act.y); const b = toUser(p, x, y);
      if (this.calibrating) { this.clearLive(view); await finishCalibration(this.app, dist(a, b)); return; }
      this.apply(view, { add: [{ id: uid(), type: 'measure', page: p.i, color: this.app.prefs.color, size: Math.max(1, Math.min(2, this.app.prefs.size)), a, b, label: lengthLabel(this.app, dist(a, b)) }] });
      return;
    }
    if (act.tool === 'redact') {
      // Zona da oscurare: quadrilatero in coordinate PDF (si applica poi con «Applica gli oscuramenti»).
      const [x0, y0, x1, y1] = [Math.min(act.x, x), Math.min(act.y, y), Math.max(act.x, x), Math.max(act.y, y)];
      const pt = (a, b) => toUser(p, a, b);
      this.apply(view, { add: [{ id: uid(), type: 'redact', page: p.i, quads: [[...pt(x0, y0), ...pt(x1, y0), ...pt(x0, y1), ...pt(x1, y1)]], text: '' }] });
      return;
    }
    this.apply(view, { add: [{ id: uid(), type: act.tool, page: p.i, color: this.app.prefs.color, size: this.app.prefs.size, a: toUser(p, act.x, act.y), b: toUser(p, x, y) }] });
  }

  // --- Misura di un'area: vertici toccati uno alla volta -------------------------
  areaPoint(view, p, x, y, e) {
    const u = toUser(p, x, y);
    const ar = this.area;
    if (ar && ar.p !== p) { this.area = null; }
    if (!this.area) { this.area = { view, p, pts: [u], last: 0 }; this.areaDraw(view, null); return; }
    const pts = this.area.pts;
    const first = toDisp(p, ...pts[0]);
    const now = performance.now();
    const double = now - this.area.last < 350;
    this.area.last = now;
    // Chiusura: tocco vicino al primo punto o doppio tocco.
    if ((pts.length >= 3 && Math.hypot(first[0] - x, first[1] - y) * view.s < 14) || (double && pts.length >= 3)) { this.areaFinish(view); return; }
    if (!double) pts.push(u);
    this.areaDraw(view, null);
    void e;
  }

  areaPreview(view, e) {
    const ar = this.area;
    if (!ar || ar.view !== view) return;
    this.areaDraw(view, toUser(ar.p, ...this.local(ar.p, e)));
  }

  areaDraw(view, extra) {
    const ar = this.area;
    if (!ar) return;
    const c = view.live.getContext('2d', { desynchronized: true });
    const dpr = devicePixelRatio;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, view.live.width, view.live.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const box = view.scroller.getBoundingClientRect(); const pr = ar.p.el.getBoundingClientRect();
    const scr = (u) => { const d = toDisp(ar.p, ...u); return [pr.left - box.left + (d[0] / ar.p.w) * pr.width, pr.top - box.top + (d[1] / ar.p.h) * pr.height]; };
    const pts = extra ? [...ar.pts, extra] : ar.pts;
    c.strokeStyle = this.app.prefs.color; c.fillStyle = 'rgba(29,63,143,.12)'; c.lineWidth = 1.6;
    c.beginPath(); pts.forEach((u, i) => { const [sx, sy] = scr(u); if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy); });
    if (pts.length > 2) c.closePath();
    c.fill(); c.stroke();
    for (const u of ar.pts) { const [sx, sy] = scr(u); c.beginPath(); c.arc(sx, sy, 3.5, 0, 7); c.fillStyle = this.app.prefs.color; c.fill(); }
    if (pts.length > 2) {
      const label = areaLabel(this.app, polygonArea(pts));
      const [sx, sy] = scr(pts[pts.length - 1]);
      c.font = '600 13px Arial'; c.lineWidth = 4; c.strokeStyle = '#fff'; c.fillStyle = '#1f2a44';
      c.strokeText(label, sx + 10, sy - 10); c.fillText(label, sx + 10, sy - 10);
    }
  }

  areaFinish(view) {
    const ar = this.area;
    this.area = null;
    this.clearLive(view);
    if (!ar || ar.pts.length < 3) return false;
    this.apply(view, { add: [{ id: uid(), type: 'area', page: ar.p.i, color: this.app.prefs.color, size: 1.2, pts: ar.pts, label: areaLabel(this.app, polygonArea(ar.pts)) }] });
    this.app.syncToolbar();
    return true;
  }

  areaCancel(view) { if (!this.area) return false; this.area = null; this.clearLive(view); return true; }

  // --- Selezione del testo ----------------------------------------------------
  async markStart(view, p, x, y) {
    const act = this.act;
    act.text = await pageText(view, p.i);
    const u = toUser(p, x, y);
    act.w0 = nearestWord(act.text.words, u[0], u[1], 26);
    if (act.w1 === undefined) act.w1 = act.w0;
    this.paintSel(view, act);
  }

  markMove(view, act, x, y) {
    if (!act.text) return;
    const u = toUser(act.p, x, y);
    if (act.w0 < 0) {
      act.w0 = nearestWord(act.text.words, u[0], u[1], 26);
      if (act.w0 < 0) { this.rectPreview(view, act, x, y); return; }
    }
    const w = nearestWord(act.text.words, u[0], u[1], 60);
    if (w >= 0) act.w1 = w;
    this.paintSel(view, act);
  }

  rectPreview(view, act, x, y) {
    act.area = [act.x, act.y, x, y];
    const r = [Math.min(act.x, x), Math.min(act.y, y), Math.abs(x - act.x), Math.abs(y - act.y)];
    this.selLayer(act.p).innerHTML = `<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" fill="#2b6cb0" fill-opacity=".25"/>`;
  }

  selLayer(p) {
    if (!p.selSvg) {
      p.selSvg = document.createElementNS(SVGNS, 'svg');
      p.selSvg.setAttribute('class', 'sel-layer');
      p.selSvg.setAttribute('preserveAspectRatio', 'none');
      p.el.append(p.selSvg);
    }
    p.selSvg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
    return p.selSvg;
  }

  selWords(act) {
    if (act.w0 === undefined || act.w0 < 0 || act.w1 === undefined || act.w1 < 0) return [];
    const [a, b] = act.w0 < act.w1 ? [act.w0, act.w1] : [act.w1, act.w0];
    return act.text.words.slice(a, b + 1);
  }

  paintSel(view, act) {
    const quads = mergeQuads(this.selWords(act));
    this.selLayer(act.p).innerHTML = quads.map((q) => {
      const { tl, tr, bl, br } = quadDisp(act.p, q);
      return `<polygon points="${tl} ${tr} ${br} ${bl}" fill="#2b6cb0" fill-opacity=".28"/>`;
    }).join('');
  }

  clearSelLayer(p) { if (p?.selSvg) p.selSvg.innerHTML = ''; }

  markEnd(view, act, x, y) {
    this.clearSelLayer(act.p);
    const words = act.text ? this.selWords(act) : [];
    const { prefs } = this.app;
    const color = act.tool === 'hl' ? prefs.hlColor : prefs.color;
    if (words.length) {
      this.apply(view, { add: [{ id: uid(), type: act.tool, page: act.p.i, color, quads: mergeQuads(words), text: words.map((w) => w.str).join(' ') }] });
    } else if (act.area && act.tool === 'hl') {
      const [x0, y0, x1, y1] = [Math.min(act.x, x), Math.min(act.y, y), Math.max(act.x, x), Math.max(act.y, y)];
      const pt = (a, b) => toUser(act.p, a, b);
      this.apply(view, { add: [{ id: uid(), type: 'hl', page: act.p.i, color, quads: [[...pt(x0, y0), ...pt(x1, y0), ...pt(x0, y1), ...pt(x1, y1)]], text: '' }] });
    }
  }

  // --- Strumento selezione -----------------------------------------------------
  selectDown(view, p, x, y) {
    const act = this.act;
    this.clearTextSel();
    const hit = this.hit(view, p, x, y, 6);
    if (hit) {
      this.select(view, hit);
      act.target = hit;
      return;
    }
    this.deselect();
    pageText(view, p.i).then((t) => {
      if (this.act !== act) return;
      act.text = t;
      const u = toUser(p, x, y);
      act.w0 = nearestWord(t.words, u[0], u[1], 26);
      act.w1 = act.w0;
    });
  }

  selectMove(view, act, x, y) {
    if (act.target) {
      const u0 = toUser(act.p, act.x, act.y); const u1 = toUser(act.p, x, y);
      act.preview = translated(act.target, u1[0] - u0[0], u1[1] - u0[1]);
      const list = view.annots;
      const i = list.findIndex((a) => a.id === act.target.id);
      if (i >= 0) list[i] = act.preview;
      this.draw(view, act.p.i);
      this.frame(view, act.preview);
      return;
    }
    if (act.text && act.w0 >= 0) {
      const u = toUser(act.p, x, y);
      const w = nearestWord(act.text.words, u[0], u[1], 60);
      if (w >= 0) act.w1 = w;
      this.paintSel(view, act);
    }
  }

  selectUp(view, act) {
    if (act.target) {
      if (act.preview && act.moved) {
        view.undoStack.push({ remove: [act.target], add: [act.preview] });
        view.redoStack.length = 0;
        this.app.markDirty(view);
        this.select(view, act.preview);
      } else if (act.preview) {
        const i = view.annots.findIndex((a) => a.id === act.target.id);
        view.annots[i] = act.target;
        this.draw(view, act.p.i);
      }
      if (act.target.type === 'text' && !act.moved) this.editText(view, act.p, act.target);
      if (act.target.type === 'note' && !act.moved) this.editNote(view, act.target);
      if (act.target.type === 'label' && !act.moved) this.editLabel(view, act.target);
      if (act.target.type === 'edit' && !act.moved) reEdit(this.app, view, act.target);
      return;
    }
    if (this.placeHook && !act.moved) { const fn = this.placeHook; this.placeHook = null; fn(view, act.p, act.x, act.y); return; }
    if (act.text && act.w0 >= 0 && act.moved) this.showTextBar(view, act);
    else if (!act.moved && act.e0?.pointerType !== 'pen') this.linkTap(view, act.p, act.x, act.y);
  }

  showTextBar(view, act) {
    const words = this.selWords(act);
    if (!words.length) return;
    const text = words.map((w) => w.str).join(' ');
    const q = words[0].quad;
    const d = toDisp(act.p, q[0], q[1]);
    const make = (type) => () => {
      const { prefs } = this.app;
      if (!this.guardEdit(view)) return;
      this.apply(view, { add: [{ id: uid(), type, page: act.p.i, color: type === 'hl' ? prefs.hlColor : prefs.color, quads: mergeQuads(words), text }] });
      this.clearTextSel();
      this.app.syncToolbar();
    };
    const bar = h('div', { class: 'an-ui minibar', style: `left:${(d[0] / act.p.w) * 100}%;top:${(d[1] / act.p.h) * 100}%` },
      h('button', { html: `${icon('copy')} Copia`, onclick: () => { navigator.clipboard.writeText(text); toast('Testo copiato'); this.clearTextSel(); } }),
      h('button', { html: `${icon('mark')} Evidenzia`, onclick: make('hl') }),
      h('button', { html: `${icon('under')} Sottolinea`, onclick: make('ul') }),
      h('button', { html: `${icon('strike')} Barra`, onclick: make('so') }),
      h('button', { class: 'redact-btn', html: `${icon('rect')} Oscura`, onclick: () => { if (!this.guardEdit(view)) return; this.apply(view, { add: [{ id: uid(), type: 'redact', page: act.p.i, quads: mergeQuads(words), text: '' }] }); this.clearTextSel(); toast('Zona da oscurare segnata. Per cancellarla davvero: menu Modifica PDF, «Applica gli oscuramenti».'); } }),
      h('button', { class: 'edit-btn', html: `${icon('text')} Sostituisci`, onclick: () => { this.clearTextSel(); startEdit(this.app, view, act.p, words, 'replace'); } }),
      h('button', { class: 'add-btn', html: `${icon('text')} Aggiungi dopo`, onclick: () => { this.clearTextSel(); startEdit(this.app, view, act.p, words, 'add'); } }),
      h('button', { class: 'para-btn', html: `${icon('edit')} Paragrafo`, title: 'Riscrivi tutto il paragrafo: le righe vanno a capo da sole', onclick: () => { this.clearTextSel(); import('./pro/paragraph.js').then((m) => m.editParagraph(this.app, view, act.p, words)); } }));
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    act.p.el.append(bar);
    this.textSel = { p: act.p, bar, text, words, view };
  }

  clearTextSel() {
    if (!this.textSel) return;
    this.textSel.bar.remove();
    this.clearSelLayer(this.textSel.p);
    this.textSel = null;
  }

  select(view, a) {
    this.deselect();
    this.selected = { view, id: a.id };
    this.frame(view, a);
    this.app.syncToolbar();
  }

  frame(view, a) {
    const p = view.pages[a.page];
    const b = bbox(a, p);
    if (!this.selEl) {
      this.selEl = h('div', { class: 'an-ui sel-frame' });
      this.selEl.addEventListener('pointerdown', (e) => this.frameDown(e));
    }
    if (this.selEl.parentElement !== p.el) {
      this.selEl.textContent = '';
      const del = h('button', { title: 'Elimina', 'aria-label': 'Elimina', html: icon('trash'), onclick: () => this.deleteSelected() });
      const bar = h('div', { class: 'frame-bar' }, del);
      if (a.type === 'edit') bar.append(h('button', { title: 'Modifica', 'aria-label': 'Modifica', html: icon('edit'), onclick: () => reEdit(this.app, view, this.current()) }));
      if (a.type === 'label') bar.append(h('button', { title: 'Modifica', 'aria-label': 'Modifica', html: icon('edit'), onclick: () => this.editLabel(view, this.current()) }));
      if (a.type === 'text' || a.type === 'note') bar.append(h('button', { title: 'Modifica', 'aria-label': 'Modifica', html: icon('edit'), onclick: () => (a.type === 'text' ? this.editText(view, p, this.current()) : this.editNote(view, this.current())) }));
      this.selEl.append(bar);
      if (a.type === 'field') bar.append(h('button', { title: 'Proprietà del campo', 'aria-label': 'Proprietà del campo', html: icon('edit'), onclick: async () => { const cur = this.current(); const props = cur && await fieldDialog(cur); if (props) this.apply(view, { remove: [cur], add: [{ ...cur, ...props }] }); } }));
      if (['rect', 'ellipse', 'text', 'label', 'stamp', 'sig', 'image', 'field'].includes(a.type)) this.selEl.append(h('span', { class: 'handle' }));
      p.el.append(this.selEl);
    }
    Object.assign(this.selEl.style, { left: `${(b[0] / p.w) * 100}%`, top: `${(b[1] / p.h) * 100}%`, width: `${((b[2] - b[0]) / p.w) * 100}%`, height: `${((b[3] - b[1]) / p.h) * 100}%` });
  }

  current() {
    if (!this.selected) return null;
    return this.selected.view.annots.find((a) => a.id === this.selected.id);
  }

  deselect() {
    this.selEl?.remove();
    this.selected = null;
  }

  deleteSelected() {
    const a = this.current();
    if (!a) return;
    const { view } = this.selected;
    this.deselect();
    this.apply(view, { remove: [a] });
    this.app.syncToolbar();
  }

  // Maniglia in basso a destra per ridimensionare.
  frameDown(e) {
    if (e.target.closest('button')) return;
    e.stopPropagation();
    const a = this.current();
    if (!a) return;
    const { view } = this.selected;
    const p = view.pages[a.page];
    if (!e.target.classList.contains('handle')) {
      // Trascina il riquadro: stesso comportamento dello strumento selezione.
      const [x, y] = this.local(p, e);
      this.act = { tool: 'select', p, x, y, target: a, e0: e, moved: false };
    }
    const el = e.target;
    el.setPointerCapture(e.pointerId);
    const orig = a;
    const r0 = dispRect(p, a);
    let cur = a;
    const mv = (ev) => {
      if (this.act) { this.move(view, ev); return; }
      const [x, y] = this.local(p, ev);
      const nx = Math.max(r0[0] + 16, x);
      let ny = Math.max(r0[1] + 12, y);
      if (a.type === 'sig' || a.type === 'stamp' || a.type === 'image' || a.type === 'label') ny = r0[1] + (r0[3] - r0[1]) * ((nx - r0[0]) / (r0[2] - r0[0]));
      cur = { ...JSON.parse(JSON.stringify(orig)), a: toUser(p, r0[0], r0[1]), b: toUser(p, nx, ny) };
      const i = view.annots.findIndex((t) => t.id === a.id);
      view.annots[i] = cur;
      this.draw(view, p.i);
      this.frame(view, cur);
    };
    const end = (ev) => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      if (this.act) { this.up(view, ev); return; }
      if (cur !== orig) {
        view.undoStack.push({ remove: [orig], add: [cur] });
        view.redoStack.length = 0;
        this.app.markDirty(view);
        this.app.syncToolbar();
      }
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // --- Elementi da posizionare ---------------------------------------------------
  place(view, p, x, y) {
    const { prefs } = this.app;
    if (this.tool === 'text') {
      const fontSize = 12;
      const a = { id: uid(), type: 'text', page: p.i, color: prefs.color, fontSize, text: '', a: toUser(p, x, y), b: toUser(p, Math.min(p.w, x + 220), y + 40) };
      this.editText(view, p, a, true);
    } else if (this.tool === 'note') {
      const a = { id: uid(), type: 'note', page: p.i, color: '#d9a400', text: '', a: toUser(p, x - 11, y - 10) };
      this.editNote(view, a, true);
    } else if (this.tool === 'label') {
      this.editLabel(view, { id: uid(), type: 'label', page: p.i, color: prefs.color, text: '', at: [x, y] }, true);
    } else if (this.tool === 'stamp') {
      if (!this.stamp) { this.app.openStampMenu(); return; }
      const w = Math.max(110, this.stamp.label.length * 11.5); const hg = 36;
      this.apply(view, { add: [{ id: uid(), type: 'stamp', page: p.i, label: this.stamp.label, color: this.stamp.color, a: toUser(p, x - w / 2, y - hg / 2), b: toUser(p, x + w / 2, y + hg / 2) }] });
    } else if (this.tool === 'sig') {
      if (!this.signature) { this.app.openSignMenu(); return; }
      const s = this.signature;
      const hg = 50; const w = hg * (s.ratio || 2.6);
      this.apply(view, { add: [{ id: uid(), type: 'sig', page: p.i, color: s.color || '#14213d', strokes: s.strokes, png: s.png, a: toUser(p, x - w / 2, y - hg / 2), b: toUser(p, x + w / 2, y + hg / 2) }] });
    }
    this.app.syncToolbar();
  }

  editText(view, p, a, isNew = false) {
    this.commitEditor();
    const r = dispRect(p, a);
    const ta = h('textarea', { class: 'an-ui text-editor', 'aria-label': 'Testo della casella', style: `left:${(r[0] / p.w) * 100}%;top:${(r[1] / p.h) * 100}%;width:${((r[2] - r[0]) / p.w) * 100}%;height:${((r[3] - r[1]) / p.h) * 100}%;font-size:${a.fontSize * view.s}px;color:${a.color}` });
    ta.value = a.text;
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.commitEditor(); });
    p.el.append(ta);
    if (!isNew) { const g = p.svg?.querySelector(`[data-id="${a.id}"]`); if (g) g.style.visibility = 'hidden'; }
    this.editor = {
      el: ta,
      commit: () => {
        const text = ta.value.replace(/\s+$/, '');
        ta.remove();
        this.editor = null;
        if (!text) { if (!isNew) this.apply(view, { remove: [a] }); else this.draw(view, p.i); return; }
        if (text === a.text) { this.draw(view, p.i); return; }
        const [x0, y0, x1] = r;
        const lines = wrapLines(text, a.fontSize, x1 - x0).length;
        const n = { ...a, text, b: toUser(p, x1, y0 + Math.max(lines * a.fontSize * 1.2 + 6, 20)) };
        n.a = toUser(p, x0, y0);
        this.apply(view, isNew ? { add: [n] } : { remove: [a], add: [n] });
        this.app.syncToolbar();
      },
    };
    requestAnimationFrame(() => ta.focus({ preventScroll: true }));
  }

  editNote(view, a, isNew = false) {
    this.commitEditor();
    const p = view.pages[a.page];
    const [x, y] = toDisp(p, ...a.a);
    const ta = h('textarea', { placeholder: 'Scrivi la nota…', 'aria-label': 'Testo della nota' });
    ta.value = a.text;
    const box = h('div', { class: 'an-ui note-pop', style: `left:${(x / p.w) * 100}%;top:calc(${(y / p.h) * 100}% + 26px)` }, ta);
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.commitEditor(); });
    p.el.append(box);
    this.editor = {
      el: box,
      commit: () => {
        const text = ta.value.trim();
        box.remove();
        this.editor = null;
        if (isNew) { if (text) this.apply(view, { add: [{ ...a, text }] }); } else if (text !== a.text) {
          this.deselect();
          this.apply(view, { remove: [a], add: [{ ...a, text }] });
        }
        this.app.syncToolbar();
      },
    };
    requestAnimationFrame(() => ta.focus({ preventScroll: true }));
  }

  // 0.9.4: etichetta. Si scrive in una riga; la larghezza segue il testo. Nuova: centrata dove si è toccato.
  editLabel(view, a, isNew = false) {
    this.commitEditor();
    const p = view.pages[a.page];
    const HG = 22;
    const r = isNew ? [a.at[0] - 60, a.at[1] - HG / 2, a.at[0] + 60, a.at[1] + HG / 2] : dispRect(p, a);
    const inp = h('input', { type: 'text', class: 'label-input', maxlength: '80', placeholder: 'Testo dell\'etichetta…', 'aria-label': 'Testo dell\'etichetta' });
    inp.value = a.text || '';
    const box = h('div', { class: 'an-ui note-pop label-pop', style: `left:${(r[0] / p.w) * 100}%;top:calc(${(r[3] / p.h) * 100}% + 6px)` }, inp);
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); this.commitEditor(); } });
    p.el.append(box);
    this.editor = {
      el: box,
      commit: () => {
        const text = inp.value.trim().replace(/\s+/g, ' ');
        box.remove();
        this.editor = null;
        if (text && (isNew || text !== a.text)) {
          const hg = r[3] - r[1]; const w = labelWidth(text, hg);
          const left = isNew ? a.at[0] - w / 2 : r[0];
          const n = { id: a.id, type: 'label', page: a.page, color: a.color, text, a: toUser(p, left, r[1]), b: toUser(p, left + w, r[1] + hg) };
          if (isNew) this.apply(view, { add: [n] });
          else { this.deselect(); this.apply(view, { remove: [a], add: [n] }); }
        }
        this.app.syncToolbar();
      },
    };
    requestAnimationFrame(() => inp.focus({ preventScroll: true }));
  }

  // 0.9.4: etichette e note si accendono quando la penna (o il mouse) passa sopra senza toccare;
  // la nota mostra anche il suo testo. Nessuna modifica al documento.
  glow(view, e) {
    const p = this.pageAt(view, e.clientX, e.clientY);
    let a = null;
    if (p?.vp) {
      const [x, y] = this.local(p, e);
      const list = view.annots.filter((q) => q.page === p.i && (q.type === 'label' || q.type === 'note'));
      for (let i = list.length - 1; i >= 0 && !a; i -= 1) if (hits(list[i], p, x, y, 6)) a = list[i];
    }
    if (a && a.id === this.lit?.id && this.lit.el?.isConnected) return;
    if (!a && !this.lit) return;
    this.unglow();
    if (!a) return;
    const el = p.svg?.querySelector(`[data-id="${a.id}"]`);
    el?.classList.add('lit');
    let peek = null;
    if (a.type === 'note' && a.text) {
      const [nx, ny] = toDisp(p, ...a.a);
      peek = h('div', { class: 'an-ui note-peek', style: `left:${(nx / p.w) * 100}%;top:calc(${(ny / p.h) * 100}% + 26px)` }, a.text);
      p.el.append(peek);
    }
    this.lit = { id: a.id, el, peek };
  }

  unglow() {
    if (!this.lit) return;
    this.lit.el?.classList.remove('lit');
    this.lit.peek?.remove();
    this.lit = null;
  }

  commitEditor() { this.editor?.commit(); }
}
