// Esportazione del PDF in altri formati (0.9.0): Excel (.xlsx), PowerPoint (.pptx), immagini (PNG o JPEG)
// e testo semplice. Tutto nel renderer, quindi uguale sul PC e sul tablet; il PDF non viene modificato.
// - Excel: righe e colonne ricavate dalla posizione del testo (come per Word); i numeri scritti all'italiana
//   («1.234,56», «12%», «31/12/2026») diventano numeri e date veri, i codici (zeri iniziali, IBAN) restano testo.
// - PowerPoint: ogni pagina diventa una diapositiva (immagine nitida della pagina, annotazioni comprese).
// - Immagini: una per pagina, alla risoluzione scelta.
import { openPdf } from '../docview.js';
import { h, toast, ask, modal, baseName } from '../core.js';
import { buildPdf } from '../pdfio.js';
import { readPage, buildLines, makeTable, renderCanvas, canvasBytes, xmlEsc as esc, progressBar } from './word.js';
import { parseRange } from './pages.js';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const EMU = 12700;
const zip = (files) => window.fflate.zipSync(files, { level: 6 });
const u8 = (s) => window.fflate.strToU8(s);
const tick = () => new Promise((r) => setTimeout(r, 0));

export const FORMATS = {
  xlsx: { label: 'Excel (.xlsx)', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { label: 'PowerPoint (.pptx)', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  png: { label: 'Immagini PNG (una per pagina)', ext: 'png', mime: 'image/png' },
  jpg: { label: 'Immagini JPEG (una per pagina)', ext: 'jpg', mime: 'image/jpeg' },
  txt: { label: 'Testo semplice (.txt)', ext: 'txt', mime: 'text/plain' },
};

// Il documento da esportare: se ci sono annotazioni o modifiche, il PDF come si vede adesso (buildPdf).
async function sourceOf(view, withAnnots) {
  if (withAnnots && view.annots?.length) {
    const bytes = await buildPdf(view);
    return { pdf: await openPdf(bytes), bytes, own: true };
  }
  return { pdf: view.pdf, bytes: null, own: false };
}
const closeSrc = (src) => { if (src.own) src.pdf.loadingTask.destroy().catch(() => {}); };

// ---------------------------------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------------------------------
const colName = (n) => { let s = ''; for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s; return s; };
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

// Testo di una cella → { v: numero, s: stile } oppure { t: testo }.
export function cellValue(raw) {
  const t = String(raw || '').replace(/ /g, ' ').trim();
  if (!t) return null;
  // Date: 31/12/2026, 31.12.2026, 31-12-26.
  let m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (m) {
    const d = +m[1]; const mo = +m[2]; let y = +m[3]; if (y < 100) y += 2000;
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (mo >= 1 && mo <= 12 && d >= 1 && back.getUTCDate() === d && back.getUTCMonth() === mo - 1) return { v: (ms - EXCEL_EPOCH) / 86400000, s: 2 };
    return { t };
  }
  let s = t.replace(/^(EUR|USD|GBP|CHF|€|\$|£)\s*/i, '').replace(/\s*(EUR|USD|GBP|CHF|€|\$|£)$/i, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (/^[-−–]/.test(s)) { neg = !neg; s = s.replace(/^[-−–]\s*/, ''); }
  if (/^\+/.test(s)) s = s.slice(1).trim();
  if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1).trim(); } // «1.234,00-» (gestionali)
  let pct = false;
  if (/\s?%$/.test(s)) { pct = true; s = s.replace(/\s?%$/, ''); }
  s = s.replace(/(\d)[ '’](?=\d{3}(\D|$))/g, '$1'); // 1 234 567 o 1'234
  // Codici: zeri iniziali (00123), numeri lunghissimi (conti, IBAN): restano testo.
  if (/^0\d/.test(s) || s.replace(/\D/g, '').length > 15) return { t };
  let num = null; let dec = 0;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) { num = +s.replace(/\./g, '').replace(',', '.'); dec = (s.split(',')[1] || '').length; } // 1.234,56
  else if (/^\d+,\d+$/.test(s)) { num = +s.replace(',', '.'); dec = s.split(',')[1].length; } // 12,5
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) { num = +s.replace(/,/g, ''); dec = (s.split('.')[1] || '').length; } // 1,234.56
  else if (/^\d+\.\d+$/.test(s)) { num = +s; dec = s.split('.')[1].length; } // 12.5 (l'1.234 all'italiana è già sopra)
  else if (/^\d+$/.test(s)) num = +s;
  if (num == null || !Number.isFinite(num)) return { t };
  if (neg) num = -num;
  if (pct) return { v: num / 100, s: 3 };
  return { v: num, s: dec ? 1 : (Math.abs(num) >= 1000 ? 5 : 0) };
}

// Righe di una pagina: tabelle con le loro colonne, il resto del testo in colonna A.
function pageRows(page, { tablesOnly }) {
  const lines = buildLines(page.pieces);
  const rows = [];
  let i = 0; let tables = 0;
  const boldOf = (runs) => runs.length > 0 && runs.every((r) => r.bold || !r.text.trim());
  while (i < lines.length) {
    if (lines[i].segs.length >= 2) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].segs.length >= 2 && lines[j + 1].y - lines[j].y < 3.2 * lines[j].size) j += 1;
      const tbl = j > i ? makeTable(lines.slice(i, j + 1)) : null;
      if (tbl) {
        tables += 1;
        if (rows.length && !tablesOnly) rows.push(null); // riga vuota prima della tabella
        let grid = tbl.rows.map((r) => r.cells.map((c) => ({ text: c.runs.map((x) => x.text).join('').trim(), bold: boldOf(c.runs) })));
        // Intestazione allineata a sinistra e numeri allineati a destra finiscono in due colonne vicine che non
        // sono mai piene insieme: si uniscono in una sola.
        const cols = tbl.cols.map((c) => [...c]);
        for (let k = cols.length - 2; k >= 0; k -= 1) {
          const near = cols[k + 1][0] - cols[k][1] < 4 * tbl.size;
          const apart = grid.every((r) => !(r[k]?.text && r[k + 1]?.text));
          if (near && apart) {
            grid = grid.map((r) => { const c = [...r]; if (!c[k]?.text) c[k] = c[k + 1]; c.splice(k + 1, 1); return c; });
            cols[k][1] = cols[k + 1][1]; cols.splice(k + 1, 1);
          }
        }
        rows.push(...grid);
        rows.push(null);
        i = j + 1;
        continue;
      }
    }
    if (!tablesOnly) {
      // Riga normale: i pezzi lontani (es. «Totale ........ 1.234,00») vanno in colonne diverse.
      rows.push(lines[i].segs.map((sg) => ({ text: sg.text.trim(), bold: boldOf(sg.runs) })));
    }
    i += 1;
  }
  while (rows.length && rows[rows.length - 1] === null) rows.pop();
  return { rows, tables };
}

function sheetXml(rows) {
  const widths = [];
  const out = [];
  rows.forEach((r, ri) => {
    if (!r) return;
    const cells = [];
    r.forEach((c, ci) => {
      if (!c || !c.text) return;
      const ref = `${colName(ci)}${ri + 1}`;
      const val = cellValue(c.text);
      widths[ci] = Math.max(widths[ci] || 8, Math.min(60, c.text.length * 1.1 + 2));
      if (val && 'v' in val) cells.push(`<c r="${ref}" s="${c.bold && val.s === 0 ? 4 : val.s}"><v>${+val.v.toPrecision(15)}</v></c>`);
      else cells.push(`<c r="${ref}" t="inlineStr"${c.bold ? ' s="4"' : ''}><is><t xml:space="preserve">${esc(c.text)}</t></is></c>`);
    });
    if (cells.length) out.push(`<row r="${ri + 1}">${cells.join('')}</row>`);
  });
  const cols = widths.map((w, k) => (w ? `<col min="${k + 1}" max="${k + 1}" width="${w.toFixed(1)}" customWidth="1"/>` : '')).join('');
  return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${out.join('')}</sheetData></worksheet>`;
}

const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/><numFmt numFmtId="166" formatCode="0.00%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function sheetName(n, used) {
  let s = String(n).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Foglio';
  let k = 2; const base = s;
  while (used.has(s.toLowerCase())) { s = `${base.slice(0, 27)} (${k})`; k += 1; }
  used.add(s.toLowerCase());
  return s;
}

export function packageXlsx(sheets, title = '') {
  const used = new Set();
  const named = sheets.map((sh) => ({ ...sh, name: sheetName(sh.name, used) }));
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files = {
    '[Content_Types].xml': u8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((_s, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    '_rels/.rels': u8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'xl/workbook.xml': u8(`${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named.map((sh, k) => `<sheet name="${esc(sh.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': u8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_s, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('')}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': u8(STYLES),
    'docProps/core.xml': u8(`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Postilla</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`),
  };
  named.forEach((sh, k) => { files[`xl/worksheets/sheet${k + 1}.xml`] = u8(sheetXml(sh.rows.length ? sh.rows : [[{ text: '' }]])); });
  return zip(files);
}

// opts: { pages, perPage, tablesOnly, ocr, title, onProgress, isCancelled }
export async function pdfToXlsx(pdf, opts = {}) {
  const pages = opts.pages || [...Array(pdf.numPages).keys()];
  const state = { ocr: opts.ocr, fontCache: new Map(), libDoc: null, getBytes: async () => opts.bytes || null, noImages: true };
  const report = { pages: pages.length, tables: 0, scans: 0, rows: 0 };
  const sheets = [];
  let all = [];
  for (const [k, i] of pages.entries()) {
    if (opts.isCancelled?.()) throw new Error('annullato');
    opts.onProgress?.(k / pages.length, `Lettura della pagina ${i + 1}`);
    const page = await readPage(state, pdf, i);
    if (page.kind === 'scan') report.scans += 1;
    const { rows, tables } = pageRows(page, opts);
    report.tables += tables;
    report.rows += rows.filter(Boolean).length;
    if (opts.perPage) sheets.push({ name: `Pagina ${i + 1}`, rows });
    else { if (all.length && rows.length) all.push(null, null); all = all.concat(rows); }
    await tick();
  }
  if (!opts.perPage) sheets.push({ name: opts.title || 'Documento', rows: all });
  return { bytes: packageXlsx(sheets, opts.title), report };
}

// ---------------------------------------------------------------------------------------------------
// Immagini delle pagine (anche per PowerPoint)
// ---------------------------------------------------------------------------------------------------
async function pageImage(pdf, i, dpi, jpeg) {
  const pg = await pdf.getPage(i + 1);
  const vp = pg.getViewport({ scale: 1 });
  const max = window.POSTILLA_LIMITS?.canvas || 3.2e7;
  const scale = Math.min(dpi / 72, Math.sqrt(max / (vp.width * vp.height)));
  const canvas = await renderCanvas(pg, scale);
  // Sfondo bianco: in JPEG il trasparente diventerebbe nero.
  if (jpeg) {
    const c2 = document.createElement('canvas');
    c2.width = canvas.width; c2.height = canvas.height;
    const g = c2.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c2.width, c2.height); g.drawImage(canvas, 0, 0);
    canvas.width = 0;
    const out = await canvasBytes(c2, true);
    c2.width = 0; pg.cleanup();
    return { ...out, wPt: vp.width, hPt: vp.height };
  }
  const out = await canvasBytes(canvas, false);
  canvas.width = 0; pg.cleanup();
  return { ...out, wPt: vp.width, hPt: vp.height };
}

export async function pdfToImages(pdf, { pages, dpi = 150, jpeg = false, onProgress, isCancelled } = {}) {
  const list = pages || [...Array(pdf.numPages).keys()];
  const out = [];
  for (const [k, i] of list.entries()) {
    if (isCancelled?.()) throw new Error('annullato');
    onProgress?.(k / list.length, `Pagina ${i + 1}`);
    out.push({ page: i, ...(await pageImage(pdf, i, dpi, jpeg)) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------------------------------
const NSP = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const emptyTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Postilla"><a:themeElements><a:clrScheme name="Postilla"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="1D3F8F"/></a:accent1><a:accent2><a:srgbClr val="C62828"/></a:accent2><a:accent3><a:srgbClr val="1B7A4B"/></a:accent3><a:accent4><a:srgbClr val="B5541C"/></a:accent4><a:accent5><a:srgbClr val="5B4B8A"/></a:accent5><a:accent6><a:srgbClr val="2E7D9A"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Postilla"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Postilla"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

export function packagePptx(images, title = '') {
  // Dimensione delle diapositive: quella della prima pagina (limiti di PowerPoint: da 2,54 a 142 cm).
  const clampE = (v) => Math.max(914400, Math.min(51206400, Math.round(v)));
  const W = clampE((images[0]?.wPt || 842) * EMU); const H = clampE((images[0]?.hPt || 595) * EMU);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const n = images.length;
  const files = {};
  files['[Content_Types].xml'] = u8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>${images.map((_m, k) => `<Override PartName="/ppt/slides/slide${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  files['_rels/.rels'] = u8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  files['docProps/core.xml'] = u8(`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Postilla</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  files['ppt/presentation.xml'] = u8(`${XML}<p:presentation ${NSP} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${images.map((_m, k) => `<p:sldId id="${256 + k}" r:id="rId${k + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  files['ppt/_rels/presentation.xml.rels'] = u8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${images.map((_m, k) => `<Relationship Id="rId${k + 2}" Type="${REL}/slide" Target="slides/slide${k + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 2}" Type="${REL}/presProps" Target="presProps.xml"/><Relationship Id="rId${n + 3}" Type="${REL}/viewProps" Target="viewProps.xml"/><Relationship Id="rId${n + 4}" Type="${REL}/theme" Target="theme/theme1.xml"/><Relationship Id="rId${n + 5}" Type="${REL}/tableStyles" Target="tableStyles.xml"/></Relationships>`);
  files['ppt/presProps.xml'] = u8(`${XML}<p:presentationPr ${NSP}/>`);
  files['ppt/viewProps.xml'] = u8(`${XML}<p:viewPr ${NSP}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  files['ppt/tableStyles.xml'] = u8(`${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  files['ppt/theme/theme1.xml'] = u8(THEME);
  files['ppt/slideMasters/slideMaster1.xml'] = u8(`${XML}<p:sldMaster ${NSP}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`);
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = u8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`);
  files['ppt/slideLayouts/slideLayout1.xml'] = u8(`${XML}<p:sldLayout ${NSP} type="blank" preserve="1"><p:cSld name="Vuota"><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = u8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  images.forEach((im, k) => {
    // L'immagine occupa la diapositiva conservando le proporzioni (pagine di altra misura: centrata).
    const s = Math.min(W / (im.wPt * EMU), H / (im.hPt * EMU));
    const cw = Math.round(im.wPt * EMU * s); const ch = Math.round(im.hPt * EMU * s);
    const x = Math.round((W - cw) / 2); const y = Math.round((H - ch) / 2);
    const media = `pagina${k + 1}.${im.ext}`;
    files[`ppt/media/${media}`] = [im.bytes, { level: 0 }];
    files[`ppt/slides/slide${k + 1}.xml`] = u8(`${XML}<p:sld ${NSP}><p:cSld><p:spTree>${emptyTree}<p:pic><p:nvPicPr><p:cNvPr id="2" name="Pagina ${im.page + 1}" descr="Pagina ${im.page + 1}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cw}" cy="${ch}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    files[`ppt/slides/_rels/slide${k + 1}.xml.rels`] = u8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/image" Target="../media/${media}"/></Relationships>`);
  });
  return zip(files);
}

export async function pdfToPptx(pdf, opts = {}) {
  const images = await pdfToImages(pdf, { pages: opts.pages, dpi: opts.dpi || 150, jpeg: opts.jpeg !== false, onProgress: opts.onProgress, isCancelled: opts.isCancelled });
  return { bytes: packagePptx(images, opts.title), report: { slides: images.length } };
}

// ---------------------------------------------------------------------------------------------------
// Testo semplice
// ---------------------------------------------------------------------------------------------------
export async function pdfToText(pdf, opts = {}) {
  const pages = opts.pages || [...Array(pdf.numPages).keys()];
  const state = { ocr: opts.ocr, fontCache: new Map(), libDoc: null, getBytes: async () => opts.bytes || null, noImages: true };
  const out = [];
  let scans = 0;
  for (const [k, i] of pages.entries()) {
    if (opts.isCancelled?.()) throw new Error('annullato');
    opts.onProgress?.(k / pages.length, `Pagina ${i + 1}`);
    const page = await readPage(state, pdf, i);
    if (page.kind === 'scan') scans += 1;
    const lines = buildLines(page.pieces).map((l) => l.segs.map((s) => s.text).join('\t'));
    out.push(`--- Pagina ${i + 1} ---\r\n${lines.join('\r\n')}`);
  }
  return { bytes: u8(`﻿${out.join('\r\n\r\n')}\r\n`), report: { pages: pages.length, scans } };
}

// ---------------------------------------------------------------------------------------------------
// Finestra
// ---------------------------------------------------------------------------------------------------
const field = (label, input) => h('label', { class: 'pro-field' }, h('span', {}, label), input);
const sel = (options, value) => h('select', {}, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const check = (label, on) => { const i = h('input', { type: 'checkbox' }); i.checked = !!on; return { el: h('label', { class: 'pro-check' }, i, ` ${label}`), input: i }; };

export async function exportDialog(app, view, initial = 'xlsx') {
  view = view || app?.view;
  if (!view?.pdf) { toast('Apri prima un PDF da esportare.'); return null; }
  const opts = await modal((box, done) => {
    const kind = sel(Object.entries(FORMATS).map(([k, f]) => [k, f.label]), initial);
    const pages = h('input', { type: 'text', value: 'tutte', 'aria-label': 'Pagine', title: 'tutte, questa, oppure per esempio 1-3, 5' });
    pages.addEventListener('keydown', (e) => e.stopPropagation());
    const layout = sel([['one', 'Tutto in un foglio'], ['per', 'Un foglio per ogni pagina']], 'one');
    const tablesOnly = check('Solo le tabelle', false);
    const dpi = sel([['96', 'Schermo (96 punti per pollice)'], ['150', 'Buona (150)'], ['300', 'Stampa (300)']], '150');
    const annots = check('Con le annotazioni e le modifiche', true);
    const hint = h('p', { class: 'hint' });
    const fLayout = field('Fogli', layout); const fDpi = field('Qualità', dpi);
    const sync = () => {
      const k = kind.value;
      fLayout.hidden = k !== 'xlsx'; tablesOnly.el.hidden = k !== 'xlsx';
      fDpi.hidden = !['png', 'jpg', 'pptx'].includes(k);
      annots.el.hidden = !['png', 'jpg', 'pptx'].includes(k);
      hint.textContent = {
        xlsx: 'Righe e colonne vengono dalla posizione del testo; importi, percentuali e date diventano numeri veri. Le pagine scansionate servono già riconosciute (OCR).',
        pptx: 'Ogni pagina diventa una diapositiva, con l\'immagine nitida della pagina.',
        png: 'Un\'immagine per pagina, senza perdita di qualità.',
        jpg: 'Un\'immagine per pagina, più leggera (adatta a e-mail e WhatsApp).',
        txt: 'Solo il testo, pagina per pagina.',
      }[k];
    };
    kind.addEventListener('change', sync);
    box.append(h('h2', {}, 'Esporta in un altro formato'), field('Formato', kind), field('Pagine', pages), fLayout, tablesOnly.el, fDpi, annots.el, hint,
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => done(null) }, 'Annulla'),
        h('button', { class: 'primary', onclick: () => done({ kind: kind.value, pages: parseRange(pages.value, view.pages.length, view.current), perPage: layout.value === 'per', tablesOnly: tablesOnly.input.checked, dpi: +dpi.value, annots: annots.input.checked }) }, 'Esporta')));
    sync();
  });
  if (!opts || !opts.pages.length) return null;
  return runExport(app, view, opts);
}

export async function runExport(app, view, opts, H = window.host) {
  const fmt = FORMATS[opts.kind];
  const base = (view.tab?.path || 'documento.pdf').replace(/\.pdf$/i, '');
  const title = baseName(base);
  const images = opts.kind === 'png' || opts.kind === 'jpg';
  let dest = null; let folder = null;
  if (images && opts.pages.length > 1) {
    folder = opts.folder || await H.pickFolder();
    if (!folder) return null;
  } else {
    const suggested = images ? `${base} - pagina ${opts.pages[0] + 1}.${fmt.ext}` : `${base}.${fmt.ext}`;
    dest = opts.dest || await (H.pickSaveAs ? H.pickSaveAs(suggested, { ext: fmt.ext, mime: fmt.mime, name: fmt.label, title: 'Esporta' }) : H.pickSave(suggested));
    if (!dest) return null;
  }
  const job = { cancelled: false };
  const bar = progressBar(() => { job.cancelled = true; });
  let src = null;
  try {
    src = await sourceOf(view, opts.annots !== false && (images || opts.kind === 'pptx') ? true : (view.annots || []).some((a) => a.type === 'edit'));
    const common = { pages: opts.pages, ocr: view.ocr, title, bytes: src.bytes || view.cleanBytes, onProgress: (f, m) => bar.set(m, f), isCancelled: () => job.cancelled };
    let report = {}; const written = [];
    if (opts.kind === 'xlsx') { const r = await pdfToXlsx(src.pdf, { ...common, perPage: opts.perPage, tablesOnly: opts.tablesOnly }); report = r.report; await H.writeFile(dest, r.bytes); written.push(dest); }
    else if (opts.kind === 'pptx') { const r = await pdfToPptx(src.pdf, { ...common, dpi: opts.dpi }); report = r.report; await H.writeFile(dest, r.bytes); written.push(dest); }
    else if (opts.kind === 'txt') { const r = await pdfToText(src.pdf, common); report = r.report; await H.writeFile(dest, r.bytes); written.push(dest); }
    else {
      const list = await pdfToImages(src.pdf, { ...common, dpi: opts.dpi, jpeg: opts.kind === 'jpg' });
      for (const im of list) {
        const p = dest || `${folder.replace(/[\\/]+$/, '')}${folder.includes('\\') ? '\\' : '/'}${title} - pagina ${String(im.page + 1).padStart(3, '0')}.${fmt.ext}`;
        await H.writeFile(p, im.bytes);
        written.push(p);
      }
      report = { images: list.length };
    }
    bar.remove();
    const notes = [];
    if (report.scans) notes.push(`${report.scans} pagin${report.scans === 1 ? 'a è scansionata' : 'e sono scansionate'} senza testo riconosciuto: esegui prima «Riconosci il testo» (OCR) per averne il contenuto.`);
    if (opts.kind === 'xlsx') notes.push(report.tables ? `Tabelle riconosciute: ${report.tables}.` : 'Non ho trovato tabelle vere e proprie: il testo è stato messo riga per riga.');
    const what = written.length > 1 ? `${written.length} immagini salvate nella cartella scelta.` : `${baseName(written[0])} è pronto.`;
    if (!opts.quiet) {
      const choice = await ask('Esportazione completata', `${what} ${notes.join(' ')}`, [{ label: 'Mostra nella cartella', value: 'reveal' }, { label: 'OK', value: 'ok', primary: true }]);
      if (choice === 'reveal') H.reveal?.(written[0]);
    }
    return { written, report };
  } catch (e) {
    if (e?.message === 'annullato') toast('Esportazione annullata.');
    else { console.error(e); toast(`Esportazione non riuscita: ${e?.message || e}`, 'error'); }
    return null;
  } finally {
    bar.remove();
    if (src) closeSrc(src);
  }
}
