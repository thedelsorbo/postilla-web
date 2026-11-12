// «Apri a voce» (0.9.1): si dice solo il nome del file («fattura Rossi», «UCP seicento») e Postilla apre il PDF
// più simile, senza passare dai comandi di Theresa. Sul PC la voce si trascrive con whisper.cpp (modello «small»,
// sul computer, senza internet) suggerendogli i nomi dei file recenti; sul tablet con il riconoscitore di Android.
// La ricerca è tollerante: accenti, maiuscole, numeri detti a parole e piccoli errori di trascrizione.
// Si cerca fra i documenti recenti e nell'elenco dei nomi dei PDF del dispositivo (mai il contenuto).
import { h, modal, toast, icon, baseName, fmtDate } from './core.js';
import { norm } from './text.js';
import { Voice } from './claudia/voice.js';

// --- Numeri detti a parole → cifre («seicento» → 600, «ventidue» → 22, «duemilaventisei» → 2026) ---------------
const UNITS = { zero: 0, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19 };
const TENS = { venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90 };
export function wordNumber(s) {
  if (!s) return null;
  let m = s.match(/^(.*?)(mila|mille)(.*)$/);
  if (m) {
    if (m[2] === 'mille' && m[1]) return null;
    const a = m[1] ? wordNumber(m[1]) : 1; const b = m[3] ? wordNumber(m[3]) : 0;
    return a == null || b == null || a < 1 ? null : a * 1000 + b;
  }
  m = s.match(/^(.*?)cento(.*)$/);
  if (m) {
    const a = m[1] ? wordNumber(m[1]) : 1; const b = m[2] ? wordNumber(m[2]) : 0;
    return a == null || b == null || a < 1 || a > 9 || b > 99 ? null : a * 100 + b;
  }
  for (const [k, v] of Object.entries(TENS)) {
    for (const p of [k, k.slice(0, -1)]) {
      if (!s.startsWith(p)) continue;
      const rest = s.slice(p.length);
      if (!rest) return p === k ? v : null;
      const u = UNITS[rest];
      if (u != null && u > 0 && u < 10 && (p !== k) === (u === 1 || u === 8)) return v + u;
    }
  }
  return UNITS[s] ?? null;
}
export function spokenToDigits(text) {
  return String(text).split(/(\s+)/).map((w) => { const k = norm(w).replace(/[^a-z]/g, ''); if (k.length < 3 || k !== norm(w).replace(/[.,;:!?]/g, '')) return w; const n = wordNumber(k); return n == null ? w : String(n); }).join('');
}

// Toglie le parole di contorno: «apri il file della fattura Rossi per favore» → «fattura Rossi».
export function cleanQuery(text) {
  let s = ` ${norm(spokenToDigits(text)).replace(/[.,;:!?«»"“”]/g, ' ')} `;
  s = s.replace(/\b(theresa|teresa|claudia)\b/g, ' ')
    .replace(/\b(per favore|grazie|puoi|potresti|mi|vorrei|voglio)\b/g, ' ')
    .replace(/\b(apri|aprimi|apra|aprire|apre|mostrami|mostra|fammi vedere|cerca|trova|carica)\b/g, ' ')
    .replace(/\b(il|lo|la|i|gli|le|l'|un|una|uno)\s+(file|documento|pdf)\b/g, ' ')
    .replace(/\b(file|documento|pdf)\b/g, ' ')
    .replace(/^\s*(il|lo|la|i|gli|le|del|della|dello|dei|di|l')\s+/, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const toks = (s) => norm(s).replace(/([a-z])(\d)|(\d)([a-z])/g, '$1$3 $2$4').split(/[^a-z0-9]+/).filter((t) => t && !['il', 'lo', 'la', 'di', 'del', 'della', 'e', 'a', 'in', 'pdf'].includes(t));
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_v, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
// Quanto una parola detta somiglia a una parola del nome (1 = uguale).
function sim(q, t) {
  if (q === t) return 1;
  if (/^\d+$/.test(q) || /^\d+$/.test(t)) return q === t ? 1 : 0;
  if (t.startsWith(q) && q.length >= 3) return 0.9;
  if (q.startsWith(t) && t.length >= 4) return 0.8;
  const d = lev(q, t);
  const s = 1 - d / Math.max(q.length, t.length);
  return s >= 0.7 && Math.min(q.length, t.length) >= 4 ? s : 0;
}

// Punteggio di un file per la richiesta detta; i recenti valgono un po' di più.
export function scoreName(query, title, { recent = 0 } = {}) {
  const qt = toks(query); const tt = toks(title);
  if (!qt.length || !tt.length) return 0;
  let s = 0; let hit = 0;
  for (const q of qt) { let b = 0; for (const t of tt) b = Math.max(b, sim(q, t)); s += b; if (b > 0) hit += 1; }
  if (!hit) return 0;
  const cover = hit / qt.length; // parole dette ritrovate nel nome
  const flat = (x) => ` ${toks(x).join(' ')} `;
  const inOrder = flat(title).includes(flat(query)) ? 0.6 : 0;
  return s / qt.length * 2 + cover + inOrder + recent * 0.4 - Math.max(0, tt.length - qt.length) * 0.02;
}

export function candidates(app) {
  const seen = new Set(); const out = [];
  (app.settings.recents || []).forEach((r, k) => { const key = r.path.toLowerCase(); if (seen.has(key)) return; seen.add(key); out.push({ path: r.path, title: (r.name || baseName(r.path)).replace(/\.pdf$/i, ''), recent: Math.max(0, 1 - k / 40), at: r.at }); });
  for (const e of app.fileIndex?.files || []) { const key = e.path.toLowerCase(); if (seen.has(key)) continue; seen.add(key); out.push({ path: e.path, title: e.title, recent: 0, at: e.mtime }); }
  return out;
}

export function findByVoice(app, text, max = 8) {
  const q = cleanQuery(text);
  if (!q) return { query: q, list: [] };
  const qt = toks(q);
  const grams = new Set(qt.filter((t) => t.length >= 3).flatMap((t) => [t.slice(0, 3), t.slice(-3)]));
  const list = [];
  for (const c of candidates(app)) {
    const k = c.key || (c.key = norm(c.title));
    // Scrematura veloce: almeno un pezzo di una parola detta, o un numero detto, nel nome.
    if (!qt.some((t) => (/^\d+$/.test(t) ? k.includes(t) : false)) && ![...grams].some((g) => k.includes(g)) && !c.recent) continue;
    const s = scoreName(q, c.title, c);
    if (s > 1.2) list.push({ ...c, score: s });
  }
  list.sort((a, b) => b.score - a.score || b.recent - a.recent || a.title.length - b.title.length);
  return { query: q, list: list.slice(0, max) };
}

// Suggerimento per il trascrittore: i nomi dei file usati più spesso (aiuta con sigle e cognomi).
function promptFor(app) {
  const names = (app.settings.recents || []).slice(0, 25).map((r) => (r.name || baseName(r.path)).replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '));
  return `Apri il file ${names.join(', ')}`.slice(0, 600);
}

let styled = false;
function style() {
  if (styled) return; styled = true;
  document.head.append(h('style', {}, `
.vo-dialog { width: min(560px, calc(100vw - 32px)); }
.vo-mic { display: flex; align-items: center; gap: 14px; margin: 10px 0; }
.vo-mic button.vo-big { width: 64px; height: 64px; border-radius: 50%; padding: 0; display: grid; place-items: center; }
.vo-mic button.vo-big .ico { width: 30px; height: 30px; }
.vo-mic.on button.vo-big { background: #c62828; color: #fff; border-color: #c62828; box-shadow: 0 0 0 calc(var(--lv, 0) * 14px) #c628283a; }
.vo-heard { width: 100%; box-sizing: border-box; font-size: 17px; }
.vo-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; max-height: 44vh; overflow: auto; }
.vo-list button { text-align: left; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.vo-list button small { color: var(--muted, #667); word-break: break-all; }
`));
}

export async function openByVoice(app) {
  style();
  const idx = app.fileIndex;
  idx?.start();
  if (idx && !idx.files.length) { await idx.loaded; if (!idx.files.length) idx.refresh(); }
  const voice = new Voice({});
  const ok = await voice.available().catch(() => false);
  return modal((box, done) => {
    box.classList.add('vo-dialog');
    const status = h('p', { class: 'vo-status', 'aria-live': 'polite' });
    const big = h('button', { class: 'vo-big primary', title: 'Parla', 'aria-label': 'Parla', html: icon('mic') });
    const mic = h('div', { class: 'vo-mic' }, big, status);
    const heard = h('input', { type: 'search', class: 'vo-heard', placeholder: 'Il nome del file (puoi anche scriverlo)', 'aria-label': 'Nome del file' });
    const list = h('div', { class: 'vo-list' });
    let listening = false; let endTimer = null; let spoke = 0; let quietSince = 0;
    const close = (v) => { voice.cancel().catch(() => {}); clearInterval(endTimer); done(v); };
    const openFile = async (c) => { close(true); await app.open(c.path); toast(`Aperto: ${baseName(c.path)}`); };
    const show = (text, { auto = false } = {}) => {
      const r = findByVoice(app, text);
      list.textContent = '';
      if (!text.trim()) return r;
      if (!r.list.length) {
        list.append(h('p', { class: 'hint' }, idx?.running ? 'Sto ancora preparando l\'elenco dei PDF del dispositivo: riprova fra poco.' : `Nessun PDF con un nome simile a «${r.query || text}». Prova con un'altra parola del nome.`));
        return r;
      }
      for (const c of r.list) list.append(h('button', { class: 'vo-pick', onclick: () => openFile(c) }, h('b', {}, c.title), h('small', {}, `${c.path}${c.at ? ` · ${fmtDate(c.at)}` : ''}`)));
      // Un solo candidato nettamente migliore: si apre subito.
      const [a, b] = r.list;
      if (auto && a && (!b || a.score - b.score >= 1) && a.score >= 3) openFile(a);
      return r;
    };
    heard.addEventListener('input', () => show(heard.value));
    heard.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') list.querySelector('.vo-pick')?.click(); });
    const finish = async () => {
      if (!listening) return;
      listening = false; clearInterval(endTimer);
      mic.classList.remove('on');
      status.textContent = 'Capisco…';
      const r = await voice.stop({ prompt: promptFor(app) });
      if (!r || !box.isConnected) return;
      if (r.discarded) { status.textContent = r.discarded === 'silenzio' ? 'Non ho sentito nulla: tocca il microfono e riprova.' : 'Non ho capito: riprova, oppure scrivi il nome.'; return; }
      heard.value = r.text;
      status.textContent = `Ho sentito: «${r.text}». Tocca il file giusto, oppure correggi qui sotto.`;
      show(r.text, { auto: true });
    };
    const startListening = async () => {
      if (listening) { finish(); return; }
      if (!ok) { status.textContent = 'Il riconoscimento della voce non è disponibile su questo dispositivo: scrivi il nome del file.'; heard.focus(); return; }
      try {
        spoke = 0; quietSince = 0;
        voice.onLevel = (lv) => {
          big.style.setProperty('--lv', lv.toFixed(2));
          const now = performance.now();
          if (lv > 0.16) { spoke += 1; quietSince = 0; } else if (spoke > 3 && !quietSince) quietSince = now;
        };
        await voice.start();
        listening = true;
        mic.classList.add('on');
        status.textContent = 'Ti ascolto: di\' il nome del file. Quando hai finito mi fermo da solo (o tocca di nuovo).';
        if (voice.native) {
          // Tablet: il riconoscitore di Android si ferma da solo a fine frase.
          voice.nativeResult.then(() => { if (listening) finish(); });
        } else {
          const t0 = performance.now();
          endTimer = setInterval(() => {
            const now = performance.now();
            if ((quietSince && now - quietSince > 1100) || now - t0 > 12000) finish();
          }, 150);
        }
      } catch (e) { status.textContent = `Non riesco ad accendere il microfono: ${e.message || e}`; }
    };
    big.addEventListener('click', startListening);
    box.append(h('h2', {}, 'Apri a voce'),
      h('p', { class: 'hint' }, 'Di\' solo il nome del file, per esempio «fattura Rossi» o «UCP 600». Cerco fra i documenti recenti e in tutti i PDF del dispositivo (solo i nomi).'),
      mic, heard, list,
      h('div', { class: 'modal-actions' }, h('button', { onclick: () => close(false) }, 'Chiudi')));
    startListening();
  });
}
