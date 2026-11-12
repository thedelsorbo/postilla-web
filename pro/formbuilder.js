// Creazione di moduli compilabili (0.9.0): si disegnano i campi sulla pagina (testo, testo su più righe, data,
// casella di spunta, elenco a discesa, firma digitale). Finché il documento non si salva sono riquadri
// modificabili; al salvataggio diventano campi veri del PDF (AcroForm), compilabili con qualunque programma.
// I campi «Firma» restano vuoti: chi riceve il PDF ci firma con il proprio certificato (anche con Postilla).
import { h, modal } from '../core.js';

const { PDFName, PDFHexString, rgb } = window.PDFLib;

export const FIELD_KINDS = {
  text: { label: 'Testo', prefix: 'testo', size: [180, 20] },
  multiline: { label: 'Testo su più righe', prefix: 'testo', size: [260, 60] },
  date: { label: 'Data', prefix: 'data', size: [100, 20] },
  check: { label: 'Casella di spunta', prefix: 'spunta', size: [14, 14] },
  choice: { label: 'Elenco a discesa', prefix: 'elenco', size: [160, 20] },
  sig: { label: 'Firma digitale', prefix: 'firma', size: [190, 54] },
};

// Nome valido e unico per un campo (niente punti: in PDF separano i livelli dei nomi).
export const cleanName = (s) => String(s || '').normalize('NFC').replace(/[.\u0000-\u001f]/g, '_').trim().slice(0, 60);

export function nextName(view, kind) {
  const pre = FIELD_KINDS[kind]?.prefix || 'campo';
  const used = new Set((view.annots || []).filter((a) => a.type === 'field').map((a) => a.name));
  let n = 1;
  while (used.has(`${pre}_${n}`)) n += 1;
  return `${pre}_${n}`;
}

// Proprietà di un campo: nome, suggerimento per chi compila, voci dell'elenco, obbligatorio.
export function fieldDialog(a) {
  return modal((box, done) => {
    const k = FIELD_KINDS[a.kind];
    const name = h('input', { type: 'text', value: a.name || '', 'aria-label': 'Nome del campo' });
    const tip = h('input', { type: 'text', value: a.tip || '', placeholder: a.kind === 'date' ? 'Per esempio: gg/mm/aaaa' : 'Facoltativo', 'aria-label': 'Suggerimento' });
    const opts = h('textarea', { rows: '4', 'aria-label': 'Voci dell\'elenco', placeholder: 'Una voce per riga' }, (a.options || []).join('\n'));
    const req = h('input', { type: 'checkbox' }); req.checked = !!a.required;
    for (const el of [name, tip, opts]) el.addEventListener('keydown', (e) => e.stopPropagation());
    box.append(h('h2', {}, `Campo: ${k.label}`),
      h('label', { class: 'pro-field' }, h('span', {}, 'Nome'), name),
      h('label', { class: 'pro-field' }, h('span', {}, 'Suggerimento'), tip),
      a.kind === 'choice' ? h('label', { class: 'pro-field' }, h('span', {}, 'Voci'), opts) : '',
      a.kind !== 'sig' ? h('label', { class: 'pro-check' }, req, ' Obbligatorio') : h('p', { class: 'hint' }, 'Chi riceve il PDF firma in questo riquadro con il proprio certificato digitale.'),
      h('p', { class: 'hint' }, 'Il campo diventa compilabile quando salvi il documento.'),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'),
        h('button', { class: 'primary', onclick: () => done({ name: cleanName(name.value) || a.name, tip: tip.value.trim(), options: opts.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), required: req.checked }) }, 'OK')));
  });
}

// Riquadro di un campo in coordinate del PDF.
const rectOf = (a) => {
  const x = Math.min(a.a[0], a.b[0]); const y = Math.min(a.a[1], a.b[1]);
  return { x, y, width: Math.max(6, Math.abs(a.b[0] - a.a[0])), height: Math.max(6, Math.abs(a.b[1] - a.a[1])) };
};

// Campo firma vuoto (pdf-lib non ne crea): widget con aspetto «Firma qui», da riempire con un certificato.
function addSigField(pdf, page, name, r, font) {
  const ctx = pdf.context;
  const label = 'Firma qui';
  const fs = Math.max(6, Math.min(10, r.height * 0.28));
  const tw = font.widthOfTextAtSize(label, fs);
  const ap = ctx.register(ctx.stream(`q 0.45 0.5 0.6 RG 0.8 w [3 2] 0 d 0.5 0.5 ${r.width - 1} ${r.height - 1} re S Q BT /F1 ${fs} Tf 0.45 0.5 0.6 rg ${((r.width - tw) / 2).toFixed(2)} ${(4).toFixed(2)} Td ${font.encodeText(label)} Tj ET`,
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, r.width, r.height], Resources: { Font: { F1: font.ref } } }));
  const ref = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFHexString.fromText(name), F: 4, P: page.ref, Rect: [r.x, r.y, r.x + r.width, r.y + r.height], AP: { N: ap }, MK: { BC: [0.45, 0.5, 0.6] } }));
  page.node.addAnnot(ref);
  pdf.getForm().acroForm.addField(ref);
  return ref;
}

// Crea i campi veri nel PDF (chiamata da buildPdf). Restituisce i nomi usati.
export function createFields(pdf, pages, list, font) {
  if (!list.length) return [];
  const form = pdf.getForm();
  const taken = new Set(form.getFields().map((f) => f.getName()));
  const out = [];
  for (const a of list) {
    const page = pages[a.page];
    if (!page) continue;
    let name = cleanName(a.name) || 'campo';
    const base = name; let k = 2;
    while (taken.has(name)) { name = `${base}_${k}`; k += 1; }
    taken.add(name);
    const r = rectOf(a);
    const look = { ...r, borderColor: rgb(0.45, 0.5, 0.6), borderWidth: 0.8, backgroundColor: rgb(0.96, 0.97, 1) };
    let field = null;
    if (a.kind === 'sig') { addSigField(pdf, page, name, r, font); out.push(name); continue; }
    if (a.kind === 'check') {
      field = form.createCheckBox(name);
      field.addToPage(page, { ...look, backgroundColor: rgb(1, 1, 1) });
    } else if (a.kind === 'choice') {
      field = form.createDropdown(name);
      if (a.options?.length) field.addOptions(a.options);
      field.addToPage(page, { ...look, font });
      field.setFontSize(Math.max(6, Math.min(11, r.height * 0.6))); // dopo addToPage: prima il campo non ha /DA
    } else {
      field = form.createTextField(name);
      if (a.kind === 'multiline') field.enableMultiline();
      field.addToPage(page, { ...look, font });
      field.setFontSize(a.kind === 'multiline' ? 10 : Math.max(6, Math.min(11, r.height * 0.62)));
    }
    if (a.required) field.enableRequired();
    if (a.tip) field.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(a.tip));
    out.push(name);
  }
  return out;
}

// Scelta del tipo di campo, poi si disegna il riquadro sulla pagina (o si tocca dove metterlo).
export async function startFieldTool(app) {
  const kind = await modal((box, done) => {
    box.append(h('h2', {}, 'Crea un modulo: quale campo?'),
      h('p', { class: 'hint' }, 'Poi disegna il riquadro sulla pagina, oppure tocca dove metterlo. Puoi aggiungere quanti campi vuoi; al salvataggio diventano compilabili.'),
      h('div', { class: 'field-kinds' }, ...Object.entries(FIELD_KINDS).map(([k, f]) => h('button', { 'data-kind': k, onclick: () => done(k) }, f.label))),
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla')));
  });
  if (!kind) return false;
  app.tools.fieldKind = kind;
  app.tools.set('field');
  return true;
}
