// Claudia: trova l'articolo, il passaggio esatto e le tre numerazioni della pagina.
// Lavora sul testo vero del PDF o sul testo riconosciuto (OCR), sempre tramite pageText: la citazione è
// quindi un pezzo identico del testo della pagina, mai una frase ricostruita.
import { LOW_CONF, mergeQuads, norm, pageText } from '../text.js';

const HEAD = /^\s*(?:articolo|art\.?|article)\s+(\d+[a-z]?(?:\s*-?\s*(?:bis|ter|quater|quinquies))?)(?=$|[\s.:–—-])/i;
const MAX_ARTICLE_PAGES = 8;

const normNum = (n) => n.replace(/\s+|-/g, '').toLowerCase();

// Un titolo di articolo sta all'inizio di una riga breve: «Articolo 3 - Autorità competente», «Art. 3. Sanzioni».
// I rimandi nel testo («ai sensi dell'articolo 3») stanno dentro la riga e quindi non contano.
function headingsOf(text) {
  const out = [];
  let off = 0;
  for (const line of text.split('\n')) {
    const m = line.match(HEAD);
    if (m && line.trim().length <= 110 && !/[,;]$/.test(line.trim())) {
      const after = line.slice(m[0].length).trim();
      if (!after || /^[-–—.:]/.test(after) || /^[A-ZÀ-Ý]/.test(after)) out.push({ num: normNum(m[1]), off: off + line.indexOf(line.trimStart()), line: line.trim() });
    }
    off += line.length + 1;
  }
  return out;
}

// Numero stampato sulla pagina (piè di pagina o intestazione): «Pag. 41», «- 12 -», «41», «L 150/40».
export function printedNumber(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const cand = [...lines.slice(-3).reverse(), ...lines.slice(0, 3)];
  for (const l of cand) {
    const m = l.match(/^(?:pag(?:ina)?\.?|p\.|page)?\s*[-–]?\s*(\d{1,4})\s*[-–]?$/i);
    if (m) return l;
    if (/^[A-Z]\s?\d{1,4}\/\d{1,4}$/.test(l)) return l;
  }
  return null;
}

export async function numbering(doc, i) {
  let labels = null;
  try { labels = await doc.pdf.getPageLabels(); } catch { /* nessuna etichetta */ }
  const pt = await pageText(doc, i);
  return { index: i + 1, total: doc.pages.length, label: labels?.[i] || null, printed: printedNumber(pt.text) };
}

// Testo continuo di più pagine, con la mappa per tornare a (pagina, posizione).
async function joinPages(doc, from, to) {
  const parts = [];
  let text = '';
  for (let p = from; p <= to; p += 1) {
    const pt = await pageText(doc, p);
    parts.push({ page: p, start: text.length, pt });
    text += `${pt.text}\n`;
  }
  return { text, parts, lower: norm(text) };
}

function toPagePos(joined, off) {
  let part = joined.parts[0];
  for (const p of joined.parts) if (p.start <= off) part = p;
  return { page: part.page, off: off - part.start, part };
}

// Confini della frase che contiene la posizione: punto, punto e virgola, a capo seguito da «2.» o «b.».
function sentenceAround(text, from, to, lo, hi) {
  let a = from;
  while (a > lo) {
    const c = text[a - 1];
    if ((c === '.' || c === ';' || c === ':') && /\s/.test(text[a] || ' ') && !/\d/.test(text[a - 2] || '')) break;
    if (c === '\n' && /^\s*(?:\d{1,2}\.|[a-z]\.|\([a-z0-9]+\))\s/.test(text.slice(a, a + 6))) break;
    a -= 1;
  }
  let b = to;
  while (b < hi) {
    const c = text[b];
    if ((c === '.' || c === ';') && (/\s/.test(text[b + 1] || ' ')) && !/\d/.test(text[b - 1] || '')) { b += 1; break; }
    if (c === '\n' && /^\s*(?:\d{1,2}\.|[a-z]\.|\([a-z0-9]+\))\s/.test(text.slice(b + 1, b + 7))) break;
    b += 1;
  }
  while (/\s/.test(text[a] || '') && a < b) a += 1;
  return [a, Math.min(b, hi)];
}

function quadsFor(joined, a, b) {
  const byPage = new Map();
  let unsure = false;
  let ocr = false;
  for (const part of joined.parts) {
    const s = Math.max(a, part.start) - part.start;
    const e = Math.min(b, part.start + part.pt.text.length) - part.start;
    if (e <= s) continue;
    const ws = part.pt.words.filter((w) => w.off < e && w.off + w.str.length > s);
    if (!ws.length) continue;
    if (part.pt.ocr) ocr = true;
    if (ws.some((w) => w.ocr && w.conf < LOW_CONF)) unsure = true;
    byPage.set(part.page, { quads: mergeQuads(ws), unsure: ws.filter((w) => w.ocr && w.conf < LOW_CONF).map((w) => w.quad) });
  }
  return { byPage, unsure, ocr };
}

const tidy = (s) => s.replace(/-\n(?=[a-zà-ÿ])/g, '').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

// Tutte le occorrenze di una frase, tollerando a capo, spazi doppi e punteggiatura diversa fra le parole
// (a voce «banca emittente» deve trovare anche «banca\nemittente» o «banca - emittente»).
export async function findPhrase(doc, phrase, { page = null, cancelled = () => false } = {}) {
  const words = norm(phrase).split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return [];
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![a-z0-9])${words.map(esc).join('[^a-z0-9]{1,6}')}(?![a-z0-9])`, 'g');
  const hits = [];
  const pages = page != null ? [page] : [...Array(doc.pages.length).keys()];
  for (const p of pages) {
    if (cancelled()) break;
    const pt = await pageText(doc, p);
    for (const m of pt.lower.matchAll(re)) {
      const a = m.index; const b = a + m[0].length;
      const ws = pt.words.filter((w) => w.off < b && w.off + w.str.length > a);
      if (!ws.length) continue;
      hits.push({
        page: p, quads: mergeQuads(ws), text: tidy(pt.text.slice(a, b)), ocr: !!pt.ocr,
        unsure: ws.filter((w) => w.ocr && w.conf < LOW_CONF).map((w) => w.quad),
        snippet: tidy(pt.text.slice(Math.max(0, a - 40), Math.min(pt.text.length, b + 40))),
      });
    }
  }
  return hits;
}

// Cerca l'articolo (e, se chiesto, le parole dentro l'articolo). Non inventa nulla: se non trova lo dice.
export async function locate(doc, { article, keywords }, cancelled = () => false) {
  const n = doc.pages.length;
  let scanned = 0;
  const seenArticles = [];
  if (!article) {
    // Solo parole: prima occorrenza nel documento.
    const needle = norm(keywords);
    for (let p = 0; p < n; p += 1) {
      if (cancelled()) return { found: false, reason: 'annullato' };
      const pt = await pageText(doc, p);
      if (pt.text.replace(/\s/g, '').length < 20 && !pt.ocr) scanned += 1;
      const at = pt.lower.indexOf(needle);
      if (at >= 0) {
        const joined = await joinPages(doc, p, Math.min(n - 1, p + 1));
        const [a, b] = sentenceAround(joined.text, at, at + needle.length, 0, joined.text.length);
        return finish(doc, joined, a, b, null, keywords);
      }
    }
    return { found: false, reason: scanned === n ? 'scansione' : 'parole-assenti', keywords };
  }

  const want = normNum(article);
  for (let p = 0; p < n; p += 1) {
    if (cancelled()) return { found: false, reason: 'annullato' };
    const pt = await pageText(doc, p);
    if (pt.text.replace(/\s/g, '').length < 20 && !pt.ocr) scanned += 1;
    for (const hd of headingsOf(pt.text)) {
      if (!seenArticles.includes(hd.num)) seenArticles.push(hd.num);
      if (hd.num !== want) continue;
      // Trovato il titolo: l'articolo finisce al titolo dell'articolo successivo.
      const joined = await joinPages(doc, p, Math.min(n - 1, p + MAX_ARTICLE_PAGES));
      const start = joined.parts[0].start + hd.off;
      let end = joined.text.length;
      for (const part of joined.parts) {
        for (const h2 of headingsOf(part.pt.text)) {
          const o = part.start + h2.off;
          if (o > start && o < end) { end = o; break; }
        }
        if (end < joined.text.length) break;
      }
      const head = { num: hd.num, title: hd.line, page: p };
      if (keywords) {
        const needle = norm(keywords);
        // Prima nel testo dell'articolo (dopo il titolo): la citazione utile è il passaggio, non il titolo.
        const bodyStart = Math.min(end, joined.text.indexOf('\n', start) + 1 || start);
        let at = joined.lower.indexOf(needle, bodyStart);
        if (at < 0 || at >= end) at = joined.lower.indexOf(needle, start);
        if (at < 0 || at >= end) {
          return { found: false, reason: 'parole-assenti-articolo', article: head, keywords, articleText: tidy(joined.text.slice(start, end)).slice(0, 400) };
        }
        const [a, b] = sentenceAround(joined.text, at, at + needle.length, start, end);
        return finish(doc, joined, a, b, head, keywords, { start, end });
      }
      // Solo l'articolo: titolo e primo comma (fino al secondo comma numerato o 700 caratteri).
      const firstLineEnd = joined.text.indexOf('\n', start);
      let b = end;
      const second = joined.text.slice(firstLineEnd + 1, end).search(/\n\s*(?:2\.|b\.|\(2\)|\(b\))\s/);
      if (second >= 0) b = firstLineEnd + 1 + second;
      if (b - start > 700) { const cut = joined.text.lastIndexOf('.', start + 700); b = cut > start ? cut + 1 : start + 700; }
      const r = await finish(doc, joined, start, b, head, null, { start, end }, end > b);
      // Per l'evidenziazione: tutto l'articolo, dal titolo all'articolo successivo (anche su più pagine).
      const all = quadsFor(joined, start, end);
      r.fullHighlight = all.byPage;
      r.fullPages = [...all.byPage.keys()];
      return r;
    }
  }
  return { found: false, reason: scanned === n ? 'scansione' : 'articolo-assente', article: { num: want }, articles: seenArticles };
}

async function finish(doc, joined, a, b, head, keywords, span, truncated = false) {
  const q = quadsFor(joined, a, b);
  const pos = toPagePos(joined, a);
  const before = span ? (() => { const [x] = sentenceAround(joined.text, Math.max(span.start, a - 2), Math.max(span.start, a - 2), span.start, a); return tidy(joined.text.slice(x, a)); })() : '';
  const after = span ? (() => { const [, y] = sentenceAround(joined.text, Math.min(span.end, b + 1), Math.min(span.end, b + 1), b, span.end); return tidy(joined.text.slice(b, y)); })() : '';
  return {
    found: true, article: head, keywords,
    quote: tidy(joined.text.slice(a, b)),
    rawQuote: joined.text.slice(a, b),
    context: { before: before === tidy(joined.text.slice(a, b)) ? '' : before, after },
    page: pos.page, pages: [...q.byPage.keys()], highlight: q.byPage,
    ocr: q.ocr, unsure: q.unsure, truncated,
    numbering: await numbering(doc, pos.page),
    headingNumbering: head && head.page !== pos.page ? await numbering(doc, head.page) : null,
  };
}
