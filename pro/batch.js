// Operazioni su tanti PDF insieme (0.9.0): si scelgono i file (o una cartella), l'operazione e la cartella dove
// mettere i risultati. Gli originali non vengono mai toccati; i nomi esistenti non si sovrascrivono.
// Operazioni: comprimere, filigrana, numeri di pagina, numerazione Bates continua su tutti i file, password,
// PDF/A, esportazione in Word / Excel / testo / immagini, unione in un solo PDF.
import { h, modal, toast, ask, baseName } from '../core.js';
import { openPdf } from '../docview.js';
import { progressBar } from './word.js';

const sep = (dir) => (dir.includes('\\') ? '\\' : '/');
const join = (dir, name) => `${dir.replace(/[\\/]+$/, '')}${sep(dir)}${name}`;
const stem = (p) => baseName(p).replace(/\.pdf$/i, '');
const countPagesOf = async (bytes) => (await window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();

export const OPERATIONS = {
  compress: 'Comprimi (file più leggeri)',
  watermark: 'Filigrana',
  numbers: 'Numeri di pagina',
  bates: 'Numerazione Bates continua (atti, allegati)',
  protect: 'Proteggi con password',
  pdfa: 'Converti in PDF/A (archiviazione)',
  docx: 'Esporta in Word',
  xlsx: 'Esporta in Excel',
  txt: 'Esporta in testo',
  jpg: 'Esporta in immagini JPEG',
  merge: 'Unisci tutto in un solo PDF',
};

// Esegue l'operazione sui file; restituisce { done: [{src, out}], failed: [{src, why}], ... }.
export async function runBatch(files, op, opts, { outDir, H = window.host, onProgress, isCancelled } = {}) {
  const done = []; const failed = [];
  const unique = (name) => H.uniquePath(join(outDir, name));
  let bates = opts.start ?? 1;
  const merged = op === 'merge' ? await window.PDFLib.PDFDocument.create() : null;
  for (const [k, src] of files.entries()) {
    if (isCancelled?.()) throw new Error('annullato');
    onProgress?.(k / files.length, `${k + 1} di ${files.length}: ${baseName(src)}`);
    try {
      const bytes = new Uint8Array((await H.readFile(src)).data);
      const { isEncrypted } = await import('./crypt.js');
      if (isEncrypted(bytes)) throw new Error('protetto da password');
      let out = null; let name = null;
      if (op === 'compress') { const { compressPdf } = await import('./compress.js'); out = (await compressPdf(bytes, { level: opts.level || 'media' })).bytes; name = `${stem(src)} - compresso.pdf`; }
      else if (op === 'watermark') { const { stampPages } = await import('./pages.js'); out = await stampPages(bytes, { kind: 'watermark', text: opts.text || 'BOZZA', color: opts.color || '#c62828', opacity: 0.25, angle: 45, bold: true }); name = `${stem(src)} - filigrana.pdf`; }
      else if (op === 'numbers') { const { stampPages } = await import('./pages.js'); out = await stampPages(bytes, { kind: 'numbers', format: opts.format || 'Pagina {n} di {N}', position: 'bottom-center', size: 10, color: '#000000' }); name = `${stem(src)} - numerato.pdf`; }
      else if (op === 'bates') {
        // La numerazione continua da un file all'altro, nell'ordine scelto.
        const { stampPages } = await import('./pages.js');
        const n = await countPagesOf(bytes);
        const first = bates;
        out = await stampPages(bytes, { kind: 'bates', prefix: opts.prefix ?? 'DOC-', start: bates, digits: opts.digits || 6, position: opts.position || 'bottom-right', size: 9, color: '#000000' });
        bates += n;
        const fmt = (v) => `${opts.prefix ?? 'DOC-'}${String(v).padStart(opts.digits || 6, '0')}`;
        name = `${stem(src)} - ${fmt(first)}-${fmt(bates - 1)}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
      } else if (op === 'protect') { const { encryptPdf } = await import('./crypt.js'); out = await encryptPdf(bytes, { userPassword: opts.password, ownerPassword: opts.password }); name = `${stem(src)} - protetto.pdf`; }
      else if (op === 'pdfa') { const { convertToPdfA } = await import('./pdfa.js'); out = (await convertToPdfA(bytes, { title: stem(src) })).bytes; name = `${stem(src)} - PDFA.pdf`; }
      else if (op === 'merge') {
        const doc = await window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
        done.push({ src, out: null, pages: pages.length });
        continue;
      } else {
        const pdf = await openPdf(bytes);
        try {
          if (op === 'docx') { const { convertPdfToDocx } = await import('./word.js'); out = (await convertPdfToDocx(bytes.slice())).bytes; name = `${stem(src)}.docx`; }
          else if (op === 'xlsx') { const { pdfToXlsx } = await import('./export.js'); out = (await pdfToXlsx(pdf, { title: stem(src), bytes })).bytes; name = `${stem(src)}.xlsx`; }
          else if (op === 'txt') { const { pdfToText } = await import('./export.js'); out = (await pdfToText(pdf, { bytes })).bytes; name = `${stem(src)}.txt`; }
          else if (op === 'jpg') {
            const { pdfToImages } = await import('./export.js');
            const imgs = await pdfToImages(pdf, { dpi: opts.dpi || 150, jpeg: true });
            const written = [];
            for (const im of imgs) { const p = await unique(`${stem(src)} - pagina ${String(im.page + 1).padStart(3, '0')}.jpg`); await H.writeFile(p, im.bytes); written.push(p); }
            done.push({ src, out: written[0], count: written.length });
            continue;
          }
        } finally { pdf.loadingTask.destroy().catch(() => {}); }
      }
      const dest = await unique(name);
      await H.writeFile(dest, out);
      done.push({ src, out: dest });
    } catch (e) {
      if (e?.message === 'annullato') throw e;
      failed.push({ src, why: /protetto|password|encrypt/i.test(String(e?.message)) ? 'protetto da password' : (e?.message || String(e)).slice(0, 120) });
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  let mergedPath = null;
  if (merged && merged.getPageCount()) {
    merged.setTitle(opts.title || 'PDF uniti'); merged.setProducer('Postilla');
    mergedPath = await unique(`${(opts.title || 'PDF uniti').replace(/[\\/:*?"<>|]/g, '_')}.pdf`);
    await H.writeFile(mergedPath, await merged.save({ useObjectStreams: false }));
  }
  return { done, failed, mergedPath, nextBates: bates };
}

const field = (label, input) => h('label', { class: 'pro-field' }, h('span', {}, label), input);

export async function batchDialog(app, H = window.host) {
  let files = [];
  const setup = await modal((box, done) => {
    box.classList.add('batch-dialog');
    const list = h('div', { class: 'batch-files' });
    const op = h('select', { 'aria-label': 'Operazione' }, ...Object.entries(OPERATIONS).map(([k, l]) => h('option', { value: k }, l)));
    const inp = (attrs) => { const i = h('input', attrs); i.addEventListener('keydown', (e) => e.stopPropagation()); return i; };
    const level = h('select', {}, h('option', { value: 'leggera' }, 'Leggera'), h('option', { value: 'media', selected: true }, 'Media'), h('option', { value: 'forte' }, 'Forte'));
    const text = inp({ type: 'text', value: 'BOZZA' });
    const prefix = inp({ type: 'text', value: 'DOC-' });
    const start = inp({ type: 'number', value: '1', min: '0' });
    const pw = inp({ type: 'password', autocomplete: 'off' });
    const pw2 = inp({ type: 'password', autocomplete: 'off' });
    const title = inp({ type: 'text', value: 'PDF uniti' });
    const f = { level: field('Livello', level), text: field('Testo', text), prefix: field('Prefisso', prefix), start: field('Primo numero', start), pw: field('Password', pw), pw2: field('Ripeti la password', pw2), title: field('Nome del file', title) };
    const err = h('p', { class: 'hint batch-err', role: 'alert' });
    const sync = () => {
      const k = op.value;
      f.level.hidden = k !== 'compress'; f.text.hidden = k !== 'watermark'; f.prefix.hidden = k !== 'bates'; f.start.hidden = k !== 'bates';
      f.pw.hidden = k !== 'protect'; f.pw2.hidden = k !== 'protect'; f.title.hidden = k !== 'merge';
    };
    op.addEventListener('change', sync);
    const paint = () => {
      list.textContent = '';
      files.forEach((p, k) => list.append(h('div', { class: 'batch-file' }, h('span', {}, `${k + 1}. ${baseName(p)}`),
        h('button', { title: 'Su', 'aria-label': `Sposta su ${baseName(p)}`, disabled: k === 0, onclick: () => { files.splice(k - 1, 0, files.splice(k, 1)[0]); paint(); } }, '↑'),
        h('button', { title: 'Togli', 'aria-label': `Togli ${baseName(p)}`, onclick: () => { files.splice(k, 1); paint(); } }, '✕'))));
      if (!files.length) list.append(h('p', { class: 'hint' }, 'Nessun file scelto.'));
    };
    const addFiles = async () => { const got = await H.pickPdf(true); files = [...new Set([...files, ...(got || [])])]; paint(); };
    const addFolder = async () => {
      const dir = await H.pickFolder(); if (!dir) return;
      const found = await H.scanFolders([dir]);
      files = [...new Set([...files, ...found.map((x) => x.path).sort((a, b) => a.localeCompare(b, 'it'))])];
      paint();
    };
    box.append(h('h2', {}, 'Operazioni su più PDF insieme'),
      h('div', { class: 'create-add' }, h('button', { class: 'batch-add', onclick: addFiles }, '+ Aggiungi PDF…'), h('button', { class: 'batch-folder', onclick: addFolder }, '+ Tutta una cartella…')),
      list, field('Operazione', op), ...Object.values(f), err,
      h('p', { class: 'hint' }, 'I risultati vanno nella cartella che sceglierai; gli originali non cambiano.'),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'), h('button', {
        class: 'primary',
        onclick: () => {
          if (!files.length) { err.textContent = 'Aggiungi almeno un PDF.'; return; }
          if (op.value === 'protect' && (!pw.value || pw.value !== pw2.value)) { err.textContent = pw.value ? 'Le due password non sono uguali.' : 'Scrivi la password.'; return; }
          done({ op: op.value, opts: { level: level.value, text: text.value.trim() || 'BOZZA', prefix: prefix.value, start: +start.value || 0, password: pw.value, title: title.value.trim() || 'PDF uniti' } });
        },
      }, 'Continua')));
    sync(); paint();
  });
  if (!setup) return null;
  const outDir = await H.pickFolder();
  if (!outDir) return null;
  const job = { cancelled: false };
  const bar = progressBar(() => { job.cancelled = true; });
  try {
    const r = await runBatch(files, setup.op, setup.opts, { outDir, H, onProgress: (fr, m) => bar.set(m, fr), isCancelled: () => job.cancelled });
    bar.remove();
    const ok = setup.op === 'merge' ? (r.mergedPath ? `Creato ${baseName(r.mergedPath)} con ${r.done.length} PDF.` : 'Nessun PDF unito.') : `Fatto: ${r.done.length} file su ${files.length}.`;
    const bad = r.failed.length ? ` Non riusciti: ${r.failed.map((x) => `${baseName(x.src)} (${x.why})`).join('; ')}.` : '';
    const batesNote = setup.op === 'bates' && r.done.length ? ` Ultimo numero usato: ${setup.opts.prefix}${String(r.nextBates - 1).padStart(6, '0')}.` : '';
    const c = await ask('Operazione completata', ok + bad + batesNote, [{ label: 'Mostra nella cartella', value: 'reveal' }, { label: 'OK', value: 'ok', primary: true }]);
    if (c === 'reveal') H.reveal?.(r.mergedPath || r.done[0]?.out || outDir);
    return r;
  } catch (e) {
    if (e?.message === 'annullato') toast('Operazione interrotta: i file già fatti restano nella cartella.');
    else { console.error(e); toast(`Operazione non riuscita: ${e?.message || e}`, 'error'); }
    return null;
  } finally { bar.remove(); }
}
