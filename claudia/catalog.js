// Claudia: raccolta autorizzata e schede dei documenti (titolo, lingua, giurisdizione, edizione).
// Le schede si propongono in automatico dai metadati e dalle prime pagine; l'utente può correggerle.
import { openPdf } from '../docview.js';
import { norm, pageText } from '../text.js';
import { ENGINE, INDEX_VERSION } from '../ocr.js';
import { baseName } from '../core.js';

// Documento aperto "in sottofondo", senza scheda: basta per leggerne il testo.
export class HeadlessDoc {
  static async open(path) {
    const meta = await host.openDoc(path);
    const d = new HeadlessDoc();
    d.path = path;
    d.meta = meta;
    try {
      d.pdf = await openPdf(meta, () => { throw new Error('PDF protetto da password'); });
    } catch (e) { host.closeDoc(meta.token); throw e; }
    d.pages = Array.from({ length: d.pdf.numPages }, (_, i) => ({ i }));
    d.textCache = new Map();
    d.pageCache = new Map();
    // Se il documento è una scansione già riconosciuta, si usa il suo indice OCR.
    try {
      const hash = await host.ocrLookup({ path, size: meta.size, mtime: meta.mtime });
      const idx = hash ? await host.ocrGet(hash) : null;
      if (idx && idx.version === INDEX_VERSION && idx.engine === ENGINE && idx.pageCount === d.pages.length) d.ocr = idx;
    } catch { /* nessun indice */ }
    return d;
  }

  getPage(i) {
    if (!this.pageCache.has(i)) {
      const p = this.pdf.getPage(i + 1);
      p.catch(() => {}); // se il documento viene chiuso nel frattempo, l'errore non interessa
      this.pageCache.set(i, p);
    }
    return this.pageCache.get(i);
  }

  // Si chiude solo dopo che le letture di pagina in corso sono finite: altrimenti PDF.js segnala
  // "Transport destroyed" per richieste ormai inutili.
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const pending = [...this.pageCache.values(), ...this.textCache.values()];
    await Promise.allSettled(pending);
    host.closeDoc(this.meta.token);
    this.pdf.loadingTask.destroy().catch(() => {});
  }
}

const IT_WORDS = ['il', 'la', 'di', 'che', 'e', 'per', 'del', 'della', 'delle', 'sono', 'non', 'un', 'una', 'dei', 'nel', 'alla', 'presente', 'articolo'];
const EN_WORDS = ['the', 'of', 'and', 'to', 'in', 'is', 'shall', 'be', 'for', 'that', 'by', 'this', 'with', 'on', 'article', 'are'];

export function detectLang(text) {
  const words = norm(text).split(/[^a-z']+/);
  let it = 0; let en = 0;
  for (const w of words) { if (IT_WORDS.includes(w)) it += 1; if (EN_WORDS.includes(w)) en += 1; }
  if (it + en < 5) return null;
  return it >= en ? 'it' : 'en';
}

export function detectJurisdiction(text) {
  if (/\b(UE|Unione europea|European Union|Official Journal of the European Union|Gazzetta ufficiale dell'Unione)\b|\((UE|EU)\)/i.test(text)) return 'UE';
  if (/Repubblica italiana|Gazzetta Ufficiale della Repubblica|decreto legislativo|D\.\s?Lgs|\blegge n\./i.test(text)) return 'Italia';
  if (/\bICC\b|International Chamber of Commerce|Camera di Commercio Internazionale|\bUCP\b|\bISBP\b/i.test(text)) return 'ICC';
  return null;
}

export function detectEdition(text) {
  const m = text.match(/(testo consolidato|versione consolidata|consolidated (?:text|version)|versione originale|edizione|edition|revision|revisione)[^\n]{0,40}?((?:\d{1,2}[./ ](?:\d{1,2}|[a-z]+)[./ ])?((?:19|20)\d{2}))/i);
  if (m) return `${m[1].toLowerCase()} ${m[3]}`;
  const y = text.match(/\b(19|20)\d{2}\b/);
  return y ? y[0] : null;
}

const cleanTitle = (t) => (t || '').replace(/\s+/g, ' ').trim();

// Scheda automatica di un PDF (le correzioni dell'utente, in entry.user, hanno sempre la precedenza).
export async function describe(path) {
  const d = await HeadlessDoc.open(path);
  try {
    const { info } = await d.pdf.getMetadata().catch(() => ({ info: {} }));
    let text = '';
    for (let i = 0; i < Math.min(3, d.pages.length); i += 1) text += `${(await pageText(d, i)).text}\n`;
    const title = cleanTitle(info?.Title) || cleanTitle(text.split('\n').find((l) => l.trim().length > 6)) || baseName(path).replace(/\.pdf$/i, '');
    const all = `${title}\n${baseName(path)}\n${text}`;
    return {
      path, size: d.meta.size, mtime: d.meta.mtime, pages: d.pages.length,
      title, lang: detectLang(all), jurisdiction: detectJurisdiction(all), edition: detectEdition(`${title}\n${text}`),
      scanned: text.replace(/\s/g, '').length < 40 && !d.ocr,
    };
  } finally { d.destroy(); }
}

// Valori effettivi della scheda: quelli corretti dall'utente prevalgono su quelli automatici.
export const card = (e) => ({ ...e, ...(e.user || {}) });

// Aggiorna le schede della raccolta: nuove, cambiate o sparite. Restituisce quante ne ha lette.
export async function refreshCatalog(app, onProgress = () => {}) {
  const c = app.settings.claudia;
  const roots = [...c.folders, ...(c.files || [])];
  const files = roots.length ? await host.scanFolders(roots) : [];
  const seen = new Set();
  let read = 0;
  for (const [k, f] of files.entries()) {
    seen.add(f.path);
    const old = c.docs[f.path];
    if (old && old.size === f.size && Math.round(old.mtime) === Math.round(f.mtime) && !old.scanned) continue;
    onProgress(k + 1, files.length, f.name);
    try {
      const e = await describe(f.path);
      c.docs[f.path] = { ...e, user: old?.user };
      read += 1;
    } catch (err) {
      c.docs[f.path] = { path: f.path, size: f.size, mtime: f.mtime, title: f.name.replace(/\.pdf$/i, ''), error: String(err.message || err), user: old?.user };
    }
  }
  for (const p of Object.keys(c.docs)) if (!seen.has(p)) delete c.docs[p];
  host.settingsSet({ claudia: c });
  return read;
}

// --- Scelta del documento a partire dalle parole dell'utente --------------------------------------

const STOP = new Set(['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una', 'uno', 'di', 'del', 'della', 'dello', 'dei', 'degli', 'delle', 'a', 'al', 'alla', 'ai', 'da', 'dal', 'dalla',
  'in', 'nel', 'nella', 'su', 'sul', 'sulla', 'per', 'con', 'e', 'o', 'pdf', 'documento', 'file', 'testo', 'copia', 'the', 'of', 'on', 'and', 'apri', 'mio', 'quel', 'quello']);
const SYN = {
  normativa: ['regolamento', 'regulation', 'direttiva', 'directive', 'decreto', 'legge', 'norme', 'normativa'],
  regolamento: ['regolamento', 'regulation'], regulation: ['regolamento', 'regulation'],
  pagamenti: ['pagamenti', 'pagamento', 'payment', 'payments'], pagamento: ['pagamenti', 'pagamento', 'payment'],
  decreto: ['decreto'], crediti: ['crediti', 'credito', 'credit', 'credits'], scansione: ['scansione', 'scanned', 'scan'], scansionata: ['scansione', 'scanned', 'scan'],
  consolidato: ['consolidato', 'consolidata', 'consolidated'], consolidata: ['consolidato', 'consolidata', 'consolidated'], originale: ['originale', 'original'],
};
const LANG_HINT = { italiano: 'it', italiana: 'it', inglese: 'en', english: 'en', ita: 'it', eng: 'en' };

export function tokens(s) { return norm(s || '').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)); }

// Punteggio di somiglianza fra la richiesta ("il regolamento pagamenti in italiano") e una scheda.
export function score(query, entry) {
  const e = card(entry);
  const hay = new Set(tokens(`${e.title} ${baseName(e.path)} ${e.jurisdiction || ''} ${e.edition || ''}`));
  if (e.jurisdiction === 'UE') { hay.add('ue'); hay.add('eu'); hay.add('europea'); hay.add('europeo'); }
  if (e.jurisdiction === 'Italia') hay.add('italia');
  let s = 0;
  let wanted = null;
  for (const t of tokens(query)) {
    if (LANG_HINT[t]) { wanted = LANG_HINT[t]; continue; }
    // Un anno indica l'edizione: conta solo nel campo edizione (nel titolo può far parte del numero, «2024/77»).
    if (/^(19|20)\d{2}$/.test(t)) { const ed = e.edition || ''; s += ed.includes(t) ? 2 : (/\b(19|20)\d{2}\b/.test(ed) ? -1 : 0); continue; }
    const alts = SYN[t] || [t];
    if (alts.some((a) => hay.has(a) || [...hay].some((h) => h.length > 4 && a.length > 4 && (h.startsWith(a.slice(0, 5)) || a.startsWith(h.slice(0, 5)))))) s += 1;
  }
  // Lingua: dalla scheda; per i file trovati solo per nome (lingua sconosciuta) conta se il nome la indica.
  if (wanted && e.lang) s += e.lang === wanted ? 1.5 : -3;
  else if (wanted) s += (wanted === 'it' ? /\b(?:ita|it|italiano|italian)\b/ : /\b(?:eng?|english|inglese)\b/).test(norm(e.title).replace(/[^a-z0-9]+/g, ' ')) ? 1 : 0;
  return s;
}

// Prima i documenti della raccolta (con le schede), poi i PDF dell'indice del dispositivo (solo il nome).
export function rank(app, query) {
  const docs = Object.values(app.settings.claudia.docs);
  const known = new Set(docs.map((e) => e.path.toLowerCase()));
  // Prima scrematura veloce dell'indice (anche 100.000 file): basta che il nome contenga una delle parole.
  const want = tokens(query).filter((t) => !LANG_HINT[t]).map((t) => (SYN[t] || [t]).map((a) => a.slice(0, 5))).flat();
  const extra = want.length ? (app.fileIndex?.files || []).filter((e) => {
    const k = e.key || (e.key = norm(e.path));
    return want.some((w) => k.includes(w)) && !known.has(e.path.toLowerCase());
  }) : [];
  // Fra i file dell'indice (anche decine di migliaia): conta di più il nome che contiene le parole nell'ordine
  // detto («UCP 600» → «UCP_600_…»); a parità, il nome più corto e poi il file più recente.
  const flat = (x) => ` ${norm(x).replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const q = flat(tokens(query).join(' '));
  const bonus = (e) => (q.trim() && flat(e.title).includes(q) ? 0.5 : 0);
  // Le parole che compaiono nella cartella (non nel nome) aiutano a scegliere fra copie con lo stesso nome.
  const qt = tokens(query).filter((t) => !LANG_HINT[t] && t.length > 2);
  const inDir = (e) => { const d = norm(e.path.replace(/[\\/][^\\/]*$/, '')); const n = norm(e.title); return 0.3 * qt.filter((t) => d.includes(t) && !n.includes(t)).length; };
  return [...docs.map((e) => ({ entry: e, score: score(query, e) + 0.25 + bonus(e) })), ...extra.map((e) => ({ entry: e, score: score(query, e) + bonus(e) + inDir(e) }))]
    .filter((x) => x.score > 0.25)
    .sort((a, b) => b.score - a.score || (a.entry.indexed ? 1 : 0) - (b.entry.indexed ? 1 : 0)
      || a.entry.title.length - b.entry.title.length || (b.entry.mtime || 0) - (a.entry.mtime || 0));
}
