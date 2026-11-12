// Postilla nel browser (iPhone, iPad, Mac, e qualunque computer): fornisce al programma la stessa "presa"
// (window.host) delle versioni Windows e Android.
//
// Il browser non lascia vedere le cartelle del dispositivo: i PDF che apri vengono copiati in un archivio
// interno del browser (IndexedDB), con percorsi del tipo «/Documenti/nome.pdf». Le copie annotate, i file
// esportati e i risultati delle operazioni restano lì finché non li scarichi o li condividi (riquadro in basso,
// oppure Menu → File → Archivio del browser). Nessun dato lascia il dispositivo, tranne:
//   - il riconoscimento della voce del browser, se lo usi (Safari: Apple; Chrome ed Edge: Google);
//   - i link che scegli di aprire.
// L'assistente AI con chiave personale non c'è in questa versione: la chiave resterebbe leggibile nel browser.
(() => {
  const ROOT = '/Documenti';
  const IMPORT = '/.importati';
  const html = document.documentElement;
  html.classList.add('web');
  // Sui dispositivi touch (iPhone, iPad, telefoni) valgono gli stessi ritocchi del tablet Android.
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch) html.classList.add('android');
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) html.classList.add('ios');
  // Memoria video di telefoni e tablet più piccola di quella di un PC.
  if (touch) window.POSTILLA_LIMITS = { canvas: 8e6, total: 64e6, ocrPx: 2200 };
  // Il browser può cancellare i dati dei siti poco usati: si chiede di tenerli.
  navigator.storage?.persist?.().catch(() => {});

  // --- Archivio: IndexedDB ------------------------------------------------------------------
  const db = new Promise((ok, ko) => {
    const r = indexedDB.open('postilla-web', 1);
    r.onupgradeneeded = () => {
      for (const s of ['meta', 'blobs', 'thumbs', 'drafts', 'ocr', 'ocrmap']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
  const tx = async (stores, mode, fn) => {
    const d = await db;
    return new Promise((ok, ko) => {
      const t = d.transaction(stores, mode);
      const out = fn(t);
      t.oncomplete = () => ok(out && 'result' in out ? out.result : out);
      t.onerror = () => ko(t.error);
      t.onabort = () => ko(t.error || new Error('Memoria del browser piena.'));
    });
  };
  const kv = (store, fn) => tx(store, 'readwrite', (t) => fn(t.objectStore(store))).then((r) => r ?? null, () => null);
  const metaOf = (p) => tx('meta', 'readonly', (t) => t.objectStore('meta').get(p)).then((r) => r || null);
  const blobOf = async (p) => {
    const b = await tx('blobs', 'readonly', (t) => t.objectStore('blobs').get(p));
    if (!b) throw new Error('File non trovato nell\'archivio del browser.');
    return b;
  };
  const allMeta = () => tx('meta', 'readonly', (t) => {
    const list = [];
    t.objectStore('meta').openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { list.push({ path: c.key, ...c.value }); c.continue(); } };
    return list;
  });
  async function put(p, blob, mtime = Date.now()) {
    const meta = { size: blob.size, mtime };
    await tx(['meta', 'blobs'], 'readwrite', (t) => { t.objectStore('blobs').put(blob, p); t.objectStore('meta').put(meta, p); });
    return meta;
  }
  const remove = (p) => tx(['meta', 'blobs'], 'readwrite', (t) => { t.objectStore('blobs').delete(p); t.objectStore('meta').delete(p); });

  const base = (p) => String(p).split('/').pop();
  const dir = (p) => String(p).slice(0, String(p).lastIndexOf('/')) || '/';
  const clean = (name) => String(name || 'documento').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'documento';
  async function uniquePath(p) {
    if (!(await metaOf(p))) return p;
    const d = dir(p); const n = base(p); const dot = n.lastIndexOf('.');
    const stem = dot > 0 ? n.slice(0, dot) : n; const ext = dot > 0 ? n.slice(dot) : '';
    for (let i = 2; ; i += 1) { const c = `${d}/${stem} (${i})${ext}`; if (!(await metaOf(c))) return c; }
  }
  // Un file scelto dal dispositivo entra nell'archivio; se c'è già lo stesso file (nome, grandezza, data) si riusa.
  async function importFile(f, folder = ROOT) {
    const want = `${folder}/${clean(f.name)}`;
    const m = await metaOf(want);
    if (m && m.size === f.size && Math.round(m.mtime) === Math.round(f.lastModified || 0)) return want;
    const p = m ? await uniquePath(want) : want;
    await put(p, f, f.lastModified || Date.now());
    return p;
  }

  // --- Scelta dei file dal dispositivo ------------------------------------------------------
  // input.click() va chiamato subito, dentro il tocco dell'utente: niente attese prima.
  function choose({ accept = '', multi = true, capture = false } = {}) {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.multiple = !!multi;
    if (capture) input.setAttribute('capture', 'environment');
    input.style.cssText = 'position:fixed;left:-1000px;top:0;opacity:0';
    document.body.append(input);
    return new Promise((ok) => {
      let done = false;
      const finish = (files) => { if (done) return; done = true; input.remove(); ok(files); };
      input.addEventListener('change', () => finish([...(input.files || [])]));
      input.addEventListener('cancel', () => finish([]));
      // Browser senza l'evento «cancel»: se la finestra torna attiva e non è arrivato nulla, è annullato.
      window.addEventListener('focus', () => setTimeout(() => finish([...(input.files || [])]), 1500), { once: true });
      input.click();
    });
  }
  const MIME_EXT = { 'application/pdf': '.pdf', 'image/*': 'image/*', 'application/x-pkcs12': '.p12,.pfx' };

  // --- Riquadro «salvato nel browser»: scarica o condividi ------------------------------------
  const tray = { files: [], el: null, timer: 0 };
  const USER_FILE = /\.(pdf|docx|xlsx|pptx|png|jpe?g|txt|csv|zip|xml)$/i;
  async function fileObj(p) {
    const b = await blobOf(p);
    const n = base(p);
    const type = /\.pdf$/i.test(n) ? 'application/pdf' : b.type || 'application/octet-stream';
    return new File([b], n, { type, lastModified: (await metaOf(p))?.mtime || Date.now() });
  }
  async function download(p) {
    const f = await fileObj(p);
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url; a.download = f.name; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function share(paths) {
    const files = await Promise.all(paths.map(fileObj));
    if (navigator.canShare?.({ files })) {
      try { await navigator.share({ files, title: files.length === 1 ? files[0].name : 'Documenti di Postilla' }); return true; } catch (e) { if (e.name === 'AbortError') return true; }
    }
    for (const p of paths) await download(p);
    return true;
  }
  function showTray(paths, title) {
    tray.files = [...new Set([...tray.files, ...paths])];
    tray.el?.remove();
    const el = document.createElement('div');
    el.id = 'web-tray';
    el.setAttribute('role', 'dialog');
    const n = tray.files.length;
    const label = title || (n === 1 ? `«${base(tray.files[0])}» è nell'archivio del browser.` : `${n} file sono nell'archivio del browser.`);
    el.innerHTML = `<p></p><div class="web-tray-actions"><button class="primary web-share">${navigator.canShare ? 'Condividi o salva in File' : 'Scarica'}</button>${navigator.canShare ? '<button class="web-dl">Scarica</button>' : ''}<button class="web-close" aria-label="Chiudi">✕</button></div>`;
    el.querySelector('p').textContent = label;
    const close = () => { el.remove(); tray.el = null; tray.files = []; };
    el.querySelector('.web-share').onclick = async () => { const f = tray.files; close(); if (navigator.canShare) await share(f); else for (const p of f) await download(p); };
    el.querySelector('.web-dl')?.addEventListener('click', async () => { const f = tray.files; close(); for (const p of f) await download(p); });
    el.querySelector('.web-close').onclick = close;
    document.body.append(el);
    tray.el = el;
  }
  const noteSaved = (p) => {
    if (!USER_FILE.test(p) || p.startsWith(IMPORT)) return;
    tray.pending = [...(tray.pending || []), p];
    clearTimeout(tray.timer);
    tray.timer = setTimeout(() => { const list = tray.pending; tray.pending = []; showTray(list); }, 700);
  };

  // --- Archivio: finestra per scaricare o eliminare ------------------------------------------
  const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  async function archiveDialog() {
    document.getElementById('web-archive')?.remove();
    const back = document.createElement('div');
    back.id = 'web-archive';
    back.className = 'web-archive-back';
    back.innerHTML = `<div class="web-archive" role="dialog" aria-label="Archivio del browser"><h2>Archivio del browser</h2>
      <p class="web-archive-note">Qui ci sono i PDF che hai aperto e i file che Postilla ha creato. Restano solo in questo browser, su questo dispositivo: scaricali o condividili per averli altrove.</p>
      <p class="web-archive-space"></p><ul class="web-archive-list"></ul>
      <div class="web-archive-actions"><button class="web-archive-close primary">Chiudi</button></div></div>`;
    const close = () => back.remove();
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    back.querySelector('.web-archive-close').onclick = close;
    const list = back.querySelector('.web-archive-list');
    async function paint() {
      const files = (await allMeta()).filter((m) => !m.path.startsWith(IMPORT)).sort((a, b) => b.mtime - a.mtime);
      list.textContent = '';
      if (!files.length) list.innerHTML = '<li class="web-archive-empty">L\'archivio è vuoto.</li>';
      const open = new Set((window.postilla?.tabs || []).map((t) => t.path));
      for (const m of files) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="wa-name"></span><span class="wa-info"></span><span class="wa-btns"><button class="wa-dl">Scarica</button><button class="wa-del">Elimina</button></span>';
        li.querySelector('.wa-name').textContent = base(m.path);
        li.querySelector('.wa-info').textContent = `${fmtSize(m.size)} · ${new Date(m.mtime).toLocaleDateString('it-IT')}`;
        li.querySelector('.wa-dl').onclick = () => share([m.path]);
        li.querySelector('.wa-del').onclick = async () => {
          if (open.has(m.path)) { alert('Il documento è aperto: chiudi prima la sua scheda.'); return; }
          if (!confirm(`Eliminare «${base(m.path)}» dall'archivio del browser? Non si può annullare (le copie che hai scaricato restano).`)) return;
          await remove(m.path);
          await kv('thumbs', (s) => s.delete(m.path));
          await kv('drafts', (s) => s.delete(m.path));
          const s = window.postilla?.settings;
          if (s?.recents) { s.recents = s.recents.filter((r) => (r.path || r) !== m.path); await window.host.settingsSet({ recents: s.recents }); }
          paint();
          window.postilla?.home?.refresh?.();
        };
        list.append(li);
      }
      const est = await navigator.storage?.estimate?.().catch(() => null);
      const used = files.reduce((s, m) => s + m.size, 0);
      back.querySelector('.web-archive-space').textContent = `${files.length} file, ${fmtSize(used)}${est?.quota ? ` · spazio disponibile per Postilla circa ${fmtSize(Math.max(0, est.quota - (est.usage || 0)))}` : ''}`;
    }
    document.body.append(back);
    back.querySelector('.web-archive-close').focus();
    await paint();
  }

  // --- Impostazioni ---------------------------------------------------------------------------
  const DEFAULTS = {
    recents: [], folders: [ROOT], bookmarks: {}, pinned: [],
    stamps: [
      { label: 'VERIFICATO', color: '#1b7a4b' }, { label: 'DA RIVEDERE', color: '#b5541c' },
      { label: 'APPROVATO', color: '#1f5f8b' }, { label: 'NON CONFORME', color: '#b3261e' },
    ],
    signatures: [],
    prefs: { color: '#1d3f8f', size: 2, hlColor: '#ffe14d', fingerDraw: false, panel: false, inkText: false },
  };
  let settings;
  try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('postilla') || '{}') }; } catch { settings = { ...DEFAULTS }; }
  settings.prefs = { ...DEFAULTS.prefs, ...settings.prefs };
  const persist = () => { try { localStorage.setItem('postilla', JSON.stringify(settings)); } catch { /* memoria piena */ } };

  const ocrKey = (w) => `${String(w.path).toLowerCase()}|${w.size}|${Math.round(w.mtime)}`;
  const docs = new Map();
  let seq = 0;
  const listeners = { open: [] };
  const opened = (p) => listeners.open.forEach((fn) => fn(p));

  async function writeFile(p, data) {
    const bytes = data instanceof Uint8Array ? data : data instanceof Blob ? data : new Uint8Array(data);
    try {
      const st = await put(p, bytes instanceof Blob ? bytes : new Blob([bytes]));
      noteSaved(p);
      return st;
    } catch (e) {
      throw new Error(/quota/i.test(String(e?.name || e?.message)) ? 'Memoria del browser piena: elimina qualche file da Menu → File → Archivio del browser.' : 'Salvataggio non riuscito nel browser.');
    }
  }

  const NO_AI = 'L\'assistente AI con chiave personale non è disponibile nella versione web: usa Postilla su Windows o Android.';

  window.host = {
    settingsGet: async () => JSON.parse(JSON.stringify(settings)),
    settingsSet: async (patch) => { Object.assign(settings, patch); persist(); return true; },
    pendingFiles: async () => [],
    pickPdf: async (multi) => {
      const files = await choose({ accept: 'application/pdf,.pdf', multi: multi !== false });
      const out = [];
      for (const f of files) if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') out.push(await importFile(f));
      return out;
    },
    // Nel browser non ci sono cartelle del dispositivo: la «cartella» è l'archivio di Postilla.
    pickFolder: async () => ROOT,
    pickSave: async (suggested) => uniquePath(`${ROOT}/${clean(base(suggested || 'documento.pdf'))}`),
    pickSaveAs: async (suggested) => uniquePath(`${ROOT}/${clean(base(suggested || 'documento'))}`),
    pickFiles: async (opts = {}) => {
      const accept = (opts.mimes || []).map((m) => MIME_EXT[m] || m).join(',');
      const files = await choose({ accept, multi: opts.multi !== false });
      const out = [];
      for (const f of files) out.push(await importFile(f, IMPORT));
      return out;
    },
    // «Fotografa i fogli»: la fotocamera del telefono o del tablet (sul computer, la scelta di un'immagine).
    scanImage: async () => {
      const files = await choose({ accept: 'image/*', multi: true, capture: true });
      if (!files.length) return { error: 'annullato' };
      const paths = [];
      for (const f of files) paths.push(await importFile(f, IMPORT));
      return { paths };
    },
    collabList: async (d) => {
      if (!/\.commenti$/i.test(d)) return [];
      return (await allMeta()).filter((m) => dir(m.path) === d && /\.postilla\.json$/i.test(m.path)).map((m) => ({ path: m.path, mtime: m.mtime, size: m.size }));
    },
    readFile: async (p) => {
      const m = await metaOf(p);
      if (!m) throw new Error('File non trovato');
      return { data: new Uint8Array(await (await blobOf(p)).arrayBuffer()), size: m.size, mtime: m.mtime };
    },
    openDoc: async (p) => {
      const m = await metaOf(p);
      if (!m) throw new Error('File non trovato');
      const token = `d${++seq}`;
      docs.set(token, await blobOf(p));
      return { token, size: m.size, mtime: m.mtime };
    },
    readRange: async (token, begin, end) => new Uint8Array(await docs.get(token).slice(begin, end).arrayBuffer()),
    closeDoc: async (token) => { docs.delete(token); },
    writeFile,
    uniquePath,
    exists: async (p) => !!(await metaOf(p)),
    reveal: async (p) => { showTray([p], `«${base(p)}»: scaricalo o condividilo.`); return true; },
    // Condividi: il pannello del sistema (iPhone, iPad, Mac, Android) dopo un tocco sul pulsante.
    shareTargets: async () => null,
    shareSystem: async (p) => { if (!(await metaOf(p))) return false; showTray([p], `Condividi «${base(p)}»`); return true; },
    inkAvailable: async () => null,
    inkRecognize: async () => null,
    openLink: async (url) => { window.open(String(url), '_blank', 'noopener,noreferrer'); return true; },
    printPage: async () => { window.print(); return true; },
    fontList: async () => [],
    scanFolders: async (folders) => {
      const want = (folders || []).map(String);
      return (await allMeta())
        .filter((m) => /\.pdf$/i.test(m.path) && !m.path.startsWith(IMPORT) && want.some((f) => m.path === f || m.path.startsWith(`${f.replace(/\/$/, '')}/`)))
        .map((m) => ({ path: m.path, name: base(m.path), size: m.size, mtime: m.mtime }));
    },
    indexRoots: async () => [ROOT],
    thumbGet: (p) => kv('thumbs', (s) => s.get(p)),
    thumbSet: (p, url) => kv('thumbs', (s) => s.put(url, p)),
    draftGet: (p) => kv('drafts', (s) => s.get(p)),
    draftSet: (p, d) => kv('drafts', (s) => s.put(JSON.parse(JSON.stringify(d)), p)),
    draftDel: (p) => kv('drafts', (s) => s.delete(p)),
    fileHash: async (p) => {
      const buf = await (await blobOf(p)).arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
    },
    ocrGet: (hash) => kv('ocr', (s) => s.get(hash)),
    ocrSet: async (hash, data, where) => {
      await kv('ocr', (s) => s.put(JSON.parse(JSON.stringify(data)), hash));
      if (where) await kv('ocrmap', (s) => s.put(hash, ocrKey(where)));
      return true;
    },
    ocrDel: async (hash) => {
      await kv('ocr', (s) => s.delete(hash));
      await tx('ocrmap', 'readwrite', (t) => {
        t.objectStore('ocrmap').openCursor().onsuccess = (e) => { const c = e.target.result; if (!c) return; if (c.value === hash) c.delete(); c.continue(); };
      }).catch(() => {});
      return true;
    },
    ocrLookup: (where) => kv('ocrmap', (s) => s.get(ocrKey(where))),
    setTitle: async (t) => { document.title = t ? `${t} – Postilla` : 'Postilla'; },
    appVersion: async () => window.POSTILLA_VERSION || '',
    setFullscreen: async (on) => {
      try { if (on && !document.fullscreenElement) await html.requestFullscreen?.(); else if (!on && document.fullscreenElement) await document.exitFullscreen(); } catch { /* iPhone: non disponibile */ }
    },
    warmFiles: async () => true,
    onOpenFile: (fn) => listeners.open.push(fn),
    onAskClose: () => {},
    closeOk: () => {},
    pathForFile: () => null,
    aiKeyHas: async () => false,
    aiKeySet: async () => { throw new Error(NO_AI); },
    aiKeyDel: async () => true,
    // Solo per la versione web.
    archiveDialog,
    webImport: importFile,
  };

  // PDF trascinati sulla finestra: entrano nell'archivio e si aprono.
  window.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.pdf$/i.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    (async () => { for (const f of files) opened(await importFile(f)); })();
  }, true);
  // Chrome ed Edge sul computer, con Postilla installata: «Apri con» dal sistema.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      for (const hnd of params.files || []) { try { opened(await importFile(await hnd.getFile())); } catch { /* file non leggibile */ } }
    });
  }
  // Uscendo con modifiche non salvate il browser chiede conferma.
  window.addEventListener('beforeunload', (e) => {
    if ((window.postilla?.tabs || []).some((t) => t.dirty)) { e.preventDefault(); e.returnValue = ''; }
  });

  // --- Voce: riconoscitore del browser (Web Speech), con le stesse risposte del tablet Android ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    let rec = null;
    let t0 = 0;
    window.PostillaNative = {
      voiceAvailable: () => true,
      voiceStart: () => {
        try { rec?.abort(); } catch { /* già fermo */ }
        let sent = false;
        const send = (o) => { if (sent) return; sent = true; window.__pnVoice?.(JSON.stringify({ ...o, ms: Date.now() - t0 })); };
        rec = new SR();
        rec.lang = 'it-IT';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.continuous = false;
        rec.onresult = (e) => {
          const r = e.results[e.results.length - 1]?.[0];
          send(r ? { text: r.transcript, confidence: r.confidence || 0.7 } : { error: 'no-match' });
        };
        rec.onerror = (e) => send({ error: e.error === 'no-speech' ? 'no-match' : e.error === 'not-allowed' ? 'permesso' : e.error || 'errore' });
        rec.onend = () => send({ error: 'no-match' });
        t0 = Date.now();
        try { rec.start(); } catch { send({ error: 'errore' }); }
      },
      voiceStop: () => { try { rec?.stop(); } catch { /* già fermo */ } },
    };
  }

  // --- Funzionamento senza rete: il service worker conserva il programma sul dispositivo ----------
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.POSTILLA_NO_SW) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
