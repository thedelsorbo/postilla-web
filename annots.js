// Geometria e disegno a schermo delle annotazioni.
// Le coordinate sono salvate nello spazio del PDF: restano giuste con zoom e rotazioni.
import { getStroke } from './node_modules/perfect-freehand/dist/esm/index.mjs';

const mctx = document.createElement('canvas').getContext('2d');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const toDisp = (p, x, y) => p.vp.convertToViewportPoint(x, y);
export const toUser = (p, x, y) => p.vp.convertToPdfPoint(x, y);

export function dispRect(p, a) {
  const [x0, y0] = toDisp(p, ...a.a); const [x1, y1] = toDisp(p, ...a.b);
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

export function strokeOutline(pts, size, pressure) {
  return getStroke(pts, { size, thinning: pressure ? 0.62 : 0, smoothing: 0.55, streamline: 0.35, simulatePressure: false, last: true });
}

export function outlineD(outline) {
  if (!outline.length) return '';
  let d = `M${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)}`;
  for (let i = 1; i < outline.length; i += 1) d += `L${outline[i][0].toFixed(2)} ${outline[i][1].toFixed(2)}`;
  return `${d}Z`;
}

export function wrapLines(text, size, maxW, font = 'Arial') {
  mctx.font = `${size}px ${font}`;
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (mctx.measureText(test).width <= maxW || !line) line = test;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

export function stampFont(label, w, hgt) {
  mctx.font = 'bold 100px Arial';
  const width = mctx.measureText(label).width || 1;
  return Math.min(hgt * 0.56, ((w - 12) / width) * 100);
}

// 0.9.5: nota invisibile (etichetta): un piccolo foglietto bianco, bordo appena accennato, testo grigio scuro, nessuna icona.
const LBL_L = 0.45; const LBL_R = 0.45; const LBL_FS = 0.56;
export function labelFont(text, w, hgt) {
  mctx.font = '100px Arial';
  const width = mctx.measureText(text).width || 1;
  return Math.max(4, Math.min(hgt * LBL_FS, ((w - hgt * (LBL_L + LBL_R)) / width) * 100));
}
export function labelWidth(text, hgt) {
  mctx.font = `${hgt * LBL_FS}px Arial`;
  return Math.max(hgt * 1.6, mctx.measureText(text).width + hgt * (LBL_L + LBL_R));
}
export const labelParts = (r, text) => {
  const w = r[2] - r[0]; const hg = r[3] - r[1];
  return { w, hg, fs: labelFont(text, w, hg), rx: hg * 0.22, tx: r[0] + hg * LBL_L };
};
export const LABEL_INK = '#3b3b3b';

export function arrowHead(x0, y0, x1, y1, size) {
  const len = Math.max(8, size * 4.5);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const wing = (t) => [x1 - len * Math.cos(ang + t), y1 - len * Math.sin(ang + t)];
  return [[x1, y1], wing(0.45), wing(-0.45)];
}

const quadDisp = (p, q) => {
  const tl = toDisp(p, q[0], q[1]); const tr = toDisp(p, q[2], q[3]);
  const bl = toDisp(p, q[4], q[5]); const br = toDisp(p, q[6], q[7]);
  return { tl, tr, bl, br };
};
export { quadDisp };

// Disposizione dei tratti di una firma dentro il suo riquadro (0..1 -> pagina).
export function sigPaths(a, r) {
  const w = r[2] - r[0]; const hgt = r[3] - r[1];
  return a.strokes.map((s) => strokeOutline(s.map(([x, y, pr]) => [r[0] + x * w, r[1] + y * hgt, pr]), Math.max(1.1, hgt * 0.035), true));
}

export function annSvg(a, p) {
  const id = `data-id="${a.id}"`;
  const c = a.color;
  switch (a.type) {
    case 'ink': {
      const pts = a.pts.map(([x, y, pr]) => [...toDisp(p, x, y), pr]);
      return `<path ${id} d="${outlineD(strokeOutline(pts, a.size, a.pressure))}" fill="${c}" fill-opacity="${a.opacity ?? 1}"/>`;
    }
    case 'hl': return a.quads.map((q) => {
      const { tl, tr, bl, br } = quadDisp(p, q);
      return `<polygon ${id} points="${tl} ${tr} ${br} ${bl}" fill="${c}"/>`;
    }).join('');
    case 'ul': case 'so': return a.quads.map((q) => {
      const { tl, tr, bl, br } = quadDisp(p, q);
      const t = a.type === 'ul' ? 0.92 : 0.55;
      const L = [tl[0] + (bl[0] - tl[0]) * t, tl[1] + (bl[1] - tl[1]) * t];
      const R = [tr[0] + (br[0] - tr[0]) * t, tr[1] + (br[1] - tr[1]) * t];
      return `<line ${id} x1="${L[0]}" y1="${L[1]}" x2="${R[0]}" y2="${R[1]}" stroke="${c}" stroke-width="1.2"/>`;
    }).join('');
    case 'rect': { const r = dispRect(p, a); return `<rect ${id} x="${r[0]}" y="${r[1]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}" fill="none" stroke="${c}" stroke-width="${a.size}"/>`; }
    case 'ellipse': { const r = dispRect(p, a); return `<ellipse ${id} cx="${(r[0] + r[2]) / 2}" cy="${(r[1] + r[3]) / 2}" rx="${(r[2] - r[0]) / 2}" ry="${(r[3] - r[1]) / 2}" fill="none" stroke="${c}" stroke-width="${a.size}"/>`; }
    case 'line': case 'arrow': {
      const [x0, y0] = toDisp(p, ...a.a); const [x1, y1] = toDisp(p, ...a.b);
      let s = `<line ${id} x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${c}" stroke-width="${a.size}" stroke-linecap="round"/>`;
      if (a.type === 'arrow') s += `<polygon ${id} points="${arrowHead(x0, y0, x1, y1, a.size).join(' ')}" fill="${c}"/>`;
      return s;
    }
    case 'text': {
      const r = dispRect(p, a);
      const lines = wrapLines(a.text, a.fontSize, r[2] - r[0]);
      return `<g ${id} fill="${c}" font-family="Arial" font-size="${a.fontSize}"><rect x="${r[0]}" y="${r[1]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}" fill="transparent"/>${lines.map((l, i) => `<text x="${r[0]}" y="${r[1] + a.fontSize * (1 + i * 1.2)}" xml:space="preserve">${esc(l)}</text>`).join('')}</g>`;
    }
    case 'edit': {
      // Copertura del testo originale con il colore del fondo, poi il testo nuovo con lo stesso carattere.
      const cover = a.quads.map((q) => { const { tl, tr, bl, br } = quadDisp(p, q); return `<polygon points="${tl} ${tr} ${br} ${bl}" fill="${a.bg}"/>`; }).join('');
      const [x, y] = toDisp(p, ...a.a);
      const [x2, y2] = toDisp(p, a.a[0] + a.dir[0], a.a[1] + a.dir[1]);
      const ang = (Math.atan2(y2 - y, x2 - x) * 180) / Math.PI;
      const fam = String(a.css || a.font?.css || 'Arial').replace(/"/g, "'");
      const weight = a.font?.bold && !a.font?.file ? ' font-weight="700"' : '';
      const style = a.font?.italic && !a.font?.file ? ' font-style="italic"' : '';
      if (a.lines) {
        // Paragrafo riscritto (0.9.0): una riga alla volta, parola per parola se giustificato.
        const font = `font-family="${esc(fam)}" font-size="${a.size}" fill="${a.color}"${weight}${style}`;
        const txt = a.lines.map((ln) => (ln.words ? ln.words.map(([w, dx]) => { const [tx, ty] = toDisp(p, ln.x - ln.dx + dx, ln.y); return `<text x="${tx}" y="${ty}" ${font} xml:space="preserve">${esc(w)}</text>`; }).join('')
          : (() => { const [tx, ty] = toDisp(p, ln.x, ln.y); return `<text x="${tx}" y="${ty}" ${font} xml:space="preserve">${esc(ln.text)}</text>`; })())).join('');
        return `<g ${id} class="an-edit an-para">${cover}${txt}</g>`;
      }
      const len = a.w > 0 && a.text ? ` textLength="${a.w}" lengthAdjust="spacingAndGlyphs"` : '';
      return `<g ${id} class="an-edit">${cover}<text x="${x}" y="${y}" transform="rotate(${ang.toFixed(2)} ${x} ${y})" font-family="${esc(fam)}" font-size="${a.size}" fill="${a.color}"${weight}${style}${len} xml:space="preserve">${esc(a.text)}</text></g>`;
    }
    case 'note': {
      const [x, y] = toDisp(p, ...a.a);
      return `<g ${id}><rect x="${x}" y="${y}" width="22" height="20" rx="3" fill="${c}"/><path d="M${x + 5} ${y + 7}h12M${x + 5} ${y + 12}h8" stroke="#fff" stroke-width="1.6"/></g>`;
    }
    case 'stamp': {
      const r = dispRect(p, a); const w = r[2] - r[0]; const hg = r[3] - r[1];
      const fs = stampFont(a.label, w, hg);
      return `<g ${id}><rect x="${r[0] + 1}" y="${r[1] + 1}" width="${w - 2}" height="${hg - 2}" rx="4" fill="#ffffff" fill-opacity="0.01" stroke="${c}" stroke-width="2"/><text x="${r[0] + w / 2}" y="${r[1] + hg / 2 + fs * 0.36}" text-anchor="middle" font-family="Arial" font-weight="700" font-size="${fs}" fill="${c}">${esc(a.label)}</text></g>`;
    }
    case 'label': {
      const r = dispRect(p, a); const L = labelParts(r, a.text);
      return `<g ${id} class="an-label"><rect class="lb-bg" x="${r[0] + 0.5}" y="${r[1] + 0.5}" width="${L.w - 1}" height="${L.hg - 1}" rx="${L.rx}" fill="#ffffff" fill-opacity="0.97" stroke="#000000" stroke-opacity="0.14" stroke-width="0.6"/><text x="${L.tx}" y="${r[1] + L.hg / 2 + L.fs * 0.36}" font-family="Arial" font-size="${L.fs}" fill="${LABEL_INK}" xml:space="preserve">${esc(a.text)}</text></g>`;
    }
    case 'sig': {
      const r = dispRect(p, a);
      if (a.png) return `<image ${id} href="${a.png}" x="${r[0]}" y="${r[1]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}" preserveAspectRatio="none"/>`;
      return `<g ${id}><rect x="${r[0]}" y="${r[1]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}" fill="transparent"/>${sigPaths(a, r).map((o) => `<path d="${outlineD(o)}" fill="${c}"/>`).join('')}</g>`;
    }
    case 'image': {
      const r = dispRect(p, a);
      return `<image ${id} href="${a.src}" x="${r[0]}" y="${r[1]}" width="${r[2] - r[0]}" height="${r[3] - r[1]}" preserveAspectRatio="none"/>`;
    }
    case 'redact': return a.quads.map((q) => {
      // Zona da oscurare: si vede in trasparenza finché non si applica l'oscuramento.
      const { tl, tr, bl, br } = quadDisp(p, q);
      return `<polygon ${id} class="an-redact" points="${tl} ${tr} ${br} ${bl}" fill="#000" fill-opacity="0.35" stroke="#c62828" stroke-width="1.4" stroke-dasharray="4 2"/>`;
    }).join('');
    case 'field': {
      // Campo del modulo non ancora salvato: riquadro tratteggiato con il nome.
      const r = dispRect(p, a); const w = r[2] - r[0]; const hg = r[3] - r[1];
      const fs = Math.max(5, Math.min(9, hg - 4));
      const label = a.kind === 'check' ? '' : a.kind === 'sig' ? `Firma: ${a.name}` : `${a.kind === 'choice' ? '▾ ' : ''}${a.name}`;
      return `<g ${id} class="an-field"><rect x="${r[0]}" y="${r[1]}" width="${w}" height="${hg}" fill="#2b6cb0" fill-opacity="0.08" stroke="#2b6cb0" stroke-width="1" stroke-dasharray="4 2"/>${a.kind === 'check' ? `<path d="M${r[0] + w * 0.2} ${r[1] + hg * 0.55}l${w * 0.2} ${hg * 0.22}l${w * 0.38} ${-hg * 0.5}" fill="none" stroke="#2b6cb0" stroke-width="1.2"/>` : `<text x="${r[0] + 3}" y="${r[1] + Math.min(hg - 2, fs + 2)}" font-family="Arial" font-size="${fs}" fill="#2b6cb0">${esc(label)}</text>`}</g>`;
    }
    case 'measure': {
      const [x0, y0] = toDisp(p, ...a.a); const [x1, y1] = toDisp(p, ...a.b);
      const ang = Math.atan2(y1 - y0, x1 - x0); const nx = -Math.sin(ang) * 4; const ny = Math.cos(ang) * 4;
      const mx = (x0 + x1) / 2; const my = (y0 + y1) / 2;
      return `<g ${id} class="an-measure"><path d="M${x0} ${y0}L${x1} ${y1}M${x0 + nx} ${y0 + ny}L${x0 - nx} ${y0 - ny}M${x1 + nx} ${y1 + ny}L${x1 - nx} ${y1 - ny}" stroke="${c}" stroke-width="${a.size}" stroke-linecap="round" fill="none"/><text x="${mx}" y="${my - 4}" text-anchor="middle" font-family="Arial" font-size="9" font-weight="600" fill="${c}" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(a.label)}</text></g>`;
    }
    case 'area': {
      const pts = a.pts.map(([x, y]) => toDisp(p, x, y));
      const cx = pts.reduce((t, q) => t + q[0], 0) / pts.length; const cy = pts.reduce((t, q) => t + q[1], 0) / pts.length;
      return `<g ${id} class="an-area"><polygon points="${pts.map((q) => q.join(',')).join(' ')}" fill="${c}" fill-opacity="0.12" stroke="${c}" stroke-width="${a.size}"/><text x="${cx}" y="${cy}" text-anchor="middle" font-family="Arial" font-size="9" font-weight="600" fill="${c}" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(a.label)}</text></g>`;
    }
    default: return '';
  }
}

export function bbox(a, p) {
  if (a.type === 'area') {
    const pts = a.pts.map(([x, y]) => toDisp(p, x, y));
    return [Math.min(...pts.map((q) => q[0])) - 2, Math.min(...pts.map((q) => q[1])) - 2, Math.max(...pts.map((q) => q[0])) + 2, Math.max(...pts.map((q) => q[1])) + 2];
  }
  if (a.type === 'measure') {
    const [x0, y0] = toDisp(p, ...a.a); const [x1, y1] = toDisp(p, ...a.b);
    return [Math.min(x0, x1) - 6, Math.min(y0, y1) - 16, Math.max(x0, x1) + 6, Math.max(y0, y1) + 6];
  }
  if (a.type === 'ink') {
    let x0 = 1e9; let y0 = 1e9; let x1 = -1e9; let y1 = -1e9;
    for (const [x, y] of a.pts) { const d = toDisp(p, x, y); x0 = Math.min(x0, d[0]); y0 = Math.min(y0, d[1]); x1 = Math.max(x1, d[0]); y1 = Math.max(y1, d[1]); }
    const m = a.size / 2 + 1;
    return [x0 - m, y0 - m, x1 + m, y1 + m];
  }
  if (a.type === 'edit') {
    let x0 = 1e9; let y0 = 1e9; let x1 = -1e9; let y1 = -1e9;
    for (const q of [...a.quads, a.tquad]) for (let i = 0; i < 8; i += 2) { const d = toDisp(p, q[i], q[i + 1]); x0 = Math.min(x0, d[0]); y0 = Math.min(y0, d[1]); x1 = Math.max(x1, d[0]); y1 = Math.max(y1, d[1]); }
    return [x0, y0, x1, y1];
  }
  if (a.quads) {
    let x0 = 1e9; let y0 = 1e9; let x1 = -1e9; let y1 = -1e9;
    for (const q of a.quads) for (let i = 0; i < 8; i += 2) { const d = toDisp(p, q[i], q[i + 1]); x0 = Math.min(x0, d[0]); y0 = Math.min(y0, d[1]); x1 = Math.max(x1, d[0]); y1 = Math.max(y1, d[1]); }
    return [x0, y0, x1, y1];
  }
  if (a.type === 'note') { const [x, y] = toDisp(p, ...a.a); return [x, y, x + 22, y + 20]; }
  const r = dispRect(p, a);
  const m = (a.size || 0) / 2 + (a.type === 'arrow' ? a.size * 4 + 6 : 0);
  return [r[0] - m, r[1] - m, r[2] + m, r[3] + m];
}

const segDist = (px, py, x0, y0, x1, y1) => {
  const dx = x1 - x0; const dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
};

export function hits(a, p, x, y, tol) {
  const b = bbox(a, p);
  if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) return false;
  if (a.type === 'ink') {
    const pts = a.pts.map(([ux, uy]) => toDisp(p, ux, uy));
    if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) < tol + a.size;
    for (let i = 1; i < pts.length; i += 1) if (segDist(x, y, ...pts[i - 1], ...pts[i]) < tol + a.size / 2) return true;
    return false;
  }
  if (a.type === 'measure') return segDist(x, y, ...toDisp(p, ...a.a), ...toDisp(p, ...a.b)) < tol + a.size + 4;
  if (a.type === 'line' || a.type === 'arrow') return segDist(x, y, ...toDisp(p, ...a.a), ...toDisp(p, ...a.b)) < tol + a.size;
  if (a.type === 'rect' || a.type === 'ellipse') {
    const inner = x > b[0] + tol + a.size && x < b[2] - tol - a.size && y > b[1] + tol + a.size && y < b[3] - tol - a.size;
    return !inner;
  }
  return true;
}

export function translated(a, dx, dy) {
  const n = JSON.parse(JSON.stringify(a));
  if (n.pts) n.pts = n.pts.map(([x, y, pr]) => [x + dx, y + dy, pr]);
  if (n.quads) n.quads = n.quads.map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)));
  if (n.a) n.a = [n.a[0] + dx, n.a[1] + dy];
  if (n.tquad) n.tquad = n.tquad.map((v, i) => v + (i % 2 ? dy : dx));
  if (n.b) n.b = [n.b[0] + dx, n.b[1] + dy];
  return n;
}
