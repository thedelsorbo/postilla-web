// Link del PDF: quelli interni portano alla pagina giusta, quelli esterni si aprono solo dopo aver mostrato l'indirizzo vero.
// Si attivano con il dito o con il mouse, mai con la penna, così non scattano mentre si scrive.
import { h, modal, toast } from './core.js';

const SCHEMES = ['http:', 'https:', 'mailto:'];
const NAMED = { NextPage: 1, PrevPage: -1, FirstPage: 'first', LastPage: 'last' };

// Link di una pagina, in coordinate della pagina a scala 1 (le stesse di tools.local).
export function pageLinks(view, i) {
  view.linkCache = view.linkCache || new Map();
  if (!view.linkCache.has(i)) {
    view.linkCache.set(i, (async () => {
      const pg = await view.getPage(i);
      const p = view.pages[i];
      const list = await pg.getAnnotations({ intent: 'display' });
      return list.filter((a) => a.subtype === 'Link' && a.rect).map((a) => {
        const [x0, y0] = p.vp.convertToViewportPoint(a.rect[0], a.rect[1]);
        const [x1, y1] = p.vp.convertToViewportPoint(a.rect[2], a.rect[3]);
        return {
          box: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
          url: a.url || a.unsafeUrl || null, dest: a.dest ?? null, action: a.action || null,
        };
      }).filter((l) => l.url || l.dest != null || NAMED[l.action] !== undefined);
    })().catch(() => []));
  }
  return view.linkCache.get(i);
}

// Versione immediata per il passaggio del mouse: usa solo ciò che è già stato letto.
export function cachedLinkAt(view, p, x, y) {
  const c = view.linkCache?.get(p.i);
  if (!c || !c.done) { if (c) return null; pageLinks(view, p.i).then((l) => { view.linkCache.get(p.i).done = l; }); return null; }
  return find(c.done, x, y);
}

const find = (list, x, y, tol = 2) => list.find(({ box: [x0, y0, x1, y1] }) => x >= x0 - tol && x <= x1 + tol && y >= y0 - tol && y <= y1 + tol) || null;

export async function linkAt(view, p, x, y) {
  const list = await pageLinks(view, p.i);
  const c = view.linkCache.get(p.i);
  if (c) c.done = list;
  return find(list, x, y);
}

// Destinazione interna → indice di pagina e punto (a scala 1) da mostrare.
async function resolveDest(view, dest) {
  const explicit = typeof dest === 'string' ? await view.pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || !explicit.length) return null;
  const [ref, kind, ...args] = explicit;
  let index;
  if (Number.isInteger(ref)) index = ref;
  else if (ref && typeof ref === 'object') index = await view.pdf.getPageIndex(ref);
  if (!Number.isInteger(index) || index < 0 || index >= view.pages.length) return null;
  await view.getPage(index);
  const p = view.pages[index];
  let top = null;
  const name = kind?.name;
  if (name === 'XYZ' && args[1] != null) top = args[1];
  else if ((name === 'FitH' || name === 'FitBH') && args[0] != null) top = args[0];
  else if (name === 'FitR' && args[3] != null) top = args[3];
  const y = top == null ? 0 : Math.max(0, p.vp.convertToViewportPoint(0, top)[1]);
  return { index, y };
}

function pushBack(view) {
  view.linkBack = view.linkBack || [];
  view.linkBack.push({ top: view.scroller.scrollTop, left: view.scroller.scrollLeft });
  showBack(view);
}

function showBack(view) {
  view.backBtn?.remove();
  if (!view.linkBack?.length) { view.backBtn = null; return; }
  view.backBtn = h('button', {
    class: 'link-back', title: 'Torna al punto in cui hai toccato il link',
    onclick: () => {
      const b = view.linkBack.pop();
      if (b) { view.scroller.scrollTop = b.top; view.scroller.scrollLeft = b.left; view.schedule(); }
      showBack(view);
    },
  }, '← Torna indietro');
  view.root.append(view.backBtn);
}

export async function followLink(app, view, link) {
  if (link.dest != null) {
    const d = await resolveDest(view, link.dest).catch(() => null);
    if (!d) { toast('Questo link interno punta a una destinazione che non esiste nel documento.', 'warn'); return false; }
    pushBack(view);
    view.goto(d.index, d.y * view.s);
    return true;
  }
  const named = NAMED[link.action];
  if (named !== undefined) {
    const cur = view.current;
    const index = named === 'first' ? 0 : named === 'last' ? view.pages.length - 1 : cur + named;
    pushBack(view);
    view.goto(index);
    return true;
  }
  if (link.url) return openExternal(link.url, app, view);
  return false;
}

// --- Fiducia: siti e documenti che l'utente ha dichiarato affidabili (salvati nelle impostazioni) ---
const docKey = (view) => (view?.tab?.path || '').replace(/\//g, '\\').toLowerCase();
const trust = (app) => { app.settings.links = app.settings.links || { sites: [], docs: [] }; return app.settings.links; };
const saveTrust = (app) => host.settingsSet({ links: trust(app) });
export const siteOf = (url) => (url.protocol === 'mailto:' ? (decodeURIComponent(url.pathname).split('@')[1] || '').toLowerCase() : url.hostname.toLowerCase());
export const docTrusted = (app, view) => trust(app).docs.includes(docKey(view));
export function setDocTrusted(app, view, on) {
  const t = trust(app); const k = docKey(view);
  t.docs = t.docs.filter((d) => d !== k);
  if (on && k) t.docs.push(k);
  saveTrust(app);
}
function trustSite(app, site) { const t = trust(app); if (site && !t.sites.includes(site)) { t.sites.push(site); saveTrust(app); } }

// Elenco gestibile: togliere un sito o un documento dalla fiducia.
export function manageTrust(app) {
  modal((box, done) => {
    const body = h('div', { class: 'trust-list' });
    const draw = () => {
      const t = trust(app);
      body.textContent = '';
      const row = (label, onRemove) => h('div', { class: 'trust-row' }, h('span', {}, label), h('button', { onclick: () => { onRemove(); saveTrust(app); draw(); } }, 'Togli'));
      body.append(h('h3', {}, 'Siti affidabili'),
        t.sites.length ? h('div', {}, t.sites.map((s) => row(s, () => { t.sites = t.sites.filter((x) => x !== s); }))) : h('p', { class: 'hint' }, 'Nessuno.'),
        h('h3', {}, 'Documenti con tutti i link affidabili'),
        t.docs.length ? h('div', {}, t.docs.map((d) => row(d.split(/[\\/]/).pop(), () => { t.docs = t.docs.filter((x) => x !== d); }))) : h('p', { class: 'hint' }, 'Nessuno.'));
    };
    draw();
    box.append(h('h2', {}, 'Link affidabili'),
      h('p', { class: 'hint' }, 'Per questi siti e documenti Postilla apre i link web e di posta senza chiedere. I link di altro tipo (per esempio quelli che eseguono codice) restano sempre bloccati.'),
      body, h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: () => done() }, 'Chiudi')));
  });
}

// Indirizzo esterno: si mostra quello vero (non il testo del link) e si apre solo dopo conferma,
// a meno che il sito o il documento non siano stati dichiarati affidabili.
export async function openExternal(raw, app, view) {
  let url;
  try { url = new URL(raw); } catch { toast('Il link contiene un indirizzo non valido: non viene aperto.', 'warn'); return false; }
  if (!SCHEMES.includes(url.protocol)) { toast(`Link di tipo «${url.protocol}» non aperto: Postilla apre solo indirizzi web e di posta.`, 'warn'); return false; }
  const mail = url.protocol === 'mailto:';
  const site = siteOf(url);
  const shown = mail ? decodeURIComponent(url.pathname) : url.href;
  let choice = 'open';
  if (!(app && (docTrusted(app, view) || trust(app).sites.includes(site)))) {
    choice = await modal((box, done) => {
      const allDoc = h('input', { type: 'checkbox', class: 'trust-doc' });
      box.append(h('h2', {}, mail ? 'Scrivere una mail?' : 'Aprire il link nel browser?'),
        h('p', {}, mail ? `Il link apre il programma di posta per scrivere a:\n${shown}` : `Indirizzo completo:\n${shown}\n\nDominio: ${url.hostname}`),
        ...[app && view?.tab?.path ? h('label', { class: 'check' }, allDoc, 'Tutti i link di questo documento sono affidabili: non chiedere più') : null].filter(Boolean),
        h('div', { class: 'modal-actions' },
          h('button', { onclick: () => done(false) }, 'Annulla'),
          app && site ? h('button', { class: 'trust-site', onclick: () => done(allDoc.checked ? 'doc' : 'site') }, `Apri e fidati di ${site}`) : null,
          h('button', { class: 'primary', onclick: () => done(allDoc.checked ? 'doc' : 'open') }, mail ? 'Apri la posta' : 'Apri nel browser')));
    });
    if (!choice) return false;
    if (choice === 'site') trustSite(app, site);
    if (choice === 'doc') setDocTrusted(app, view, true);
  }
  const done = await host.openLink(url.href);
  if (!done) toast('Non sono riuscito ad aprire il link.', 'warn');
  return !!done;
}
