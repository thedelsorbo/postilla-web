// Misure sulle pagine (0.9.0): distanze (si trascina una linea) e aree (si toccano i vertici; si chiude
// toccando di nuovo il primo punto, con un doppio tocco o con Invio). La scala del disegno si sceglie
// (1:100, 1:50…) oppure si ricava da una misura nota. Le misure si salvano come annotazioni con l'etichetta.
import { h, modal, toast, promptText } from '../core.js';

export const UNITS = { mm: 1, cm: 10, m: 1000, km: 1e6 };
const PT_MM = 25.4 / 72;
const fmt = (v) => v.toLocaleString('it-IT', { maximumFractionDigits: v < 10 ? 2 : (v < 1000 ? 1 : 0) });

export function scaleOf(app) {
  const s = app.prefs.measure || {};
  return { n: s.n > 0 ? s.n : 1, unit: UNITS[s.unit] ? s.unit : 'mm' };
}
export const scaleText = (s) => `scala 1:${fmt(s.n)}, in ${s.unit}`;

// Lunghezza in punti del PDF → testo («3,25 m»).
export function lengthLabel(app, pt) {
  const s = scaleOf(app);
  return `${fmt((pt * PT_MM * s.n) / UNITS[s.unit])} ${s.unit}`;
}
export function areaLabel(app, pt2) {
  const s = scaleOf(app);
  return `${fmt((pt2 * PT_MM * PT_MM * s.n * s.n) / (UNITS[s.unit] ** 2))} ${s.unit}²`;
}
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i += 1) { const [x0, y0] = pts[i]; const [x1, y1] = pts[(i + 1) % pts.length]; a += x0 * y1 - x1 * y0; }
  return Math.abs(a) / 2;
}
export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// Scala del disegno: preimpostata, a mano o ricavata da una misura nota (strumento «calibra»).
export async function measureSettings(app) {
  const cur = scaleOf(app);
  const r = await modal((box, done) => {
    const scale = h('select', {}, ...[1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].map((n) => h('option', { value: String(n), selected: n === cur.n }, n === 1 ? '1:1 (misure reali del foglio)' : `1:${n}`)),
      h('option', { value: 'altro', selected: ![1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].includes(cur.n) }, 'Altra…'));
    const other = h('input', { type: 'number', min: '0.0001', step: 'any', value: String(cur.n) });
    other.addEventListener('keydown', (e) => e.stopPropagation());
    const unit = h('select', {}, ...Object.keys(UNITS).map((u) => h('option', { value: u, selected: u === cur.unit }, u)));
    const fOther = h('label', { class: 'pro-field' }, h('span', {}, 'Scala 1:'), other);
    const sync = () => { fOther.hidden = scale.value !== 'altro'; };
    scale.addEventListener('change', sync);
    box.append(h('h2', {}, 'Scala delle misure'),
      h('p', { class: 'hint' }, 'Per i disegni in scala (planimetrie, progetti) scegli la scala scritta sul disegno, oppure ricavala da una misura che conosci.'),
      h('label', { class: 'pro-field' }, h('span', {}, 'Scala'), scale), fOther, h('label', { class: 'pro-field' }, h('span', {}, 'Unità'), unit),
      h('div', { class: 'modal-actions' },
        h('button', { onclick: () => done({ calibrate: true, unit: unit.value }) }, 'Ricava da una misura nota'),
        h('button', { onclick: () => done(null) }, 'Annulla'),
        h('button', { class: 'primary', onclick: () => done({ n: scale.value === 'altro' ? +other.value : +scale.value, unit: unit.value }) }, 'OK')));
    sync();
  });
  if (!r) return false;
  if (r.calibrate) {
    app.prefs.measure = { ...scaleOf(app), unit: r.unit };
    app.tools.calibrating = true;
    app.tools.set('measure');
    toast('Trascina una linea su una misura che conosci (per esempio una quota del disegno).');
    return true;
  }
  if (!(r.n > 0)) { toast('Scala non valida.', 'error'); return false; }
  app.prefs.measure = { n: r.n, unit: r.unit };
  app.savePrefs();
  toast(`Misure in ${scaleText(scaleOf(app))}.`);
  return true;
}

// Fine della linea di calibrazione: si chiede la lunghezza vera e si ricava la scala.
export async function finishCalibration(app, lenPt) {
  app.tools.calibrating = false;
  const s = scaleOf(app);
  const v = await promptText('Misura nota', `Quanto è lunga davvero la linea, in ${s.unit}?`, '', { okLabel: 'Imposta la scala' });
  const real = parseFloat(String(v || '').replace(/\./g, '').replace(',', '.'));
  if (!(real > 0) || !(lenPt > 0)) { if (v !== undefined) toast('Lunghezza non valida: scala invariata.', 'error'); return false; }
  const n = (real * UNITS[s.unit]) / (lenPt * PT_MM);
  app.prefs.measure = { n: +n.toPrecision(6), unit: s.unit };
  app.savePrefs();
  toast(`Scala impostata: 1:${fmt(n)}. Ora le misure usano questa scala.`);
  return true;
}
