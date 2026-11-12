// Immagini dentro un PDF: elenco, lettura dei pixel, creazione di nuove immagini e sostituzione.
// Tutto in JavaScript (pdf-lib, fflate, canvas del browser): funziona uguale su Windows e su Android.
// Lo usano la compressione e l'oscuramento di zone di immagini.

const L = () => window.PDFLib;
const N = (s) => L().PDFName.of(s);

// --- Utilità sugli oggetti di pdf-lib ----------------------------------------
const num = (v, d = 0) => (v && typeof v.asNumber === 'function' ? v.asNumber() : d);
const nameOf = (v) => (v instanceof L().PDFName ? v.decodeText() : null);
const isStream = (o) => !!(o && o.dict instanceof L().PDFDict && o.contents);
const resolve = (doc, v) => (v instanceof L().PDFRef ? doc.context.lookup(v) : v);

// Il dizionario dell'immagine e il riferimento (se c'è).
function streamOf(doc, refOrStream) {
  const ref = refOrStream instanceof L().PDFRef ? refOrStream : null;
  const obj = ref ? doc.context.lookup(ref) : refOrStream;
  return { ref, obj: isStream(obj) ? obj : null };
}

function filtersOf(dict) {
  const f = dict.lookup(N('Filter'));
  const p = dict.lookup(N('DecodeParms')) || dict.lookup(N('DP'));
  if (!f) return [];
  if (f instanceof L().PDFName) return [{ name: abbrev(f.decodeText()), parms: p instanceof L().PDFDict ? p : null }];
  if (f instanceof L().PDFArray) {
    return f.asArray().map((x, i) => {
      const pi = p instanceof L().PDFArray ? p.lookup(i) : null;
      return { name: abbrev(nameOf(x) || ''), parms: pi instanceof L().PDFDict ? pi : null };
    });
  }
  return [];
}
const ABBR = { AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode' };
const abbrev = (s) => ABBR[s] || s;

// --- Decompressione dei filtri senza perdita -----------------------------------
// Un passo con pdf-lib (LZW, ASCII85, ASCIIHex, RunLength): si costruisce un flusso finto con un solo filtro.
function pdfLibStep(bytes, name) {
  const filter = N(name);
  const fake = { contents: bytes, dict: { lookup: (k) => (k === N('Filter') ? filter : undefined) } };
  return L().decodePDFRawStream(fake).decode();
}

function inflate(bytes) {
  try { return window.fflate.unzlibSync(bytes); } catch {
    // Flussi un po' rovinati o senza intestazione: si prova senza intestazione, poi col lettore tollerante di pdf-lib.
    try { return window.fflate.inflateSync(bytes.subarray(2)); } catch { return pdfLibStep(bytes, 'FlateDecode'); }
  }
}

// Predittori: 2 (TIFF) e 10–15 (PNG). Restituisce i dati senza i byte di filtro delle righe.
export function unpredict(data, parms) {
  const pred = num(parms?.lookup(N('Predictor')), 1);
  if (pred < 2) return data;
  const colors = num(parms.lookup(N('Colors')), 1);
  const bpc = num(parms.lookup(N('BitsPerComponent')), 8);
  const cols = num(parms.lookup(N('Columns')), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8)); // byte per pixel (almeno 1)
  const row = Math.ceil((colors * bpc * cols) / 8);
  if (pred === 2) {
    const out = new Uint8Array(data);
    if (bpc === 8) {
      for (let r = 0; r + row <= out.length; r += row) for (let i = r + colors; i < r + row; i += 1) out[i] = (out[i] + out[i - colors]) & 255;
    } else if (bpc === 16) {
      for (let r = 0; r + row <= out.length; r += row) {
        for (let i = r + colors * 2; i + 1 < r + row; i += 2) {
          const v = ((out[i] << 8) | out[i + 1]) + ((out[i - colors * 2] << 8) | out[i - colors * 2 + 1]);
          out[i] = (v >> 8) & 255; out[i + 1] = v & 255;
        }
      }
    } else return null; // TIFF con meno di 8 bit: raro, non gestito
    return out;
  }
  const rows = Math.floor(data.length / (row + 1));
  const out = new Uint8Array(rows * row);
  const prev = new Uint8Array(row);
  for (let r = 0; r < rows; r += 1) {
    const type = data[r * (row + 1)];
    const src = data.subarray(r * (row + 1) + 1, (r + 1) * (row + 1));
    const cur = out.subarray(r * row, (r + 1) * row);
    for (let i = 0; i < row; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    prev.set(cur);
  }
  return out;
}

// Decodifica i filtri fino al primo filtro "di immagine" (DCT, JPX, JBIG2, CCITT), che resta da fare.
function decodeFilters(contents, filters) {
  let data = contents;
  for (let i = 0; i < filters.length; i += 1) {
    const { name, parms } = filters[i];
    if (name === 'FlateDecode') data = unpredict(inflate(data), parms);
    else if (name === 'LZWDecode') data = unpredict(pdfLibStep(data, 'LZWDecode'), parms);
    else if (['ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode'].includes(name)) data = pdfLibStep(data, name);
    else return { data, rest: filters.slice(i) };
    if (!data) return { data: null, rest: [] };
  }
  return { data, rest: [] };
}

// --- Spazi colore --------------------------------------------------------------
// Restituisce { kind: 'gray'|'rgb'|'cmyk'|'indexed', n, base, hival, lookup } oppure null se non gestito.
function colorSpaceInfo(doc, cs) {
  cs = resolve(doc, cs);
  const n = nameOf(cs);
  if (n) {
    if (n === 'DeviceGray' || n === 'G' || n === 'CalGray') return { kind: 'gray', n: 1, label: 'DeviceGray' };
    if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB') return { kind: 'rgb', n: 3, label: 'DeviceRGB' };
    if (n === 'DeviceCMYK' || n === 'CMYK') return { kind: 'cmyk', n: 4, label: 'DeviceCMYK' };
    return null;
  }
  if (!(cs instanceof L().PDFArray) || !cs.size()) return null;
  const family = nameOf(cs.lookup(0));
  if (family === 'CalGray') return { kind: 'gray', n: 1, label: 'CalGray' };
  if (family === 'CalRGB') return { kind: 'rgb', n: 3, label: 'CalRGB' };
  if (family === 'ICCBased') {
    const s = cs.lookup(1);
    const k = num(s?.dict?.lookup(N('N')), 0);
    if (k === 1) return { kind: 'gray', n: 1, label: 'ICCBased' };
    if (k === 3) return { kind: 'rgb', n: 3, label: 'ICCBased' };
    if (k === 4) return { kind: 'cmyk', n: 4, label: 'ICCBased' };
    return null;
  }
  if (family === 'Indexed' || family === 'I') {
    const base = colorSpaceInfo(doc, cs.get(1));
    if (!base || base.kind === 'indexed') return null;
    const hival = num(cs.lookup(2), 0);
    let lk = cs.lookup(3);
    let bytes;
    if (lk instanceof L().PDFHexString || lk instanceof L().PDFString) bytes = lk.asBytes();
    else if (isStream(lk)) bytes = decodeFilters(lk.contents, filtersOf(lk.dict)).data;
    if (!bytes) return null;
    return { kind: 'indexed', n: 1, base, hival, lookup: bytes, label: 'Indexed' };
  }
  return null;
}

// Un pixel nello spazio di base → RGB 0..255 (CMYK in modo semplice, senza profili).
function toRgb(kind, comps, out, o) {
  if (kind === 'gray') { out[o] = out[o + 1] = out[o + 2] = comps[0]; return; }
  if (kind === 'rgb') { out[o] = comps[0]; out[o + 1] = comps[1]; out[o + 2] = comps[2]; return; }
  const k = 255 - comps[3];
  out[o] = ((255 - comps[0]) * k) / 255;
  out[o + 1] = ((255 - comps[1]) * k) / 255;
  out[o + 2] = ((255 - comps[2]) * k) / 255;
}

// Campioni grezzi (1, 2, 4, 8, 16 bit) → valori interi per componente.
function samples(data, width, height, ncomp, bpc) {
  const total = width * height * ncomp;
  const out = new Uint16Array(total);
  const rowBytes = Math.ceil((width * ncomp * bpc) / 8);
  if (data.length < rowBytes * height) return null;
  for (let y = 0; y < height; y += 1) {
    const base = y * rowBytes;
    const o = y * width * ncomp;
    if (bpc === 8) { for (let i = 0; i < width * ncomp; i += 1) out[o + i] = data[base + i]; continue; }
    if (bpc === 16) { for (let i = 0; i < width * ncomp; i += 1) out[o + i] = data[base + i * 2]; continue; } // si tiene il byte alto
    const mask = (1 << bpc) - 1;
    for (let i = 0; i < width * ncomp; i += 1) {
      const bit = i * bpc;
      out[o + i] = (data[base + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask;
    }
  }
  return out;
}

// --- JPEG ----------------------------------------------------------------------
// Legge dall'intestazione del JPEG il numero di componenti e se c'è il segno Adobe (CMYK invertito).
function jpegInfo(b) {
  let comps = 0; let adobe = false; let w = 0; let hgt = 0;
  for (let i = 2; i + 4 < b.length;) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xee && b[i + 4] === 0x41 && b[i + 5] === 0x64 && b[i + 6] === 0x6f && b[i + 7] === 0x62 && b[i + 8] === 0x65) adobe = true;
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      hgt = (b[i + 5] << 8) | b[i + 6]; w = (b[i + 7] << 8) | b[i + 8]; comps = b[i + 9];
      break;
    }
    if (m === 0xda) break;
    i += 2 + len;
  }
  return { comps, adobe, width: w, height: hgt };
}

async function decodeJpeg(bytes) {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  return g.getImageData(0, 0, c.width, c.height).data;
}

// --- Lettura dell'immagine ----------------------------------------------------
// decodeImage(pdfDoc, refOrStream) → { width, height, data (RGBA), kind, colorSpace, bpc, hasAlpha } oppure null.
export async function decodeImage(doc, refOrStream, { withMask = true } = {}) {
  try {
    const { obj } = streamOf(doc, refOrStream);
    if (!obj) return null;
    const d = obj.dict;
    if (nameOf(d.lookup(N('Subtype'))) !== 'Image') return null;
    const width = num(d.lookup(N('Width'))); const height = num(d.lookup(N('Height')));
    if (!width || !height || width * height > 80e6) return null;
    const imageMask = d.lookup(N('ImageMask'));
    if (imageMask && imageMask.asBoolean?.()) return null; // maschere a stampo: non sono immagini a colori
    const filters = filtersOf(d);
    const { data, rest } = decodeFilters(obj.contents, filters);
    if (!data) return null;
    let rgba;
    let kind = 'raw';
    let bpc = num(d.lookup(N('BitsPerComponent')), 8);
    const csObj = d.get(N('ColorSpace'));
    let cs = csObj ? colorSpaceInfo(doc, csObj) : null;
    const decodeArr = d.lookup(N('Decode'));
    const dec = decodeArr instanceof L().PDFArray ? decodeArr.asArray().map((v) => num(v)) : null;
    if (rest.length) {
      if (rest[0].name !== 'DCTDecode' || rest.length > 1) return null; // JPX, JBIG2, CCITT: non gestiti
      kind = 'jpeg';
      const info = jpegInfo(data);
      if (!info.comps) return null;
      const inverted = dec && dec[0] === 1 && dec[1] === 0;
      // CMYK: il browser lo legge come "Adobe invertito"; senza il segno Adobe i colori verrebbero sbagliati.
      if (info.comps === 4 && (!info.adobe || inverted)) return null;
      if (info.comps !== 4 && inverted) return null;
      rgba = await decodeJpeg(data);
      bpc = 8;
      if (!cs) cs = info.comps === 1 ? { label: 'DeviceGray' } : (info.comps === 4 ? { label: 'DeviceCMYK' } : { label: 'DeviceRGB' });
      // Dimensioni diverse da quelle dichiarate: il JPEG comanda, ma il risultato deve corrispondere al dizionario.
      if (info.width !== width || info.height !== height) return null;
    } else {
      if (!cs) return null;
      kind = filters.length ? (filters.some((f) => f.name === 'FlateDecode') ? 'flate' : filters[0].name.replace('Decode', '').toLowerCase()) : 'raw';
      if (![1, 2, 4, 8, 16].includes(bpc)) return null;
      const s = samples(data, width, height, cs.n, bpc);
      if (!s) return null;
      const max = (1 << bpc) - 1;
      rgba = new Uint8ClampedArray(width * height * 4);
      const comps = [0, 0, 0, 0];
      if (cs.kind === 'indexed') {
        if (dec && !(dec[0] === 0 && dec[1] === max)) return null;
        const bn = cs.base.n;
        const pal = new Uint8ClampedArray((cs.hival + 1) * 4);
        for (let i = 0; i <= cs.hival; i += 1) {
          for (let k = 0; k < bn; k += 1) comps[k] = cs.lookup[i * bn + k] ?? 0;
          toRgb(cs.base.kind, comps, pal, i * 4);
          pal[i * 4 + 3] = 255;
        }
        for (let i = 0, o = 0; i < s.length; i += 1, o += 4) {
          const v = Math.min(s[i], cs.hival) * 4;
          rgba[o] = pal[v]; rgba[o + 1] = pal[v + 1]; rgba[o + 2] = pal[v + 2]; rgba[o + 3] = 255;
        }
      } else {
        // Tabella dei valori: tiene conto di un eventuale /Decode (per esempio [1 0] che inverte i grigi).
        const lut = [];
        for (let k = 0; k < cs.n; k += 1) {
          const dmin = dec ? dec[k * 2] : 0; const dmax = dec ? dec[k * 2 + 1] : 1;
          const t = new Uint8ClampedArray(max + 1);
          for (let v = 0; v <= max; v += 1) t[v] = Math.round((dmin + (v * (dmax - dmin)) / max) * 255);
          lut.push(t);
        }
        const n = cs.n;
        for (let p = 0, i = 0, o = 0; p < width * height; p += 1, i += n, o += 4) {
          for (let k = 0; k < n; k += 1) comps[k] = lut[k][s[i + k]];
          toRgb(cs.kind, comps, rgba, o);
          rgba[o + 3] = 255;
        }
      }
    }
    let hasAlpha = false;
    // /SMask: un'immagine in grigi che fa da trasparenza.
    const sm = d.get(N('SMask'));
    if (withMask && sm) {
      const mask = await decodeImage(doc, sm, { withMask: false });
      if (!mask) return null; // senza la trasparenza l'immagine verrebbe sbagliata
      for (let y = 0; y < height; y += 1) {
        const my = Math.min(mask.height - 1, Math.floor((y * mask.height) / height));
        for (let x = 0; x < width; x += 1) {
          const mx = Math.min(mask.width - 1, Math.floor((x * mask.width) / width));
          const a = mask.data[(my * mask.width + mx) * 4];
          rgba[(y * width + x) * 4 + 3] = a;
          if (a < 255) hasAlpha = true;
        }
      }
    }
    if (!(rgba instanceof Uint8ClampedArray)) rgba = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
    return { width, height, data: rgba, kind, colorSpace: cs?.label || null, bpc, hasAlpha };
  } catch (e) {
    console.warn('Immagine non leggibile:', e?.message || e);
    return null;
  }
}

// --- Analisi dei pixel ---------------------------------------------------------
// Quanti colori diversi (fino a limit+1), se è tutta in grigi, se ha trasparenza.
export function analyzePixels(rgba, limit = 256) {
  let gray = true; let alpha = false;
  const seen = new Map();
  let many = false;
  for (let o = 0; o < rgba.length; o += 4) {
    const r = rgba[o]; const g = rgba[o + 1]; const b = rgba[o + 2];
    if (gray && (r !== g || g !== b)) gray = false;
    if (rgba[o + 3] !== 255) alpha = true;
    if (!many) {
      const key = (r << 16) | (g << 8) | b;
      if (!seen.has(key)) { seen.set(key, seen.size); if (seen.size > limit) many = true; }
    }
  }
  return { gray, alpha, colors: many ? limit + 1 : seen.size, palette: many ? null : seen };
}

// Filtro PNG per ogni riga (scelto quello con la somma minore): rende la compressione Flate molto più efficace.
function pngFilter(raw, rowBytes, bpp) {
  const rows = raw.length / rowBytes;
  const out = new Uint8Array(rows * (rowBytes + 1));
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(rowBytes));
  const zero = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r += 1) {
    const cur = raw.subarray(r * rowBytes, (r + 1) * rowBytes);
    const prev = r ? raw.subarray((r - 1) * rowBytes, r * rowBytes) : zero;
    let best = 0; let bestSum = Infinity;
    for (let t = 0; t < 5; t += 1) {
      const c = cand[t];
      let sum = 0;
      for (let i = 0; i < rowBytes; i += 1) {
        const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const cc = i >= bpp ? prev[i - bpp] : 0;
        let p;
        if (t === 0) p = 0; else if (t === 1) p = a; else if (t === 2) p = b; else if (t === 3) p = (a + b) >> 1;
        else { const q = a + b - cc; const pa = Math.abs(q - a); const pb = Math.abs(q - b); const pc = Math.abs(q - cc); p = pa <= pb && pa <= pc ? a : (pb <= pc ? b : cc); }
        const v = (cur[i] - p) & 255;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = t; }
    }
    out[r * (rowBytes + 1)] = best;
    out.set(cand[best], r * (rowBytes + 1) + 1);
  }
  return out;
}

const deflate = (bytes) => window.fflate.zlibSync(bytes, { level: 9 });

// Flusso Flate (grigi, RGB o tavolozza) per i pixel dati, senza trasparenza.
function flateImage(doc, rgba, width, height, info) {
  const px = width * height;
  if (info.palette && info.colors <= 256 && !(info.gray && info.colors > 16)) {
    // Tavolozza: 1, 2, 4 o 8 bit per pixel secondo il numero di colori.
    const colors = [...info.palette.keys()];
    const bpc = colors.length <= 2 ? 1 : colors.length <= 4 ? 2 : colors.length <= 16 ? 4 : 8;
    const rowBytes = Math.ceil((width * bpc) / 8);
    const raw = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        const idx = info.palette.get((rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]);
        const bit = x * bpc;
        raw[y * rowBytes + (bit >> 3)] |= idx << (8 - bpc - (bit & 7));
      }
    }
    const lut = new Uint8Array(colors.length * 3);
    colors.forEach((c, i) => { lut[i * 3] = c >> 16; lut[i * 3 + 1] = (c >> 8) & 255; lut[i * 3 + 2] = c & 255; });
    const cs = doc.context.obj([N('Indexed'), N('DeviceRGB'), colors.length - 1, L().PDFHexString.of([...lut].map((v) => v.toString(16).padStart(2, '0')).join(''))]);
    return doc.context.stream(deflate(raw), { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: cs, BitsPerComponent: bpc, Filter: 'FlateDecode' });
  }
  const n = info.gray ? 1 : 3;
  const raw = new Uint8Array(px * n);
  for (let p = 0, o = 0; p < px; p += 1, o += 4) {
    if (n === 1) raw[p] = rgba[o];
    else { raw[p * 3] = rgba[o]; raw[p * 3 + 1] = rgba[o + 1]; raw[p * 3 + 2] = rgba[o + 2]; }
  }
  const filtered = pngFilter(raw, width * n, n);
  return doc.context.stream(deflate(filtered), {
    Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: n === 1 ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8,
    Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: n, BitsPerComponent: 8, Columns: width },
  });
}

async function jpegBytes(rgba, width, height, quality) {
  const opaque = new Uint8ClampedArray(rgba);
  for (let o = 3; o < opaque.length; o += 4) opaque[o] = 255; // la trasparenza va nella SMask, non nel JPEG
  const c = new OffscreenCanvas(width, height);
  c.getContext('2d').putImageData(new ImageData(opaque, width, height), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

// Crea il flusso dell'immagine (senza registrarlo). Usato da encodeImage e dalla compressione per confrontare le dimensioni.
export async function buildImageStream(doc, rgba, width, height, { format = 'flate', quality = 0.8, info } = {}) {
  info = info || analyzePixels(rgba);
  let stream;
  if (format === 'jpeg') {
    const bytes = await jpegBytes(rgba, width, height, quality);
    stream = doc.context.stream(bytes, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
  } else {
    stream = flateImage(doc, rgba, width, height, info);
  }
  let smask = null;
  if (info.alpha) {
    const a = new Uint8Array(width * height);
    for (let p = 0; p < a.length; p += 1) a[p] = rgba[p * 4 + 3];
    smask = doc.context.stream(deflate(pngFilter(a, width, 1)), {
      Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: width },
    });
  }
  return { stream, smask, bytes: stream.contents.length + (smask ? smask.contents.length : 0) };
}

// Registra un'immagine già costruita (e la sua trasparenza) e ne restituisce il riferimento.
export function registerImage(doc, built) {
  if (built.smask) built.stream.dict.set(N('SMask'), doc.context.register(built.smask));
  return doc.context.register(built.stream);
}

// encodeImage(pdfDoc, rgba, width, height, { format, quality }) → PDFRef di un nuovo XObject immagine.
// L'alfa diventa /SMask solo se qualche pixel non è del tutto opaco.
export async function encodeImage(doc, rgba, width, height, opts = {}) {
  return registerImage(doc, await buildImageStream(doc, rgba, width, height, opts));
}

// Chiavi del vecchio dizionario che vale la pena conservare nella nuova immagine.
const KEEP = ['Intent', 'Interpolate', 'OC', 'StructParent', 'ID', 'Name'];

// replaceImage(pdfDoc, ref, newRef): sostituzione "in posto". Il nuovo oggetto prende il numero di quello vecchio,
// così pagine, moduli e disegni che lo usano non cambiano; il numero nuovo viene liberato.
// La vecchia /SMask, se nessuno la usa più, sparisce alla pulizia degli oggetti non raggiungibili.
export function replaceImage(doc, ref, newRef) {
  const ctx = doc.context;
  const old = ctx.lookup(ref);
  const neu = ctx.lookup(newRef);
  if (!isStream(neu)) throw new Error('La nuova immagine non è valida');
  if (isStream(old)) for (const k of KEEP) { const v = old.dict.get(N(k)); if (v !== undefined && !neu.dict.has(N(k))) neu.dict.set(N(k), v); }
  ctx.assign(ref, neu);
  if (newRef !== ref) ctx.delete(newRef);
  return ref;
}

// listImages(pdfDoc) → [{ ref, width, height, filter, bytes, colorSpace, bpc, isMask, hasSMask }]
// isMask: l'immagine fa da trasparenza (/SMask o /Mask) di un'altra; si tratta insieme a quella.
export function listImages(doc) {
  const out = [];
  const masks = new Set();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!isStream(obj) || nameOf(obj.dict.lookup(N('Subtype'))) !== 'Image') continue;
    const d = obj.dict;
    for (const k of ['SMask', 'Mask']) { const m = d.get(N(k)); if (m instanceof L().PDFRef) masks.add(m.toString()); }
    const f = filtersOf(d);
    const cs = d.lookup(N('ColorSpace'));
    out.push({
      ref, width: num(d.lookup(N('Width'))), height: num(d.lookup(N('Height'))),
      filter: f.length ? f.map((x) => x.name).join('+') : 'nessuno', bytes: obj.contents.length,
      colorSpace: nameOf(cs) || (cs instanceof L().PDFArray ? nameOf(cs.lookup(0)) : null), bpc: num(d.lookup(N('BitsPerComponent')), 0),
      hasSMask: !!d.get(N('SMask')), hasMask: !!d.get(N('Mask')), imageMask: !!d.lookup(N('ImageMask'))?.asBoolean?.(),
    });
  }
  for (const it of out) it.isMask = masks.has(it.ref.toString());
  return out;
}

// Ridimensiona con media dei pixel (filtro a riquadro), pesando i colori con la trasparenza: niente bordi scuri.
export function downscale(rgba, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4);
  const xs = new Int32Array(nw + 1); const ys = new Int32Array(nh + 1);
  for (let x = 0; x <= nw; x += 1) xs[x] = Math.min(w, Math.round((x * w) / nw));
  for (let y = 0; y <= nh; y += 1) ys[y] = Math.min(h, Math.round((y * h) / nh));
  for (let ty = 0; ty < nh; ty += 1) {
    const y0 = ys[ty]; const y1 = Math.max(ys[ty + 1], y0 + 1);
    for (let tx = 0; tx < nw; tx += 1) {
      const x0 = xs[tx]; const x1 = Math.max(xs[tx + 1], x0 + 1);
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let y = y0; y < y1; y += 1) {
        let o = (y * w + x0) * 4;
        for (let x = x0; x < x1; x += 1, o += 4) {
          const al = rgba[o + 3];
          r += rgba[o] * al; g += rgba[o + 1] * al; b += rgba[o + 2] * al; a += al; n += 1;
        }
      }
      const q = (ty * nw + tx) * 4;
      if (a > 0) { out[q] = r / a; out[q + 1] = g / a; out[q + 2] = b / a; }
      out[q + 3] = a / n;
    }
  }
  return out;
}
