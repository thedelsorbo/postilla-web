// Campi compilabili dei moduli PDF: si modificano direttamente sulla pagina e il valore vero del campo
// viene scritto al salvataggio (sempre in una copia, come le annotazioni).
// Attivi con gli strumenti Seleziona e Mano; con la penna si continua a scrivere sopra la pagina.
import { h } from './core.js';

// Campi di una pagina letti da PDF.js, in coordinate della pagina a scala 1.
export function pageFields(view, i) {
  view.fieldCache = view.fieldCache || new Map();
  if (!view.fieldCache.has(i)) {
    view.fieldCache.set(i, (async () => {
      const pg = await view.getPage(i);
      const p = view.pages[i];
      const list = await pg.getAnnotations({ intent: 'display' });
      return list.filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden && ['Tx', 'Btn', 'Ch'].includes(a.fieldType) && !a.pushButton).map((a) => {
        const [x0, y0] = p.vp.convertToViewportPoint(a.rect[0], a.rect[1]);
        const [x1, y1] = p.vp.convertToViewportPoint(a.rect[2], a.rect[3]);
        return {
          id: a.id, page: i, name: a.fieldName, type: a.fieldType, value: a.fieldValue,
          box: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
          readOnly: !!a.readOnly, multiLine: !!a.multiLine, maxLen: a.maxLen || 0, comb: !!a.comb,
          checkBox: !!a.checkBox, radio: !!a.radioButton, exportValue: a.exportValue ?? a.buttonValue ?? 'Yes', buttonValue: a.buttonValue,
          options: a.options || [], combo: !!a.combo, multiSelect: !!a.multiSelect,
          align: ['left', 'center', 'right'][a.textAlignment || 0], fontSize: a.defaultAppearanceData?.fontSize || 0,
          label: a.alternativeText || '',
        };
      });
    })().catch(() => []));
  }
  return view.fieldCache.get(i);
}

// Valore corrente di un campo: quello modificato in Postilla, altrimenti quello del file.
export const fieldValue = (view, f) => (view.formEdits?.has(f.name) ? view.formEdits.get(f.name) : f.value);

export function setField(app, view, name, value) {
  view.formEdits = view.formEdits || new Map();
  view.formEdits.set(name, value);
  app.markDirty(view);
  // Altri riquadri dello stesso campo (stesso nome) si aggiornano.
  for (const el of view.pagesEl.querySelectorAll('.pdf-field')) if (el.dataset.name === name && el !== document.activeElement) syncEl(view, el);
}

function syncEl(view, el) {
  const f = el.field;
  const v = fieldValue(view, f);
  if (f.type === 'Btn' && f.radio) el.checked = v === f.buttonValue;
  else if (f.type === 'Btn') el.checked = !!v && v !== 'Off';
  else if (f.type === 'Ch' && f.multiSelect) { const set = new Set([].concat(v || [])); for (const o of el.options) o.selected = set.has(o.value); } else el.value = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

// Disegna (una volta) i campi sopra la pagina.
export async function renderFields(app, view, i) {
  const p = view.pages[i];
  if (!p || p.formLayer?.isConnected) return;
  const fields = await pageFields(view, i);
  if (!fields.length || p.formLayer?.isConnected || view.pages[i] !== p) return;
  const layer = h('div', { class: 'form-layer' });
  const pct = (v, tot) => `${(v / tot) * 100}%`;
  for (const f of fields) {
    if (f.readOnly) continue; // i campi bloccati li disegna già la pagina: niente da modificare
    const [x0, y0, x1, y1] = f.box;
    let el;
    if (f.type === 'Tx') {
      el = f.multiLine ? h('textarea', {}) : h('input', { type: 'text' });
      if (f.maxLen) el.maxLength = f.maxLen;
      el.addEventListener('input', () => setField(app, view, f.name, el.value));
    } else if (f.type === 'Btn') {
      el = h('input', { type: f.radio ? 'radio' : 'checkbox' });
      el.addEventListener('change', () => setField(app, view, f.name, f.radio ? f.buttonValue : (el.checked ? f.exportValue : 'Off')));
    } else {
      el = h('select', {}, f.options.map((o) => h('option', { value: o.exportValue }, o.displayValue ?? o.exportValue)));
      if (f.multiSelect) el.multiple = true; else if (!f.combo) el.size = Math.max(2, Math.min(f.options.length, 4));
      el.addEventListener('change', () => setField(app, view, f.name, f.multiSelect ? [...el.selectedOptions].map((o) => o.value) : el.value));
    }
    el.addEventListener('focus', () => { el.before = fieldValue(view, f); });
    el.addEventListener('change', () => {
      const after = fieldValue(view, f);
      if (JSON.stringify(el.before ?? f.value) !== JSON.stringify(after)) app.onFieldChanged?.(view, f, el.before ?? f.value, after);
      el.before = after;
    });
    el.classList.add('pdf-field');
    el.field = f;
    el.dataset.name = f.name;
    el.title = f.label || f.name;
    el.setAttribute('aria-label', f.label || f.name);
    el.disabled = view.readonly;
    const size = f.fontSize || Math.max(6, Math.min(14, (y1 - y0) * (f.multiLine ? 0.25 : 0.62)));
    el.style.cssText = `left:${pct(x0, p.w)};top:${pct(y0, p.h)};width:${pct(x1 - x0, p.w)};height:${pct(y1 - y0, p.h)};font-size:calc(var(--s) * ${size.toFixed(2)}px);text-align:${f.align}`;
    syncEl(view, el);
    layer.append(el);
  }
  p.formLayer = layer;
  p.el.append(layer);
}

// Elenco di tutti i campi del documento (per il pannello e per i comandi di Claudia).
export async function allFields(view) {
  const out = [];
  for (let i = 0; i < view.pages.length; i += 1) for (const f of await pageFields(view, i)) out.push({ ...f, page: i, current: fieldValue(view, f) });
  return out;
}

// --- Scrittura nel PDF (pdf-lib), chiamata dal salvataggio ---
export async function applyFormEdits(pdf, edits, font) {
  if (!edits?.size) return [];
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = window.PDFLib;
  const form = pdf.getForm();
  const problems = [];
  for (const [name, value] of edits) {
    const field = form.getFieldMaybe(name);
    if (!field) { problems.push(name); continue; }
    try {
      if (field instanceof PDFTextField) field.setText(String(value ?? ''));
      else if (field instanceof PDFCheckBox) { if (value && value !== 'Off') field.check(); else field.uncheck(); } else if (field instanceof PDFRadioGroup) { if (value && value !== 'Off') field.select(String(value)); else field.clear(); } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const v = [].concat(value ?? []).map(String);
        if (v.length) field.select(v.length === 1 ? v[0] : v); else field.clear();
      }
      field.defaultUpdateAppearances(font);
    } catch (e) { console.error(e); problems.push(name); }
  }
  return problems;
}
