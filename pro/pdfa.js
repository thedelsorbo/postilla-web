// Conversione in PDF/A-2b (o PDF/A-3b se ci sono allegati), il formato per l'archiviazione a lungo termine
// e la conservazione (0.9.0). Si lavora su una copia; l'originale non cambia. Cosa si fa:
// - caratteri non incorporati: si incorporano caratteri liberi equivalenti già presenti in Postilla
//   (Liberation Sans per Helvetica/Arial, con le stesse misure; Foxit Serif e Foxit Fixed per Times e Courier);
// - profilo colore sRGB (OutputIntent), metadati XMP coerenti con le proprietà del documento, identificativo del file;
// - via JavaScript, azioni non ammesse (avvio di programmi, suoni, filmati…), trasferimenti e interpolazione
//   delle immagini; annotazioni sempre stampabili; allegati marcati come richiesto dal PDF/A-3.
// Il risultato non è certificato: Postilla controlla i requisiti principali, ma la verifica ufficiale si fa con
// un validatore (per esempio veraPDF). Tutto avviene sul dispositivo.
import { h, toast, ask, modal, baseName } from '../core.js';
import { buildPdf } from '../pdfio.js';

const L = () => window.PDFLib;
const N = (s) => L().PDFName.of(s);
const LIB = `${new URL('../node_modules/', import.meta.url).href}pdfjs-dist/standard_fonts/`;

// --- Profilo colore sRGB (ICC v2), costruito qui: nessun file esterno ------------------------------------
export function srgbProfile() {
  const enc = (s) => [...s].map((c) => c.charCodeAt(0));
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const s15 = (v) => u32(Math.round(v * 65536) >>> 0);
  const pad4 = (a) => { while (a.length % 4) a.push(0); return a; };
  const desc = (t) => pad4([...enc('desc'), 0, 0, 0, 0, ...u32(t.length + 1), ...enc(t), 0, ...u32(0), ...u32(0), 0, 0, 0, ...new Array(67).fill(0)]);
  const text = (t) => pad4([...enc('text'), 0, 0, 0, 0, ...enc(t), 0]);
  const xyz = (x, y, z) => [...enc('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
  // Curva sRGB vera (non un gamma 2,2 approssimato), 1024 punti.
  const curve = () => {
    const n = 1024; const out = [...enc('curv'), 0, 0, 0, 0, ...u32(n)];
    for (let i = 0; i < n; i += 1) {
      const v = i / (n - 1);
      const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      const q = Math.round(lin * 65535); out.push((q >> 8) & 255, q & 255);
    }
    return pad4(out);
  };
  const trc = curve();
  const tags = [
    ['desc', desc('sRGB IEC61966-2.1 (Postilla)')], ['cprt', text('Nessun diritto riservato: profilo generato da Postilla')],
    ['wtpt', xyz(0.9642, 1, 0.8249)],
    ['rXYZ', xyz(0.4360747, 0.2225045, 0.0139322)], ['gXYZ', xyz(0.3850649, 0.7168786, 0.0971045)], ['bXYZ', xyz(0.1430804, 0.0606169, 0.7141733)],
    ['rTRC', trc], ['gTRC', trc], ['bTRC', trc],
  ];
  const tableLen = 4 + tags.length * 12;
  let off = 128 + tableLen;
  const table = [...u32(tags.length)]; const data = [];
  const seen = new Map();
  for (const [sig, bytes] of tags) {
    if (!seen.has(bytes)) { seen.set(bytes, off); data.push(...bytes); off += bytes.length; }
    table.push(...enc(sig), ...u32(seen.get(bytes)), ...u32(bytes.length));
  }
  const size = 128 + tableLen + data.length;
  const now = new Date();
  const u16 = (v) => [(v >> 8) & 255, v & 255];
  const header = [...u32(size), 0, 0, 0, 0, 0x02, 0x10, 0, 0, ...enc('mntr'), ...enc('RGB '), ...enc('XYZ '),
    ...u16(now.getUTCFullYear()), ...u16(now.getUTCMonth() + 1), ...u16(now.getUTCDate()), ...u16(now.getUTCHours()), ...u16(now.getUTCMinutes()), ...u16(now.getUTCSeconds()),
    ...enc('acsp'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0),
    ...s15(0.9642), ...s15(1), ...s15(0.8249), 0, 0, 0, 0];
  while (header.length < 128) header.push(0);
  return new Uint8Array([...header, ...table, ...data]);
}

// --- Caratteri sostitutivi ----------------------------------------------------------------------------
const WIN = (() => {
  const m = new Map();
  for (let c = 32; c < 127; c += 1) m.set(c, c);
  [0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0, 0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178]
    .forEach((u, k) => { if (u) m.set(128 + k, u); });
  for (let c = 160; c < 256; c += 1) m.set(c, c);
  return m;
})();
const NAMES = 'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde'.split(' ');
const LATIN = 'space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis'.split(' ');
const GLYPH = (() => {
  const m = new Map();
  NAMES.forEach((n, k) => m.set(n, 32 + k));
  LATIN.forEach((n, k) => { if (!m.has(n)) m.set(n, 160 + k); });
  Object.entries({ Euro: 0x20AC, quotesinglbase: 0x201A, florin: 0x192, quotedblbase: 0x201E, ellipsis: 0x2026, dagger: 0x2020, daggerdbl: 0x2021, circumflex: 0x2C6, perthousand: 0x2030, Scaron: 0x160, guilsinglleft: 0x2039, OE: 0x152, Zcaron: 0x17D, quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201C, quotedblright: 0x201D, bullet: 0x2022, endash: 0x2013, emdash: 0x2014, tilde: 0x2DC, trademark: 0x2122, scaron: 0x161, guilsinglright: 0x203A, oe: 0x153, zcaron: 0x17E, Ydieresis: 0x178, dotlessi: 0x131, fi: 0xFB01, fl: 0xFB02, minus: 0x2212, fraction: 0x2044, nbspace: 0xA0, sfthyphen: 0xAD })
    .forEach(([n, u]) => m.set(n, u));
  return m;
})();
const nameToUni = (n) => { if (GLYPH.has(n)) return GLYPH.get(n); const m = /^uni([0-9A-F]{4})$/i.exec(n) || /^u([0-9A-F]{4,6})$/i.exec(n); return m ? parseInt(m[1], 16) : 0; };

// Da codice del carattere a Unicode, secondo la codifica del dizionario del font.
function decoder(fd) {
  const { PDFDict, PDFName } = L();
  const map = new Map(WIN);
  const enc = fd.lookup(N('Encoding'));
  if (enc instanceof PDFDict) {
    const diff = enc.lookup(N('Differences'));
    if (diff?.asArray) {
      let code = 0;
      for (const it of diff.asArray()) {
        if (it.asNumber) code = it.asNumber();
        else if (it instanceof PDFName) { const u = nameToUni(it.decodeText()); if (u) map.set(code, u); else map.delete(code); code += 1; }
      }
    }
  }
  return (c) => map.get(c) || 0;
}

const fontCache = new Map();
const fetchBytes = (name) => {
  if (!fontCache.has(name)) fontCache.set(name, fetch(LIB + name).then((r) => { if (!r.ok) throw new Error(name); return r.arrayBuffer(); }).then((b) => new Uint8Array(b)));
  return fontCache.get(name);
};

// Nome del carattere nel programma CFF (prima voce dell'indice dei nomi).
function cffName(b) {
  const hdr = b[2]; const count = (b[hdr] << 8) | b[hdr + 1];
  if (!count) return 'Postilla';
  const offSize = b[hdr + 2];
  const rd = (p) => { let v = 0; for (let k = 0; k < offSize; k += 1) v = (v << 8) | b[p + k]; return v; };
  const o1 = rd(hdr + 3); const o2 = rd(hdr + 3 + offSize);
  const base = hdr + 3 + (count + 1) * offSize - 1;
  return String.fromCharCode(...b.slice(base + o1, base + o2)).replace(/[^\x21-\x7e]/g, '') || 'Postilla';
}

// Che sostituto usare per un carattere non incorporato.
function familyOf(name, flags) {
  const k = String(name).replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z]/g, '');
  const bold = /bold|black|heavy|semibold|demi/.test(k) || !!(flags & 0x40000);
  const italic = /italic|oblique/.test(k) || !!(flags & 64);
  if (/symbol|dingbat|wingding|webding/.test(k) || (flags & 4 && !(flags & 32))) return null; // simbolici: non sostituibili
  const kind = /courier|mono|consol|fixed/.test(k) ? 'mono' : (/times|serif|roman|garamond|georgia|cambria|book|palatino|century/.test(k) && !/sans/.test(k) ? 'serif' : 'sans');
  return { kind, bold, italic };
}

async function substitute(doc, fam, scratch) {
  const { StandardFonts } = L();
  const v = (fam.bold ? 1 : 0) + (fam.italic ? 2 : 0);
  if (fam.kind === 'sans') {
    const file = ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf'][v];
    const bytes = await fetchBytes(file);
    const fk = window.fontkit.create(bytes);
    const k = 1000 / fk.unitsPerEm;
    return {
      file, bytes, type: 'TrueType', name: fk.postscriptName || file.replace('.ttf', ''),
      width: (u) => { if (!u) return 0; const g = fk.glyphForCodePoint(u); return g && g.id ? Math.round(g.advanceWidth * k) : 0; },
      desc: { FontBBox: fk.bbox ? [fk.bbox.minX, fk.bbox.minY, fk.bbox.maxX, fk.bbox.maxY].map((x) => Math.round(x * k)) : [-200, -250, 1100, 950], Ascent: Math.round(fk.ascent * k), Descent: Math.round(fk.descent * k), CapHeight: Math.round((fk.capHeight || 700 / k) * k), ItalicAngle: fk.italicAngle || 0, StemV: fam.bold ? 140 : 80 },
    };
  }
  const file = fam.kind === 'serif' ? ['FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifItalic.pfb', 'FoxitSerifBoldItalic.pfb'][v] : ['FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedItalic.pfb', 'FoxitFixedBoldItalic.pfb'][v];
  const bytes = await fetchBytes(file);
  // Misure: quelle dei caratteri standard equivalenti (Times, Courier), con cui i Foxit sono compatibili.
  const std = fam.kind === 'serif' ? [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic][v] : [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique][v];
  const pf = await scratch.embedFont(std);
  const m = pf.embedder?.font || {};
  return {
    file, bytes, type: 'Type1C', name: cffName(bytes),
    width: (u) => { if (!u) return 0; try { return Math.round(pf.widthOfTextAtSize(String.fromCodePoint(u), 1000)); } catch { return 0; } },
    desc: { FontBBox: m.FontBBox || [-200, -250, 1100, 950], Ascent: m.Ascender || 700, Descent: m.Descender || -200, CapHeight: m.CapHeight || 660, ItalicAngle: m.ItalicAngle || 0, StemV: fam.bold ? 140 : 80 },
  };
}

// Incorpora un sostituto al posto di ogni carattere semplice non incorporato. Restituisce cosa ha fatto.
async function embedMissingFonts(doc) {
  const { PDFDict, PDFArray, PDFName, PDFNumber } = L();
  const ctx = doc.context;
  const report = { fixed: [], left: [] };
  const scratch = await L().PDFDocument.create();
  const programs = new Map(); // file -> ref del programma del carattere
  const has = (desc) => desc instanceof PDFDict && (desc.get(N('FontFile')) || desc.get(N('FontFile2')) || desc.get(N('FontFile3')));
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.lookup(N('Type'))?.toString() !== '/Font') continue;
    const sub = obj.lookup(N('Subtype'))?.toString();
    const base = obj.lookup(N('BaseFont'))?.decodeText?.() || 'Sconosciuto';
    if (sub === '/Type3') continue;
    if (sub === '/Type0') {
      const kids = obj.lookup(N('DescendantFonts'));
      const kid = kids instanceof PDFArray ? ctx.lookup(kids.get(0)) : null;
      if (!(kid instanceof PDFDict) || !has(kid.lookup(N('FontDescriptor')))) report.left.push(base);
      continue;
    }
    if (sub !== '/Type1' && sub !== '/TrueType' && sub !== '/MMType1') continue;
    const desc0 = obj.lookup(N('FontDescriptor'));
    if (has(desc0)) continue;
    const flags = desc0 instanceof PDFDict ? desc0.lookup(N('Flags'))?.asNumber?.() || 0 : 0;
    const fam = familyOf(base, flags);
    if (!fam) { report.left.push(base); continue; }
    let s;
    try { s = await substitute(doc, fam, scratch); } catch (e) { console.warn('Sostituto non disponibile', e); report.left.push(base); continue; }
    if (!programs.has(s.file)) {
      const stream = s.type === 'TrueType' ? ctx.flateStream(s.bytes, { Length1: s.bytes.length }) : ctx.flateStream(s.bytes, { Subtype: 'Type1C' });
      programs.set(s.file, ctx.register(stream));
    }
    const dec = decoder(obj);
    const first = 0; const last = 255;
    const widths = [];
    for (let c = first; c <= last; c += 1) widths.push(s.width(dec(c)));
    const desc = ctx.obj({
      Type: 'FontDescriptor', FontName: s.name, Flags: 32 | (fam.italic ? 64 : 0) | (fam.kind === 'serif' ? 2 : 0) | (fam.kind === 'mono' ? 1 : 0),
      FontBBox: s.desc.FontBBox, ItalicAngle: s.desc.ItalicAngle, Ascent: s.desc.Ascent, Descent: s.desc.Descent, CapHeight: s.desc.CapHeight, StemV: s.desc.StemV,
      [s.type === 'TrueType' ? 'FontFile2' : 'FontFile3']: programs.get(s.file),
    });
    obj.set(N('Subtype'), N(s.type === 'TrueType' ? 'TrueType' : 'Type1'));
    obj.set(N('BaseFont'), N(s.name));
    obj.set(N('FirstChar'), PDFNumber.of(first));
    obj.set(N('LastChar'), PDFNumber.of(last));
    obj.set(N('Widths'), ctx.obj(widths));
    obj.set(N('FontDescriptor'), ctx.register(desc));
    // I TrueType non simbolici vogliono una codifica esplicita (WinAnsi, come quasi sempre nei PDF da Office).
    const enc = obj.get(N('Encoding'));
    if (!enc || (enc instanceof PDFName && !['/WinAnsiEncoding', '/MacRomanEncoding'].includes(enc.toString()))) {
      if (!(obj.lookup(N('Encoding')) instanceof PDFDict)) obj.set(N('Encoding'), N('WinAnsiEncoding'));
    }
    obj.delete(N('ToUnicode'));
    report.fixed.push(`${base} → ${s.name}`);
    void ref;
  }
  return report;
}

// --- Pulizia: cose non ammesse dal PDF/A --------------------------------------------------------------
const BAD_ACTIONS = ['/Launch', '/Sound', '/Movie', '/ResetForm', '/ImportData', '/JavaScript', '/Hide', '/SetOCGState', '/Rendition', '/Trans', '/GoTo3DView'];
function clean(doc, report) {
  const { PDFDict, PDFArray, PDFStream, PDFNumber, PDFName } = L();
  const ctx = doc.context;
  const cat = doc.catalog;
  // JavaScript del documento e azioni automatiche
  const names = cat.lookup(N('Names'));
  if (names instanceof PDFDict && names.get(N('JavaScript'))) { names.delete(N('JavaScript')); report.removed.push('JavaScript del documento'); }
  if (cat.get(N('AA'))) { cat.delete(N('AA')); report.removed.push('azioni automatiche del documento'); }
  const oa = cat.lookup(N('OpenAction'));
  if (oa instanceof PDFDict && BAD_ACTIONS.includes(oa.lookup(N('S'))?.toString())) { cat.delete(N('OpenAction')); report.removed.push('azione all\'apertura'); }
  const af = cat.lookup(N('AcroForm'));
  if (af instanceof PDFDict) { af.delete(N('NeedAppearances')); af.delete(N('XFA')); }
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFStream ? obj.dict : obj;
    if (!(d instanceof PDFDict)) continue;
    const type = d.lookup(N('Type'))?.toString();
    const subtype = d.lookup(N('Subtype'))?.toString();
    if (d.get(N('AA'))) { d.delete(N('AA')); if (!report.removed.includes('azioni automatiche')) report.removed.push('azioni automatiche'); }
    const act = d.lookup(N('A'));
    if (act instanceof PDFDict && BAD_ACTIONS.includes(act.lookup(N('S'))?.toString())) { d.delete(N('A')); if (!report.removed.includes('azioni non ammesse (programmi, suoni, filmati, script)')) report.removed.push('azioni non ammesse (programmi, suoni, filmati, script)'); }
    if (type === '/ExtGState') { for (const k of ['TR', 'TR2']) if (d.get(N(k)) && d.lookup(N(k))?.toString() !== '/Default') d.delete(N(k)); }
    if (subtype === '/Image' && d.get(N('Interpolate'))) d.set(N('Interpolate'), ctx.obj(false));
    if (type === '/Annot' || (d.get(N('Rect')) && subtype && d.get(N('P')))) {
      if (subtype !== '/Popup') {
        const F = d.lookup(N('F'))?.asNumber?.() || 0;
        d.set(N('F'), PDFNumber.of((F | 4) & ~(1 | 2 | 32 | 256)));
      }
    }
  }
  // Allegati (PDF/A-3): relazione con il documento dichiarata.
  const ef = names instanceof PDFDict ? names.lookup(N('EmbeddedFiles')) : null;
  const specs = [];
  const walk = (node) => {
    if (!(node instanceof PDFDict)) return;
    const arr = node.lookup(N('Names'));
    if (arr instanceof PDFArray) for (let i = 1; i < arr.size(); i += 2) specs.push(arr.get(i));
    const kids = node.lookup(N('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i += 1) walk(kids.lookup(i));
  };
  walk(ef);
  for (const r of specs) {
    const spec = ctx.lookup(r);
    if (!(spec instanceof PDFDict)) continue;
    if (!spec.get(N('AFRelationship'))) spec.set(N('AFRelationship'), N('Unspecified'));
    const emb = spec.lookup(N('EF'))?.lookup?.(N('F'));
    if (emb instanceof PDFStream && !emb.dict.get(N('Subtype'))) emb.dict.set(N('Subtype'), N('application/octet-stream'));
    void PDFName;
  }
  if (specs.length) cat.set(N('AF'), ctx.obj(specs));
  return specs.length;
}

const xmlEsc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Stesso istante e stesso formato delle date nelle proprietà (pdf-lib le scrive in UTC, «Z»).
const isoTz = (d) => new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');

// opts: { title } ; restituisce { bytes, report }
export async function convertToPdfA(input, opts = {}) {
  const { PDFDocument, PDFHexString, PDFDict } = L();
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) throw new Error('Il PDF è protetto da password: togli prima la protezione (un PDF/A non può essere cifrato).');
  const report = { fonts: null, removed: [], attachments: 0, part: 2, warnings: [] };
  report.fonts = await embedMissingFonts(doc);
  report.attachments = clean(doc, report);
  report.part = report.attachments ? 3 : 2;
  const ctx = doc.context;
  // Profilo colore
  const icc = ctx.register(ctx.flateStream(srgbProfile(), { N: 3 }));
  doc.catalog.set(N('OutputIntents'), ctx.obj([ctx.obj({ Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFHexString.fromText('sRGB IEC61966-2.1'), Info: PDFHexString.fromText('sRGB IEC61966-2.1'), DestOutputProfile: icc })]));
  // Proprietà e metadati XMP con gli stessi valori.
  const now = new Date();
  const title = opts.title || doc.getTitle() || 'Documento';
  const author = doc.getAuthor() || '';
  const created = doc.getCreationDate() || now;
  doc.setTitle(title); if (author) doc.setAuthor(author);
  doc.setProducer('Postilla'); doc.setCreator(doc.getCreator() || 'Postilla');
  doc.setCreationDate(created); doc.setModificationDate(now);
  const creator = doc.getCreator();
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>${report.part}</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title)}</rdf:li></rdf:Alt></dc:title>${author ? `<dc:creator><rdf:Seq><rdf:li>${xmlEsc(author)}</rdf:li></rdf:Seq></dc:creator>` : ''}</rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreateDate>${isoTz(created)}</xmp:CreateDate><xmp:ModifyDate>${isoTz(now)}</xmp:ModifyDate><xmp:MetadataDate>${isoTz(now)}</xmp:MetadataDate><xmp:CreatorTool>${xmlEsc(creator)}</xmp:CreatorTool></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>Postilla</pdf:Producer></rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const meta = ctx.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(N('Metadata'), ctx.register(meta));
  // Lingua del documento (se manca) e niente parole chiave non riportate nell'XMP.
  if (!doc.catalog.get(N('Lang'))) doc.catalog.set(N('Lang'), PDFHexString.fromText(opts.lang || 'it-IT'));
  const info = doc.getInfoDict();
  for (const k of ['Keywords', 'Subject', 'Trapped', 'PostillaAnnotated']) if (info instanceof PDFDict) info.delete(N(k));
  // Identificativo del file (obbligatorio).
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  if (report.fonts.left.length) report.warnings.push(`Caratteri che non ho potuto incorporare: ${[...new Set(report.fonts.left)].join(', ')}. Il file potrebbe non superare la verifica PDF/A.`);
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes, report };
}

// Controllo rapido di un PDF già convertito (usato anche dalle prove): cosa c'è e cosa manca.
export async function inspectPdfA(input) {
  const { PDFDocument, PDFDict, PDFStream } = L();
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const ctx = doc.context;
  const out = { outputIntent: !!doc.catalog.get(N('OutputIntents')), xmpPart: null, id: !!ctx.trailerInfo.ID, notEmbedded: [], js: false };
  const m = doc.catalog.lookup(N('Metadata'));
  if (m instanceof PDFStream) { const t = new TextDecoder().decode(m.getContents ? m.getContents() : m.contents); out.xmpPart = (t.match(/<pdfaid:part>(\d)<\/pdfaid:part>/) || [])[1] || null; }
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.lookup(N('Type'))?.toString() !== '/Font') continue;
    const sub = obj.lookup(N('Subtype'))?.toString();
    if (sub === '/Type3' || sub === '/Type0') continue;
    const d = obj.lookup(N('FontDescriptor'));
    if (!(d instanceof PDFDict) || !(d.get(N('FontFile')) || d.get(N('FontFile2')) || d.get(N('FontFile3')))) out.notEmbedded.push(obj.lookup(N('BaseFont'))?.decodeText?.());
  }
  const names = doc.catalog.lookup(N('Names'));
  out.js = !!(names instanceof PDFDict && names.get(N('JavaScript')));
  return out;
}

// --- Finestra ----------------------------------------------------------------------------------------
export async function pdfaFlow(app, view, H = window.host) {
  view = view || app?.view;
  if (!view?.pdf) return null;
  const go = await ask('Converti in PDF/A (archiviazione)', 'Crea una copia nel formato PDF/A, adatto alla conservazione a lungo termine: caratteri incorporati, colori definiti, niente script. Le annotazioni diventano parte delle pagine. L\'originale non cambia.', [{ label: 'Annulla', value: 'no' }, { label: 'Crea la copia PDF/A', value: 'yes', primary: true }]);
  if (go !== 'yes') return null;
  const base = view.tab.path.replace(/\.pdf$/i, '');
  const dest = await H.pickSave(`${base} - PDFA.pdf`);
  if (!dest) return null;
  try {
    toast('Conversione in PDF/A…');
    await view.ready; app.tools.commitEditor();
    const src = await buildPdf(view, { flatten: true });
    const { bytes, report } = await convertToPdfA(src, { title: view.tab.name.replace(/\.pdf$/i, '') });
    await H.writeFile(dest, bytes);
    const lines = [`Creato ${baseName(dest)} (PDF/A-${report.part}b).`];
    if (report.fonts.fixed.length) lines.push(`Caratteri incorporati: ${report.fonts.fixed.length}.`);
    if (report.removed.length) lines.push(`Tolti: ${report.removed.join(', ')}.`);
    if (report.attachments) lines.push(`Gli allegati (${report.attachments}) restano: per questo il file è PDF/A-3.`);
    lines.push(...report.warnings);
    lines.push('Postilla controlla i requisiti principali; per una verifica ufficiale usa un validatore PDF/A (per esempio veraPDF).');
    const c = await ask('PDF/A creato', lines.join(' '), [{ label: 'Apri la copia', value: 'open' }, { label: 'OK', value: 'ok', primary: true }]);
    if (c === 'open') await app.open(dest);
    return { dest, report };
  } catch (e) {
    console.error(e);
    toast(`Conversione PDF/A non riuscita: ${e?.message || e}`, 'error');
    return null;
  }
}
void modal; void h;
