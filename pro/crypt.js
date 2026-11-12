// Password e protezione dei PDF: riconosce i file protetti, li apre con la password
// (RC4 a 40 e 128 bit, AES a 128 e 256 bit) e protegge una copia con AES a 256 bit.
// Solo JavaScript del renderer (funziona anche su Android): usa window.PDFLib e window.forge.
import { h, modal } from '../core.js';

const L = () => window.PDFLib;
const F = () => window.forge;
const N = (s) => L().PDFName.of(s);
const fail = (msg, code) => Object.assign(new Error(msg), { code });

// Riempitivo fisso della norma PDF per le password (32 byte).
const PAD = String.fromCharCode(0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A);

// ---------- byte e stringhe "binarie" (un carattere = un byte, come vuole forge) ----------
function toBin(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
}
function fromBin(s) {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) u[i] = s.charCodeAt(i) & 255;
  return u;
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
function toHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 1) s += HEX[u8[i]];
  return s;
}
function rand(n) {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) return toBin(c.getRandomValues(new Uint8Array(n)));
  return F().random.getBytesSync(n);
}
const le = (v, n) => { let s = ''; for (let i = 0; i < n; i += 1) s += String.fromCharCode((v >>> (8 * i)) & 255); return s; };
const xorKey = (k, x) => { let s = ''; for (let i = 0; i < k.length; i += 1) s += String.fromCharCode(k.charCodeAt(i) ^ x); return s; };

// ---------- primitive ----------
const digest = (name, bin) => F().md[name].create().update(bin).digest().getBytes();
const md5 = (b) => digest('md5', b);
const sha256 = (b) => digest('sha256', b);

function rc4(keyBin, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) s[i] = i;
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + s[i] + keyBin.charCodeAt(i % keyBin.length)) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const rc4Bin = (k, bin) => toBin(rc4(k, fromBin(bin)));

// AES-CBC senza riempimento (per chiavi e verifiche).
function aesRaw(keyBin, ivBin, dataBin, decrypt = false) {
  const c = decrypt ? F().cipher.createDecipher('AES-CBC', keyBin) : F().cipher.createCipher('AES-CBC', keyBin);
  c.start({ iv: ivBin });
  c.update(F().util.createBuffer(dataBin));
  c.finish(() => true);
  return c.output.getBytes();
}
const ZERO16 = '\0'.repeat(16);

// Flusso o stringa cifrati AES: 16 byte di vettore iniziale, poi i dati con riempimento PKCS#7.
function aesDecrypt(keyBin, data) {
  if (data.length < 32) return new Uint8Array(0);
  let body = data.subarray(16);
  body = body.subarray(0, body.length - (body.length % 16));
  const out = fromBin(aesRaw(keyBin, toBin(data.subarray(0, 16)), toBin(body), true));
  const p = out[out.length - 1];
  if (p >= 1 && p <= 16 && p <= out.length) {
    let ok = true;
    for (let i = out.length - p; i < out.length; i += 1) if (out[i] !== p) { ok = false; break; }
    if (ok) return out.subarray(0, out.length - p);
  }
  return out;
}
function aesEncrypt(keyBin, data) {
  const iv = rand(16);
  const c = F().cipher.createCipher('AES-CBC', keyBin);
  c.start({ iv });
  c.update(F().util.createBuffer(toBin(data)));
  c.finish();
  return fromBin(iv + c.output.getBytes());
}

// ---------- calcolo delle chiavi (norma ISO 32000) ----------
const padPw = (pw) => (Array.from(pw, (ch) => String.fromCharCode(ch.charCodeAt(0) & 255)).join('') + PAD).slice(0, 32);
const utf8Pw = (pw) => toBin(new TextEncoder().encode(String(pw).normalize('NFKC'))).slice(0, 127);

// Algoritmo 2: chiave del file per RC4 e AES-128.
function keyR4(padded, s) {
  let k = md5(padded + s.O.slice(0, 32) + le(s.P, 4) + s.id0 + (s.R >= 4 && !s.encMeta ? '\xff\xff\xff\xff' : ''));
  if (s.R >= 3) for (let i = 0; i < 50; i += 1) k = md5(k.slice(0, s.n));
  return k.slice(0, s.n);
}
// Algoritmi 4 e 5: verifica della password dell'utente.
function userOk(key, s) {
  if (s.R === 2) return rc4Bin(key, PAD) === s.U.slice(0, 32);
  let x = rc4Bin(key, md5(PAD + s.id0));
  for (let i = 1; i <= 19; i += 1) x = rc4Bin(xorKey(key, i), x);
  return x === s.U.slice(0, 16);
}
// Algoritmo 7: dalla password del proprietario ricava quella dell'utente.
function ownerToUser(padded, s) {
  let k = md5(padded);
  if (s.R >= 3) for (let i = 0; i < 50; i += 1) k = md5(k);
  k = k.slice(0, s.n);
  let x = s.O.slice(0, 32);
  if (s.R === 2) return rc4Bin(k, x);
  for (let i = 19; i >= 0; i -= 1) x = rc4Bin(xorKey(k, i), x);
  return x;
}
// Algoritmo 2.B (R6); con R5 basta un SHA-256.
function hash6(pw, salt, udata, R) {
  let k = sha256(pw + salt + udata);
  if (R === 5) return k;
  let e = '';
  for (let i = 0; i < 64 || e.charCodeAt(e.length - 1) > i - 32; i += 1) {
    e = aesRaw(k.slice(0, 16), k.slice(16, 32), (pw + k + udata).repeat(64));
    let sum = 0;
    for (let j = 0; j < 16; j += 1) sum += e.charCodeAt(j);
    k = digest(['sha256', 'sha384', 'sha512'][sum % 3], e);
  }
  return k.slice(0, 32);
}

// Legge il dizionario /Encrypt, verifica la password e restituisce tutto il necessario per decifrare.
function openSecurity(enc, id0, password) {
  const { PDFNumber, PDFString, PDFHexString, PDFDict, PDFName } = L();
  const get = (k) => enc.lookup(N(k));
  const num = (k, d) => { const v = get(k); return v instanceof PDFNumber ? v.asNumber() : d; };
  const bin = (k) => { const v = get(k); return v instanceof PDFString || v instanceof PDFHexString ? toBin(v.asBytes()) : ''; };
  const name = (v) => (v instanceof PDFName ? String(v).slice(1) : '');
  if (name(get('Filter')) !== 'Standard') throw fail('Questo PDF usa un sistema di protezione non supportato (certificati o altro).', 'unsupported');
  const V = num('V', 0);
  const R = num('R', 2);
  const em = get('EncryptMetadata');
  const s = { V, R, P: num('P', 0) | 0, O: bin('O'), U: bin('U'), id0, encMeta: !(em && em.asBoolean && em.asBoolean() === false) };
  if (V < 1 || V > 5 || V === 3 || R < 2 || R > 6) throw fail(`Protezione non supportata (V${V}, R${R}).`, 'unsupported');

  // Metodo di cifratura per stringhe e flussi.
  const cf = V >= 4 ? get('CF') : null;
  s.cfm = (fname) => {
    if (V < 4) return 'V2';
    if (!fname || fname === 'Identity') return 'None';
    const f = cf instanceof PDFDict ? cf.lookup(N(fname)) : null;
    const m = f instanceof PDFDict ? name(f.lookup(N('CFM'))) : '';
    return m || 'None';
  };
  s.stmF = V >= 4 ? name(get('StmF')) || 'Identity' : 'Std';
  s.strF = V >= 4 ? name(get('StrF')) || 'Identity' : 'Std';
  const mStm = s.cfm(s.stmF);
  const mStr = s.cfm(s.strF);
  let bits = num('Length', V === 1 ? 40 : V >= 4 ? 128 : 40);
  if (bits < 40) bits *= 8; // alcuni programmi scrivono la lunghezza in byte
  s.n = V === 1 ? 5 : V === 5 ? 32 : Math.max(5, Math.min(16, Math.floor(bits / 8)));
  if (V === 4 && (mStm === 'AESV2' || mStr === 'AESV2')) s.n = 16;

  let owner = false;
  if (R >= 5) {
    const pw = utf8Pw(password);
    const U48 = s.U.slice(0, 48);
    if (hash6(pw, s.O.slice(32, 40), U48, R) === s.O.slice(0, 32)) {
      owner = true;
      s.key = aesRaw(hash6(pw, s.O.slice(40, 48), U48, R), ZERO16, bin('OE').slice(0, 32), true);
    } else if (hash6(pw, s.U.slice(32, 40), '', R) === s.U.slice(0, 32)) {
      s.key = aesRaw(hash6(pw, s.U.slice(40, 48), '', R), ZERO16, bin('UE').slice(0, 32), true);
    } else throw fail('Password sbagliata.', 'password');
  } else {
    const padded = padPw(String(password));
    let key = keyR4(ownerToUser(padded, s), s);
    if (userOk(key, s)) owner = true;
    else {
      key = keyR4(padded, s);
      if (!userOk(key, s)) throw fail('Password sbagliata.', 'password');
    }
    s.key = key;
  }

  const P = s.P;
  const method = V === 5 ? 'AES-256' : (mStm === 'AESV2' || mStr === 'AESV2') ? 'AES-128' : s.n <= 5 ? 'RC4-40' : 'RC4-128';
  s.info = {
    method, revision: R, owner,
    permissions: {
      print: !!(P & 4), modify: !!(P & 8), copy: !!(P & 16), annotate: !!(P & 32),
      fillForms: !!(P & 32) || (R >= 3 && !!(P & 256)),
    },
  };
  return s;
}

// Funzione che decifra i byte di un oggetto (numero e generazione) col metodo indicato.
function decryptorFor(s, cfm, ref) {
  if (cfm === 'None') return null;
  const base = () => s.key + le(ref.objectNumber, 3) + le(ref.generationNumber, 2);
  if (cfm === 'AESV3') return (d) => aesDecrypt(s.key, d);
  if (cfm === 'AESV2') { let k; return (d) => aesDecrypt(k || (k = md5(base() + 'sAlT').slice(0, 16)), d); }
  let k;
  return (d) => rc4(k || (k = md5(base()).slice(0, Math.min(s.n + 5, 16))), d);
}

// Le firme digitali tengono /Contents in chiaro anche nei file protetti.
function isSigDict(d) {
  const t = d.lookup(N('Type'));
  return t === N('Sig') || t === N('DocTimeStamp') || (d.has(N('ByteRange')) && d.has(N('Contents')) && d.has(N('Filter')));
}

// Sostituisce ogni stringa (anche dentro dizionari e liste) con la sua versione trasformata.
function mapStrings(obj, fn) {
  const { PDFString, PDFHexString, PDFArray, PDFDict } = L();
  if (obj instanceof PDFString || obj instanceof PDFHexString) return PDFHexString.of(toHex(fn(obj.asBytes())));
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i += 1) { const v = obj.get(i); const nv = mapStrings(v, fn); if (nv !== v) obj.set(i, nv); }
  } else if (obj instanceof PDFDict) {
    const sig = isSigDict(obj);
    for (const [k, v] of obj.entries()) {
      if (sig && k === N('Contents')) continue;
      const nv = mapStrings(v, fn);
      if (nv !== v) obj.set(k, nv);
    }
  }
  return obj;
}

// Se il flusso ha un filtro /Crypt suo, lo toglie e restituisce il nome del filtro indicato.
function takeCryptFilter(dict) {
  const { PDFArray, PDFDict, PDFName } = L();
  const filt = dict.lookup(N('Filter'));
  const parms = dict.lookup(N('DecodeParms'));
  const nameOf = (p) => { const v = p instanceof PDFDict ? p.lookup(N('Name')) : null; return v instanceof PDFName ? String(v).slice(1) : 'Identity'; };
  if (filt === N('Crypt')) {
    dict.delete(N('Filter')); dict.delete(N('DecodeParms'));
    return nameOf(parms);
  }
  if (filt instanceof PDFArray && filt.size() && filt.lookup(0) === N('Crypt')) {
    const p0 = parms instanceof PDFArray ? parms.lookup(0) : parms;
    filt.remove(0);
    if (parms instanceof PDFArray && parms.size()) parms.remove(0);
    return nameOf(p0);
  }
  return null;
}

// ---------- API ----------

// Vero se il PDF dichiara una protezione (/Encrypt nel trailer o nel flusso xref).
export function isEncrypted(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const pat = [47, 69, 110, 99, 114, 121, 112, 116]; // "/Encrypt"
  outer: for (let i = u.length - pat.length - 1; i >= 0; i -= 1) {
    if (u[i] !== 47) continue;
    for (let j = 1; j < pat.length; j += 1) if (u[i + j] !== pat[j]) continue outer;
    let k = i + pat.length;
    while (k < u.length && (u[k] === 32 || u[k] === 10 || u[k] === 13 || u[k] === 9 || u[k] === 12 || u[k] === 0)) k += 1;
    if ((u[k] >= 48 && u[k] <= 57) || (u[k] === 60 && u[k + 1] === 60)) return true;
  }
  return false;
}

// Apre un PDF protetto con la password (dell'utente o del proprietario) e restituisce
// una copia non protetta, con tutte le stringhe e i flussi in chiaro.
export async function decryptPdf(bytes, password = '') {
  const { PDFParser, PDFRawStream, PDFXRefStreamParser, PDFObjectStreamParser, PDFWriter, PDFRef, PDFDict, PDFArray, PDFString, PDFHexString, decodePDFRawStream } = L();
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parser = PDFParser.forBytesWithOptions(u8, 200, false, false);
  const ctx = parser.context;
  const seq = new Map();
  const objStms = new Set();
  let order = 0;
  const ENDOBJ = Array.from('endobj', (c) => c.charCodeAt(0));
  // Come il lettore di pdf-lib, ma i flussi di oggetti restano chiusi: si aprono dopo averli decifrati.
  parser.parseIndirectObject = async function parseIndirectObject() {
    const ref = this.parseIndirectObjectHeader();
    this.skipWhitespaceAndComments();
    const obj = this.parseObject();
    this.skipWhitespaceAndComments();
    this.matchKeyword(ENDOBJ);
    const type = obj instanceof PDFRawStream ? obj.dict.lookup(N('Type')) : null;
    if (type === N('XRef')) PDFXRefStreamParser.forStream(obj).parseIntoContext();
    else {
      ctx.assign(ref, obj);
      seq.set(ref.tag, order++);
      if (type === N('ObjStm')) objStms.add(ref); else objStms.delete(ref);
    }
    return ref;
  };
  parser.maybeRecoverRoot = () => {};
  await parser.parseDocument();

  const encEntry = ctx.trailerInfo.Encrypt;
  const enc = encEntry ? ctx.lookup(encEntry) : null;
  if (!(enc instanceof PDFDict)) {
    // Non protetto: si rilegge normalmente.
    return { bytes: u8, info: null };
  }
  let id0 = '';
  const ids = ctx.lookup(ctx.trailerInfo.ID);
  if (ids instanceof PDFArray && ids.size()) {
    const v = ids.lookup(0);
    if (v instanceof PDFString || v instanceof PDFHexString) id0 = toBin(v.asBytes());
  }
  const s = openSecurity(enc, id0, password);
  const encRef = encEntry instanceof PDFRef ? encEntry : null;
  const mStr = s.cfm(s.strF);

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref === encRef) continue;
    const strFn = decryptorFor(s, mStr, ref);
    if (obj instanceof PDFRawStream) {
      const dict = obj.dict;
      if (strFn) mapStrings(dict, strFn);
      const own = takeCryptFilter(dict);
      const skip = !s.encMeta && dict.lookup(N('Type')) === N('Metadata');
      const fn = skip ? null : decryptorFor(s, s.cfm(own || s.stmF), ref);
      if (fn) ctx.assign(ref, PDFRawStream.of(dict, fn(obj.contents)));
    } else if (strFn) {
      mapStrings(obj, strFn);
    }
  }

  // Ora si aprono i flussi di oggetti, nell'ordine del file: un oggetto già definito
  // più avanti nel file (aggiornamento successivo) resta quello valido.
  const list = [...objStms].sort((a, b) => seq.get(a.tag) - seq.get(b.tag));
  for (const ref of list) {
    const stm = ctx.lookup(ref);
    if (!(stm instanceof PDFRawStream)) continue;
    const at = seq.get(ref.tag);
    const keep = [];
    try {
      const data = decodePDFRawStream(stm).decode();
      const count = stm.dict.lookup(N('N')).asNumber();
      let p = 0;
      const int = () => {
        while (p < data.length && (data[p] < 48 || data[p] > 57)) p += 1;
        let v = 0;
        while (p < data.length && data[p] >= 48 && data[p] <= 57) { v = v * 10 + data[p] - 48; p += 1; }
        return v;
      };
      for (let i = 0; i < count; i += 1) {
        const r = PDFRef.of(int(), 0);
        int();
        const prev = ctx.lookup(r);
        if (prev !== undefined && (seq.get(r.tag) ?? -1) > at) keep.push([r, prev]);
        else seq.set(r.tag, at);
      }
      ctx.delete(ref);
      await PDFObjectStreamParser.forStream(stm).parseIntoContext();
    } catch (e) {
      console.warn('Flusso di oggetti illeggibile', ref.tag, e);
    }
    for (const [r, o] of keep) ctx.assign(r, o);
  }
  PDFParser.prototype.maybeRecoverRoot.call(parser);
  if (ctx.lookup(PDFRef.of(0))) ctx.delete(PDFRef.of(0));

  if (encRef) ctx.delete(encRef);
  ctx.trailerInfo.Encrypt = undefined;
  ctx.largestObjectNumber = ctx.enumerateIndirectObjects().reduce((m, [r]) => Math.max(m, r.objectNumber), 0);
  const out = await PDFWriter.forContext(ctx, 200).serializeToBuffer();
  return { bytes: out, info: s.info };
}

// Protegge una copia del PDF con AES a 256 bit (V5, R6) e i permessi scelti.
export async function encryptPdf(bytes, {
  userPassword = '', ownerPassword = '', allowPrint = true, allowCopy = true, allowModify = true, allowAnnotate = true,
} = {}) {
  const { PDFDocument, PDFRawStream, PDFRef, PDFArray, PDFHexString, PDFWriter, PDFHeader } = L();
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let first;
  try {
    first = await PDFDocument.load(u8, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw fail('Il PDF è già protetto: aprilo con la password prima di proteggerlo di nuovo.', 'encrypted');
    throw e;
  }
  // Senza flussi di oggetti: ogni oggetto resta separato e si cifra da solo.
  const flat = await first.save({ useObjectStreams: false });
  const doc = await PDFDocument.load(flat, { updateMetadata: false });
  const ctx = doc.context;

  // Versione 1.7 con estensione Adobe di livello 8 (richiesta da AES a 256 bit).
  const v = String(ctx.header.toString()).match(/%PDF-(\d+)\.(\d+)/);
  if (!v || Number(v[1]) * 10 + Number(v[2]) < 17) ctx.header = PDFHeader.forVersion(1, 7);
  if (!doc.catalog.has(N('Extensions'))) {
    doc.catalog.set(N('Extensions'), ctx.obj({ ADBE: { BaseVersion: N('1.7'), ExtensionLevel: 8 } }));
  }

  // L'identificativo del file resta in chiaro nel trailer.
  let ids = ctx.trailerInfo.ID ? ctx.lookup(ctx.trailerInfo.ID) : null;
  if (!(ids instanceof PDFArray) || ids.size() < 2) {
    const id = toHex(fromBin(rand(16)));
    ids = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  } else {
    ids = ctx.obj([ids.get(0), ids.get(1)]);
  }
  ctx.trailerInfo.ID = ids;

  // Chiave del file e voci /U /UE /O /OE (algoritmi 8 e 9 della norma ISO 32000-2).
  const key = rand(32);
  const upw = utf8Pw(userPassword);
  const opw = utf8Pw(ownerPassword ? ownerPassword : toHex(fromBin(rand(24))));
  const uv = rand(8); const uk = rand(8);
  const U = hash6(upw, uv, '', 6) + uv + uk;
  const UE = aesRaw(hash6(upw, uk, '', 6), ZERO16, key);
  const ov = rand(8); const ok = rand(8);
  const O = hash6(opw, ov, U, 6) + ov + ok;
  const OE = aesRaw(hash6(opw, ok, U, 6), ZERO16, key);

  // Permessi (bit della voce /P, contati da 1).
  const bit = (n) => 1 << (n - 1);
  let P = 0xFFFFF0C0 | bit(10);
  if (allowPrint) P |= bit(3) | bit(12);
  if (allowModify) P |= bit(4) | bit(11);
  if (allowCopy) P |= bit(5);
  if (allowAnnotate) P |= bit(6) | bit(9);
  P |= 0;
  const Perms = aesRaw(key, ZERO16, le(P, 4) + '\xff\xff\xff\xff' + 'Tadb' + rand(4));

  const enc = (d) => aesEncrypt(key, d);
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      if (obj.dict.lookup(N('Type')) === N('XRef')) continue;
      mapStrings(obj.dict, enc);
      ctx.assign(ref, PDFRawStream.of(obj.dict, enc(obj.contents)));
    } else {
      mapStrings(obj, enc);
    }
  }

  const hex = (b) => PDFHexString.of(toHex(fromBin(b)));
  const encDict = ctx.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256,
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } },
    StmF: 'StdCF', StrF: 'StdCF',
    O: hex(O), U: hex(U), OE: hex(OE), UE: hex(UE), P, Perms: hex(Perms),
    EncryptMetadata: true,
  });
  const encRef = ctx.register(encDict);
  if (!(encRef instanceof PDFRef)) throw new Error('Registrazione non riuscita');
  ctx.trailerInfo.Encrypt = encRef;
  return PDFWriter.forContext(ctx, 200).serializeToBuffer();
}

// ---------- interfaccia ----------
let styled = false;
function addStyle() {
  if (styled) return;
  styled = true;
  document.head.append(h('style', {}, `
.modal.protect { max-width: 440px; }
.modal.protect label.field { display: block; margin: 8px 0; }
.modal.protect label.field input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; }
.modal.protect fieldset { border: 1px solid rgba(128,128,128,.4); border-radius: 6px; margin: 12px 0 8px; padding: 6px 10px 8px; }
.modal.protect label.check { display: flex; gap: 8px; align-items: center; margin: 5px 0; }
.modal.protect .hint { font-size: .85em; opacity: .75; margin: 2px 0 6px; }
.modal.protect .msg { color: #c0392b; min-height: 1.2em; margin: 6px 0 0; }
`));
}

// Chiede password e permessi. Restituisce le opzioni per encryptPdf, oppure null se si annulla.
export function askProtection() {
  addStyle();
  return modal((box, done) => {
    box.classList.add('protect');
    const inp = (id) => h('input', { type: 'password', autocomplete: 'new-password', 'data-id': id });
    const user = inp('pc-user');
    const again = inp('pc-again');
    const owner = inp('pc-owner');
    const check = (id, label) => { const i = h('input', { type: 'checkbox', checked: true, 'data-id': id }); return [i, h('label', { class: 'check' }, i, label)]; };
    const [print, printL] = check('pc-print', 'stampare');
    const [copy, copyL] = check('pc-copy', 'copiare il testo');
    const [modify, modifyL] = check('pc-modify', 'modificare il documento');
    const [annot, annotL] = check('pc-annotate', 'aggiungere note e compilare i moduli');
    const show = h('input', { type: 'checkbox', 'data-id': 'pc-show' });
    show.addEventListener('change', () => { for (const i of [user, again, owner]) i.type = show.checked ? 'text' : 'password'; });
    const msg = h('p', { class: 'msg', role: 'alert', 'data-id': 'pc-msg' });
    const confirm = () => {
      if (!user.value) { msg.textContent = 'Scrivi la password di apertura.'; user.focus(); return; }
      if (user.value !== again.value) { msg.textContent = 'Le due password di apertura non coincidono.'; again.focus(); return; }
      const limited = !(print.checked && copy.checked && modify.checked && annot.checked);
      if (owner.value && owner.value === user.value && limited) {
        msg.textContent = 'La password del proprietario deve essere diversa da quella di apertura, altrimenti i limiti non valgono.';
        owner.focus();
        return;
      }
      done({
        userPassword: user.value, ownerPassword: owner.value,
        allowPrint: print.checked, allowCopy: copy.checked, allowModify: modify.checked, allowAnnotate: annot.checked,
      });
    };
    for (const i of [user, again, owner]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
    box.append(
      h('h2', {}, 'Proteggi con password'),
      h('p', { class: 'hint' }, 'La copia sarà cifrata (AES a 256 bit): senza la password non si potrà aprire. Se dimentichi la password, nessuno potrà recuperarla.'),
      h('label', { class: 'field' }, 'Password di apertura', user),
      h('label', { class: 'field' }, 'Ripeti la password', again),
      h('label', { class: 'field' }, 'Password del proprietario (facoltativa)', owner),
      h('p', { class: 'hint' }, 'Serve a togliere i limiti qui sotto. Se la lasci vuota ne viene creata una a caso, che nessuno conosce.'),
      h('fieldset', {}, h('legend', {}, 'Chi conosce solo la password di apertura può:'), printL, copyL, modifyL, annotL),
      h('label', { class: 'check' }, show, 'Mostra le password'),
      msg,
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => done(null), 'data-id': 'pc-cancel' }, 'Annulla'),
        h('button', { class: 'primary', onclick: confirm, 'data-id': 'pc-ok' }, 'Proteggi')),
    );
  }).then((v) => v || null);
}

// Descrizione in italiano della protezione letta da decryptPdf.
export function protectionLabel(info) {
  if (!info) return 'Nessuna protezione';
  const M = { 'RC4-40': 'RC4 a 40 bit (debole)', 'RC4-128': 'RC4 a 128 bit', 'AES-128': 'AES a 128 bit', 'AES-256': 'AES a 256 bit' };
  const p = info.permissions || {};
  const f = (ok, what) => `${what} ${ok ? 'consentita' : 'vietata'}`;
  const perms = [f(p.print, 'stampa'), f(p.copy, 'copia'), f(p.modify, 'modifica'), `note ${p.annotate ? 'consentite' : 'vietate'}`, f(p.fillForms, 'compilazione dei moduli')].join(', ');
  const method = M[info.method] || 'cifratura sconosciuta';
  if (info.owner) return `${method}, aperto con la password del proprietario: nessun limite (con la sola password di apertura: ${perms})`;
  return `${method}, ${perms}`;
}
