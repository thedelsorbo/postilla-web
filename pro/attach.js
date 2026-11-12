// Allegati dentro il PDF (0.9.0): elenco, salvataggio su disco, apertura dei PDF allegati, aggiunta di
// nuovi file ed eliminazione. Gli allegati non vengono mai eseguiti: si possono solo salvare (i PDF si aprono
// in Postilla). Le modifiche vanno in una copia del documento, come le altre.
import { h, modal, toast, ask, baseName, fmtSize, icon } from '../core.js';
import { logEntry } from '../thirdparty.js';

const L = () => window.PDFLib;
const N = (s) => L().PDFName.of(s);
const MIME = { pdf: 'application/pdf', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip', p7m: 'application/pkcs7-mime' };
const extOf = (n) => (String(n).match(/\.([a-z0-9]{1,6})$/i) || [, ''])[1].toLowerCase();

// Allegati del documento aperto (anche quelli appesi a una pagina con un'annotazione).
// Letti dal file con pdf-lib (PDF.js non consegna più il contenuto degli allegati).
export async function listAttachments(view) {
  return attachmentsOf(await view.ensureBytes());
}

export async function attachmentsOf(bytes) {
  const { PDFDocument, PDFDict, PDFArray, PDFRawStream, PDFStream, decodePDFRawStream } = L();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = [];
  const text = (v) => v?.decodeText?.() || '';
  const content = (spec) => {
    const ef = spec instanceof PDFDict ? spec.lookup(N('EF')) : null;
    const st = ef instanceof PDFDict ? (ef.lookup(N('UF')) || ef.lookup(N('F'))) : null;
    if (st instanceof PDFRawStream) { try { return decodePDFRawStream(st).decode(); } catch { return st.contents; } }
    if (st instanceof PDFStream) return st.getContents ? st.getContents() : null;
    return null;
  };
  const names = doc.catalog.lookup(N('Names'));
  const ef = names instanceof PDFDict ? names.lookup(N('EmbeddedFiles')) : null;
  const walk = (node) => {
    if (!(node instanceof PDFDict)) return;
    const arr = node.lookup(N('Names'));
    if (arr instanceof PDFArray) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        const key = text(arr.lookup(i)); const spec = arr.lookup(i + 1);
        const b = content(spec);
        if (b) out.push({ key, name: text(spec.lookup(N('UF'))) || text(spec.lookup(N('F'))) || key, bytes: b, description: text(spec.lookup(N('Desc'))), where: 'documento' });
      }
    }
    const kids = node.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i += 1) walk(kids.lookup(i));
  };
  walk(ef);
  doc.getPages().forEach((pg, i) => {
    const arr = pg.node.lookup(N('Annots'));
    if (!(arr instanceof PDFArray)) return;
    for (let k = 0; k < arr.size(); k += 1) {
      const a = arr.lookup(k);
      if (!(a instanceof PDFDict) || a.lookup(N('Subtype'))?.toString() !== '/FileAttachment') continue;
      const spec = a.lookup(N('FS')); const b = content(spec);
      if (b) out.push({ key: null, name: text(spec.lookup(N('UF'))) || text(spec.lookup(N('F'))) || 'allegato', bytes: b, description: text(spec.lookup(N('Desc'))), where: `pagina ${i + 1}` });
    }
  });
  return out;
}

export async function addAttachments(bytes, files) {
  const doc = await L().PDFDocument.load(bytes, { updateMetadata: false });
  const now = new Date();
  for (const f of files) await doc.attach(f.bytes, f.name, { mimeType: MIME[extOf(f.name)] || 'application/octet-stream', description: f.description || f.name, creationDate: now, modificationDate: now });
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

// Toglie un allegato del documento (per nome) dall'albero dei file incorporati.
export async function removeAttachment(bytes, name) {
  const { PDFDict, PDFArray } = L();
  const doc = await L().PDFDocument.load(bytes, { updateMetadata: false });
  const names = doc.catalog.lookup(N('Names'));
  const ef = names instanceof PDFDict ? names.lookup(N('EmbeddedFiles')) : null;
  let removed = 0;
  const walk = (node) => {
    if (!(node instanceof PDFDict)) return;
    const arr = node.lookup(N('Names'));
    if (arr instanceof PDFArray) {
      for (let i = arr.size() - 2; i >= 0; i -= 2) {
        const key = arr.lookup(i)?.decodeText?.();
        const spec = arr.lookup(i + 1);
        const fname = spec instanceof PDFDict ? (spec.lookup(N('UF'))?.decodeText?.() || spec.lookup(N('F'))?.decodeText?.()) : null;
        if (key === name || fname === name) { arr.remove(i + 1); arr.remove(i); removed += 1; }
      }
    }
    const kids = node.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i += 1) walk(kids.lookup(i));
  };
  walk(ef);
  // Anche dall'elenco /AF del PDF/A-3, se c'è.
  const af = doc.catalog.lookup(N('AF'));
  if (af instanceof PDFArray) {
    for (let i = af.size() - 1; i >= 0; i -= 1) { const s = af.lookup(i); const f = s instanceof PDFDict ? (s.lookup(N('UF'))?.decodeText?.() || s.lookup(N('F'))?.decodeText?.()) : null; if (f === name) af.remove(i); }
  }
  return { bytes: await doc.save({ useObjectStreams: false, updateFieldAppearances: false }), removed };
}

export async function attachmentsDialog(app, view, H = window.host) {
  view = view || app.view;
  if (!view) return;
  await view.ready;
  const list = await listAttachments(view);
  const action = await modal((box, done) => {
    box.classList.add('attach-dialog');
    const rows = list.length ? list.map((a, k) => h('div', { class: 'attach-row', 'data-name': a.name },
      h('span', { class: 'attach-name', title: a.description }, a.name), h('span', { class: 'hint' }, ` ${fmtSize(a.bytes?.length || 0)} · ${a.where}`),
      h('span', { class: 'attach-actions' },
        h('button', { class: 'attach-save', onclick: () => done({ kind: 'save', k }) }, 'Salva…'),
        extOf(a.name) === 'pdf' ? h('button', { class: 'attach-open', onclick: () => done({ kind: 'open', k }) }, 'Apri') : '',
        a.key ? h('button', { class: 'attach-del', title: 'Elimina dal PDF', 'aria-label': `Elimina ${a.name}`, html: icon('trash'), onclick: () => done({ kind: 'del', k }) }) : ''))) : [h('p', { class: 'hint' }, 'Questo PDF non ha allegati.')];
    box.append(h('h2', {}, 'Allegati del PDF'), ...rows,
      h('p', { class: 'hint' }, 'Gli allegati non vengono mai aperti con altri programmi da Postilla: puoi salvarli e controllarli prima di aprirli.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'attach-add', onclick: () => done({ kind: 'add' }) }, '+ Aggiungi file…'), h('button', { class: 'primary', onclick: () => done(null) }, 'Chiudi')));
  });
  if (!action) return;
  const a = list[action.k];
  try {
    if (action.kind === 'save') {
      const ext = extOf(a.name) || 'bin';
      const dir = view.tab.path.replace(/[\\/][^\\/]*$/, '');
      const dest = await (H.pickSaveAs ? H.pickSaveAs(`${dir}${dir.includes('\\') ? '\\' : '/'}${a.name}`, { ext, mime: MIME[ext] || 'application/octet-stream', name: 'Allegato', title: 'Salva l\'allegato' }) : H.pickSave(a.name));
      if (!dest) return;
      await H.writeFile(dest, a.bytes);
      toast(`Allegato salvato: ${baseName(dest)}`);
    } else if (action.kind === 'open') {
      const dest = await H.uniquePath(`${view.tab.path.replace(/\.pdf$/i, '')} - allegato ${a.name.replace(/\.pdf$/i, '')}.pdf`);
      await H.writeFile(dest, a.bytes);
      await app.open(dest);
      toast(`Allegato salvato accanto al documento e aperto: ${baseName(dest)}`);
    } else if (action.kind === 'del') {
      if (!app.tools.guardEdit(view)) return;
      if (await ask('Eliminare l\'allegato?', `«${a.name}» verrà tolto dalla copia del documento (l'originale non cambia).`, [{ label: 'Annulla', value: 'no' }, { label: 'Elimina', value: 'yes', primary: true }]) !== 'yes') return;
      await app.pageOp(view, async (b) => (await removeAttachment(b, a.key || a.name)).bytes, (p) => p);
      logEntry(app, view, { kind: 'allegato', page: 0, before: a.name, after: 'eliminato' });
      toast('Allegato eliminato. Si salva in una copia; Ctrl+Z per annullare.');
    } else if (action.kind === 'add') {
      if (!app.tools.guardEdit(view)) return;
      const paths = H.pickFiles ? await H.pickFiles({ title: 'Allega file al PDF', multi: true }) : [];
      if (!paths?.length) return;
      const files = [];
      for (const p of paths) files.push({ name: baseName(p), bytes: new Uint8Array((await H.readFile(p)).data) });
      await app.pageOp(view, (b) => addAttachments(b, files), (p) => p);
      logEntry(app, view, { kind: 'allegato', page: 0, before: '', after: `aggiunti: ${files.map((f) => f.name).join(', ')}` });
      toast(`${files.length === 1 ? 'Allegato aggiunto' : `${files.length} allegati aggiunti`}. Si salva in una copia.`);
    }
  } catch (e) {
    console.error(e);
    toast(`Operazione sugli allegati non riuscita: ${e?.message || e}`, 'error');
  }
}
