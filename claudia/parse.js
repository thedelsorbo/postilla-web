// Claudia: comprensione dei comandi in italiano, con regole fisse (niente servizi esterni).
// Esempio: «Claudia, apri il PDF della normativa e cerca l'articolo 3 su competent authority. Evidenzialo e leggilo.»
// I comandi arrivano solo dalla tastiera o dal microfono dell'utente: il testo dei PDF non passa mai di qui.
import { parseAction } from './actions.js';

const ORD = { primo: 1, prima: 1, secondo: 2, seconda: 2, terzo: 3, terza: 3, quarto: 4, quarta: 4, quinto: 5, quinta: 5, sesto: 6, sesta: 6, ultimo: -1, ultima: -1 };
const ART = String.raw`(?:articolo|art\.?|article|art)`;
const NUM = String.raw`(\d+[a-z]?(?:\s*-?\s*(?:bis|ter|quater|quinquies))?)`;
const END = String.raw`(?=\s*[.;,!?]|\s+e\s+(?:cerca|trova|vai|evidenzi|legg|apri|spieg|tradu)|\s+(?:cerca|cercami|trova|leggi|evidenzia)\b|\s+(?:e\s+)?(?:all['’]|al\s|alla\s|nell['’]|nel\s)?${ART}\b|$)`;
const QUOTES = /^[\s"«“'‘]+|[\s"»”'’]+$/g;

export function parseCommand(input) {
  const raw = String(input || '').trim();
  const out = {
    raw, wake: false, control: null, choice: null, note: null, reopenLast: false,
    doc: null, article: null, keywords: null, highlight: false, read: false, explain: false, translate: false, open: false, edit: null,
  };
  // A voce i numeri possono arrivare in lettere: «articolo tre» diventa «articolo 3».
  const NUMS = { uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20, one: 1, two: 2, three: 3, four: 4, five: 5 };
  // La trascrizione può storpiare «articolo» («articcolo», «art.collo tre»): si riporta alla forma giusta.
  const fixed = raw.replace(/\bart(?:i|\.)?\s*c+o+l+o(?=\s|\d|[a-z]|$)/gi, 'articolo ');
  const spoken = fixed.replace(new RegExp(String.raw`\b(${ART})\s*(${Object.keys(NUMS).join('|')})\b`, 'gi'), (_m, a, n) => `${a} ${NUMS[n.toLowerCase()]}`).replace(/\s{2,}/g, ' ');
  let s = spoken.replace(/^\s*(?:ehi\s+|ok\s+|ciao\s+)?(?:theresa|teresa|tereza|claudia)\b[\s,:;!.-]*/i, () => { out.wake = true; return ''; });
  const low = s.toLowerCase().replace(/[’‘]/g, "'");

  // Funzioni di Postilla (pagina, zoom, stampa, strumenti, ascolto…): stesse voci del Menu.
  const action = parseAction(s);
  if (action) { out.action = action; return out; }

  // Comandi di controllo: valgono subito, da soli.
  if (/^(fermati|ferma|stop|basta|smetti|zitta|silenzio|interrompi)\b/.test(low)) { out.control = 'stop'; return out; }
  if (/^(pausa|metti in pausa|aspetta)\b/.test(low)) { out.control = 'pausa'; return out; }
  if (/^(riprendi|continua|vai avanti|prosegui)\b/.test(low)) { out.control = 'riprendi'; return out; }
  if (/^(annulla|torna indietro|disfa|lascia stare)\b/.test(low)) { out.control = 'annulla'; return out; }
  if (/^salva(?:lo|la)?(?:\s+(?:il documento|la copia|le modifiche|tutto))?\s*[.!]?$/.test(low)) { out.control = 'salva'; return out; }
  // Conferma o rifiuto di una modifica proposta.
  if (/^confermo(?:\s+la\s+sostituzione)?\s*[.!]?$/.test(low)) { out.control = 'conferma-forte'; return out; }
  if (/^(?:s[iì]|conferma|ok|okay|va bene|procedi|applica|applicala|fallo)(?:[\s,.!]+(?:s[iì]|conferma|ok|va bene|procedi|applica|applicala|fallo|grazie))*[\s,.!]*$/.test(low)) { out.control = 'si'; return out; }
  if (/^(no|non applicare|non farlo|lascia perdere)\b[\s,.!]*$/.test(low)) { out.control = 'no'; return out; }

  // Modifiche al documento: «modifica la data di emissione in 12 novembre 2026», «aggiungi il numero della
  // lettera di credito 123/ABC», «sostituisci "ABC-123" con "XYZ-789"», «modifica questo punto in …».
  const edit = parseEdit(s);
  if (edit) { out.edit = edit; return out; }

  // Annotazioni: «evidenzia l'articolo 14 delle UCP», «sottolinea la frase "banca emittente"», «barra … in rosso», «evidenzialo».
  const annot = parseAnnot(s);
  if (annot) {
    out.annot = annot;
    out.article = annot.article || null;
    out.keywords = annot.phrase || null;
    out.doc = annot.doc || null;
    out.open = !!annot.doc;
    return out;
  }

  // Risposta a una domanda di scelta: «il secondo», «2», «la prima».
  const ch = low.match(/^(?:il|la|lo|l')?\s*(primo|prima|secondo|seconda|terzo|terza|quarto|quarta|quinto|quinta|sesto|sesta|ultimo|ultima|\d{1,2})\b(?:\s+(?:documento|pdf|file))?\s*[.!]?$/);
  if (ch) { out.choice = ORD[ch[1]] ?? Number(ch[1]); return out; }

  // Note e promemoria: si salvano solo dopo conferma.
  const nt = s.match(/^(?:prendi nota|annota|segna|ricordami(?: di)?|promemoria)\s*[:,]?\s*(?:che\s+)?(.+)$/i);
  if (nt) { out.note = nt[1].trim(); return out; }

  // A voce «riapri» può arrivare come «reapri», «reapre», «riapre», «ria apri»; anche «il ultimo».
  if (/\b(?:ri|re)(?:a\s+|\s+)?ap+r[ie]\w*\s+(?:l'|lo\s+|il\s+)?ultimo(?:\s+(?:documento|pdf|file))?/.test(low)) out.reopenLast = true;

  const art = s.match(new RegExp(String.raw`\b${ART}\s*${NUM}\b`, 'i'));
  if (art) out.article = art[1].replace(/\s+/g, '').toLowerCase();

  // Documento: «apri il PDF della normativa …», «nel regolamento pagamenti …»
  const doc = s.match(new RegExp(String.raw`\b(?:apri|aprì|aprimi|mostrami|prendi)\s+(?:il|la|lo|l'|l’|i|gli|le)?\s*(?:pdf|documento|file|testo)?\s*(?:della|del|dello|dei|delle|degli|di|sul|sulla|sullo|relativ[oa] a(?:l|lla)?)?\s*(.+?)${END}`, 'i'))
    || s.match(new RegExp(String.raw`\b(?:nel|nella|nello|nell['’])\s*(?:pdf|documento|file)?\s*(?:della|del|dello|di)?\s*(.+?)${END}`, 'i'));
  if (doc && !/^(?:l['’])?ultimo\b/i.test(doc[1])) {
    out.doc = doc[1].replace(QUOTES, '').trim() || null;
    out.open = true;
  }

  // Parole da cercare: «… su competent authority», «cerca "termine"»
  const kw = s.match(new RegExp(String.raw`${ART}\s*${NUM}\s*(?:,\s*)?(?:su|sulla|sul|sullo|sugli|sulle|riguardo (?:a|al|alla|ai)|relativ[oa] a(?:l|lla)?|che parla di|che contiene|dove (?:si )?parla di|con)\s+(.+?)${END.replace(String.raw`|\s+(?:e\s+)?(?:all['’]|al\s|alla\s|nell['’]|nel\s)?${ART}\b`, '')}`, 'i'))
    || s.match(/\b(?:cerca|trova|cercami)\s+(?!(?:l['’])?(?:articolo|art\.?|article)\b)(?:la parola|il termine|la frase|le parole)?\s*(.+?)(?=\s*[.;!?]|\s+e\s+(?:evidenzi|legg|apri|spieg|tradu)|\s+(?:nel|nella|nello|nell['’])\s|$)/i);
  if (kw) {
    const k = kw[kw.length - 1].replace(QUOTES, '').trim();
    if (k && !new RegExp(`^${ART}\\s*\\d`, 'i').test(k)) out.keywords = k;
  }

  out.highlight = /\bevidenzi/i.test(s);
  out.read = /\blegg(?:i|ilo|ila|ili|imi|imelo|imela|ere)\b|\bleggi\w*/i.test(s);
  out.explain = /\bspieg/i.test(s);
  out.translate = /\btradu/i.test(s);
  return out;
}

const ANNOT_VERB = /^(?:evidenzi(?:a|ami|are)|sottoline(?:a|ami|are)|barra(?:mi)?|sbarra|depenna|cancella con una riga|tira una riga su)\b/i;
const ANNOT_TYPE = (v) => (/^evidenzi/i.test(v) ? 'hl' : /^sottolin/i.test(v) ? 'ul' : 'so');
const COLORS = { giallo: '#ffe14d', verde: '#a8f07a', azzurro: '#8fd3ff', celeste: '#8fd3ff', blu: '#1d3f8f', rosa: '#ffb3d1', arancione: '#ffc56b', viola: '#d6c2ff', lilla: '#d6c2ff', rosso: '#b3261e', nero: '#14213d' };

// «evidenzia l'articolo 14 delle UCP 600 in verde», «sottolinea la frase "banca emittente" a pagina 2», «barralo».
export function parseAnnot(s) {
  let t = politeEdit(s).replace(/[.!?\s]+$/, '');
  // Pronome: «evidenzialo», «sottolineala», «barrali» → il risultato appena trovato.
  const pr = t.match(/^(evidenzi|sottoline|barr)a(?:lo|la|li|le)(?:\s+(?:in|di)\s+(\w+))?$/i);
  if (pr) return { type: ANNOT_TYPE(pr[1]), pronoun: true, color: COLORS[pr[2]?.toLowerCase()] || null };
  const v = t.match(ANNOT_VERB);
  if (!v) return null;
  const type = ANNOT_TYPE(v[0]);
  let rest = t.slice(v[0].length).trim();
  if (/^(?:lo|la|li|le|questo|questa|quello)$/i.test(rest)) return { type, pronoun: true, color: null };
  let color = null; let page = null; let all = false;
  const col = rest.match(new RegExp(String.raw`\s+(?:in|di|con il|col|color)\s+(${Object.keys(COLORS).join('|')})\b`, 'i'));
  if (col) { color = COLORS[col[1].toLowerCase()]; rest = (rest.slice(0, col.index) + rest.slice(col.index + col[0].length)).trim(); }
  const pg = rest.match(/\s+(?:a|alla|in|nella)\s+pagina\s+(\d{1,4})\b/i);
  if (pg) { page = Number(pg[1]); rest = (rest.slice(0, pg.index) + rest.slice(pg.index + pg[0].length)).trim(); }
  const ev = rest.match(/\s+(?:ovunque|dappertutto|ogni volta(?: che (?:compare|appare|c'è))?|tutte le volte|in tutto il documento)\s*$/i);
  if (ev) { all = true; rest = rest.slice(0, ev.index).trim(); }
  if (/^tutte le\s+/i.test(rest)) { all = true; rest = rest.replace(/^tutte le\s+(?:volte\s+)?(?:che compare\s+)?/i, ''); }
  // Articolo: «l'articolo 14 delle UCP 600», «tutto l'articolo 3 nel regolamento pagamenti»
  const art = rest.match(new RegExp(String.raw`^(?:tutto\s+)?(?:l['’]\s*)?${ART}\s*${NUM}(?:\s+(?:delle|del|della|dello|dei|degli|nel|nella|nello|nelle|sul|sulla)\s+(?:pdf\s+|documento\s+|file\s+)?(.+))?$`, 'i'));
  if (art) return { type, article: art[1].replace(/\s+/g, '').toLowerCase(), doc: art[2] ? art[2].replace(QUOTES, '').trim() : null, color, page, all: false };
  // Frase o parole, tra virgolette o no; il documento solo dopo «nel documento / nel file / nel pdf …».
  rest = rest.replace(/^(?:la frase|le parole|la parola|il testo|la scritta|il passaggio|la riga|l['’]espressione)\s*(?::\s*)?/i, '');
  let doc = null;
  const q = rest.match(/^["«“'‘](.+?)["»”'’](?:\s+(?:nel|nella|sul|sulla|del|della)\s+(?:pdf\s+|documento\s+|file\s+)?(.+))?$/);
  let phrase;
  if (q) { phrase = q[1]; doc = q[2] || null; } else {
    const d = rest.match(/\s+(?:nel|nella|sul|sulla)\s+(?:pdf|documento|file)\s+(.+)$/i);
    if (d) { doc = d[1]; rest = rest.slice(0, d.index); }
    phrase = rest;
  }
  phrase = String(phrase || '').replace(QUOTES, '').trim();
  if (!phrase) return null;
  return { type, phrase, doc: doc ? doc.replace(QUOTES, '').trim() : null, color, page, all };
}

// Tipi di documento che, dopo «del/della/sul/nel», indicano il documento e non fanno parte del dato.
const DOC_TYPE = String.raw`(?:certificat\w*|polizz\w*|document\w*|modul\w*|fattur\w*|bill\b|packing\b|list\w*|dichiarazion\w*|attestat\w*|lettera di vettura|pdf|file)`;
const DOC_SPLIT = new RegExp(String.raw`\s+(?:(?:sul|sulla|sullo|sull['’]|nel|nella|nello|nell['’])\s+(?:pdf\s+|documento\s+|file\s+)?(.+)|(?:del|della|dello|dell['’]|dal|dalla)\s+(${DOC_TYPE}.*)|(?:di|del|della|dello)\s+((?:quest[oa]|presente)(?:\s+\S+)?))$`, 'i');

// Forme cortesi o parlate: «Mi modifichi …?», «puoi cambiare …», «modificami …, per favore» → «modifica …».
const VERBS = [[/^modific\w*/i, 'modifica'], [/^cambi\w*/i, 'cambia'], [/^corre(?:g)?g\w*/i, 'correggi'], [/^sostitu\w*/i, 'sostituisci'],
  [/^rimpiazz\w*/i, 'rimpiazza'], [/^aggiorn\w*/i, 'aggiorna'], [/^impost\w*/i, 'imposta'], [/^mett\w*/i, 'metti'], [/^compil\w*/i, 'compila'],
  [/^aggiung\w*/i, 'aggiungi'], [/^inser\w*/i, 'inserisci'], [/^scriv\w*/i, 'scrivi']];
export function politeEdit(s) {
  let t = s.trim().replace(/[?!.\s]+$/, '')
    .replace(/[\s,]+(?:per favore|per cortesia|per piacere|grazie)$/i, '')
    .replace(/^(?:per favore|per cortesia|per piacere)[\s,]+/i, '')
    .replace(/^(?:mi\s+|me\s+|ci\s+)?(?:puoi|potresti|può|potrebbe|riesci a|riusciresti a|vorrei che (?:tu\s+)?|devi|dovresti)\s+/i, '')
    .replace(/^(?:mi|me|ci)\s+/i, '');
  for (const [re, base] of VERBS) {
    const m = t.match(re);
    if (m) { t = base + t.slice(m[0].length); break; }
  }
  return t;
}
const Q = String.raw`["«“']`;
const QE = String.raw`["»”']`;

function splitDoc(t) {
  const m = t.match(DOC_SPLIT);
  if (!m) return { text: t.trim(), doc: null };
  const doc = (m[1] || m[2] || m[3] || '').replace(QUOTES, '').trim();
  return { text: t.slice(0, m.index).trim(), doc: /^(?:quest[oa]|presente)\b/i.test(doc) ? null : doc };
}

const clean = (v) => v.replace(QUOTES, '').replace(/\s*[.!]$/, '').trim();
const ART_RE = /^(?:il|la|lo|l['’]|i|gli|le|un|una)\s+/i;

export function parseEdit(s) {
  let t = politeEdit(s);
  // «… indicando 1° novembre anziché 2», «… mettendo Francia al posto di Italia»: il valore vecchio serve da controllo.
  let old = null;
  const ov = t.match(/^(.+?)\s+(?:anzich[eé]|invece di|invece che|al posto di|e non)\s+(.+)$/i);
  let docAfter = null;
  if (ov) { const d = splitDoc(ov[2]); t = ov[1]; old = clean(d.text); docAfter = d.doc; }
  t = t.replace(/^((?:modifica|cambia|correggi|aggiorna|imposta|compila)\s+.+?)\s+(?:indicando|mettendo|scrivendo|inserendo|riportando|così)\s*:?\s+/i, '$1 in ');
  const r = parseEditCore(t);
  if (r && r.mode === 'replace' && r.label && !old) {
    // «cambia la data di emissione da 2 novembre a 1° novembre»
    const da = r.label.match(/^(.+?)\s+da\s+(.+)$/i);
    if (da) { r.label = da[1].trim(); old = clean(da[2]); }
  }
  if (r && old) r.old = old;
  if (r && docAfter && !r.doc) r.doc = docAfter;
  return r;
}

function parseEditCore(t) {
  // Sostituzione di un testo preciso: «sostituisci "ABC-123" con "XYZ-789"»
  let m = t.match(new RegExp(String.raw`^(?:sostituisci|cambia|rimpiazza)\s+(?:il testo|la parola|la scritta|la frase)?\s*${Q}(.+?)${QE}\s+(?:con|in)\s+(.+)$`, 'i'))
    || t.match(/^(?:sostituisci|rimpiazza)\s+(?:il testo|la parola|la scritta|la frase)?\s*(.+?)\s+con\s+(.+)$/i);
  if (m && !/^(?:questo|questa|quello|la selezione)\b/i.test(m[1])) { const v = splitDoc(m[2]); return { mode: 'replace', find: clean(m[1]), value: clean(v.text), doc: v.doc }; }
  // Il punto selezionato: «modifica questo punto in …», «scrivi qui …», «sostituisci questo con …»
  m = t.match(/^(?:modifica|cambia|correggi|sostituisci)\s+(?:questo punto|questo testo|questa parte|la selezione|questo|quello selezionato)\s+(?:in|con)\s+(.+)$/i);
  if (m) return { mode: 'replace', selection: true, value: clean(m[1]), doc: null };
  m = t.match(/^(?:scrivi|aggiungi|inserisci)\s+(?:qui|in questo punto|dopo la selezione)\s*[:,]?\s+(.+)$/i);
  if (m) return { mode: 'add', selection: true, value: clean(m[1]), doc: null };
  // Campo o dato con etichetta: «modifica la data di emissione del certificato di origine in 12 novembre 2026»
  m = t.match(/^(?:modifica|cambia|correggi|aggiorna|imposta|metti|compila)\s+(.+?)\s+(?:in|a|con|come)\s+(.+)$/i);
  if (m) {
    // Il documento può stare dopo il dato («… del certificato di origine in …») o dopo il valore («… in 12/11 sul certificato»).
    const a = splitDoc(m[1]); const b = splitDoc(m[2]);
    const label = a.text.replace(ART_RE, '').replace(/^campo\s+/i, '').replace(QUOTES, '').trim();
    if (label) return { mode: 'replace', label, value: clean(b.text), doc: a.doc || b.doc, field: /\bcampo\b/i.test(m[1]) || /^compila/i.test(t) };
  }
  // Aggiunta: «aggiungi il numero della lettera di credito 123/ABC sul certificato sanitario», «aggiungi "Merce conforme" dopo Remarks»
  m = t.match(/^(?:aggiungi|inserisci|scrivi)\s+(.+)$/i);
  if (m) {
    let rest = m[1];
    let anchor = null;
    const an = rest.match(new RegExp(String.raw`\s+(?:dopo|accanto a|vicino a|accanto al|vicino al)\s+(?:la voce\s+|l['’]etichetta\s+|il campo\s+|la scritta\s+)?${Q}?(.+?)${QE}?(?=\s+(?:sul|sulla|sullo|nel|nella|nello)\s|$)`, 'i'));
    if (an) { anchor = an[1].trim(); rest = rest.slice(0, an.index) + rest.slice(an.index + an[0].length); }
    const d = splitDoc(rest);
    rest = d.text;
    let value; let what = '';
    const q = rest.match(new RegExp(String.raw`${Q}(.+?)${QE}`));
    if (q) { value = q[1]; what = rest.replace(q[0], '').replace(ART_RE, '').trim(); } else {
      const v = rest.match(/(?:^|\s)((?:[A-Z]{1,6}[\s.-]?)?[\w./-]*\d[\w./-]*(?:\s+[\w./-]*\d[\w./-]*)*)\s*$/);
      if (v) { value = v[1].trim(); what = rest.slice(0, v.index).replace(ART_RE, '').trim(); } else value = rest.replace(ART_RE, '').trim();
    }
    if (value) return { mode: 'add', what: what || null, anchor, value: clean(value), doc: d.doc };
  }
  return null;
}
