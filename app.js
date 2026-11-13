// Postilla: regia dell'interfaccia. Schede, barra strumenti, salvataggio, firme e timbri.
import { $, ask, baseName, h, icon, iconBtn, modal, promptText, toast, uid } from './core.js';
import { DocView, PCT, openPdf } from './docview.js';
import { Tools } from './tools.js';
import { Home } from './home.js';
import { PageManager, Panel } from './panels.js';
import { buildPdf, extractOwn } from './pdfio.js';
import { OcrController } from './ocr-ui.js';
import { ClaudiaPanel } from './claudia/panel.js';
import { GrokLink } from './claudia/grok-link.js';
import { FileIndex } from './claudia/fileindex.js';
import { docTrusted, manageTrust, setDocTrusted } from './links.js';
import { renderFields, pageFields } from './forms.js';
import { hydrateEdits } from './edits.js';
import { MainMenu } from './menu.js';
import { printDoc } from './print.js';
import { shareDoc } from './share.js';
import { InkText } from './inktext.js';
import { Collab } from './collab.js';
import { Library } from './library.js';
import { openLibrary, openSearch } from './library-ui.js';
import { LASER_COLORS, hlPanel, penPanel, remember } from './colors.js';
import { carryOver, editTitles, isThirdParty, logEntry, proposeIfNeeded, setThirdParty, showLog } from './thirdparty.js';

const COLORS = ['#1d3f8f', '#14213d', '#b3261e', '#1b7a4b', '#b5541c', '#7a2f9b'];
const HL_COLORS = ['#ffe14d', '#a8f07a', '#8fd3ff', '#ffb3d1', '#ffc56b', '#d6c2ff'];
const SIZES = [1, 2, 4, 7];

class App {
  constructor() {
    this.tabs = [];
    this.active = null;
    this.tools = new Tools(this);
    this.inkText = new InkText(this);
    this.collab = new Collab(this);
    this.library = new Library(this);
    this.ocr = new OcrController(this);
    this.claudia = new ClaudiaPanel(this);
  }

  get view() { return this.active?.view || null; }
  get prefs() { return this.settings.prefs; }

  async start() {
    this.settings = await host.settingsGet();
    if (!this.prefs.layout2) { this.prefs.layout2 = true; this.prefs.panel = false; this.savePrefs(); }
    this.home = new Home(this);
    this.panel = new Panel(this);
    this.pm = new PageManager(this);
    this.buildToolbar();
    this.buildRail();
    this.renderTabs();
    this.showHome();
    this.home.refresh();
    this.bindGlobal();
    this.grok = new GrokLink(this); // collegamento con Grok Bot (spento finché non lo accendi)
    this.fileIndex = new FileIndex(); // nomi dei PDF del dispositivo, per «apri …» anche fuori dalla raccolta
    if (this.prefs.theresa) this.fileIndex.start();
    document.body.classList.toggle('no-theresa', !this.prefs.theresa);
    document.body.classList.toggle('grok-on', !!this.settings.grok?.enabled);
    // PDF aperti da fuori (doppio clic, allegati di posta, più file insieme): niente valore di ritorno,
    // perché attraverso il ponte con Windows verrebbe ricopiata l'intera scheda e la finestra si bloccherebbe.
    host.onOpenFile((f) => { this.open(f); });
    host.onAskClose(() => { this.askClose(); });
    for (const f of await host.pendingFiles()) this.open(f);
    setTimeout(() => this.warmPinned(), 2500);
    // Ricerca in tutti i PDF: l'indice delle cartelle scelte si aggiorna in sottofondo (solo i file nuovi o cambiati).
    setTimeout(() => { if (this.library.folders.length) this.library.update().catch(() => {}); }, 20000);
    setInterval(() => { if (this.library.folders.length) this.library.update().catch(() => {}); }, 30 * 60 * 1000);
    window.postilla = this; // usato dai test automatici
    document.documentElement.dataset.ready = '1';
  }

  savePrefs() { host.settingsSet({ prefs: this.prefs }); }

  // Theresa (assistente vocale) è nascosta per impostazione: si mostra dal menu Impostazioni.
  // Nascosta, non ascolta e non indicizza i file; il collegamento con il bot Grok continua a funzionare.
  setTheresa(on) {
    this.prefs.theresa = !!on;
    this.savePrefs();
    document.body.classList.toggle('no-theresa', !on);
    this.claudia.setHidden(!on);
    if (on) this.fileIndex.start();
    this.renderTabs();
    toast(on ? 'Theresa è di nuovo visibile (pulsante in alto, Ctrl+K).' : 'Theresa è nascosta. La ritrovi nel menu Impostazioni.');
  }

  // Assistente AI: il modulo si carica alla prima apertura.
  async openAi({ settings = false } = {}) {
    try {
      if (!this.ai) { const { AiPanel } = await import('./pro/ai.js'); this.ai = new AiPanel(this); }
      if (settings) this.ai.openSettings(); else this.ai.toggle();
    } catch (e) {
      console.error(e);
      toast('L\'assistente AI non è disponibile.', 'error');
    }
  }

  // --- Schede ---------------------------------------------------------------
  renderTabs() {
    const bar = $('#tabbar');
    bar.textContent = '';
    this.menu = this.menu || new MainMenu(this);
    bar.append(h('button', { class: 'tab menu-tab', id: 'menu-btn', title: 'Menu: tutte le funzioni', 'aria-label': 'Menu', html: `${icon('menu')}<span>Menu</span>`, onclick: (e) => this.menu.open(e.currentTarget) }));
    bar.append(h('button', { class: `tab home-tab ${this.active ? '' : 'on'}`, title: 'Documenti', 'aria-label': 'Documenti', html: icon('home'), onclick: () => this.showHome() }));
    for (const t of this.tabs) {
      bar.append(h('div', { class: `tab ${t === this.active ? 'on' : ''}`, title: t.path },
        h('button', { class: 'tab-name', onclick: () => this.activate(t) }, `${t.dirty ? '• ' : ''}${t.name}`),
        iconBtn('close', `Chiudi ${t.name}`, () => this.closeTab(t))));
    }
    // Apre altri PDF accanto a quelli aperti: nella finestra di scelta se ne possono selezionare più d'uno.
    bar.append(h('button', { class: 'tab voice-open-tab', id: 'voice-open', title: 'Apri un PDF dicendo il suo nome (Ctrl+Maiusc+O)', 'aria-label': 'Apri a voce', html: icon('mic'), onclick: () => this.openByVoice() }));
    bar.append(h('button', { class: 'tab open-tab', id: 'open-more', title: 'Apri altri PDF (Ctrl+O): puoi sceglierne più di uno insieme', 'aria-label': 'Apri altri PDF', html: `${icon('plus')}<span>Apri</span>`, onclick: () => this.pickAndOpen() }));
    if (this.prefs.theresa) bar.append(h('button', { class: 'tab claudia-tab', id: 'claudia-btn', title: 'Theresa, segreteria documentale (Ctrl+K)', html: `${icon('claudia')}<span>Theresa</span>`, onclick: () => this.claudia.toggle() }));
    bar.append(h('button', { class: 'tab ai-tab', id: 'ai-btn', title: this.prefs.theresa ? 'Assistente AI' : 'Assistente AI (Ctrl+K)', html: this.prefs.theresa ? icon('claudia') : `${icon('claudia')}<span>Assistente</span>`, 'aria-label': 'Assistente AI', onclick: () => this.openAi() }));
    bar.append(h('button', { class: 'tab quick-tab', id: 'quick', title: 'PDF a portata di mano', html: `${icon('folder')}<span>Documenti</span>`, onclick: (e) => this.openQuick(e.currentTarget) }));
    // 0.9.4: spazio libero sempre presente per trascinare la finestra (doppio clic: ingrandisci o riduci).
    bar.append(h('div', { class: 'drag-space', title: 'Trascina da qui per spostare la finestra (doppio clic: ingrandisci o riduci)', 'aria-hidden': 'true' }));
  }

  showHome() {
    this.tools.commitEditor();
    this.pm.close();
    if (this.active) this.active.view.root.hidden = true;
    if (this.active) this.active.view.hidden = true;
    this.active = null;
    $('#home').hidden = false;
    $('#docs').hidden = true;
    $('#toolbar').hidden = true;
    this.rail.hidden = true;
    this.panel.show(false);
    host.setTitle('Postilla');
    this.renderTabs();
    this.home.renderRecents?.();
  }

  activate(t) {
    this.tools.commitEditor();
    this.tools.deselect();
    this.pm.close();
    if (this.active && this.active !== t) { this.active.view.root.hidden = true; this.active.view.hidden = true; }
    this.active = t;
    t.view.root.hidden = false;
    t.view.hidden = false;
    $('#home').hidden = true;
    $('#docs').hidden = false;
    $('#toolbar').hidden = false;
    this.rail.hidden = this.prefs.rail === false;
    this.panel.show(this.prefs.panel);
    if (this.prefs.panel) this.panel.render();
    host.setTitle(`${t.name} - Postilla`);
    this.renderTabs();
    this.syncToolbar();
    t.view.fitLive();
    t.view.schedule();
  }

  // Lo stesso file chiesto due volte mentre si sta ancora aprendo (doppio clic ripetuto, allegato
  // consegnato due volte) apre una sola scheda.
  open(path, opts) {
    const key = String(path).toLowerCase();
    this.opening = this.opening || new Map();
    if (this.opening.has(key)) return this.opening.get(key);
    const p = this.openNow(path, opts).finally(() => this.opening.delete(key));
    this.opening.set(key, p);
    return p;
  }

  async openNow(path, { reveal = true } = {}) {
    const existing = this.tabs.find((t) => t.path.toLowerCase() === path.toLowerCase());
    if (existing) { this.activate(existing); return existing; }
    const t0 = performance.now();
    let meta;
    try { meta = await host.openDoc(path); } catch {
      toast(`Non trovo il file: ${baseName(path)}`, 'error');
      this.settings.recents = this.settings.recents.filter((r) => r.path !== path);
      host.settingsSet({ recents: this.settings.recents });
      this.home.renderRecents();
      return null;
    }
    const tab = { path, name: baseName(path), dirty: false, own: false, size: meta.size, mtime: meta.mtime };
    const view = new DocView(this, tab);
    Object.assign(view, { annots: [], undoStack: [], redoStack: [], pageHistory: [], readonly: false, hasSig: false, cleanBytes: null, sourcePath: path, token: meta.token, loading: true });
    tab.view = view;
    let pdf;
    try {
      pdf = await openPdf(meta, async (update, reason) => {
        const again = reason === 2;
        const pw = await promptText('PDF protetto', again ? 'Password errata. Riprova:' : `Password di ${tab.name}:`, '', { password: true, okLabel: 'Apri' });
        if (pw === undefined) update(new Error('annullato')); else { tab.password = pw; update(pw); }
      });
    } catch (e) {
      view.destroy();
      if (e?.message !== 'annullato') toast(`Non riesco ad aprire ${tab.name}: il file sembra danneggiato o non è un PDF valido.`, 'error');
      return null;
    }
    this.tabs.push(tab);
    $('#docs').append(view.root);
    view.root.hidden = true;
    this.activate(tab);
    await view.setDoc(pdf);
    tab.openMs = performance.now() - t0;
    const recent = this.settings.recents.find((r) => r.path === path);
    if (recent?.page && reveal) view.goto(recent.page);
    this.touchRecent(tab);
    if (this.prefs.panel && view === this.view) this.panel.render();
    view.ready = this.afterOpen(view, tab, pdf);
    return tab;
  }

  async afterOpen(view, tab, pdf) {
    const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
    if (view.closed) return;
    view.hasSig = !!info?.IsSignaturesPresent;
    tab.own = !!(info?.Custom?.get?.('PostillaAnnotated') ?? info?.Custom?.PostillaAnnotated);
    if (info?.EncryptFilterName) await this.unlock(view, tab, tab.password || '');
    if (view.hasSig) this.banner(view, 'Questo PDF contiene una firma digitale. Se lo annoti, Postilla salva sempre una copia: la firma della copia non sarà più valida, l’originale resta intatto.');
    if (tab.own && !view.readonly) {
      // Le annotazioni di Postilla tornano modificabili: intanto il documento è già leggibile.
      try {
        const { data } = await host.readFile(view.sourcePath);
        const r = await extractOwn(data);
        const clean = await openPdf(r.bytes);
        if (view.closed) return;
        const page = view.current;
        const top = view.scroller.scrollTop;
        view.cleanBytes = r.bytes;
        view.annots = r.annots;
        view.editLog = r.log || [];
        await view.setDoc(clean);
        view.goto(page);
        view.scroller.scrollTop = top;
        this.tools.drawAll(view);
        hydrateEdits(this, view);
      } catch (e) { console.error(e); }
    }
    view.loading = false;
    this.collab?.opened(view);
    this.announceFields(view);
    const draft = await host.draftGet(tab.path);
    const draftFields = Object.entries(draft?.fields || {});
    if (draft && draft.size === tab.size && draft.mtime === tab.mtime && (draft.annots?.length || draftFields.length) && !view.readonly) {
      view.annots = draft.annots || [];
      view.formEdits = new Map(draftFields);
      if (draft.editLog) view.editLog = draft.editLog;
      view.pages.forEach((p) => { p.formLayer?.remove(); p.formLayer = null; renderFields(this, view, p.i); });
      this.tools.drawAll(view);
      hydrateEdits(this, view);
      this.setDirty(tab, true);
      toast('Ho recuperato le annotazioni non salvate dell’ultima sessione.');
    } else if (draft) host.draftDel(tab.path);
    this.syncToolbar();
    if (this.prefs.panel && view === this.view) this.panel.render();
    this.ocr.afterOpen(view);
    this.syncThirdParty(view);
    proposeIfNeeded(this, view);
  }

  // PDF cifrato: si può modificare solo se la password data è quella del proprietario o se il documento
  // permette le modifiche. Nessuna protezione viene aggirata: senza permesso resta in sola lettura.
  async unlock(view, tab, password, { manual = false } = {}) {
    let r = null;
    try {
      const { decryptPdf } = await import('./pro/crypt.js');
      const { data } = await host.readFile(view.sourcePath);
      r = await decryptPdf(new Uint8Array(data), password);
    } catch (e) { r = null; if (manual) toast(e?.code === 'password' ? 'Password errata.' : 'Non riesco a sbloccare questo PDF.', 'error'); }
    view.root.querySelectorAll('.banner.locked').forEach((b) => b.remove());
    if (r && (r.info.owner || r.info.permissions?.modify)) {
      const page = view.current;
      view.cleanBytes = r.bytes;
      view.readonly = false;
      view.encryption = r.info;
      await view.setDoc(await openPdf(r.bytes));
      view.goto(page);
      this.tools.drawAll(view);
      this.banner(view, 'PDF protetto da password: puoi modificarlo. La copia che salvi non avrà la password; per rimetterla usa Documento › Proteggi con password.');
      return true;
    }
    view.readonly = true;
    const b = h('div', { class: 'banner locked', role: 'status' }, 'PDF protetto: puoi leggerlo, ma per modificarlo serve la password del proprietario. ',
      h('button', { onclick: async () => { const pw = await promptText('Password del proprietario', 'Inserisci la password del proprietario del documento:', '', { password: true, okLabel: 'Sblocca' }); if (pw) this.unlock(view, tab, pw, { manual: true }); } }, 'Inserisci la password'),
      iconBtn('close', 'Chiudi avviso', () => b.remove()));
    view.root.append(b);
    return false;
  }

  syncThirdParty(view) { view.root.classList.toggle('terzi', isThirdParty(this, view)); }

  // Registro: rimozioni e annullamenti di sostituzioni o aggiunte (creazione e correzione le registra edits.js).
  onEditOp(view, op, how) {
    const added = (op.add || []).filter((a) => a.type === 'edit');
    const removed = (op.remove || []).filter((a) => a.type === 'edit');
    const orig = (a) => (a.mode === 'replace' ? a.before : '');
    const L = (kind, a, before, after) => logEntry(this, view, { kind, page: a.page, before, after });
    if (how === 'do') { if (removed.length && !added.length) removed.forEach((a) => L('rimozione', a, a.text, orig(a))); return; }
    if (how === 'undo') {
      added.forEach((a) => L('annullata', a, a.text, orig(a)));
      if (!added.length) removed.forEach((a) => L('ripristinata', a, orig(a), a.text));
      return;
    }
    added.forEach((a) => L('ripristinata', a, orig(a), a.text));
    if (!added.length) removed.forEach((a) => L('rimozione', a, a.text, orig(a)));
  }

  onFieldChanged(view, f, before, after) {
    const show = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
    logEntry(this, view, { kind: 'campo', page: f.page, field: f.label || f.name, before: show(before), after: show(after) });
    if (isThirdParty(this, view) && !view.fieldWarned) { view.fieldWarned = true; toast('Documento di terzi: stai modificando un campo del modulo. La modifica resta nel registro.', 'warn'); }
  }

  // Solo nell'app Android: avvisa che il PDF ha campi da compilare (evidenziati in android.css).
  async announceFields(view) {
    const html = document.documentElement;
    if (!html.classList.contains('android') || html.classList.contains('web') || view.readonly) return;
    const names = new Set();
    for (let i = 0; i < Math.min(view.pages.length, 60); i += 1) for (const f of await pageFields(view, i)) if (!f.readOnly) names.add(f.name);
    if (view.closed) return;
    const n = names.size;
    if (n) toast(n === 1 ? 'Questo PDF ha un campo da compilare, evidenziato in azzurro: toccalo per scrivere.' : `Questo PDF ha ${n} campi da compilare, evidenziati in azzurro: toccane uno per scrivere.`);
  }

  banner(view, msg) {
    const b = h('div', { class: 'banner', role: 'status' }, msg, iconBtn('close', 'Chiudi avviso', () => b.remove()));
    view.root.append(b);
  }

  touchRecent(tab) {
    const page = tab.view.current;
    const r = this.settings.recents.filter((x) => x.path !== tab.path);
    r.unshift({ path: tab.path, name: tab.name, page, at: Date.now() });
    this.settings.recents = r.slice(0, 40);
    host.settingsSet({ recents: this.settings.recents });
  }

  async pickAndOpen() { for (const f of await host.pickPdf()) await this.open(f); }

  // 0.9.1: apre un PDF dicendo il suo nome (senza Theresa).
  async openByVoice() { const m = await import('./voiceopen.js'); return m.openByVoice(this); }

  async closeTab(t) {
    this.tools.commitEditor();
    if (t.dirty) {
      const c = await ask(`Salvare ${t.name}?`, 'Ci sono modifiche non salvate.', [{ label: 'Annulla', value: 'x' }, { label: 'Non salvare', value: 'no' }, { label: 'Salva', value: 'yes', primary: true }]);
      if (c === 'x' || c === undefined) return false;
      if (c === 'yes' && !(await this.save(t.view))) return false;
      if (c === 'no') host.draftDel(t.path);
    }
    this.touchRecent(t);
    this.ocr.closing(t.view);
    const i = this.tabs.indexOf(t);
    this.tabs.splice(i, 1);
    t.view.destroy();
    if (this.active === t) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next); else this.showHome();
    }
    this.renderTabs();
    return true;
  }

  async askClose() {
    this.tools.commitEditor();
    for (const t of [...this.tabs]) {
      if (t.dirty) { this.activate(t); if (!(await this.closeTab(t))) return; } else this.touchRecent(t);
    }
    host.closeOk();
  }

  // --- Eventi dal visualizzatore ---------------------------------------------
  onPageChange(view, page) {
    if (view !== this.view) return;
    this.pageInput.value = page + 1;
    this.syncPageArrows(view);
    this.panel.sync(view, page);
    clearTimeout(this.pageTimer);
    this.pageTimer = setTimeout(() => this.touchRecent(view.tab), 1500);
  }

  onZoom(view) { if (view === this.view) this.zoomLabel.textContent = `${Math.round((view.s / PCT) * 100)}%`; }

  onPageDrawn(view, i, canvas) {
    renderFields(this, view, i);
    if (i !== 0 || view.tab.thumbDone) return;
    view.tab.thumbDone = true;
    const c = document.createElement('canvas');
    const k = 220 / canvas.width;
    c.width = 220; c.height = Math.round(canvas.height * k);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    host.thumbSet(view.tab.path, c.toDataURL('image/jpeg', 0.72));
  }

  setDirty(tab, on) {
    if (tab.dirty !== on) { tab.dirty = on; this.renderTabs(); }
    if (this.saveBtn && tab === this.active) this.saveBtn.classList.toggle('attention', on);
  }

  markDirty(view) {
    this.setDirty(view.tab, true);
    clearTimeout(view.draftTimer);
    view.draftTimer = setTimeout(() => {
      const { tab } = view;
      if (tab.dirty && !view.pageHistory.length) host.draftSet(tab.path, { size: tab.size, mtime: tab.mtime, annots: view.annots, fields: Object.fromEntries(view.formEdits || []), editLog: view.editLog || [] });
    }, 1500);
    if (this.panel.mode === 'annots' && view === this.view && this.prefs.panel) this.panel.render();
  }

  // --- Salvataggio -------------------------------------------------------------
  async save(view, { as = false, flatten = false } = {}) {
    const { tab } = view;
    this.tools.commitEditor();
    await view.ready;
    if (view.readonly) { toast('Questo PDF è protetto e non può essere salvato con modifiche.', 'error'); return false; }
    // Zone da oscurare non ancora applicate: il contenuto sotto c'è ancora, quindi si chiede cosa fare.
    if (view.annots.some((a) => a.type === 'redact')) {
      const c = await ask('Ci sono zone da oscurare non ancora applicate', flatten ? 'Nella versione definitiva vanno applicate prima: il contenuto sotto le zone verrebbe salvato.' : 'Se non le applichi, il contenuto sotto le zone resta nel file (le zone si vedono come riquadri rossi).',
        [{ label: 'Annulla', value: 'x' }, ...(flatten ? [] : [{ label: 'Salva senza oscurare', value: 'no' }]), { label: 'Oscura e salva', value: 'yes', primary: true }]);
      if (c === 'x' || c === undefined) return false;
      if (c === 'yes') {
        const { applyRedactions } = await import('./pro/redact.js');
        if (!(await applyRedactions(this, view, { confirm: false }))) return false;
      }
    }
    let dest = tab.path;
    const base = tab.path.replace(/\.pdf$/i, '');
    if (as || flatten) {
      dest = await host.pickSave(flatten ? `${base} - definitivo.pdf` : `${base} - copia.pdf`);
      if (!dest) return false;
    } else if (!tab.own || view.hasSig) {
      // La prima volta si crea una copia: l'originale non viene mai toccato.
      dest = await host.uniquePath(`${base} - annotato.pdf`);
    }
    try {
      if (tab.size > 20e6) { toast('Salvataggio in corso…'); await new Promise((r) => setTimeout(r, 40)); }
      const bytes = await buildPdf(view, { flatten });
      const st = await host.writeFile(dest, bytes);
      if (dest !== tab.path) { carryOver(this, tab.path, dest); this.collab?.moved(tab.path, dest); }
      if (flatten) { this.ocr.afterSave(view, dest, st); toast(`Creata la versione definitiva: ${baseName(dest)}`); return true; }
      // Campi del modulo appena creati: da qui in poi sono campi veri, da compilare.
      const madeFields = view.annots.some((a) => a.type === 'field');
      await host.draftDel(tab.path);
      if (dest !== tab.path) { const th = await host.thumbGet(tab.path); if (th) host.thumbSet(dest, th); }
      Object.assign(tab, { path: dest, name: baseName(dest), own: true, size: st.size, mtime: st.mtime });
      view.hasSig = false;
      view.pageHistory = [];
      this.setDirty(tab, false);
      this.touchRecent(tab);
      this.renderTabs();
      host.setTitle(`${tab.name} - Postilla`);
      this.ocr.afterSave(view, dest, st);
      if (madeFields) await this.fieldsToReal(view, bytes);
      toast(madeFields ? `Salvato: ${tab.name}. I campi ora sono compilabili.` : `Salvato: ${tab.name}`);
      return true;
    } catch (e) {
      console.error(e);
      toast(`Salvataggio non riuscito: ${e.message || e}`, 'error');
      return false;
    }
  }

  // Dopo il salvataggio di un modulo creato in Postilla: il documento si ricarica come all'apertura, così i
  // riquadri disegnati diventano i campi veri da compilare (le altre annotazioni restano modificabili).
  async fieldsToReal(view, bytes) {
    try {
      const r = await extractOwn(bytes);
      const clean = await openPdf(r.bytes);
      const page = view.current; const top = view.scroller.scrollTop;
      view.cleanBytes = r.bytes;
      view.annots = r.annots;
      view.formEdits = new Map();
      view.fieldCache = new Map();
      view.undoStack.length = 0; view.redoStack.length = 0;
      this.tools.deselect();
      await view.setDoc(clean);
      view.pages.forEach((p) => { p.formLayer?.remove(); p.formLayer = null; renderFields(this, view, p.i); });
      view.goto(page); view.scroller.scrollTop = top;
      this.tools.drawAll(view);
      hydrateEdits(this, view);
    } catch (e) { console.error(e); }
  }

  // --- Operazioni sulle pagine ---------------------------------------------------
  async pageOp(view, fn, mapping) {
    await view.ready;
    const snapshot = { bytes: await view.ensureBytes(), annots: view.annots };
    const bytes = await fn(view.cleanBytes);
    const annots = view.annots.map((a) => ({ ...a, page: mapping(a.page) })).filter((a) => a.page >= 0);
    await this.reloadDoc(view, bytes, annots);
    view.pageHistory.push(snapshot);
    if (view.pageHistory.length > 8) view.pageHistory.shift();
  }

  async undoPageOp(view) {
    const s = view.pageHistory.pop();
    if (!s) return false;
    await this.reloadDoc(view, s.bytes, s.annots);
    return true;
  }

  async reloadDoc(view, bytes, annots) {
    const page = view.current;
    view.cleanBytes = bytes;
    view.annots = annots;
    view.undoStack.length = 0;
    view.redoStack.length = 0;
    view.thumbs = null;
    this.tools.deselect();
    this.ocr.reset(view);
    const pdf = await openPdf(bytes);
    await view.setDoc(pdf);
    view.goto(Math.min(page, view.pages.length - 1));
    this.tools.drawAll(view);
    this.markDirty(view);
    this.syncToolbar();
    if (this.prefs.panel) this.panel.render();
  }

  // Foglio precedente (-1) o successivo (+1).
  pageStep(d) {
    const v = this.view;
    if (!v?.pages.length) return;
    const i = Math.max(0, Math.min(v.pages.length - 1, v.current + d));
    if (i !== v.current) v.goto(i);
  }

  syncPageArrows(view) {
    const n = view.pages.length;
    this.prevBtn.disabled = view.current <= 0;
    this.nextBtn.disabled = view.current >= n - 1;
    const r = document.querySelector('#reading-nav');
    if (r) { r.querySelector('.prev').disabled = this.prevBtn.disabled; r.querySelector('.next').disabled = this.nextBtn.disabled; }
  }

  bookmarks(view) { return this.settings.bookmarks[view.tab.path] || []; }

  toggleBookmark(view, i) {
    const list = new Set(this.bookmarks(view));
    if (list.has(i)) list.delete(i); else list.add(i);
    this.settings.bookmarks[view.tab.path] = [...list].sort((a, b) => a - b);
    host.settingsSet({ bookmarks: this.settings.bookmarks });
  }

  // --- Barra strumenti ------------------------------------------------------------
  buildToolbar() {
    const bar = $('#toolbar');
    const tool = (id, ic, title) => iconBtn(ic, title, () => this.tools.set(id), { 'data-tool': id });
    this.pageInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Numero di pagina', value: '1' });
    this.pageInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { this.view?.goto((parseInt(this.pageInput.value, 10) || 1) - 1); this.pageInput.blur(); }
    });
    this.pageTotal = h('span', { class: 'page-total' });
    // Frecce per passare al foglio precedente o successivo (anche con i tasti freccia sinistra e destra).
    this.prevBtn = iconBtn('prev', 'Pagina precedente (freccia sinistra)', () => this.pageStep(-1), { 'data-role': 'page-prev' });
    this.nextBtn = iconBtn('next', 'Pagina successiva (freccia destra)', () => this.pageStep(1), { 'data-role': 'page-next' });
    this.zoomLabel = h('button', { class: 'zoom-label', title: 'Riporta al 100%', onclick: () => this.view?.setScale(PCT) }, '100%');
    this.saveBtn = iconBtn('save', 'Salva (Ctrl+S)', () => this.view && this.save(this.view));
    this.undoBtn = iconBtn('undo', 'Annulla (Ctrl+Z)', () => this.view && this.tools.undo(this.view));
    this.redoBtn = iconBtn('redo', 'Ripeti (Ctrl+Y)', () => this.view && this.tools.redo(this.view));
    this.fingerBtn = iconBtn('finger', 'Scrivi anche col dito', () => { this.prefs.fingerDraw = !this.prefs.fingerDraw; this.savePrefs(); this.syncToolbar(); toast(this.prefs.fingerDraw ? 'Il dito ora scrive. Con due dita sposti e ingrandisci.' : 'Il dito sposta e ingrandisce. Solo la penna scrive.'); });
    this.shapeBtn = iconBtn('rect', 'Forme', (e) => this.openShapes(e.currentTarget), { 'data-tool': 'shape' });
    this.stampBtn = iconBtn('stamp', 'Timbro', () => { this.tools.set('stamp'); this.openStampMenu(); }, { 'data-tool': 'stamp' });
    this.signBtn = iconBtn('sign', 'Firma visiva', () => { this.tools.set('sig'); this.openSignMenu(); }, { 'data-tool': 'sig' });
    this.labelsBtn = iconBtn('eye', 'Mostra o nascondi le note invisibili', () => this.toggleLabels(), { 'data-role': 'show-labels' });
    document.documentElement.classList.toggle('show-labels', !!this.prefs.showLabels);
    const sep = () => h('span', { class: 'sep' });
    bar.append(
      iconBtn('panel', 'Pannello laterale', () => { this.prefs.panel = !this.prefs.panel; this.savePrefs(); this.panel.show(this.prefs.panel); if (this.prefs.panel) this.panel.render(); }),
      iconBtn('pages', 'Gestisci pagine', () => this.pm.open()),
      iconBtn('pen', 'Mostra o nascondi la barra degli strumenti', () => { this.prefs.rail = !this.prefs.rail; this.savePrefs(); this.rail.hidden = !this.prefs.rail; }),
      sep(),
      tool('hand', 'hand', 'Sposta'), tool('select', 'select', 'Seleziona testo e annotazioni'),
      tool('hl', 'mark', 'Evidenzia'), tool('ul', 'under', 'Sottolinea'), tool('so', 'strike', 'Barra'),
      this.shapeBtn,
      tool('text', 'text', 'Casella di testo'), tool('note', 'note', 'Nota'), tool('label', 'label', 'Nota invisibile: compare quando la penna o il mouse ci passa sopra'), this.labelsBtn, this.stampBtn, this.signBtn,
      sep(), this.undoBtn, this.redoBtn,
      h('span', { class: 'spacer' }),
      iconBtn('zout', 'Riduci', () => this.zoomStep(1 / 1.25)), this.zoomLabel, iconBtn('zin', 'Ingrandisci', () => this.zoomStep(1.25)),
      iconBtn('fitw', 'Adatta alla larghezza', () => this.view?.setFit('width')), iconBtn('fitp', 'Pagina intera', () => this.view?.setFit('page')),
      sep(), iconBtn('search', 'Cerca nel documento (Ctrl+F) o in tutti i PDF (Ctrl+Maiusc+F)', () => openSearch(this), { 'data-role': 'search' }), this.prevBtn, this.pageInput, this.pageTotal, this.nextBtn, sep(),
      iconBtn('expand', 'Lettura a tutto schermo', () => this.setReading(true)),
      this.saveBtn, iconBtn('more', 'Altre azioni', (e) => this.openMore(e.currentTarget)),
    );
  }

  // Barra destra: penne colorate, spessori, evidenziatori, gomma e puntatore virtuale.
  buildRail() {
    this.rail = h('aside', { id: 'rail', 'aria-label': 'Strumenti di scrittura' });
    $('#stage').append(this.rail);
    this.fingerBtn = iconBtn('finger', 'Scrivi anche col dito', () => { this.prefs.fingerDraw = !this.prefs.fingerDraw; this.savePrefs(); this.syncToolbar(); toast(this.prefs.fingerDraw ? 'Il dito ora scrive. Con due dita sposti e ingrandisci.' : 'Il dito sposta e ingrandisce. Solo la penna scrive.'); });
    const useColor = (key, c, t) => () => { this.prefs[key] = c; this.savePrefs(); this.tools.set(t); };
    this.railItems = [];
    const penBtn = (c) => { const b = h('button', { class: 'ib rail-pen', style: `color:${c}`, title: 'Penna', 'aria-label': `Penna colore ${c}`, 'data-pen': c, html: icon('pen'), onclick: useColor('color', c, 'pen') }); return b; };
    const hlBtn = (c) => h('button', { class: 'ib rail-hl', style: `background:${c}`, title: 'Evidenziatore', 'aria-label': `Evidenziatore colore ${c}`, 'data-hl': c, html: icon('mark'), onclick: useColor('hlColor', c, 'hl') });
    const sizeBtn = (s) => h('button', { class: 'ib size', title: `Spessore ${s}`, 'aria-label': `Spessore ${s}`, 'data-size': s, html: `<i style="width:${3 + s * 2.6}px;height:${3 + s * 2.6}px"></i>`, onclick: () => { this.prefs.size = s; this.savePrefs(); if (!['pen', 'rect', 'ellipse', 'line', 'arrow'].includes(this.tools.tool)) this.tools.set('pen'); else this.syncToolbar(); } });
    const eraser = iconBtn('eraser', 'Gomma: tocca un segno per cancellarlo', () => this.tools.set('eraser'), { 'data-tool': 'eraser' });
    // Puntatore: un tocco lo sceglie; un secondo tocco apre le impostazioni (scia o punto, colore, grandezza, durata).
    const laser = iconBtn('laser', 'Puntatore virtuale: non lascia segni (tocca di nuovo per le impostazioni)', (e) => { if (this.tools.tool === 'laser') this.openLaserSettings(e.currentTarget); else this.tools.set('laser'); }, { 'data-tool': 'laser' });
    // Tutti i colori: tavolozza con tinte e tonalità, più la scelta libera di qualunque colore.
    this.penPalBtn = h('button', { class: 'ib rail-palette', title: 'Altri colori della penna', 'aria-label': 'Altri colori della penna', html: '<i></i>', onclick: (e) => this.openPenColors(e.currentTarget) });
    this.hlPalBtn = h('button', { class: 'ib rail-palette hl', title: 'Altri colori dell\'evidenziatore', 'aria-label': 'Altri colori dell\'evidenziatore', html: '<i></i>', onclick: (e) => this.openHlColors(e.currentTarget) });
    const line = () => h('hr', {});
    this.rail.append(...COLORS.map(penBtn), this.penPalBtn, line(), ...SIZES.map(sizeBtn), line(), ...HL_COLORS.slice(0, 4).map(hlBtn), this.hlPalBtn, line(), eraser, laser, this.fingerBtn);
  }

  setReading(on) {
    this.reading = on;
    document.body.classList.toggle('reading', on);
    host.setFullscreen(on);
    if (on && !$('#exit-reading')) {
      document.body.append(h('button', { id: 'exit-reading', title: 'Esci dalla lettura (Esc)', 'aria-label': 'Esci dalla lettura', html: icon('close'), onclick: () => this.setReading(false) }));
      // A tutto schermo la barra è nascosta: le frecce restano sui due lati.
      document.body.append(h('div', { id: 'reading-nav' },
        h('button', { class: 'prev', title: 'Pagina precedente', 'aria-label': 'Pagina precedente', html: icon('prev'), onclick: () => this.pageStep(-1) }),
        h('button', { class: 'next', title: 'Pagina successiva', 'aria-label': 'Pagina successiva', html: icon('next'), onclick: () => this.pageStep(1) })));
      if (this.view) this.syncPageArrows(this.view);
    } else if (!on) { $('#exit-reading')?.remove(); $('#reading-nav')?.remove(); }
  }

  // Elenco rapido: preferiti precaricati, recenti e PDF delle cartelle.
  warmPinned() {
    const files = this.settings.pinned.map((p) => p.path);
    if (files.length) host.warmFiles(files);
  }

  togglePin(path, name) {
    const { settings } = this;
    const on = settings.pinned.some((p) => p.path === path);
    settings.pinned = on ? settings.pinned.filter((p) => p.path !== path) : [{ path, name }, ...settings.pinned];
    host.settingsSet({ pinned: settings.pinned });
    if (!on) host.warmFiles([path]);
  }

  openQuick(anchor, query = '') {
    const { settings, home } = this;
    const input = h('input', { type: 'search', placeholder: 'Cerca per nome…', 'aria-label': 'Cerca un PDF', value: query });
    const list = h('div', { class: 'quick-list' });
    const pinnedSet = () => new Set(settings.pinned.map((p) => p.path));
    const row = (f) => h('div', { class: 'quick-row' },
      h('button', { class: 'quick-name', title: f.path, onclick: () => { this.closePop(); this.open(f.path); } }, f.name),
      iconBtn('star', pinnedSet().has(f.path) ? 'Togli dai preferiti' : 'Aggiungi ai preferiti', () => { this.togglePin(f.path, f.name); render(); }, { class: `ib pin ${pinnedSet().has(f.path) ? 'on' : ''}` }));
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const ok = (f) => !q || q.split(/\s+/).every((w) => f.name.toLowerCase().includes(w));
      const pins = pinnedSet();
      const seen = new Set(pins);
      const take = (arr, n) => arr.filter((f) => ok(f) && !seen.has(f.path)).slice(0, n).map((f) => { seen.add(f.path); return f; });
      const recents = take(settings.recents, q ? 20 : 8);
      const folders = take(home.files, q ? 30 : 8);
      list.textContent = '';
      const group = (title, items) => { if (items.length) list.append(h('h3', {}, title), ...items.map(row)); };
      group('Preferiti, sempre pronti', settings.pinned.filter(ok));
      group('Recenti', recents);
      group('Nelle tue cartelle', folders);
      if (!list.childElementCount) list.append(h('p', { class: 'hint' }, q ? 'Nessun PDF con questo nome.' : 'Nessun PDF ancora. Aggiungine uno qui sotto.'));
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => e.stopPropagation());
    this.popover(anchor, h('div', { class: 'pop-list quick' }, input, list,
      h('button', { html: `${icon('plus')} Aggiungi PDF ai preferiti`, onclick: async () => {
        for (const f of await host.pickPdf()) if (!settings.pinned.some((p) => p.path === f)) this.togglePin(f, baseName(f));
        render();
      } })));
    render();
    input.focus();
  }

  zoomStep(k) { this.view?.animateScale(this.view.s * k, null); }

  // Le etichette sono invisibili: questo tasto le mostra tutte (o le nasconde di nuovo).
  toggleLabels(on = !this.prefs.showLabels) {
    this.prefs.showLabels = !!on;
    this.savePrefs();
    document.documentElement.classList.toggle('show-labels', this.prefs.showLabels);
    this.labelsBtn?.classList.toggle('on', this.prefs.showLabels);
    const n = this.view ? this.view.annots.filter((a) => a.type === 'label').length : 0;
    toast(this.prefs.showLabels
      ? (n ? `Note invisibili mostrate (${n} in questo documento).` : 'In questo documento non ci sono note invisibili.')
      : 'Note invisibili nascoste: compaiono quando la penna o il mouse ci passa sopra.');
  }

  syncToolbar() {
    const { view } = this;
    this.labelsBtn?.classList.toggle('on', !!this.prefs.showLabels);
    if (!view) return;
    const { tool } = this.tools;
    document.querySelectorAll('#toolbar [data-tool]').forEach((b) => {
      const t = b.dataset.tool;
      b.classList.toggle('on', t === tool || (t === 'shape' && ['rect', 'ellipse', 'line', 'arrow', 'measure', 'area'].includes(tool)));
    });
    view.scroller.dataset.tool = tool;
    this.pageTotal.textContent = `/ ${view.pages.length}`;
    if (document.activeElement !== this.pageInput) this.pageInput.value = view.current + 1;
    this.syncPageArrows(view);
    this.undoBtn.disabled = !view.undoStack.length && !view.pageHistory?.length;
    this.redoBtn.disabled = !view.redoStack.length;
    this.fingerBtn.classList.toggle('on', this.prefs.fingerDraw);
    this.saveBtn.classList.toggle('attention', view.tab.dirty);
    this.onZoom(view);
    this.rail.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    this.rail.querySelectorAll('[data-pen]').forEach((b) => b.classList.toggle('picked', tool === 'pen' && b.dataset.pen === this.prefs.color));
    this.rail.querySelectorAll('[data-hl]').forEach((b) => b.classList.toggle('picked', tool === 'hl' && b.dataset.hl === this.prefs.hlColor));
    // I pulsanti arcobaleno mostrano il colore scelto dalla tavolozza, quando non è uno dei colori della barra.
    const penOwn = !COLORS.includes(this.prefs.color); const hlOwn = !HL_COLORS.includes(this.prefs.hlColor);
    this.penPalBtn.style.setProperty('--own', penOwn ? this.prefs.color : 'transparent');
    this.penPalBtn.classList.toggle('picked', tool === 'pen' && penOwn);
    this.hlPalBtn.style.setProperty('--own', hlOwn ? this.prefs.hlColor : 'transparent');
    this.hlPalBtn.classList.toggle('picked', tool === 'hl' && hlOwn);
    this.rail.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', +b.dataset.size === this.prefs.size));
  }

  popover(anchor, content) {
    $('#floating').textContent = '';
    const r = anchor.getBoundingClientRect();
    const pop = h('div', { class: 'popover', style: `top:${r.bottom + 6}px;left:${Math.max(8, Math.min(r.left, innerWidth - 384))}px` }, content);
    const back = h('div', { class: 'pop-back', onpointerdown: () => { $('#floating').textContent = ''; } });
    $('#floating').append(back, pop);
    return pop;
  }

  closePop() { $('#floating').textContent = ''; }

  // Finestrella accanto alla barra destra (a sinistra del pulsante), dentro lo schermo.
  railPop(anchor, content) {
    this.popover(anchor, content);
    const pop = $('#floating .popover');
    const r = anchor.getBoundingClientRect();
    pop.classList.add('rail-pop');
    pop.style.left = `${Math.max(8, r.left - pop.offsetWidth - 8)}px`;
    pop.style.top = `${Math.max(8, Math.min(r.top - 20, innerHeight - pop.offsetHeight - 8))}px`;
  }

  openPenColors(anchor) {
    const pick = (c) => { this.prefs.color = c; this.prefs.penRecent = remember(this.prefs.penRecent, c); this.savePrefs(); this.closePop(); this.tools.set(['rect', 'ellipse', 'line', 'arrow', 'text', 'pen'].includes(this.tools.tool) ? this.tools.tool : 'pen'); };
    this.railPop(anchor, penPanel({ picked: this.prefs.color, recent: this.prefs.penRecent || [], pick }));
  }

  openHlColors(anchor) {
    const pick = (c) => { this.prefs.hlColor = c; this.prefs.hlRecent = remember(this.prefs.hlRecent, c); this.savePrefs(); this.closePop(); this.tools.set('hl'); };
    this.railPop(anchor, hlPanel({ picked: this.prefs.hlColor, recent: this.prefs.hlRecent || [], pick }));
  }

  // Impostazioni del puntatore virtuale.
  laserPrefs() { return { mode: 'trail', color: '#e0161e', size: 2, fade: 1.2, glow: true, ...(this.prefs.laser || {}) }; }

  openLaserSettings(anchor) {
    const L = this.laserPrefs();
    const set = (k, v) => { this.prefs.laser = { ...this.laserPrefs(), [k]: v }; this.savePrefs(); this.openLaserSettings(anchor); };
    const seg = (k, opts) => h('div', { class: 'seg', role: 'group' }, ...opts.map(([v, label]) => h('button', { class: L[k] === v ? 'on' : '', 'data-k': k, 'data-v': String(v), onclick: () => set(k, v) }, label)));
    const glow = h('input', { type: 'checkbox', class: 'laser-glow' });
    glow.checked = !!L.glow;
    glow.addEventListener('change', () => set('glow', glow.checked));
    this.railPop(anchor, h('div', { class: 'color-panel laser-panel', role: 'dialog', 'aria-label': 'Impostazioni del puntatore' },
      h('div', { class: 'color-title' }, 'Puntatore virtuale'),
      h('div', { class: 'color-sub' }, 'Tipo'), seg('mode', [['trail', 'Scia (disegna e svanisce)'], ['point', 'Punto']]),
      h('div', { class: 'color-sub' }, 'Colore'),
      h('div', { class: 'swatches' }, ...LASER_COLORS.map((c) => h('button', { class: `swatch${c === L.color ? ' picked' : ''}`, style: `background:${c}`, 'aria-label': `Colore ${c}`, 'data-color': c, onclick: () => set('color', c) }))),
      h('div', { class: 'color-sub' }, 'Grandezza'), seg('size', [[1, 'Piccolo'], [2, 'Medio'], [3, 'Grande']]),
      h('div', { class: 'color-sub' }, 'Durata della scia'), seg('fade', [[0.6, 'Breve'], [1.2, 'Media'], [2.5, 'Lunga']]),
      h('label', { class: 'check' }, glow, ' Bagliore leggero')));
  }

  openShapes(anchor) {
    const pick = (t) => () => { this.tools.set(t); this.shapeBtn.innerHTML = icon(t); this.closePop(); };
    this.popover(anchor, h('div', { class: 'pop-row' },
      [['rect', 'Rettangolo'], ['ellipse', 'Ellisse'], ['line', 'Linea'], ['arrow', 'Freccia'], ['measure', 'Misura una distanza'], ['area', "Misura un’area (tocca i vertici, poi Invio o doppio tocco)"]].map(([t, l]) => iconBtn(t, l, pick(t)))));
  }

  openStampMenu() {
    const render = () => h('div', { class: 'pop-list' },
      this.settings.stamps.map((s, i) => h('div', { class: 'pop-line' },
        h('button', { class: 'stamp-pick', style: `color:${s.color};border-color:${s.color}`, onclick: () => { this.tools.stamp = s; this.closePop(); toast('Tocca la pagina dove mettere il timbro.'); } }, s.label),
        iconBtn('close', `Elimina ${s.label}`, () => { this.settings.stamps.splice(i, 1); host.settingsSet({ stamps: this.settings.stamps }); this.openStampMenu(); }))),
      h('button', { html: `${icon('plus')} Nuovo timbro`, onclick: async () => {
        this.closePop();
        const label = await promptText('Nuovo timbro', 'Testo del timbro:');
        if (!label?.trim()) return;
        const s = { label: label.trim().toUpperCase(), color: this.prefs.color };
        this.settings.stamps.push(s);
        host.settingsSet({ stamps: this.settings.stamps });
        this.tools.stamp = s;
      } }));
    this.popover(this.stampBtn, render());
  }

  openSignMenu() {
    this.popover(this.signBtn, h('div', { class: 'pop-list' },
      h('p', { class: 'hint' }, 'Firma visiva: è un’immagine sul documento, non una firma digitale con valore legale.'),
      this.settings.signatures.map((s, i) => h('div', { class: 'pop-line' },
        h('button', { class: 'sig-pick', onclick: () => { this.tools.signature = s; this.closePop(); toast('Tocca la pagina dove mettere la firma.'); } }, s.png ? h('img', { src: s.png, alt: 'Firma salvata' }) : h('span', { html: sigPreview(s) })),
        iconBtn('close', 'Elimina firma', () => { this.settings.signatures.splice(i, 1); host.settingsSet({ signatures: this.settings.signatures }); this.openSignMenu(); }))),
      h('button', { html: `${icon('plus')} Nuova firma`, onclick: () => { this.closePop(); this.newSignature(); } })));
  }

  newSignature() {
    modal((box, done) => {
      const pad = h('canvas', { class: 'sig-pad', width: 640, height: 240, 'aria-label': 'Area per la firma' });
      const c = pad.getContext('2d');
      c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#14213d';
      const strokes = [];
      let cur = null;
      const at = (e) => { const r = pad.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * 640, ((e.clientY - r.top) / r.height) * 240, e.pointerType === 'pen' ? e.pressure : 0.5]; };
      pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); cur = [at(e)]; strokes.push(cur); });
      pad.addEventListener('pointermove', (e) => {
        if (!cur) return;
        const p = at(e); const l = cur[cur.length - 1];
        cur.push(p);
        c.lineWidth = 1.5 + p[2] * 4; c.beginPath(); c.moveTo(l[0], l[1]); c.lineTo(p[0], p[1]); c.stroke();
      });
      pad.addEventListener('pointerup', () => { cur = null; });
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
      file.addEventListener('change', async () => {
        const f = file.files[0];
        if (!f) return;
        const img = await createImageBitmap(f);
        const cv = document.createElement('canvas');
        const k = Math.min(1, 800 / img.width);
        cv.width = img.width * k; cv.height = img.height * k;
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        done({ id: uid(), png: cv.toDataURL('image/png'), ratio: cv.width / cv.height });
      });
      box.append(h('h2', {}, 'Nuova firma'), h('p', { class: 'hint' }, 'Firma con la penna qui sotto, oppure carica un’immagine.'), pad, file,
        h('div', { class: 'modal-actions' },
          h('button', { onclick: () => { strokes.length = 0; c.clearRect(0, 0, 640, 240); } }, 'Cancella'),
          h('button', { onclick: () => file.click() }, 'Carica immagine'),
          h('button', { onclick: () => done(undefined) }, 'Annulla'),
          h('button', { class: 'primary', onclick: () => done(normalizeSig(strokes)) }, 'Salva firma')));
    }).then((sig) => {
      if (!sig) return;
      this.settings.signatures.push(sig);
      host.settingsSet({ signatures: this.settings.signatures });
      this.tools.signature = sig;
      toast('Firma salvata. Tocca la pagina per posizionarla.');
    });
  }

  openMore(anchor) {
    const v = this.view;
    const item = (label, fn) => h('button', { onclick: () => { this.closePop(); fn(); } }, label);
    this.popover(anchor, h('div', { class: 'pop-list' },
      item('Salva con nome…', () => this.save(v, { as: true })),
      item('Salva versione definitiva (annotazioni fissate)…', () => this.save(v, { flatten: true })),
      item('Condividi… (WhatsApp, posta)', () => shareDoc(this, v)),
      item('Mostra nella cartella', () => host.reveal(v.tab.path)),
      item('Segnalibro su questa pagina', () => { this.toggleBookmark(v, v.current); toast('Segnalibro aggiornato.'); }),
      item('Riconosci il testo delle pagine scansionate (OCR)', () => this.ocr.run(v)),
      v.ocr ? item('Cancella il testo riconosciuto', () => this.ocr.clear(v)) : null,
      docTrusted(this, v)
        ? item('Link di questo documento: chiedi di nuovo prima di aprirli', () => { setDocTrusted(this, v, false); toast('Per questo documento Postilla chiederà di nuovo conferma prima di aprire i link.'); })
        : item('Considera affidabili tutti i link di questo documento', () => { setDocTrusted(this, v, true); toast('I link web e di posta di questo documento si apriranno senza chiedere.'); }),
      item('Link affidabili…', () => manageTrust(this)),
      isThirdParty(this, v)
        ? item('Non è un documento di terzi', () => setThirdParty(this, v, false))
        : item('Segna come documento di terzi', () => { setThirdParty(this, v, true); toast('Segnato come documento di terzi: le modifiche avranno un avviso.'); }),
      item('Registro delle modifiche…', () => showLog(this, v)),
      item('Titoli dei documenti di terzi…', () => editTitles(this)),
      item('Stampa…', () => printDoc(this, v)),
      item('Informazioni su Postilla', () => this.openAbout())));
  }

  async openAbout() {
    const version = await host.appVersion();
    modal((box, done) => {
      const lic = h('pre', { class: 'licenses', hidden: true, tabindex: '0' });
      box.append(
        h('h2', { class: 'about-name' }, 'Postilla'),
        h('p', {}, `Versione ${version}`),
        h('p', { class: 'about-copy' }, '© 2026 Domenico Del Sorbo. Tutti i diritti riservati.'),
        h('p', { class: 'hint' }, 'Usa componenti di terzi che restano dei rispettivi autori: Electron, PDF.js, pdf-lib con fontkit, perfect-freehand, Tesseract.js con i modelli tessdata_fast, whisper.cpp con il modello Whisper «base», node-forge, fflate e mammoth.'),
        lic,
        h('div', { class: 'modal-actions' },
          h('button', { onclick: async () => { if (!lic.textContent) lic.textContent = await (await fetch('licenze-terzi.txt')).text(); lic.hidden = !lic.hidden; } }, 'Licenze dei componenti'),
          h('button', { class: 'primary', onclick: () => done() }, 'Chiudi')));
    });
  }

  // --- Tastiera e trascinamento ----------------------------------------------------
  bindGlobal() {
    window.addEventListener('keydown', (e) => {
      const editing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
      const v = this.view;
      const k = e.key.toLowerCase();
      if (e.ctrlKey) {
        const map = {
          o: () => (e.shiftKey ? this.openByVoice() : this.pickAndOpen()),
          p: () => v && printDoc(this, v),
          s: () => v && this.save(v, { as: e.shiftKey }),
          w: () => this.active && this.closeTab(this.active),
          f: () => { if (e.shiftKey || !v) openLibrary(this); else { this.prefs.panel = true; this.panel.show(true); this.panel.setMode('search'); } },
          k: () => (this.prefs.theresa ? this.claudia.toggle() : this.openAi()),
          '+': () => this.zoomStep(1.25), '=': () => this.zoomStep(1.25), '-': () => this.zoomStep(0.8),
          0: () => v?.setFit('width'),
          tab: () => { if (this.tabs.length) this.activate(this.tabs[(this.tabs.indexOf(this.active) + 1) % this.tabs.length]); },
        };
        if (!editing) { map.z = () => v && (e.shiftKey ? this.tools.redo(v) : this.tools.undo(v)); map.y = () => v && this.tools.redo(v); }
        // Copia e incolla: solo se c'è qualcosa di Postilla da copiare; altrimenti resta il copia normale (pannelli, licenze…).
        if (!editing && v && (this.tools.textSel || this.tools.selected) && !e.shiftKey) map.c = () => this.tools.copy();
        if (!editing && v && !e.shiftKey && !document.querySelector('.modal')) map.v = () => this.tools.paste(v);
        if (map[k]) { e.preventDefault(); map[k](); }
        return;
      }
      if (e.key === 'Escape' && this.reading) { this.setReading(false); return; }
      if (editing || !v) return;
      if (this.tools.tool === 'area' && e.key === 'Enter') { this.tools.areaFinish(v); return; }
      if (this.tools.tool === 'area' && e.key === 'Escape' && this.tools.areaCancel(v)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') this.tools.deleteSelected();
      else if (e.key === 'Escape') { this.tools.deselect(); this.tools.clearTextSel(); this.tools.set('hand'); } else if (e.key === 'PageDown') { e.preventDefault(); v.scroller.scrollTop += v.scroller.clientHeight * 0.9; } else if (e.key === 'PageUp') { e.preventDefault(); v.scroller.scrollTop -= v.scroller.clientHeight * 0.9; } else if (e.key === 'Home') v.goto(0);
      else if (e.key === 'ArrowLeft' && !e.altKey) { e.preventDefault(); this.pageStep(-1); } else if (e.key === 'ArrowRight' && !e.altKey) { e.preventDefault(); this.pageStep(1); }
      else if (e.key === 'End') v.goto(v.pages.length - 1);
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name)).forEach((f) => this.open(host.pathForFile(f)));
    });
  }
}

function normalizeSig(strokes) {
  const pts = strokes.flat();
  if (!pts.length) return undefined;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs); const y0 = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - x0); const hg = Math.max(1, Math.max(...ys) - y0);
  return {
    id: uid(), ratio: w / hg,
    strokes: strokes.filter((s) => s.length).map((s) => s.map(([x, y, p]) => [+((x - x0) / w).toFixed(4), +((y - y0) / hg).toFixed(4), +p.toFixed(3)])),
  };
}

function sigPreview(s) {
  const d = s.strokes.map((st) => `M${st.map(([x, y]) => `${(x * 150 * Math.min(1, s.ratio / 3)).toFixed(1)} ${(y * 44).toFixed(1)}`).join('L')}`).join('');
  return `<svg width="160" height="48" viewBox="-2 -2 156 48"><path d="${d}" fill="none" stroke="#14213d" stroke-width="1.6"/></svg>`;
}

new App().start();
