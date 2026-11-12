// Tavolozze di colori: penna (tinte in più tonalità + qualunque colore), evidenziatore e puntatore.
import { h } from './core.js';

const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
function hsl(hue, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return hex(f(0) * 255, f(8) * 255, f(4) * 255);
}

// 12 tinte × 6 tonalità (dalla più scura alla più chiara), più una fila di grigi dal nero al bianco.
export const HUES = [
  ['Rosso', 0], ['Arancio', 24], ['Ambra', 40], ['Giallo', 52], ['Lime', 80], ['Verde', 130],
  ['Verde acqua', 168], ['Azzurro', 196], ['Blu', 218], ['Indaco', 240], ['Viola', 275], ['Magenta', 315],
];
const TONES = [[85, 22], [80, 32], [75, 42], [80, 52], [85, 66], [90, 80]];
export const PEN_PALETTE = [
  ...HUES.map(([name, hue]) => ({ name, colors: TONES.map(([s, l]) => hsl(hue, s, l)) })),
  { name: 'Grigi', colors: ['#000000', '#3a3a3a', '#666666', '#939393', '#c4c4c4', '#ffffff'] },
];

// Colori adatti all'evidenziatore: chiari e luminosi, perché il testo sotto resti leggibile.
export const HL_PALETTE = [
  '#ffe14d', '#fff176', '#ffc56b', '#ffab91', '#ff8a80', '#ffb3d1',
  '#f48fb1', '#e1bee7', '#d6c2ff', '#b39ddb', '#8fd3ff', '#81d4fa',
  '#80deea', '#a7ffeb', '#a8f07a', '#c5e1a5', '#e6ee9c', '#d7ccc8',
  '#cfd8dc', '#bdbdbd',
];

export const LASER_COLORS = ['#e0161e', '#ff6d00', '#ffd600', '#00c853', '#2979ff', '#d500f9', '#ffffff'];

// Riga di quadratini colorati; «picked» è il colore in uso.
function swatches(list, picked, pick, cls = '') {
  return h('div', { class: `swatches ${cls}` }, ...list.map((c) => h('button', {
    class: `swatch${c.toLowerCase() === String(picked).toLowerCase() ? ' picked' : ''}`, style: `background:${c}`, title: c, 'aria-label': `Colore ${c}`, 'data-color': c, onclick: () => pick(c),
  })));
}

// «Altro colore…»: la scelta libera di qualunque colore del sistema.
function anyColor(picked, pick) {
  const input = h('input', { type: 'color', class: 'any-color', value: /^#[0-9a-f]{6}$/i.test(picked) ? picked : '#1d3f8f', 'aria-label': 'Qualunque colore' });
  input.addEventListener('change', () => pick(input.value));
  return h('label', { class: 'any-color-row' }, input, ' Altro colore… (qualunque colore)');
}

export function penPanel({ picked, recent = [], pick }) {
  return h('div', { class: 'color-panel', role: 'dialog', 'aria-label': 'Colori della penna' },
    h('div', { class: 'color-title' }, 'Colore della penna'),
    recent.length ? h('div', { class: 'color-sub' }, 'Usati di recente') : null,
    recent.length ? swatches(recent, picked, pick, 'recent') : null,
    h('div', { class: 'palette-grid' }, ...PEN_PALETTE.map((row) => swatches(row.colors, picked, pick, 'tones'))),
    anyColor(picked, pick));
}

export function hlPanel({ picked, recent = [], pick }) {
  return h('div', { class: 'color-panel', role: 'dialog', 'aria-label': 'Colori dell\'evidenziatore' },
    h('div', { class: 'color-title' }, 'Colore dell\'evidenziatore'),
    recent.length ? swatches(recent, picked, pick, 'recent') : null,
    swatches(HL_PALETTE, picked, pick, 'hl-grid'),
    anyColor(picked, pick));
}

// Ultimi colori scelti (al massimo 8, il più recente per primo).
export function remember(list, c) { return [c, ...(list || []).filter((x) => x.toLowerCase() !== c.toLowerCase())].slice(0, 8); }
