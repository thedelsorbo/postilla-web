// Theresa: dal comando di modifica al punto preciso del documento.
// Cerca l'etichetta («Data di emissione», «Date of issue», «L/C No.») e il valore accanto sulla stessa riga,
// oppure un testo preciso, oppure un campo compilabile. Se i punti possibili sono più d'uno chiede quale.
// Lavora sul testo vero della pagina (o su quello riconosciuto con l'OCR): il testo del PDF non è mai un comando.
import { norm, pageText } from '../text.js';
import { allFields } from '../forms.js';

// Sinonimi delle etichette più comuni nei documenti del commercio estero (italiano e inglese).
const LABELS = [
  { keys: ['data di emissione', 'data emissione', 'data di rilascio', 'data rilascio', 'emissione'], labels: ['data di emissione', 'data emissione', 'data di rilascio', 'date of issue', 'issue date', 'issued on', 'date of issuance', 'place and date of issue', 'luogo e data di emissione', 'luogo e data di rilascio'] },
  { keys: ['numero della lettera di credito', 'numero lettera di credito', 'numero del credito', 'numero credito', 'lettera di credito', 'credito documentario', 'numero lc'], labels: ['l/c no', 'l/c n', 'l/c number', 'lc no', 'lc n', 'documentary credit no', 'documentary credit number', 'documentary credit', 'credit number', 'credit no', 'numero lettera di credito', 'numero del credito', 'lettera di credito n', 'lettera di credito', 'dc no'] },
  { keys: ['paese di origine', 'paese d\'origine', 'origine'], labels: ['paese di origine', 'paese d\'origine', 'country of origin', 'origin'] },
  { keys: ['data di spedizione', 'data spedizione', 'data di imbarco', 'data imbarco'], labels: ['data di spedizione', 'data di imbarco', 'date of shipment', 'shipment date', 'shipped on board', 'on board date'] },
  { keys: ['numero fattura', 'numero della fattura', 'fattura'], labels: ['numero fattura', 'fattura n', 'invoice no', 'invoice number', 'invoice n'] },
  { keys: ['destinatario', 'consegnatario', 'consignee'], labels: ['destinatario', 'consegnatario', 'consignee'] },
  { keys: ['esportatore', 'speditore', 'mittente'], labels: ['esportatore', 'speditore', 'mittente', 'exporter', 'shipper', 'consignor'] },
];
const ADD_FALLBACK = ['remarks', 'note', 'osservazioni', 'annotazioni', 'additional information', 'informazioni aggiuntive'];
const MAX_PAGES = 12;

export function labelVariants(phrase) {
  const p = norm(phrase).replace(/[.:]+$/, '').trim();
  const out = new Set([p]);
  for (const g of LABELS) if (g.keys.some((k) => p === k || p.includes(k) || k.includes(p))) g.labels.forEach((l) => out.add(l));
  return [...out].filter((v) => v.length >= 2).sort((a, b) => b.length - a.length);
}

// --- Geometria delle parole --------------------------------------------------------------------
const box = (q) => ({ x0: Math.min(q[0], q[4]), x1: Math.max(q[2], q[6]), y: (q[5] + q[7]) / 2, h: Math.abs(q[1] - q[5]) || 8 });
const sameLine = (a, b) => Math.abs(box(a.quad).y - box(b.quad).y) < Math.min(box(a.quad).h, box(b.quad).h) * 0.5;

function wordsIn(pt, at, len) { return pt.words.filter((w) => w.off < at + len && w.off + w.str.length > at); }

// Parole a destra dell'etichetta sulla stessa riga, finché non c'è un salto grande o un'altra etichetta.
function valueAfter(pt, labelWords) {
  const last = labelWords[labelWords.length - 1];
  const lb = box(last.quad);
  const row = pt.words.filter((w) => w !== last && !labelWords.includes(w) && sameLine(w, last) && box(w.quad).x0 > lb.x1 - 1).sort((a, b) => box(a.quad).x0 - box(b.quad).x0);
  const out = [];
  let prevX = lb.x1;
  for (const w of row) {
    const b = box(w.quad);
    if (b.x0 - prevX > lb.h * 3) break;
    if (out.length && /:$/.test(out[out.length - 1].str)) { out.pop(); break; }
    out.push(w);
    prevX = b.x1;
  }
  return out.filter((w) => w.str !== ':');
}

// Ultima parola della riga dell'etichetta (per aggiungere in fondo alla riga).
function lineEnd(pt, labelWords) {
  const last = labelWords[labelWords.length - 1];
  const row = pt.words.filter((w) => sameLine(w, last) && box(w.quad).x0 >= box(labelWords[0].quad).x0 - 1);
  const v = valueAfter(pt, labelWords);
  return v.length ? v[v.length - 1] : (row.length && !v.length ? last : last);
}

async function eachPage(view, fn) {
  const n = Math.min(view.pages.length, MAX_PAGES);
  for (let i = 0; i < n; i += 1) { const pt = await pageText(view, i); fn(pt, i); }
}

const snippet = (pt, words) => {
  const a = words[0].off; const b = words[words.length - 1].off + words[words.length - 1].str.length;
  return pt.text.slice(Math.max(0, a - 30), b + 30).replace(/\s+/g, ' ').trim();
};

export async function findLabel(view, phrase) {
  const out = [];
  const variants = labelVariants(phrase);
  await eachPage(view, (pt, i) => {
    const used = new Set();
    for (const v of variants) {
      let at = pt.lower.indexOf(v);
      while (at >= 0) {
        const before = pt.lower[at - 1]; const after = pt.lower[at + v.length];
        const okEdge = (!before || /[\s(:]/.test(before)) && (!after || /[\s.:)/-]/.test(after));
        const lw = wordsIn(pt, at, v.length);
        const key = lw.map((w) => w.off).join(',');
        if (okEdge && lw.length && !used.has(key) && ![...used].some((k) => k.split(',').some((o) => key.split(',').includes(o)))) {
          used.add(key);
          out.push({ page: i, labelWords: lw, valueWords: valueAfter(pt, lw), endWord: lineEnd(pt, lw), label: lw.map((w) => w.str).join(' '), pt });
        }
        at = pt.lower.indexOf(v, at + v.length);
      }
    }
  });
  return out;
}

export async function findText(view, text) {
  const needle = norm(text).trim();
  const out = [];
  if (!needle) return out;
  await eachPage(view, (pt, i) => {
    let at = pt.lower.indexOf(needle);
    while (at >= 0) {
      const ws = wordsIn(pt, at, needle.length);
      if (ws.length) out.push({ page: i, words: ws, context: snippet(pt, ws) });
      at = pt.lower.indexOf(needle, at + needle.length);
    }
  });
  return out;
}

// Campo compilabile con nome o descrizione simile all'etichetta («numero credito» ↔ numero_credito).
export async function findField(view, phrase) {
  const tok = (s) => norm(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length > 1 && !['di', 'del', 'della', 'il', 'la', 'lo', 'le', 'campo'].includes(t));
  const want = tok(phrase);
  if (!want.length) return [];
  // Lo stesso campo può comparire su più pagine: conta una volta sola.
  const seen = new Set();
  const fields = (await allFields(view)).filter((f) => !f.readOnly && !seen.has(f.name) && seen.add(f.name));
  const scored = fields.map((f) => { const have = tok(`${f.name} ${f.label || ''}`); const hit = want.filter((t) => have.some((x) => x.startsWith(t.slice(0, 5)) || t.startsWith(x.slice(0, 5)))).length; return { f, s: hit / want.length }; });
  const best = Math.max(0, ...scored.map((x) => x.s));
  return best >= 0.6 ? scored.filter((x) => x.s === best).map((x) => x.f) : [];
}

// --- Date nel formato del documento -------------------------------------------------------------
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function parseDate(v) {
  const s = norm(v).trim();
  let m = s.match(/^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2,4})$/);
  if (m) return { d: +m[1], m: +m[2], y: +m[3] < 100 ? 2000 + +m[3] : +m[3] };
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { d: +m[3], m: +m[2], y: +m[1] };
  // A voce l'anno (e talvolta il mese) può mancare: «1° novembre», «il 1°». Si completa dalla data che si sostituisce.
  m = s.match(/^(?:il\s+)?(\d{1,2})(?:°|º)?\s+([a-z]+)\.?(?:\s+(\d{4}))?$/) || s.match(/^([a-z]+)\.?\s+(\d{1,2}),?(?:\s+(\d{4}))?$/);
  if (m) {
    const [d, name] = /^\d/.test(m[1]) ? [+m[1], m[2]] : [+m[2], m[1]];
    const k = [...MESI, ...MONTHS].findIndex((x) => x.startsWith(name.slice(0, 3)));
    if (k >= 0) return { d, m: (k % 12) + 1, y: m[3] ? +m[3] : null };
  }
  m = s.match(/^(?:il\s+)?(\d{1,2})(?:°|º)$/);
  if (m) return { d: +m[1], m: null, y: null };
  return null;
}

// Riscrive la data detta a voce nello stesso formato di quella che sostituisce («12 novembre 2026» → «12/11/2026»).
export function formatLike(value, sample) {
  const d0 = parseDate(value);
  if (!d0 || !sample) return value;
  const S = sample.trim();
  const ref = parseDate(S);
  if ((d0.m == null || d0.y == null) && !ref) return value;
  const d = { d: d0.d, m: d0.m ?? ref.m, y: d0.y ?? ref.y };
  const p2 = (n) => String(n).padStart(2, '0');
  let m = S.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{2,4})$/);
  if (m) return `${m[1].length === 2 ? p2(d.d) : d.d}${m[2]}${m[3].length === 2 ? p2(d.m) : d.m}${m[2]}${m[4].length === 2 ? String(d.y).slice(2) : d.y}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(S)) return `${d.y}-${p2(d.m)}-${p2(d.d)}`;
  m = S.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\.?\s+(\d{4})$/);
  if (m) {
    const en = MONTHS.some((x) => x.startsWith(norm(m[2]).slice(0, 3))) && !MESI.some((x) => x.startsWith(norm(m[2]).slice(0, 3)));
    let name = (en ? MONTHS : MESI)[d.m - 1];
    if (m[2].length <= 4 && /\.$|^[A-Za-z]{3}$/.test(m[2])) name = name.slice(0, 3);
    if (m[2] === m[2].toUpperCase()) name = name.toUpperCase(); else if (/^[A-Z]/.test(m[2])) name = name[0].toUpperCase() + name.slice(1);
    return `${m[1].length === 2 ? p2(d.d) : d.d} ${name} ${d.y}`;
  }
  m = S.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),\s+(\d{4})$/);
  if (m) { let name = MONTHS[d.m - 1]; if (m[1].length === 3) name = name.slice(0, 3); name = name[0].toUpperCase() + name.slice(1); return `${name} ${d.d}, ${d.y}`; }
  return value;
}

// --- Dal comando al bersaglio ------------------------------------------------------------------
// Restituisce { kind: 'words'|'field'|'choices'|'place'|'error', … } senza modificare nulla.
export async function resolveEdit(view, spec, { selection } = {}) {
  if (spec.selection) {
    if (!selection?.words?.length) return { kind: 'error', message: 'Prima seleziona sulla pagina il testo da modificare (strumento Seleziona), poi ripeti il comando.' };
    return { kind: 'words', mode: spec.mode, page: selection.p.i, words: selection.words, value: spec.value, before: selection.words.map((w) => w.str).join(' ') };
  }
  if (spec.mode === 'replace' && spec.find) {
    const hits = await findText(view, spec.find);
    if (!hits.length) return { kind: 'error', message: `Non trovo «${spec.find}» nel documento.` };
    const opts = hits.map((x) => ({ kind: 'words', mode: 'replace', page: x.page, words: x.words, value: spec.value, before: x.words.map((w) => w.str).join(' '), context: x.context }));
    return opts.length === 1 ? opts[0] : { kind: 'choices', options: opts, question: `«${spec.find}» compare ${opts.length} volte. Quale sostituisco?` };
  }
  if (spec.mode === 'replace' && spec.label) {
    const fields = await findField(view, spec.label);
    if (fields.length === 1 || (spec.field && fields.length)) {
      if (fields.length > 1) return { kind: 'choices', options: fields.map((f) => ({ kind: 'field', field: f, value: spec.value, before: String(f.current ?? '') })), question: 'Più campi corrispondono. Quale compilo?' };
      const f = fields[0];
      return { kind: 'field', field: f, value: f.type === 'Tx' ? formatLike(spec.value, String(f.current || '')) : spec.value, before: String(f.current ?? '') };
    }
    if (spec.field) return { kind: 'error', message: `Non trovo un campo compilabile che corrisponda a «${spec.label}».` };
    const hits = (await findLabel(view, spec.label)).filter((x) => x.valueWords.length);
    if (!hits.length) return { kind: 'error', message: `Non trovo «${spec.label}» con un valore accanto in questo documento. Puoi selezionare il punto e dire «modifica questo punto in …».` };
    let opts = hits.map((x) => {
      const before = x.valueWords.map((w) => w.str).join(' ');
      return { kind: 'words', mode: 'replace', page: x.page, words: x.valueWords, value: formatLike(spec.value, before), before, context: `${x.label} ${before}` };
    });
    // «… anziché 2»: fra più punti si tengono quelli che contengono il valore vecchio indicato.
    if (spec.old && opts.length > 1) {
      const od = parseDate(spec.old);
      const has = (b) => (od ? (() => { const bd = parseDate(b); return bd && bd.d === od.d && (od.m == null || bd.m === od.m); })() : false) || norm(b).includes(norm(spec.old));
      const keep = opts.filter((o) => has(o.before));
      if (keep.length) opts = keep;
    }
    return opts.length === 1 ? opts[0] : { kind: 'choices', options: opts, question: `Ho trovato «${spec.label}» in ${opts.length} punti. Quale modifico?` };
  }
  if (spec.mode === 'add') {
    const tries = spec.anchor ? [spec.anchor] : [...(spec.what ? [spec.what] : []), ...ADD_FALLBACK];
    for (const t of tries) {
      const hits = await findLabel(view, t);
      if (!hits.length) continue;
      // Se l'etichetta del dato ha già un valore, il dato c'è già: lo si dice invece di scriverlo due volte.
      if (spec.what && t === spec.what && hits.length === 1 && hits[0].valueWords.length && !spec.anchor) {
        return { kind: 'exists', label: hits[0].label, value: hits[0].valueWords.map((w) => w.str).join(' '), page: hits[0].page, words: hits[0].valueWords };
      }
      const opts = hits.map((x) => ({ kind: 'words', mode: 'add', page: x.page, words: [x.endWord], value: spec.value, before: '', context: `dopo «${x.label}${x.valueWords.length ? ` ${x.valueWords.map((w) => w.str).join(' ')}` : ''}»`, anchor: x.label }));
      return opts.length === 1 ? opts[0] : { kind: 'choices', options: opts, question: `«${t}» compare in ${opts.length} punti. Dove aggiungo?` };
    }
    return { kind: 'place', value: spec.value, message: spec.what ? `Non trovo nel documento un punto per «${spec.what}».` : 'Non trovo un punto adatto.' };
  }
  return { kind: 'error', message: 'Non ho capito cosa modificare.' };
}
