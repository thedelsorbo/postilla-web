// Crea un PDF da immagini (foto di documenti, scansioni) o direttamente dallo scanner (0.9.0).
// Sul PC lo scanner è quello di Windows (WIA); sul tablet lo scanner di documenti di Google con la fotocamera,
// che trova da solo i bordi del foglio e lo raddrizza. Le pagine si possono riordinare, ruotare e togliere;
// «Migliora per documenti» rende il foglio più bianco e il testo più nero. Tutto resta sul dispositivo.
import { h, toast, modal, baseName, icon } from '../core.js';

const { PDFDocument } = window.PDFLib;
const MM = 72 / 25.4;
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
const MAX_SIDE = 3500; // pixel: oltre, l'immagine si riduce (resta nitida anche stampata in A4 a 300 dpi)
const mimeOf = (p) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[String(p).split('.').pop().toLowerCase()] || 'application/octet-stream');

// Byte di un'immagine scelta con il selettore del sistema.
export async function readImage(path, H = window.host) {
  const { data } = await H.readFile(path);
  return { name: baseName(path), path, bytes: new Uint8Array(data), mime: mimeOf(path) };
}

// Sceglie una o più immagini: selettore di Postilla se c'è (PC e tablet), altrimenti quello della pagina.
export async function pickImages(multi = true, H = window.host) {
  if (H.pickFiles) {
    const paths = await H.pickFiles({ title: 'Scegli le immagini', name: 'Immagini', exts: IMAGE_EXTS, mimes: IMAGE_MIMES, multi });
    const out = [];
    for (const p of paths || []) { try { out.push(await readImage(p, H)); } catch { toast(`Non riesco a leggere ${baseName(p)}.`, 'error'); } }
    return out;
  }
  return new Promise((ok) => {
    const input = h('input', { type: 'file', accept: IMAGE_MIMES.join(','), multiple: multi, hidden: true });
    input.addEventListener('change', async () => { const files = [...(input.files || [])]; input.remove(); ok(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type })))); });
    document.body.append(input);
    input.click();
  });
}

// «Migliora per documenti»: scala di grigi e contrasto automatico (il 2% più chiaro diventa bianco,
// il 2% più scuro nero), come le app di scansione.
function enhance(ctx, w, hgt) {
  const img = ctx.getImageData(0, 0, w, hgt);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; d[i] = y; hist[y | 0] += 1; }
  const total = w * hgt; let acc = 0; let lo = 0; let hi = 255;
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v -= 1) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
  if (hi - lo < 40) { lo = Math.max(0, lo - 20); hi = Math.min(255, hi + 20); }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, (d[i] - lo) * k)); d[i] = v; d[i + 1] = v; d[i + 2] = v; }
  ctx.putImageData(img, 0, 0);
}

// Immagine pronta per il PDF: orientamento giusto (EXIF), rotazione scelta, dimensione ragionevole, JPEG
// (o PNG se l'originale è un PNG con trasparenza o disegni: lì il JPEG sporcherebbe i bordi).
export async function prepareImage(item, { rotate = 0, enhanceDoc = false } = {}) {
  const bmp = await createImageBitmap(new Blob([item.bytes], { type: item.mime }), { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w0 = Math.max(1, Math.round(bmp.width * k)); const h0 = Math.max(1, Math.round(bmp.height * k));
  const r = ((rotate % 360) + 360) % 360;
  const cv = document.createElement('canvas');
  cv.width = r % 180 ? h0 : w0; cv.height = r % 180 ? w0 : h0;
  const ctx = cv.getContext('2d', { willReadFrequently: enhanceDoc });
  const png = item.mime === 'image/png' && !enhanceDoc;
  if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(bmp, -w0 / 2, -h0 / 2, w0, h0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  bmp.close?.();
  if (enhanceDoc) enhance(ctx, cv.width, cv.height);
  const type = png ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((res) => cv.toBlob(res, type, 0.88));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const out = { bytes, png, w: cv.width, h: cv.height };
  cv.width = 0;
  return out;
}

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

// items: [{ bytes, mime, rotate }]; opts: { page: 'a4'|'letter'|'image', margin (mm), enhanceDoc, title }
export async function imagesToPdf(items, opts = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(opts.title || 'Documento');
  pdf.setCreator('Postilla');
  pdf.setProducer('Postilla');
  const margin = (opts.margin ?? 0) * MM;
  for (const it of items) {
    const im = await prepareImage(it, { rotate: it.rotate || 0, enhanceDoc: opts.enhanceDoc ?? it.enhance });
    const emb = im.png ? await pdf.embedPng(im.bytes) : await pdf.embedJpg(im.bytes);
    let W; let H;
    if (opts.page === 'image' || !SIZES[opts.page || 'a4']) {
      // Dimensione dell'immagine: 150 punti per pollice (una foto di un foglio A4 resta circa A4).
      W = (im.w * 72) / 150 + margin * 2; H = (im.h * 72) / 150 + margin * 2;
    } else {
      [W, H] = SIZES[opts.page || 'a4'];
      if (im.w > im.h) [W, H] = [H, W]; // immagine orizzontale: pagina orizzontale
    }
    const page = pdf.addPage([W, H]);
    const s = Math.min((W - margin * 2) / im.w, (H - margin * 2) / im.h);
    const w = im.w * s; const hh = im.h * s;
    page.drawImage(emb, { x: (W - w) / 2, y: (H - hh) / 2, width: w, height: hh });
  }
  return pdf.save({ useObjectStreams: false });
}

// --- Finestra «Crea PDF da immagini o scanner» ------------------------------------------------------
export async function createDialog(app, H = window.host) {
  const android = document.documentElement.classList.contains('android');
  const items = [];
  const result = await modal((box, done) => {
    box.classList.add('create-dialog');
    const list = h('div', { class: 'create-list', 'aria-live': 'polite' });
    const count = h('p', { class: 'hint create-count' });
    const page = h('select', {}, h('option', { value: 'a4', selected: true }, 'A4'), h('option', { value: 'letter' }, 'Lettera (USA)'), h('option', { value: 'image' }, 'Come l\'immagine'));
    const margin = h('select', {}, h('option', { value: '0', selected: true }, 'Nessuno'), h('option', { value: '10' }, 'Piccolo (1 cm)'), h('option', { value: '20' }, 'Normale (2 cm)'));
    const enhanceBox = h('input', { type: 'checkbox' });
    const ocrBox = h('input', { type: 'checkbox' }); ocrBox.checked = true;
    const create = h('button', { class: 'primary', disabled: true, onclick: () => done({ page: page.value, margin: +margin.value, enhanceDoc: enhanceBox.checked, ocr: ocrBox.checked }) }, 'Crea PDF');
    const paint = () => {
      list.textContent = '';
      items.forEach((it, k) => {
        const url = it.url || (it.url = URL.createObjectURL(new Blob([it.bytes], { type: it.mime })));
        const img = h('img', { src: url, alt: `Pagina ${k + 1}`, style: `transform: rotate(${it.rotate || 0}deg)` });
        list.append(h('div', { class: 'create-item', 'data-k': String(k) }, h('div', { class: 'create-thumb' }, img), h('span', { class: 'create-n' }, `${k + 1}`),
          h('div', { class: 'create-tools' },
            h('button', { title: 'Ruota', 'aria-label': `Ruota la pagina ${k + 1}`, html: icon('rotate'), onclick: () => { it.rotate = ((it.rotate || 0) + 90) % 360; paint(); } }),
            h('button', { title: 'Prima', 'aria-label': `Sposta prima la pagina ${k + 1}`, html: icon('up'), disabled: k === 0, onclick: () => { items.splice(k - 1, 0, items.splice(k, 1)[0]); paint(); } }),
            h('button', { title: 'Dopo', 'aria-label': `Sposta dopo la pagina ${k + 1}`, html: icon('down'), disabled: k === items.length - 1, onclick: () => { items.splice(k + 1, 0, items.splice(k, 1)[0]); paint(); } }),
            h('button', { title: 'Togli', 'aria-label': `Togli la pagina ${k + 1}`, html: icon('trash'), onclick: () => { URL.revokeObjectURL(it.url); items.splice(k, 1); paint(); } }))));
      });
      count.textContent = items.length ? `${items.length} ${items.length === 1 ? 'pagina' : 'pagine'}.` : 'Aggiungi le immagini o scansiona i fogli: ogni immagine diventa una pagina.';
      create.disabled = !items.length;
    };
    const addImages = async () => { for (const it of await pickImages(true, H)) items.push(it); paint(); };
    const scan = async () => {
      const r = H.scanImage ? await H.scanImage() : { error: 'nessuno' };
      if (r?.paths?.length) {
        for (const p of r.paths) { try { items.push({ ...(await readImage(p, H)), scanned: true }); } catch { /* immagine illeggibile */ } }
        // Le scansioni sono documenti: si propone di migliorarle.
        enhanceBox.checked = true;
        paint();
      } else if (r?.error === 'nessuno') toast(android ? 'Lo scanner di documenti non è disponibile: servono i servizi Google Play aggiornati.' : 'Non trovo uno scanner collegato al PC. Accendilo e controlla che Windows lo veda (Impostazioni → Stampanti e scanner).', 'error');
      else if (r?.error && r.error !== 'annullato') toast(`Scansione non riuscita: ${r.error}`, 'error');
    };
    box.append(h('h2', {}, 'Crea un PDF da immagini o scanner'),
      h('div', { class: 'create-add' },
        h('button', { class: 'create-images', html: `${icon('plus')} Aggiungi immagini…`, onclick: addImages }),
        h('button', { class: 'create-scan', html: `${icon('pages')} ${android ? 'Fotografa i fogli' : 'Scansiona un foglio'}`, onclick: scan })),
      count, list,
      h('label', { class: 'pro-field' }, h('span', {}, 'Formato pagina'), page),
      h('label', { class: 'pro-field' }, h('span', {}, 'Margine'), margin),
      h('label', { class: 'pro-check' }, enhanceBox, ' Migliora per documenti (foglio bianco, testo nero)'),
      h('label', { class: 'pro-check' }, ocrBox, ' Riconosci il testo dopo (OCR), così si può cercare e copiare'),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'), create));
    paint();
  });
  try {
    if (!result || !items.length) return null;
    const first = items.find((it) => it.path && !it.scanned)?.path;
    const stamp = new Date().toLocaleDateString('it-IT').replace(/\//g, '-');
    const name = items.length === 1 && !items[0].scanned ? items[0].name.replace(/\.[^.]+$/, '') : `Scansione ${stamp}`;
    const dir = first ? first.replace(/[\\/][^\\/]*$/, '') : (app.settings?.folders?.[0] || '');
    const suggested = dir ? `${dir}${dir.includes('\\') ? '\\' : '/'}${name}.pdf` : `${name}.pdf`;
    const dest = await H.pickSave(suggested);
    if (!dest) return null;
    toast('Creo il PDF…');
    const bytes = await imagesToPdf(items, { ...result, title: baseName(dest).replace(/\.pdf$/i, '') });
    await H.writeFile(dest, bytes);
    const tab = await app.open?.(dest);
    if (result.ocr && tab?.view && app.ocr) { await tab.view.ready; app.ocr.run(tab.view); }
    toast(`PDF creato: ${baseName(dest)} (${items.length} ${items.length === 1 ? 'pagina' : 'pagine'}).`);
    return dest;
  } catch (e) {
    console.error(e);
    toast(`Creazione del PDF non riuscita: ${e?.message || e}`, 'error');
    return null;
  } finally { items.forEach((it) => it.url && URL.revokeObjectURL(it.url)); }
}
