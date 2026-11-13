// Utilità comuni: creazione elementi, avvisi, finestre di dialogo, icone.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

// Appunti del sistema: su Windows e sul tablet passano dal programma (la pagina da sola non ha il permesso),
// nel browser dalle funzioni del browser. Restituiscono false / null se gli appunti non si possono usare.
export async function clipWrite(text) {
  const s = String(text ?? '');
  try { if (window.host?.clipWrite && await window.host.clipWrite(s)) return true; } catch { /* si prova sotto */ }
  try { await navigator.clipboard.writeText(s); return true; } catch { /* si prova sotto */ }
  try {
    const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0' }); ta.value = s;
    document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

export async function clipRead() {
  try { if (window.host?.clipRead) { const t = await window.host.clipRead(); if (typeof t === 'string') return t; } } catch { /* si prova sotto */ }
  try { return await navigator.clipboard.readText(); } catch { return null; }
}

function modal(build) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
    const done = (v) => { back.remove(); resolve(v); };
    build(box, done);
    back.append(box);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) done(undefined); });
    back.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') done(undefined); });
    document.body.append(back);
    ($('input,textarea', box) || $('button.primary', box) || box).focus?.();
  });
}
export { modal };

// choices: [{label, value, primary}]
export const ask = (title, text, choices) => modal((box, done) => {
  box.append(h('h2', {}, title), ...(text ? [h('p', {}, text)] : []),
    h('div', { class: 'modal-actions' }, choices.map((c) => h('button', { class: c.primary ? 'primary' : '', onclick: () => done(c.value) }, c.label))));
});

export const promptText = (title, label, value = '', { password = false, okLabel = 'OK' } = {}) => modal((box, done) => {
  const input = h('input', { type: password ? 'password' : 'text', value, 'aria-label': label });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); });
  box.append(h('h2', {}, title), h('label', {}, label, input),
    h('div', { class: 'modal-actions' },
      h('button', { onclick: () => done(undefined) }, 'Annulla'),
      h('button', { class: 'primary', onclick: () => done(input.value) }, okLabel)));
});

const P = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  print: '<path d="M7 9V4h10v5"/><path d="M7 17H5v-7h14v7h-2"/><path d="M7 14h10v6H7z"/>',
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/>',
  open: '<path d="M3 19V6h6l2 2.5h9.5V19z"/>',
  save: '<path d="M4 4h13l3 3v13H4z"/><path d="M8 4v5h7V4M7.5 20v-7h9v7"/>',
  hand: '<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6.5 7-3 0-4.5-1.5-6-4l-2-3.5a1.5 1.5 0 0 1 2.5-1.5L8 14"/>',
  select: '<path d="M5 3.5 18.5 12l-6 1.5L10 19.5z"/>',
  mark: '<path d="M4 20h7"/><path d="m9.5 15.5-3-3L15 4l5 5-8.500 8.500z" /><path d="m6.500 12.500-2 5.500 3.500-.5"/>',
  under: '<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path d="M5 20.500h14"/>',
  strike: '<path d="M4 12h16"/><path d="M16.500 7c-1-2-3-2.500-4.500-2.500C9.500 4.500 7.500 6 7.500 8c0 1.500 1 2.500 2.500 3.200M8 16.500c.8 2 2.500 3 4.500 3 2.800 0 4.500-1.700 4.500-3.800 0-.8-.2-1.500-.6-2.100"/>',
  pen: '<path d="m4 20 1-4.500L16.500 4 20 7.500 8.500 19z"/><path d="m14 6.500 3.500 3.500"/>',
  eraser: '<path d="m8 20-4.500-4.500a1.500 1.500 0 0 1 0-2L13 4l7.500 7.500L12 20z"/><path d="M8.500 8.500 16 16M21 20H8"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  line: '<path d="M5 19 19 5"/>',
  arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
  text: '<path d="M5 7V4.500h14V7M12 4.500v15M9 19.500h6"/>',
  note: '<path d="M4 4h16v12h-9l-4.500 4v-4H4z"/><path d="M8 8.500h8M8 12h5"/>',
  stamp: '<path d="M9 13c0-3-1.500-4-1.500-6a4.500 4.500 0 0 1 9 0c0 2-1.500 3-1.500 6z"/><path d="M4.500 13h15v4h-15zM6 20.500h12"/>',
  sign: '<path d="M3 17c3-1 4.500-9 6.500-9S9 18 11 18s2-4 3.500-4 1 3 2.500 3 2-1 4-1"/><path d="M3 21h18"/>',
  undo: '<path d="M8 5 4 9l4 4"/><path d="M4 9h10a6 6 0 0 1 0 12H9"/>',
  redo: '<path d="m16 5 4 4-4 4"/><path d="M20 9H10a6 6 0 0 0 0 12h5"/>',
  zin: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="m20 20-4.800-4.800M10.500 7.500v6M7.500 10.500h6"/>',
  zout: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="m20 20-4.800-4.800M7.500 10.500h6"/>',
  fitw: '<path d="M3 5v14M21 5v14M6.500 12h11M9 9.500 6.500 12 9 14.500M15 9.500l2.500 2.500-2.500 2.500"/>',
  fitp: '<rect x="6" y="3" width="12" height="18" rx="1"/><path d="M12 7v10M10 9l2-2 2 2M10 15l2 2 2-2"/>',
  panel: '<rect x="3" y="4.500" width="18" height="15" rx="1"/><path d="M9 4.500v15"/>',
  pages: '<rect x="4" y="3.500" width="7" height="8" rx="1"/><rect x="13" y="3.500" width="7" height="8" rx="1"/><rect x="4" y="13.500" width="7" height="7" rx="1"/><rect x="13" y="13.500" width="7" height="7" rx="1"/>',
  search: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="m20 20-4.800-4.800"/>',
  more: '<circle cx="5" cy="12" r="1.300"/><circle cx="12" cy="12" r="1.300"/><circle cx="19" cy="12" r="1.300"/>',
  trash: '<path d="M4 6.500h16M9 6.500V4h6v2.500M6.500 6.500 7.500 20.500h9l1-14M10 10.500v6M14 10.500v6"/>',
  edit: '<path d="m4 20 1-4 11-11 3 3-11 11z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4"/>',
  eye: '<path d="M2.500 12s3.500-6.500 9.500-6.500S21.500 12 21.500 12s-3.500 6.500-9.500 6.500S2.500 12 2.500 12z"/><circle cx="12" cy="12" r="3"/>',
  paste: '<path d="M9 4h6v3H9z"/><path d="M9 5.500H6v15h12v-15h-3"/><path d="M12 10v7M9 14l3 3 3-3"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4M14 11v6M11 14h6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  finger: '<path d="M9 13V5a1.700 1.700 0 0 1 3.400 0v6l4.800 1.200c1.300.3 2 1.300 1.800 2.600l-.8 5.200H10L5.500 15c-1-1.300.8-3 2.200-2z"/>',
  bookmark: '<path d="M6.500 3.500h11v17L12 16l-5.500 4.500z"/>',
  rotate: '<path d="M20 11a8 8 0 1 0-2.300 6.500"/><path d="M20 4.500V11h-6.500"/>',
  up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
  label: '<path d="M3 4.5v6.3l9.7 9.7 7.8-7.8L10.8 3H4.5z"/><circle cx="7.6" cy="7.6" r="1.4"/>',
  prev: '<path d="m15 5-7 7 7 7"/>', next: '<path d="m9 5 7 7-7 7"/>',
  laser: '<circle cx="12" cy="12" r="3.200"/><path d="M12 3v3.500M12 17.500V21M3 12h3.500M17.500 12H21M5.600 5.600l2.500 2.500M15.900 15.900l2.500 2.500M18.400 5.600l-2.500 2.500M8.100 15.900l-2.500 2.500"/>',
  measure: '<path d="M3.500 15.500 15.500 3.500l5 5-12 12z"/><path d="m7 12 2 2M9.500 9.500l1.500 1.500M12 7l2 2"/>',
  area: '<path d="M4 18 6 6l10-2 4 9-7 7z"/><circle cx="4" cy="18" r="1.300"/><circle cx="6" cy="6" r="1.300"/><circle cx="16" cy="4" r="1.300"/><circle cx="20" cy="13" r="1.300"/>',
  star: '<path d="m12 3.500 2.600 5.400 5.900.8-4.300 4.100 1 5.900L12 16.900l-5.200 2.800 1-5.900-4.300-4.100 5.900-.8z"/>',
  expand: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  folder: '<path d="M3 19V6h6l2 2.500h9.500V19z"/>',
  speaker: '<path d="M4 9.500h4l5-4v13l-5-4H4z"/><path d="M16.500 9a4 4 0 0 1 0 6M19 6.500a7.500 7.500 0 0 1 0 11"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.500 11a6.500 6.500 0 0 0 13 0M12 17.500V21M8.500 21h7"/>',
  claudia: '<path d="M4 5h16v11H10l-4.500 4v-4H4z"/><path d="M8.500 10.500h.01M12 10.500h.01M15.500 10.500h.01" stroke-width="2.600" stroke-linecap="round"/>',
};
export const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
export const iconBtn = (name, title, onclick, extra = {}) => h('button', { class: 'ib', title, 'aria-label': title, 'data-id': name, html: icon(name), onclick, ...extra });

export const baseName = (p) => p.split(/[\\/]/).pop();
export const fmtDate = (ms) => new Date(ms).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
export const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export const hexRgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
export const uid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
