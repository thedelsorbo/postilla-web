// Modello del testo di una pagina: parole con posizione, usate per selezione, evidenziazione e ricerca.
const ctx = document.createElement('canvas').getContext('2d');
export const LOW_CONF = 60; // OCR: sotto questa fiducia la parola è "da verificare"
export const MIN_NATIVE_CHARS = 20; // pagine con meno caratteri di testo vero sono considerate scansioni
// Confronto tollerante: niente accenti né maiuscole, apostrofi e trattini tipografici uguali a quelli semplici.
// Ogni carattere resta un carattere, così le posizioni nel testo non cambiano.
export const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘`´]/g, "'").replace(/[‐‑–—]/g, '-').toLowerCase();

function measure(str) { return ctx.measureText(str).width; }

export async function pageText(view, i) {
  if (view.textCache.has(i)) return view.textCache.get(i);
  const promise = (async () => {
    const pg = await view.getPage(i);
    const content = await pg.getTextContent();
    const words = [];
    let text = '';
    ctx.font = '100px Arial';
    content.items.forEach((it, itemIdx) => {
      if (!it.str) { if (it.hasEOL) text += '\n'; return; }
      const [a, b, c, d, e, f] = it.transform;
      const len = Math.hypot(a, b) || 1;
      const ux = a / len; const uy = b / len; // direzione del testo
      const hgt = Math.hypot(c, d) || len;
      const vx = c / (Math.hypot(c, d) || 1); const vy = d / (Math.hypot(c, d) || 1); // verso l'alto
      const total = measure(it.str) || 1;
      const k = it.width / total;
      const re = /\S+/g;
      let m;
      const base = text.length;
      while ((m = re.exec(it.str))) {
        const x0 = measure(it.str.slice(0, m.index)) * k;
        const x1 = measure(it.str.slice(0, m.index + m[0].length)) * k;
        const pt = (t, up) => [e + ux * t + vx * up, f + uy * t + vy * up];
        const top = hgt * 0.92; const bot = -hgt * 0.24;
        words.push({ str: m[0], item: itemIdx, off: base + m.index, quad: [...pt(x0, top), ...pt(x1, top), ...pt(x0, bot), ...pt(x1, bot)] });
      }
      text += it.str + (it.hasEOL ? '\n' : ' ');
    });
    // Pagina scansionata con OCR già fatto: si usano le parole riconosciute, segnate come tali.
    const ocr = view.ocr?.pages?.[i];
    if (ocr && text.replace(/\s/g, '').length < MIN_NATIVE_CHARS) return ocrText(ocr);
    return { words, text, lower: norm(text) };
  })();
  view.textCache.set(i, promise);
  return promise;
}

function ocrText(page) {
  const words = [];
  let text = '';
  let line = null;
  for (const w of page.words) {
    if (line !== null) text += w.l === line ? ' ' : (w.l > line + 1 ? '\n\n' : '\n');
    line = w.l;
    words.push({ str: w.s, off: text.length, quad: w.q, ocr: true, conf: w.c });
    text += w.s;
  }
  return { words, text, lower: norm(text), ocr: true };
}

export function nearestWord(words, ux, uy, maxDist = Infinity) {
  let best = -1; let bd = Infinity;
  words.forEach((w, i) => {
    const q = w.quad;
    const x0 = Math.min(q[0], q[4], q[2], q[6]); const x1 = Math.max(q[0], q[4], q[2], q[6]);
    const y0 = Math.min(q[1], q[5], q[3], q[7]); const y1 = Math.max(q[1], q[5], q[3], q[7]);
    const dx = Math.max(x0 - ux, 0, ux - x1); const dy = Math.max(y0 - uy, 0, uy - y1);
    const d = dx * dx + dy * dy * 4; // la riga conta più della colonna
    if (d < bd) { bd = d; best = i; }
  });
  return bd <= maxDist * maxDist ? best : -1;
}

// Unisce le parole della stessa riga in un solo riquadro: niente doppia colorazione.
export function mergeQuads(words) {
  const out = [];
  for (const w of words) {
    const last = out[out.length - 1];
    const q = w.quad;
    const sameLine = last && Math.abs(last[5] - q[4 + 1]) < (Math.abs(q[1] - q[5]) * 0.4) && q[0] >= last[0] - 1;
    if (sameLine) { last[2] = q[2]; last[3] = q[3]; last[6] = q[6]; last[7] = q[7]; } else out.push([...q]);
  }
  return out;
}

export async function searchAll(view, query, onHit, cancelled) {
  const needle = norm(query.trim());
  if (!needle) return;
  for (let i = 0; i < view.pages.length; i += 1) {
    if (cancelled()) return;
    const pt = await pageText(view, i);
    let at = pt.lower.indexOf(needle);
    while (at >= 0) {
      const end = at + needle.length;
      const ws = pt.words.filter((w) => w.off < end && w.off + w.str.length > at);
      if (ws.length) {
        const unsure = ws.filter((w) => w.ocr && w.conf < LOW_CONF).map((w) => w.quad);
        onHit({ page: i, quads: mergeQuads(ws), snippet: pt.text.slice(Math.max(0, at - 30), end + 40).replace(/\s+/g, ' '), ocr: !!pt.ocr, unsure });
      }
      at = pt.lower.indexOf(needle, end);
    }
  }
}
