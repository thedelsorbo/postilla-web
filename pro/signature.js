// Firma digitale dei PDF (PAdES B-B) e controllo delle firme presenti.
// Tutto in JavaScript nella pagina, così funziona anche su Android.
// Usa window.forge (node-forge) per certificati e RSA, window.PDFLib (pdf-lib) per leggere il PDF.
//
// Sicurezza: il certificato .p12/.pfx e la password arrivano dall'utente al momento,
// restano solo in memoria e non vengono mai salvati né scritti nei log.
import { h, modal } from '../core.js';

// Testo da mostrare accanto ai risultati del controllo.
export const TRUST_NOTE = 'Postilla controlla due cose: che il documento non sia stato cambiato dopo la firma '
  + 'e che la firma sia stata fatta davvero con la chiave del certificato indicato. '
  + 'Non controlla se il certificato è affidabile: non verifica la catena fino a un ente certificatore '
  + 'riconosciuto (per esempio una firma qualificata), né se il certificato è stato revocato o era scaduto. '
  + 'Per un controllo con valore legale usa un verificatore ufficiale.';

const ENC_MSG = 'Il PDF è protetto con una password (cifrato). Togli prima la protezione, poi firma una copia.';
const RESERVE_MIN = 16384; // byte riservati alla firma: 32 768 caratteri esadecimali
const BR_WIDTH = 40; // spazio fisso per i numeri di /ByteRange

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsa: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  ecKey: '1.2.840.10045.2.1',
  cn: '2.5.4.3',
  o: '2.5.4.10',
};
const DIGESTS = {
  '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512',
};
const RSA_SIGS = {
  '1.2.840.113549.1.1.1': null, '1.2.840.113549.1.1.5': 'sha1', '1.2.840.113549.1.1.11': 'sha256', '1.2.840.113549.1.1.12': 'sha384', '1.2.840.113549.1.1.13': 'sha512',
};
const SUBTLE = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

// ---------- piccoli attrezzi sui byte ----------
const forgeLib = () => {
  if (!window.forge) throw new Error('Manca la libreria per la firma (node-forge).');
  return window.forge;
};
const pdfLib = () => {
  if (!window.PDFLib) throw new Error('Manca la libreria pdf-lib.');
  return window.PDFLib;
};
const toU8 = (b) => (b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b || []));
function u8ToBin(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
  return s;
}
const binToU8 = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i += 1) u[i] = s.charCodeAt(i) & 255; return u; };
const ascii = (s) => binToU8(s);
const binHex = (s) => { let o = ''; for (let i = 0; i < s.length; i += 1) o += s.charCodeAt(i).toString(16).padStart(2, '0'); return o; };
function concat(parts) {
  const n = parts.reduce((t, p) => t + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const latin1 = (u8, a, b) => u8ToBin(u8.subarray(a, b));

// Impronta (hash) di più pezzi di file; usa crypto.subtle se c'è, altrimenti forge.
async function digestParts(alg, parts) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && SUBTLE[alg]) {
    try {
      const buf = parts.length === 1 ? parts[0] : concat(parts);
      return u8ToBin(new Uint8Array(await subtle.digest(SUBTLE[alg], buf)));
    } catch { /* si ripiega su forge */ }
  }
  const md = forgeLib().md[alg].create();
  for (const p of parts) for (let i = 0; i < p.length; i += 65536) md.update(u8ToBin(p.subarray(i, i + 65536)));
  return md.digest().getBytes();
}
const mdBin = (alg, bin) => { const md = forgeLib().md[alg].create(); md.update(bin); return md; };

// ---------- DER: scrittura ----------
function derLen(n) {
  if (n < 128) return String.fromCharCode(n);
  let s = '';
  while (n > 0) { s = String.fromCharCode(n & 255) + s; n = Math.floor(n / 256); }
  return String.fromCharCode(0x80 | s.length) + s;
}
const tlv = (tag, ...parts) => { const c = parts.join(''); return String.fromCharCode(tag) + derLen(c.length) + c; };
const SEQ = (...p) => tlv(0x30, ...p);
const derOid = (o) => tlv(0x06, forgeLib().asn1.oidToDer(o).getBytes());
const OCT = (b) => tlv(0x04, b);
const NULL = '\x05\x00';
const INT1 = '\x02\x01\x01';
const cmpBin = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i += 1) { const d = a.charCodeAt(i) - b.charCodeAt(i); if (d) return d; } return a.length - b.length; };
const SETOF = (items) => tlv(0x31, ...[...items].sort(cmpBin)); // DER: gli elementi di un SET OF vanno in ordine

// ---------- DER: lettura (con le posizioni, per riprendere i byte originali) ----------
function tlvAt(s, pos) {
  if (pos + 2 > s.length) throw new Error('dati ASN.1 troncati');
  const tag = s.charCodeAt(pos);
  let p = pos + 1;
  if ((tag & 0x1f) === 0x1f) while (s.charCodeAt(p++) & 0x80);
  let len = s.charCodeAt(p++);
  if (len === 0x80) { // lunghezza indefinita (BER)
    const kids = [];
    let q = p;
    while (!(s.charCodeAt(q) === 0 && s.charCodeAt(q + 1) === 0)) {
      const k = tlvAt(s, q); kids.push(k); q = k.end;
      if (q >= s.length) throw new Error('dati ASN.1 troncati');
    }
    return { tag, start: pos, hs: p, ve: q, end: q + 2, kids };
  }
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + s.charCodeAt(p++);
  }
  const end = p + len;
  if (end > s.length) throw new Error('dati ASN.1 troncati');
  return { tag, start: pos, hs: p, ve: end, end };
}
function kidsOf(s, n) {
  if (n.kids) return n.kids;
  const out = [];
  let p = n.hs;
  while (p < n.ve) { const k = tlvAt(s, p); out.push(k); p = k.end; }
  n.kids = out;
  return out;
}
const valOf = (s, n) => s.slice(n.hs, n.ve);
const rawOf = (s, n) => s.slice(n.start, n.end);
const oidOf = (s, n) => forgeLib().asn1.derToOid(valOf(s, n));

function decodeStr(s, n) {
  const v = valOf(s, n);
  if (n.tag === 0x0c) { try { return forgeLib().util.decodeUtf8(v); } catch { return v; } }
  if (n.tag === 0x1e) { let o = ''; for (let i = 0; i + 1 < v.length; i += 2) o += String.fromCharCode((v.charCodeAt(i) << 8) | v.charCodeAt(i + 1)); return o; }
  return v; // PrintableString, IA5String, T61String: trattati come Latin-1
}
const SHORT = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.5': 'SERIALNUMBER', '2.5.4.42': 'G', '2.5.4.4': 'SN', '1.2.840.113549.1.9.1': 'E' };
function nameInfo(s, n) {
  const parts = [];
  for (const rdn of kidsOf(s, n)) {
    for (const atv of kidsOf(s, rdn)) {
      const [t, v] = kidsOf(s, atv);
      parts.push([oidOf(s, t), decodeStr(s, v)]);
    }
  }
  const get = (o) => parts.find((p) => p[0] === o)?.[1] || '';
  return { cn: get(OID.cn), o: get(OID.o), text: parts.map(([o, v]) => `${SHORT[o] || o}=${v}`).join(', ') };
}
function timeOf(s, n) {
  const v = valOf(s, n);
  const m = n.tag === 0x17 ? v.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z/) : v.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?/);
  if (!m) return null;
  let y = +m[1];
  if (n.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return new Date(Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
}

// Legge un certificato X.509 dai suoi byte DER (stringa binaria).
function parseCert(der) {
  const c = tlvAt(der, 0);
  const t = kidsOf(der, kidsOf(der, c)[0]);
  const i = t[0].tag === 0xa0 ? 1 : 0;
  const serialV = valOf(der, t[i]);
  const validity = kidsOf(der, t[i + 3]);
  const spki = t[i + 5];
  const alg = kidsOf(der, kidsOf(der, spki)[0])[0];
  return {
    der: rawOf(der, c),
    serialRaw: rawOf(der, t[i]),
    serial: binHex(serialV.length > 1 && serialV.charCodeAt(0) === 0 ? serialV.slice(1) : serialV).toUpperCase(),
    issuerRaw: rawOf(der, t[i + 2]),
    subjectRaw: rawOf(der, t[i + 4]),
    issuer: nameInfo(der, t[i + 2]),
    subject: nameInfo(der, t[i + 4]),
    notBefore: timeOf(der, validity[0]),
    notAfter: timeOf(der, validity[1]),
    spkiRaw: rawOf(der, spki),
    keyOid: oidOf(der, alg),
  };
}

// ---------- il file .p12 / .pfx ----------
function keyKind(oid) {
  if (oid === OID.ecKey) return 'EC';
  if (oid === '1.3.101.112' || oid === '1.3.101.113') return 'EdDSA';
  if (oid === '1.2.840.10040.4.1') return 'DSA';
  return oid || 'sconosciuto';
}
const EC_MSG = 'Il certificato usa una chiave a curve ellittiche (EC). Postilla per ora sa firmare solo con chiavi RSA: usa un certificato con chiave RSA.';

function openP12(p12, password) {
  const forge = forgeLib();
  const u8 = toU8(p12);
  if (!u8.length) throw new Error('Scegli prima il file del certificato (.p12 o .pfx).');
  let asn;
  try { asn = forge.asn1.fromDer(u8ToBin(u8), { strict: false, parseAllBytes: false }); } catch {
    throw new Error('Il file scelto non è un certificato .p12/.pfx valido.');
  }
  let store;
  try { store = forge.pkcs12.pkcs12FromAsn1(asn, false, password ?? ''); } catch (e) {
    if (/password|MAC|decrypt/i.test(String(e?.message))) throw new Error('Password del certificato sbagliata.');
    throw new Error('Il certificato non si riesce ad aprire: la password potrebbe essere sbagliata oppure il file non è nel formato .p12/.pfx.');
  }
  const P = forge.pki.oids;
  const keyBags = [...(store.getBags({ bagType: P.pkcs8ShroudedKeyBag })[P.pkcs8ShroudedKeyBag] || []), ...(store.getBags({ bagType: P.keyBag })[P.keyBag] || [])];
  const certBags = store.getBags({ bagType: P.certBag })[P.certBag] || [];
  const certs = certBags.map((b) => {
    const der = b.cert ? forge.asn1.toDer(forge.pki.certificateToAsn1(b.cert)).getBytes() : forge.asn1.toDer(b.asn1).getBytes();
    return { forgeCert: b.cert, info: parseCert(der) };
  });
  const rsaBag = keyBags.find((b) => b.key);
  if (!rsaBag) {
    const other = keyBags.find((b) => b.asn1);
    if (other) {
      let oid = '';
      try { oid = forge.asn1.derToOid(other.asn1.value[1].value[0].value); } catch { /* resta sconosciuto */ }
      if (keyKind(oid) === 'EC') throw new Error(EC_MSG);
      throw new Error(`La chiave del certificato è di un tipo non supportato (${keyKind(oid)}). Postilla sa firmare solo con chiavi RSA.`);
    }
    if (certs.some((c) => c.info.keyOid === OID.ecKey)) throw new Error(EC_MSG);
    throw new Error('Il file non contiene la chiave privata: serve il .p12/.pfx completo, non il solo certificato.');
  }
  const key = rsaBag.key;
  const own = certs.find((c) => c.forgeCert?.publicKey?.n && c.forgeCert.publicKey.n.equals(key.n));
  if (!own) throw new Error('Nel file non c’è il certificato che corrisponde alla chiave privata.');
  // Catena: prima il firmatario, poi chi l'ha emesso, e così via; in fondo gli altri.
  const chain = [own];
  const rest = certs.filter((c) => c !== own);
  for (let cur = own; ;) {
    const up = rest.find((c) => !chain.includes(c) && c.info.subjectRaw === cur.info.issuerRaw);
    if (!up) break;
    chain.push(up);
    cur = up;
  }
  for (const c of rest) if (!chain.includes(c)) chain.push(c);
  return { key, chain: chain.map((c) => c.info) };
}

const certSummary = (c, chainLen) => ({
  name: c.subject.cn || c.subject.o || c.subject.text,
  subject: c.subject.text,
  issuer: c.issuer.cn || c.issuer.o || c.issuer.text,
  serial: c.serial,
  notBefore: c.notBefore?.toISOString() || null,
  notAfter: c.notAfter?.toISOString() || null,
  expired: !!(c.notAfter && c.notAfter < new Date()),
  chainLength: chainLen,
});

// Apre il certificato solo per mostrarne il titolare (non restituisce la chiave).
export function readCertificate(p12, password) {
  const { chain } = openP12(p12, password);
  return certSummary(chain[0], chain.length);
}

// ---------- CMS (PKCS#7) SignedData staccato, con attributi CAdES ----------
function buildCms(key, chain, digest) {
  const signer = chain[0];
  const certHash = mdBin('sha256', signer.der).digest().getBytes();
  const issuerSerial = SEQ(SEQ(tlv(0xa4, signer.issuerRaw)), signer.serialRaw);
  const signingCertV2 = SEQ(SEQ(SEQ(OCT(certHash), issuerSerial))); // ESSCertIDv2, hash SHA-256 (predefinito)
  const attrs = [
    SEQ(derOid(OID.contentType), tlv(0x31, derOid(OID.data))),
    SEQ(derOid(OID.messageDigest), tlv(0x31, OCT(digest))),
    SEQ(derOid(OID.signingCertV2), tlv(0x31, signingCertV2)),
  ];
  const signedAttrs = SETOF(attrs);
  const signature = key.sign(mdBin('sha256', signedAttrs)); // RSA PKCS#1 v1.5
  const algSha256 = SEQ(derOid(OID.sha256), NULL);
  const signerInfo = SEQ(
    INT1,
    SEQ(signer.issuerRaw, signer.serialRaw),
    algSha256,
    `\xa0${signedAttrs.slice(1)}`, // stessi byte, etichetta [0] IMPLICIT
    SEQ(derOid(OID.rsa), NULL),
    OCT(signature),
  );
  const signedData = SEQ(
    INT1,
    tlv(0x31, algSha256),
    SEQ(derOid(OID.data)), // contenuto staccato: c'è solo il tipo
    tlv(0xa0, ...[...chain.map((c) => c.der)].sort(cmpBin)),
    tlv(0x31, signerInfo),
  );
  return SEQ(derOid(OID.signedData), tlv(0xa0, signedData));
}

// ---------- scrittura del PDF ----------
function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
}
function parsePdfDate(s) {
  const m = /D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?([Z+-])?(\d\d)?'?(\d\d)?/.exec(s || '');
  if (!m) return null;
  const utc = Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0);
  const sign = m[7] === '-' ? -1 : m[7] === '+' ? 1 : 0;
  return new Date(utc - sign * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000);
}

// Ultima sezione xref: posizione, tipo (tabella o flusso) e /Size.
function readTail(bytes) {
  const from = Math.max(0, bytes.length - 4096);
  const tail = latin1(bytes, from, bytes.length);
  const k = tail.lastIndexOf('startxref');
  if (k < 0) throw new Error('Il PDF è danneggiato: manca l’indice degli oggetti (startxref).');
  const startxref = parseInt(tail.slice(k + 9).trim(), 10);
  if (!(startxref >= 0 && startxref < bytes.length)) throw new Error('Il PDF è danneggiato: l’indice degli oggetti non è valido.');
  let p = startxref;
  while (p < bytes.length && /\s/.test(String.fromCharCode(bytes[p]))) p += 1;
  const isStream = latin1(bytes, p, p + 4) !== 'xref';
  let size = 0;
  if (isStream) {
    const head = latin1(bytes, p, Math.min(bytes.length, p + 4096));
    const dictEnd = head.indexOf('stream');
    const m = /\/Size\s+(\d+)/.exec(dictEnd > 0 ? head.slice(0, dictEnd) : head);
    if (m) size = +m[1];
  } else {
    const rest = latin1(bytes, p, bytes.length);
    const t = rest.indexOf('trailer');
    const m = t >= 0 ? /\/Size\s+(\d+)/.exec(rest.slice(t)) : null;
    if (m) size = +m[1];
  }
  return { startxref, isStream, size };
}

function objBytes(obj) {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return out;
}
const hexText = (s) => pdfLib().PDFHexString.fromText(String(s)).toString();

// Contenuto del riquadro visibile: nome, data, motivo ed eventuale immagine.
function appearance({ w, h, font, img, lines }) {
  const pad = 4;
  const ops = ['q', '0.09 0.34 0.31 RG 0.6 w', `0.3 0.3 ${(w - 0.6).toFixed(2)} ${(h - 0.6).toFixed(2)} re S`];
  let tx = pad;
  if (img) {
    const aw = w * 0.38 - pad * 1.5;
    const ah = h - pad * 2;
    const k = Math.min(aw / img.width, ah / img.height);
    const iw = img.width * k;
    const ih = img.height * k;
    ops.push(`q ${iw.toFixed(3)} 0 0 ${ih.toFixed(3)} ${(pad + (aw - iw) / 2).toFixed(3)} ${((h - ih) / 2).toFixed(3)} cm /Im1 Do Q`);
    tx = w * 0.38 + 1;
  }
  const tw = w - tx - pad;
  const safe = (s) => [...String(s)].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
  const rows = lines.filter((l) => l.text).map((l) => ({ ...l, text: safe(l.text) }));
  const weight = rows.reduce((t, r) => t + (r.big ? 1.3 : 1) * 1.18, 0);
  const base = Math.max(3.5, Math.min(8, (h - pad * 2) / weight));
  let used = 0;
  for (const r of rows) {
    r.size = base * (r.big ? 1.3 : 1);
    const wd = font.widthOfTextAtSize(r.text, r.size);
    if (wd > tw) r.size = Math.max(3.5, (r.size * tw) / wd);
    while (r.text.length > 1 && font.widthOfTextAtSize(r.text, r.size) > tw) r.text = `${r.text.slice(0, -2)}…`;
    used += r.size * 1.18;
  }
  let y = h - pad - Math.max(0, (h - pad * 2 - used) / 2);
  ops.push('0.08 0.13 0.24 rg');
  for (const r of rows) {
    y -= r.size * 1.18;
    ops.push(`BT /F1 ${r.size.toFixed(2)} Tf ${tx.toFixed(2)} ${(y + r.size * 0.25).toFixed(2)} Td ${font.encodeText(r.text).toString()} Tj ET`);
  }
  ops.push('Q');
  return ops.join('\n');
}

/**
 * Firma il PDF e restituisce i byte del file firmato (aggiornamento incrementale:
 * il file originale resta identico, i nuovi oggetti vengono aggiunti in fondo).
 * opts: { p12, password, reason, location, contactInfo, name, visible: { page, rect, text?, png? } | null }
 */
export async function signPdf(input, opts = {}) {
  const L = pdfLib();
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, PDFHexString, StandardFonts } = L;
  const original = toU8(input);
  const { key, chain } = openP12(opts.p12, opts.password);
  const signer = chain[0];

  let doc;
  try { doc = await PDFDocument.load(original, { updateMetadata: false, ignoreEncryption: true }); } catch (e) {
    throw new Error(`Il PDF non si riesce a leggere: ${e?.message || e}`);
  }
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) throw new Error(ENC_MSG);
  const tail = readTail(original);
  const ctx = doc.context;
  const origMax = Math.max(ctx.largestObjectNumber, tail.size - 1);
  ctx.largestObjectNumber = origMax; // i nuovi oggetti avranno numeri mai usati

  const pages = doc.getPages();
  if (!pages.length) throw new Error('Il PDF non ha pagine.');
  let visible = opts.visible || null;
  let pageIndex = visible ? visible.page | 0 : 0;
  if (pageIndex < 0 || pageIndex >= pages.length) throw new Error(`La pagina ${pageIndex + 1} non esiste.`);
  let page = pages[pageIndex];
  const changed = new Map(); // oggetti già esistenti da riscrivere

  // Catalogo e modulo (AcroForm)
  const rootRef = ctx.trailerInfo.Root;
  const catalog = ctx.lookup(rootRef, PDFDict);
  const afRaw = catalog.get(PDFName.of('AcroForm'));
  let acro;
  if (afRaw instanceof PDFRef) { acro = ctx.lookup(afRaw, PDFDict); changed.set(afRaw.objectNumber, afRaw); } else if (afRaw instanceof PDFDict) { acro = afRaw; changed.set(rootRef.objectNumber, rootRef); } else {
    acro = ctx.obj({});
    catalog.set(PDFName.of('AcroForm'), ctx.register(acro));
    changed.set(rootRef.objectNumber, rootRef);
  }
  const oldFields = acro.lookup(PDFName.of('Fields'));
  const names = new Set();
  const refs = new Map(); // nome → riferimento del campo (per firmare in un campo firma già preparato)
  const collect = (arr) => {
    if (!(arr instanceof PDFArray)) return;
    for (let i = 0; i < arr.size(); i += 1) {
      const f = arr.lookup(i);
      if (!(f instanceof PDFDict)) continue;
      const t = f.lookup(PDFName.of('T'));
      if (t?.decodeText) { names.add(t.decodeText()); if (arr.get(i) instanceof PDFRef) refs.set(t.decodeText(), arr.get(i)); }
      collect(f.lookup(PDFName.of('Kids')));
    }
  };
  collect(oldFields);
  // 0.9.0: firma dentro un campo firma vuoto (per esempio preparato con «Crea un modulo» da chi chiede la firma).
  let existing = null;
  if (opts.field) {
    const ref = refs.get(opts.field);
    const fd = ref ? ctx.lookup(ref, PDFDict) : null;
    if (!fd || fd.lookup(PDFName.of('FT'))?.toString() !== '/Sig') throw new Error(`Il campo firma «${opts.field}» non c'è nel documento.`);
    if (fd.get(PDFName.of('V'))) throw new Error(`Il campo «${opts.field}» è già firmato.`);
    const pref = fd.get(PDFName.of('P'));
    const idx = pref instanceof PDFRef ? pages.findIndex((pg) => pg.ref.objectNumber === pref.objectNumber) : -1;
    const r = fd.lookup(PDFName.of('Rect'))?.asArray?.().map((v) => v.asNumber()) || [0, 0, 0, 0];
    existing = { ref, dict: fd, page: idx >= 0 ? idx : 0, rect: r };
  }
  let n = 1;
  while (names.has(`Firma${n}`)) n += 1;
  const fieldName = existing ? opts.field : `Firma${n}`;

  if (existing) {
    pageIndex = existing.page;
    page = pages[pageIndex];
    const [x0, y0, x1, y1] = existing.rect;
    visible = Math.abs(x1 - x0) >= 10 && Math.abs(y1 - y0) >= 10 ? { ...(opts.visible || {}), page: existing.page, rect: existing.rect } : null;
  }
  const sigRef = ctx.nextRef(); // il dizionario /Sig lo scriviamo a mano (segnaposto a larghezza fissa)

  // Aspetto del riquadro
  let rect = [0, 0, 0, 0];
  let apStream;
  if (visible) {
    const r = visible.rect || [];
    if (r.length !== 4 || r.some((v) => !Number.isFinite(+v))) throw new Error('Il riquadro della firma visibile non è valido.');
    rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])].map((v) => Math.round(v * 100) / 100);
    const rw = rect[2] - rect[0];
    const rh = rect[3] - rect[1];
    if (rw < 10 || rh < 10) throw new Error('Il riquadro della firma visibile è troppo piccolo.');
    const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
    const turned = rot === 90 || rot === 270;
    const bw = turned ? rh : rw;
    const bh = turned ? rw : rh;
    const matrix = { 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0] }[rot];
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let img = null;
    if (visible.png?.length) {
      const b = toU8(visible.png);
      img = b[0] === 0xff && b[1] === 0xd8 ? await doc.embedJpg(b) : await doc.embedPng(b);
    }
    await doc.flush();
    const when = new Date();
    const lines = [
      { text: 'Firmato digitalmente da' },
      { text: opts.name || signer.subject.cn || signer.subject.o || 'Firmatario', big: true },
      { text: `Data: ${when.toLocaleDateString('it-IT')} ${when.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` },
      opts.reason ? { text: `Motivo: ${opts.reason}` } : null,
      opts.location ? { text: `Luogo: ${opts.location}` } : null,
      ...(visible.text ? String(visible.text).split(/\r?\n/).map((t) => ({ text: t })) : []),
    ].filter(Boolean);
    const resources = { Font: { F1: font.ref } };
    if (img) resources.XObject = { Im1: img.ref };
    apStream = ctx.stream(appearance({ w: bw, h: bh, font, img, lines }), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, bw, bh], ...(matrix ? { Matrix: matrix } : {}), Resources: resources,
    });
  } else {
    apStream = ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 0, 0] });
  }
  const apRef = ctx.register(apStream);
  if (existing) {
    // Campo già nel documento: si riempie quello (valore, aspetto, stampabile e bloccato dopo la firma).
    existing.dict.set(PDFName.of('V'), sigRef);
    existing.dict.set(PDFName.of('AP'), ctx.obj({ N: apRef }));
    existing.dict.set(PDFName.of('F'), PDFNumber.of(132));
    changed.set(existing.ref.objectNumber, existing.ref);
    acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  } else {
    const widgetRef = ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFHexString.fromText(fieldName), V: sigRef,
      F: 132, P: page.ref, Rect: rect, AP: { N: apRef },
    }));

    // Pagina: aggiungi il widget a /Annots
    const annots = page.node.lookup(PDFName.of('Annots'));
    const newAnnots = PDFArray.withContext(ctx);
    if (annots instanceof PDFArray) for (let i = 0; i < annots.size(); i += 1) newAnnots.push(annots.get(i));
    newAnnots.push(widgetRef);
    page.node.set(PDFName.of('Annots'), newAnnots);
    changed.set(page.ref.objectNumber, page.ref);

    // Modulo: aggiungi il campo e /SigFlags 3
    const newFields = PDFArray.withContext(ctx);
    if (oldFields instanceof PDFArray) for (let i = 0; i < oldFields.size(); i += 1) newFields.push(oldFields.get(i));
    newFields.push(widgetRef);
    acro.set(PDFName.of('Fields'), newFields);
    acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  }

  // Oggetti da scrivere: tutti i nuovi più quelli cambiati
  const toWrite = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) if (ref.objectNumber > origMax) toWrite.set(ref.objectNumber, [ref, obj]);
  for (const ref of changed.values()) if (!toWrite.has(ref.objectNumber)) toWrite.set(ref.objectNumber, [ref, ctx.lookup(ref)]);
  toWrite.delete(sigRef.objectNumber);

  // Dizionario della firma con i segnaposto
  const leaf = chain.reduce((t, c) => t + c.der.length, 0);
  const reserve = Math.max(RESERVE_MIN, leaf + 6144 + key.n.bitLength() / 4);
  const hexLen = reserve * 2;
  const optional = [
    `/Name ${hexText(opts.name || signer.subject.cn || signer.subject.o || 'Firmatario')}`,
    opts.reason ? `/Reason ${hexText(opts.reason)}` : '',
    opts.location ? `/Location ${hexText(opts.location)}` : '',
    opts.contactInfo ? `/ContactInfo ${hexText(opts.contactInfo)}` : '',
  ].filter(Boolean).join('\n');
  const sigText = `${sigRef.objectNumber} 0 obj\n<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /ETSI.CAdES.detached\n`
    + `/ByteRange [${' '.repeat(BR_WIDTH)}]\n/Contents <${'0'.repeat(hexLen)}>\n/M (${pdfDate(new Date())})\n${optional}\n`
    + '/Prop_Build << /App << /Name /Postilla >> >>\n>>\nendobj\n';
  const brAt = sigText.indexOf('/ByteRange [') + 12;
  const cAt = sigText.indexOf('/Contents <') + 10;

  // Composizione dell'aggiornamento
  const parts = [original];
  let pos = original.length;
  const last = original[original.length - 1];
  if (last !== 0x0a && last !== 0x0d) { parts.push(ascii('\n')); pos += 1; }
  const entries = [];
  const sigObjAt = pos;
  entries.push({ num: sigRef.objectNumber, gen: 0, off: pos });
  parts.push(ascii(sigText));
  pos += sigText.length;
  for (const [num, [ref, obj]] of [...toWrite.entries()].sort((a, b) => a[0] - b[0])) {
    const head = ascii(`${num} ${ref.generationNumber} obj\n`);
    const body = objBytes(obj);
    const foot = ascii('\nendobj\n');
    entries.push({ num, gen: ref.generationNumber, off: pos });
    parts.push(head, body, foot);
    pos += head.length + body.length + foot.length;
  }
  const info = ctx.trailerInfo.Info;
  let id = ctx.trailerInfo.ID ? ctx.trailerInfo.ID.toString() : '';
  if (!id) {
    const r = binHex(forgeLib().random.getBytesSync(16)).toUpperCase();
    id = `[<${r}> <${r}>]`;
  }
  const common = `/Root ${rootRef.toString()}${info ? ` /Info ${info.toString()}` : ''} /ID ${id} /Prev ${tail.startxref}`;
  const xrefAt = pos;
  if (tail.isStream) {
    const xnum = Math.max(origMax, ...entries.map((e) => e.num)) + 1;
    entries.push({ num: xnum, gen: 0, off: xrefAt });
    entries.sort((a, b) => a.num - b.num);
    const index = [];
    const data = new Uint8Array(entries.length * 7);
    entries.forEach((e, i) => {
      if (!index.length || index[index.length - 2] + index[index.length - 1] !== e.num) index.push(e.num, 1); else index[index.length - 1] += 1;
      const o = i * 7;
      data[o] = 1;
      data[o + 1] = (e.off >>> 24) & 255; data[o + 2] = (e.off >>> 16) & 255; data[o + 3] = (e.off >>> 8) & 255; data[o + 4] = e.off & 255;
      data[o + 5] = (e.gen >>> 8) & 255; data[o + 6] = e.gen & 255;
    });
    const size = Math.max(tail.size, xnum + 1);
    const head = ascii(`${xnum} 0 obj\n<< /Type /XRef /Size ${size} /Index [${index.join(' ')}] /W [1 4 2] ${common} /Length ${data.length} >>\nstream\n`);
    parts.push(head, data, ascii(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  } else {
    entries.sort((a, b) => a.num - b.num);
    let txt = 'xref\n';
    for (let i = 0; i < entries.length;) {
      let j = i;
      while (j + 1 < entries.length && entries[j + 1].num === entries[j].num + 1) j += 1;
      txt += `${entries[i].num} ${j - i + 1}\n`;
      for (let k = i; k <= j; k += 1) txt += `${String(entries[k].off).padStart(10, '0')} ${String(entries[k].gen).padStart(5, '0')} n\r\n`;
      i = j + 1;
    }
    const size = Math.max(tail.size, ...entries.map((e) => e.num + 1));
    txt += `trailer\n<< /Size ${size} ${common} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    parts.push(ascii(txt));
  }
  const out = concat(parts);

  // /ByteRange: tutto il file tranne il valore di /Contents (parentesi angolari comprese)
  const a = sigObjAt + cAt;
  const b = a + hexLen + 2;
  const br = `0 ${a} ${b} ${out.length - b}`;
  if (br.length > BR_WIDTH) throw new Error('Il file è troppo grande per essere firmato.');
  out.set(ascii(br.padEnd(BR_WIDTH, ' ')), sigObjAt + brAt);

  const digest = await digestParts('sha256', [out.subarray(0, a), out.subarray(b)]);
  const cms = binHex(buildCms(key, chain, digest)).toUpperCase();
  if (cms.length > hexLen) throw new Error('La firma non entra nello spazio riservato (catena di certificati troppo lunga).');
  out.set(ascii(cms), a + 1);
  return out;
}

// ---------- controllo delle firme ----------
function bytesOfPdfString(o) {
  if (!o) return null;
  if (typeof o.asBytes === 'function') return o.asBytes();
  return null;
}
const textOf = (o) => { try { return o?.decodeText ? o.decodeText() : ''; } catch { return ''; } };

// Esamina un CMS e lo confronta con le parti firmate del file.
async function checkCms(cmsU8, parts) {
  const res = { signer: '', issuer: '', serial: '', intact: false, verified: null, problem: undefined, signingTime: null };
  const s = u8ToBin(cmsU8);
  let ci;
  try {
    ci = tlvAt(s, 0);
    const [typ, wrap] = kidsOf(s, ci);
    if (oidOf(s, typ) !== OID.signedData) throw new Error('non è SignedData');
    const sd = kidsOf(s, kidsOf(s, wrap)[0]);
    let i = 2; // version, digestAlgorithms
    const encap = kidsOf(s, sd[i]); i += 1;
    let certs = [];
    if (sd[i] && sd[i].tag === 0xa0) { certs = kidsOf(s, sd[i]).filter((c) => c.tag === 0x30).map((c) => { try { return parseCert(rawOf(s, c)); } catch { return null; } }).filter(Boolean); i += 1; }
    if (sd[i] && sd[i].tag === 0xa1) i += 1;
    const si = kidsOf(s, kidsOf(s, sd[i])[0]);
    let j = 1;
    const sid = si[j]; j += 1;
    const digOid = oidOf(s, kidsOf(s, si[j])[0]); j += 1;
    let attrsNode = null;
    if (si[j].tag === 0xa0) { attrsNode = si[j]; j += 1; }
    const sigAlgOid = oidOf(s, kidsOf(s, si[j])[0]); j += 1;
    const sigValue = valOf(s, si[j]);

    // Chi ha firmato
    let cert = null;
    if (sid.tag === 0x30) {
      const [iss, ser] = kidsOf(s, sid);
      cert = certs.find((c) => c.issuerRaw === rawOf(s, iss) && c.serialRaw === rawOf(s, ser)) || null;
    }
    if (!cert && certs.length === 1) cert = certs[0];
    if (cert) {
      res.signer = cert.subject.cn || cert.subject.o || cert.subject.text;
      res.issuer = cert.issuer.cn || cert.issuer.o || cert.issuer.text;
      res.serial = cert.serial;
    }

    const alg = DIGESTS[digOid];
    if (!alg) { res.problem = `Algoritmo di impronta non supportato (${digOid}).`; return res; }
    let content = await digestParts(alg, parts);
    // Vecchio tipo adbe.pkcs7.sha1: dentro il CMS c'è l'impronta SHA-1 del file.
    const eContent = kidsOf(s, encap)[1];
    if (eContent) {
      const inner = kidsOf(s, eContent)[0];
      const embedded = inner ? valOf(s, inner) : '';
      const sha1 = await digestParts('sha1', parts);
      if (embedded !== sha1) { res.intact = false; res.problem = 'Il contenuto firmato non corrisponde al file.'; return res; }
      content = await digestParts(alg, [binToU8(embedded)]);
    }
    let signedBytes;
    if (attrsNode) {
      let md = null;
      for (const attr of kidsOf(s, attrsNode)) {
        const [t, set] = kidsOf(s, attr);
        const o = oidOf(s, t);
        const v = kidsOf(s, set)[0];
        if (o === OID.messageDigest) md = valOf(s, v);
        if (o === OID.signingTime) res.signingTime = timeOf(s, v)?.toISOString() || null;
      }
      if (md === null) { res.problem = 'Nella firma manca l’impronta del documento.'; return res; }
      res.intact = md === content;
      signedBytes = `\x31${rawOf(s, attrsNode).slice(1)}`;
    } else {
      signedBytes = null; // la firma è direttamente sull'impronta del contenuto
    }

    // Verifica crittografica
    const keyOid = cert?.keyOid;
    if (sigAlgOid.startsWith('1.2.840.10045.') || keyOid === OID.ecKey) { res.verified = null; res.problem = 'Firma con chiave a curve ellittiche (EC): Postilla non sa ancora verificarla.'; return res; }
    if (sigAlgOid === OID.rsaPss) { res.verified = null; res.problem = 'Firma RSA-PSS: Postilla non sa ancora verificarla.'; return res; }
    if (!(sigAlgOid in RSA_SIGS)) { res.verified = null; res.problem = `Algoritmo di firma non supportato (${sigAlgOid}).`; return res; }
    if (!cert) { res.verified = null; res.problem = 'Nella firma non c’è il certificato del firmatario.'; return res; }
    if (keyOid !== OID.rsa) { res.verified = null; res.problem = `Tipo di chiave non supportato (${keyOid}).`; return res; }
    const forge = forgeLib();
    const pub = forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(cert.spkiRaw));
    const hashAlg = RSA_SIGS[sigAlgOid] || alg;
    const toCheck = signedBytes ? mdBin(hashAlg, signedBytes).digest().getBytes() : (hashAlg === alg ? content : null);
    if (toCheck === null) { res.verified = null; res.problem = 'Combinazione di algoritmi non supportata.'; return res; }
    try { res.verified = !!pub.verify(toCheck, sigValue); } catch { res.verified = false; }
    if (!res.verified) res.problem = 'La firma non corrisponde al certificato del firmatario.';
    else if (!res.intact) res.problem = 'Il documento è stato modificato dopo la firma.';
    return res;
  } catch (e) {
    res.problem = `La firma non si riesce a leggere (${e?.message || e}).`;
    return res;
  }
}

/**
 * Elenca le firme del PDF con il loro stato.
 * Controlla integrità (impronta dei ByteRange) e firma RSA, NON l'affidabilità del certificato (vedi TRUST_NOTE).
 */
export async function listSignatures(input) {
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } = pdfLib();
  const bytes = toU8(input);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
  const ctx = doc.context;
  const found = [];
  const seen = new Set();
  const walk = (arr, prefix, inheritedFt) => {
    if (!(arr instanceof PDFArray)) return;
    for (let i = 0; i < arr.size(); i += 1) {
      const raw = arr.get(i);
      const f = arr.lookup(i);
      if (!(f instanceof PDFDict)) continue;
      const key = raw instanceof PDFRef ? raw.toString() : null;
      if (key && seen.has(`f${key}`)) continue;
      if (key) seen.add(`f${key}`);
      const t = textOf(f.lookup(PDFName.of('T')));
      const full = t ? (prefix ? `${prefix}.${t}` : t) : prefix;
      const ft = f.lookup(PDFName.of('FT'))?.toString() || inheritedFt;
      const vRaw = f.get(PDFName.of('V'));
      const v = f.lookup(PDFName.of('V'));
      if (ft === '/Sig' && v instanceof PDFDict && v.has(PDFName.of('ByteRange'))) {
        const id = vRaw instanceof PDFRef ? vRaw.toString() : `${full}#${found.length}`;
        if (!seen.has(id)) { seen.add(id); found.push({ field: full || 'Firma', dict: v }); }
      }
      walk(f.lookup(PDFName.of('Kids')), full, ft);
    }
  };
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (acro instanceof PDFDict) walk(acro.lookup(PDFName.of('Fields')), '', undefined);
  // Firme senza campo nel modulo (file insoliti)
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || seen.has(ref.toString())) continue;
    if (obj.has(PDFName.of('ByteRange')) && obj.has(PDFName.of('Contents'))) { seen.add(ref.toString()); found.push({ field: '(senza campo)', dict: obj }); }
  }

  const out = [];
  for (const { field, dict } of found) {
    const get = (k) => dict.lookup(PDFName.of(k));
    const brArr = get('ByteRange');
    const br = brArr instanceof PDFArray ? brArr.asArray().map((x) => (typeof x.asNumber === 'function' ? x.asNumber() : NaN)) : [];
    const item = {
      field,
      signer: '', issuer: '', serial: '',
      time: parsePdfDate(textOf(get('M')))?.toISOString() || null,
      reason: textOf(get('Reason')),
      location: textOf(get('Location')),
      subFilter: get('SubFilter')?.toString().replace(/^\//, '') || '',
      intact: false,
      coversWholeFile: false,
      verified: null,
      end: 0,
    };
    const okRange = br.length === 4 && br.every((x) => Number.isInteger(x) && x >= 0) && br[0] === 0 && br[1] < br[2]
      && br[2] + br[3] <= bytes.length && bytes[br[1]] === 0x3c && bytes[br[2] - 1] === 0x3e;
    if (!okRange) {
      item.problem = 'Le indicazioni su quale parte del file è firmata (ByteRange) non sono valide.';
      out.push(item);
      continue;
    }
    item.end = br[2] + br[3];
    item.coversWholeFile = item.end === bytes.length;
    const cms = bytesOfPdfString(get('Contents'));
    if (!cms?.length) { item.problem = 'La firma è vuota.'; out.push(item); continue; }
    const r = await checkCms(cms, [bytes.subarray(br[0], br[0] + br[1]), bytes.subarray(br[2], br[2] + br[3])]);
    Object.assign(item, { signer: r.signer, issuer: r.issuer, serial: r.serial, intact: r.intact, verified: r.verified });
    if (!item.time && r.signingTime) item.time = r.signingTime;
    if (r.problem) item.problem = r.problem;
    out.push(item);
  }
  out.sort((x, y) => x.end - y.end);
  return out.map(({ end, ...rest }) => rest);
}

// ---------- interfaccia ----------
function ensureStyle() {
  if (document.getElementById('pro-signature-style')) return;
  const st = document.createElement('style');
  st.id = 'pro-signature-style';
  st.textContent = `
.sig-dlg .sig-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 6px 0 10px; }
.sig-dlg .sig-file { color: var(--soft); overflow-wrap: anywhere; }
.sig-dlg .sig-who { background: var(--accent-soft); border-radius: 8px; padding: 8px 10px; margin: 8px 0; line-height: 1.4; }
.sig-dlg .sig-err { color: var(--danger); margin: 6px 0; }
.sig-dlg .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.sig-dlg .sig-grid label.wide { grid-column: 1 / -1; }
.sig-dlg input[type=text], .sig-dlg input[type=password] { min-height: 34px; }
.sig-list { list-style: none; padding: 0; margin: 8px 0; display: flex; flex-direction: column; gap: 10px; }
.sig-list li { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.sig-list .sig-state { font-weight: 600; margin-top: 6px; }
.sig-list .ok { color: var(--accent); }
.sig-list .warn { color: #8a5a00; }
.sig-list .bad { color: var(--danger); }
.sig-note { color: var(--soft); font-size: 13px; }
@media (max-width: 560px) { .sig-dlg .sig-grid { grid-template-columns: 1fr; } }
`;
  document.head.append(st);
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) : 'non indicata');

// Riquadro 200×60 pt in basso a destra della pagina, in coordinate PDF.
async function defaultRect(view, i) {
  const p = view.pages?.[i];
  let vp = p?.vp;
  if (!vp && view.pdf) vp = (await view.pdf.getPage(i + 1)).getViewport({ scale: 1 });
  const w = vp ? vp.width : p?.w || 595;
  const hgt = vp ? vp.height : p?.h || 842;
  const bw = Math.min(200, w - 20);
  const bh = Math.min(60, hgt - 20);
  const x1 = w - 20; const y1 = hgt - 20; const x0 = x1 - bw; const y0 = y1 - bh;
  if (!vp?.convertToPdfPoint) return [x0, 20, x1, 20 + bh];
  const a = vp.convertToPdfPoint(x0, y0);
  const b = vp.convertToPdfPoint(x1, y1);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/**
 * Finestra per scegliere certificato e dati della firma.
 * Restituisce le opzioni per signPdf, oppure null se l'utente annulla.
 */
// Campi firma ancora vuoti del documento (per esempio preparati da chi chiede la firma).
export async function emptySigFields(bytes) {
  const { PDFDocument, PDFName, PDFDict, PDFArray } = pdfLib();
  const doc = await PDFDocument.load(toU8(bytes), { updateMetadata: false, ignoreEncryption: true });
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  const out = [];
  const pages = doc.getPages();
  const walk = (arr) => {
    if (!(arr instanceof PDFArray)) return;
    for (let i = 0; i < arr.size(); i += 1) {
      const f = arr.lookup(i);
      if (!(f instanceof PDFDict)) continue;
      if (f.lookup(PDFName.of('FT'))?.toString() === '/Sig' && !f.get(PDFName.of('V'))) {
        const pref = f.get(PDFName.of('P'));
        const page = pages.findIndex((pg) => pg.ref.objectNumber === pref?.objectNumber);
        out.push({ name: f.lookup(PDFName.of('T'))?.decodeText?.() || '', page: page >= 0 ? page : 0 });
      }
      walk(f.lookup(PDFName.of('Kids')));
    }
  };
  if (acro instanceof PDFDict) walk(acro.lookup(PDFName.of('Fields')));
  return out;
}

export async function signDialog(app, view) {
  ensureStyle();
  const pageIndex = view?.current ?? 0;
  const rect = view ? await defaultRect(view, pageIndex) : null;
  const empty = view ? await emptySigFields(await view.ensureBytes()).catch(() => []) : [];
  let p12 = null;
  let cert = null;
  const result = await modal((box, done) => {
    box.classList.add('sig-dlg');
    const fileIn = h('input', { type: 'file', accept: '.p12,.pfx,application/x-pkcs12', hidden: true });
    const fileName = h('span', { class: 'sig-file' }, 'Nessun certificato scelto');
    const pass = h('input', { type: 'password', autocomplete: 'off', 'aria-label': 'Password del certificato' });
    const reason = h('input', { type: 'text', 'aria-label': 'Motivo', placeholder: 'Per esempio: Approvo il documento' });
    const place = h('input', { type: 'text', 'aria-label': 'Luogo', placeholder: 'Per esempio: Roma' });
    const vis = h('input', { type: 'checkbox' });
    const who = h('div', { class: 'sig-who', hidden: true });
    const err = h('div', { class: 'sig-err', role: 'alert', hidden: true });
    const okBtn = h('button', { class: 'primary', disabled: true }, 'Firma');
    const showErr = (m) => { err.textContent = m; err.hidden = !m; };
    const reset = () => { cert = null; who.hidden = true; okBtn.disabled = true; };
    const tryOpen = () => {
      reset();
      if (!p12) { showErr('Scegli prima il file del certificato (.p12 o .pfx).'); return; }
      try {
        cert = readCertificate(p12, pass.value);
        showErr('');
        who.textContent = '';
        who.append(h('div', {}, h('b', {}, 'Titolare: '), cert.name),
          h('div', {}, `Emesso da: ${cert.issuer}`),
          h('div', {}, `Valido fino al: ${cert.notAfter ? new Date(cert.notAfter).toLocaleDateString('it-IT') : 'non indicato'}${cert.expired ? ' (scaduto!)' : ''}`));
        who.hidden = false;
        okBtn.disabled = false;
      } catch (e) {
        showErr(e.message);
      }
    };
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      if (!f) return;
      p12 = new Uint8Array(await f.arrayBuffer());
      fileName.textContent = f.name;
      fileIn.value = '';
      if (pass.value) tryOpen(); else { reset(); showErr(''); pass.focus(); }
    });
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryOpen(); } });
    pass.addEventListener('input', reset);
    const finish = (ok) => {
      const pw = pass.value;
      pass.value = '';
      if (!ok || !cert) { p12 = null; done(null); return; }
      done({
        p12, password: pw, name: cert.name,
        reason: reason.value.trim(), location: place.value.trim(), contactInfo: '',
        visible: vis.checked && rect && !where?.value ? { page: pageIndex, rect } : null,
        field: where?.value || null,
      });
    };
    okBtn.addEventListener('click', () => finish(true));
    // Dove firmare: in un campo firma vuoto del documento, oppure come prima.
    const where = empty.length ? h('select', { 'aria-label': 'Dove firmare' }, ...empty.map((f) => h('option', { value: f.name }, `Nel campo «${f.name}» (pagina ${f.page + 1})`)), h('option', { value: '' }, 'Una firma nuova')) : null;
    if (where) where.addEventListener('change', () => { vis.parentElement.hidden = !!where.value; });
    box.append(...[
      h('h2', {}, 'Firma digitale'),
      h('p', { class: 'hint' }, 'Usa il tuo certificato di firma in formato .p12 o .pfx. La password serve solo adesso e non viene salvata.'),
      h('div', { class: 'sig-row' }, h('button', { onclick: async () => {
        // Sul tablet la pagina non apre il selettore dei file: si usa quello di Postilla.
        if (window.host?.pickFiles) {
          const [pth] = await window.host.pickFiles({ title: 'Scegli il certificato', name: 'Certificati', exts: ['p12', 'pfx'], mimes: ['application/x-pkcs12', 'application/octet-stream'], multi: false });
          if (!pth) return;
          p12 = new Uint8Array((await window.host.readFile(pth)).data);
          fileName.textContent = pth.split(/[\\/]/).pop();
          if (pass.value) tryOpen(); else { reset(); showErr(''); pass.focus(); }
          return;
        }
        fileIn.click();
      } }, 'Scegli il certificato…'), fileName, fileIn),
      where ? h('label', { class: 'wide' }, 'Dove firmare', where) : null,
      h('div', { class: 'sig-grid' },
        h('label', { class: 'wide' }, 'Password del certificato',
          h('div', { class: 'sig-row' }, pass, h('button', { onclick: tryOpen }, 'Apri certificato'))),
        h('label', {}, 'Motivo', reason),
        h('label', {}, 'Luogo', place)),
      who, err,
      view ? h('label', { class: 'check' }, vis, ` Firma visibile su questa pagina (pagina ${pageIndex + 1}, in basso a destra)`) : null,
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => finish(false) }, 'Annulla'), okBtn),
    ].filter(Boolean));
  });
  return result || null;
}

function stateOf(s) {
  if (s.intact && s.verified === true) {
    return s.coversWholeFile
      ? ['ok', 'Firma valida: il documento non è stato modificato dopo la firma.']
      : ['ok', 'Firma valida per la parte firmata. Dopo questa firma il file è stato ampliato (per esempio con un’altra firma o con annotazioni).'];
  }
  if (s.verified === false) return ['bad', `Firma NON valida. ${s.problem || ''}`.trim()];
  if (!s.intact) return ['bad', `Attenzione: ${s.problem || 'il documento è stato modificato dopo la firma.'}`];
  return ['warn', `Il documento risulta integro, ma la firma non si è potuta verificare. ${s.problem || ''}`.trim()];
}

// Finestra con l'elenco delle firme del documento e il loro stato.
export async function showSignatures(app, view, bytes) {
  ensureStyle();
  let list;
  let error = '';
  try {
    const data = bytes || (view ? await view.ensureBytes() : null);
    list = data ? await listSignatures(data) : [];
  } catch (e) {
    list = [];
    error = `Non è stato possibile controllare le firme: ${e?.message || e}`;
  }
  return modal((box, done) => {
    box.classList.add('sig-dlg');
    const items = list.map((s, i) => {
      const [cls, msg] = stateOf(s);
      return h('li', {},
        h('div', {}, h('b', {}, `${i + 1}. ${s.signer || 'Firmatario sconosciuto'}`), ` · campo «${s.field}»`),
        s.issuer ? h('div', {}, `Certificato emesso da: ${s.issuer}${s.serial ? ` (numero di serie ${s.serial})` : ''}`) : null,
        h('div', {}, `Data della firma: ${fmtTime(s.time)}`),
        s.reason ? h('div', {}, `Motivo: ${s.reason}`) : null,
        s.location ? h('div', {}, `Luogo: ${s.location}`) : null,
        h('div', { class: `sig-state ${cls}` }, msg));
    });
    box.append(...[
      h('h2', {}, 'Firme digitali del documento'),
      error ? h('p', { class: 'sig-err' }, error) : null,
      !error && !list.length ? h('p', {}, 'Questo documento non contiene firme digitali.') : null,
      items.length ? h('ul', { class: 'sig-list' }, items) : null,
      h('p', { class: 'sig-note' }, TRUST_NOTE),
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: () => done() }, 'Chiudi')),
    ].filter(Boolean));
  });
}
