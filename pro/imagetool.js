// Immagini: inserire un'immagine (logo, timbro, foto) e modificare quelle già presenti nella pagina
// (spostare, ridimensionare, sostituire, eliminare). Le modifiche alle immagini esistenti cambiano il
// contenuto della pagina e si salvano in una copia; Ctrl+Z le annulla finché non si salva.
import { h, icon, toast, uid } from '../core.js';
import { toUser, toDisp } from '../annots.js';
import { logEntry } from '../thirdparty.js';
import { listPageImages, transformImage, processPage } from './content.js';

const { PDFDocument } = window.PDFLib;

const readAsDataUrl = (file) => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(file); });

// Riduce le immagini enormi (oltre 2500 px) per non appesantire il PDF; JPEG resta JPEG, il resto diventa PNG.
async function prepare(file) {
  const bmp = await createImageBitmap(file);
  const jpeg = /jpe?g/i.test(file.type);
  const k = Math.min(1, 2500 / Math.max(bmp.width, bmp.height));
  if (k === 1 && /^image\/(png|jpe?g)$/i.test(file.type)) return { src: await readAsDataUrl(file), w: bmp.width, h: bmp.height };
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return { src: cv.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.9), w: cv.width, h: cv.height };
}

async function pickImage() {
  // 0.9.0: selettore di Postilla (sul tablet la pagina non può aprire quello del sistema).
  if (window.host?.pickFiles) {
    const { pickImages } = await import('./create.js');
    const [it] = await pickImages(false);
    return it ? new File([it.bytes], it.name, { type: it.mime }) : null;
  }
  return new Promise((ok) => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    input.addEventListener('change', () => { ok(input.files[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

// Inserisce un'immagine al centro della pagina corrente, larga circa il 40% della pagina; poi si sposta e si
// ridimensiona con lo strumento Seleziona come le altre annotazioni.
export async function insertImage(app, view, file) {
  if (!app.tools.guardEdit(view)) return null;
  file = file || await pickImage();
  if (!file) return null;
  let img;
  try { img = await prepare(file); } catch { toast('Non riesco a leggere questa immagine.', 'error'); return null; }
  const p = view.pages[view.current];
  await view.getPage(p.i);
  const w = p.w * 0.4; const hg = w * (img.h / img.w);
  const cx = p.w / 2; const cy = p.h / 2;
  const a = { id: uid(), type: 'image', page: p.i, src: img.src, a: toUser(p, cx - w / 2, cy - hg / 2), b: toUser(p, cx + w / 2, cy + hg / 2) };
  app.tools.apply(view, { add: [a] });
  app.tools.set('select');
  app.tools.select(view, a);
  toast('Immagine inserita: trascinala per spostarla, usa l\'angolo per ridimensionarla.');
  return a;
}

// --- Modifica delle immagini già presenti nella pagina ---------------------------------------------
export class PageImages {
  constructor(app) { this.app = app; this.layer = null; }

  async open(view) {
    const app = this.app;
    if (!app.tools.guardEdit(view)) return;
    this.close();
    this.view = view;
    const i = view.current;
    const p = view.pages[i];
    await view.getPage(i);
    const doc = await PDFDocument.load(await view.ensureBytes(), { updateMetadata: false });
    const list = await listPageImages(doc, i);
    if (!list.length) { toast('In questa pagina non ci sono immagini da modificare.'); return; }
    this.page = p;
    this.layer = h('div', { class: 'an-ui img-layer' });
    this.layer.addEventListener('pointerdown', (e) => e.stopPropagation());
    for (const im of list) this.layer.append(this.box(view, p, im));
    this.layer.append(h('div', { class: 'img-help' }, `Immagini di pagina ${i + 1}: tocca un'immagine per sceglierla, poi trascinala o usa l'angolo. `, h('button', { onclick: () => this.close() }, 'Fine')));
    p.el.append(this.layer);
    toast(`${list.length} ${list.length === 1 ? 'immagine' : 'immagini'} in questa pagina.`);
  }

  close() { this.layer?.remove(); this.layer = null; }

  box(view, p, im) {
    const disp = im.corners.map(([x, y]) => toDisp(p, x, y));
    const xs = disp.map((d) => d[0]); const ys = disp.map((d) => d[1]);
    const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const el = h('div', { class: 'img-box', style: this.css(p, r), title: `Immagine ${im.width}×${im.height} pixel` });
    const bar = h('div', { class: 'frame-bar' },
      h('button', { title: 'Elimina l\'immagine', 'aria-label': 'Elimina l\'immagine', html: icon('trash'), onclick: (e) => { e.stopPropagation(); this.commit(view, im, null, 'eliminata'); } }),
      h('button', { title: 'Sostituisci con un\'altra immagine', 'aria-label': 'Sostituisci', html: icon('edit'), onclick: (e) => { e.stopPropagation(); this.replace(view, im, r); } }));
    const handle = h('span', { class: 'handle' });
    el.append(bar, handle);
    let start = null; let cur = r;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.stopPropagation();
      this.layer.querySelectorAll('.img-box').forEach((b) => b.classList.toggle('on', b === el));
      el.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, r: [...cur], resize: e.target === handle };
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const k = p.w / p.el.getBoundingClientRect().width;
      const dx = (e.clientX - start.x) * k; const dy = (e.clientY - start.y) * k;
      if (start.resize) {
        const w0 = start.r[2] - start.r[0]; const h0 = start.r[3] - start.r[1];
        const w1 = Math.max(12, w0 + dx);
        cur = [start.r[0], start.r[1], start.r[0] + w1, start.r[1] + h0 * (w1 / w0)];
      } else cur = [start.r[0] + dx, start.r[1] + dy, start.r[2] + dx, start.r[3] + dy];
      Object.assign(el.style, this.cssObj(p, cur));
    });
    const end = () => {
      if (!start) return;
      const moved = cur.some((v, k) => Math.abs(v - start.r[k]) > 0.5);
      start = null;
      if (!moved) return;
      // Riquadro nuovo in coordinate PDF.
      const a = toUser(p, cur[0], cur[3]); const b = toUser(p, cur[2], cur[1]);
      this.commit(view, im, [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], 'spostata o ridimensionata');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return el;
  }

  css(p, r) { const o = this.cssObj(p, r); return Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';'); }

  cssObj(p, r) { return { left: `${(r[0] / p.w) * 100}%`, top: `${(r[1] / p.h) * 100}%`, width: `${((r[2] - r[0]) / p.w) * 100}%`, height: `${((r[3] - r[1]) / p.h) * 100}%` }; }

  async commit(view, im, box, what) {
    const app = this.app;
    const i = this.page.i;
    this.close();
    await app.pageOp(view, async (bytes) => {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      await transformImage(doc, i, im.index, box);
      return doc.save({ useObjectStreams: false });
    }, (p) => p);
    logEntry(app, view, { kind: 'immagine', page: i, before: '', after: `Immagine ${what}` });
    toast(`Immagine ${what}. Ctrl+Z per annullare.`);
    this.open(view);
  }

  async replace(view, im, r) {
    const file = await pickImage();
    if (!file) return;
    const app = this.app;
    const i = this.page.i;
    let img;
    try { img = await prepare(file); } catch { toast('Non riesco a leggere questa immagine.', 'error'); return; }
    this.close();
    await app.pageOp(view, async (bytes) => {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const raw = Uint8Array.from(atob(img.src.slice(img.src.indexOf(',') + 1)), (c) => c.charCodeAt(0));
      const emb = /^data:image\/jpe?g/i.test(img.src) ? await doc.embedJpg(raw) : await doc.embedPng(raw);
      await processPage(doc, i, {
        image: (info) => (info.index === im.index ? { replaceName: info.ctx.addXObject(info.ctx.resFor(info), emb.ref) } : 'keep'),
      });
      return doc.save({ useObjectStreams: false });
    }, (p) => p);
    void r;
    logEntry(app, view, { kind: 'immagine', page: i, before: '', after: 'Immagine sostituita' });
    toast('Immagine sostituita. Ctrl+Z per annullare.');
    this.open(view);
  }
}
