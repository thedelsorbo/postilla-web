// Claudia · segreteria documentale di Postilla (funzione locale).
// Dal comando scritto alla risposta: sceglie il documento nella raccolta autorizzata, chiede quando è
// ambiguo, apre il PDF alla pagina giusta, evidenzia il passaggio senza modificare il file, restituisce
// citazione, contesto e riferimenti, e legge solo la citazione. Con il bot «Claudia» di Grok Bot comunica
// solo tramite la cartella condivisa (grok-link.js), se il collegamento è acceso.
import { baseName, h, icon, iconBtn, modal, toast, uid } from '../core.js';
import { quadDisp } from '../annots.js';
import { parseCommand } from './parse.js';
import { HeadlessDoc, card, describe, rank, refreshCatalog } from './catalog.js';
import { findPhrase, locate } from './find.js';
import { runAction } from './actions.js';
import { Speaker } from './speech.js';
import { Voice } from './voice.js';
import { cancelPreview, confirmEdit, runEdit, targetView } from './editflow.js';
import { WakeListener } from './wake.js';

const LANG_NAME = { it: 'italiano', en: 'inglese' };
const VERB_DONE = { hl: 'evidenziato', ul: 'sottolineato', so: 'barrato' };
const REASONS = {
  'articolo-assente': (r) => `Non ho trovato l'articolo ${r.article.num} in questo documento.${r.articles?.length ? ` Contiene gli articoli ${r.articles.slice(0, 15).join(', ')}.` : ''}`,
  'parole-assenti-articolo': (r) => `Ho trovato l'articolo ${r.article.num} («${r.article.title}»), ma non contiene «${r.keywords}».`,
  'parole-assenti': (r) => `Non ho trovato «${r.keywords}» in questo documento.`,
  scansione: () => 'Il documento è una scansione senza testo riconosciuto: usa «Riconosci il testo» dal menu con i tre puntini e riprova.',
};

export class ClaudiaPanel {
  constructor(app) {
    this.app = app;
    this.token = 0;
    this.pending = null;
    this.current = null; // ultima risposta: vista, evidenziazione, posizione precedente
    this.speaker = new Speaker(() => this.syncSpeech());
    this.el = null;
    // Ctrl+Spazio tenuti premuti = pulsante per parlare; Esc ferma subito la lettura.
    window.addEventListener('keydown', (e) => {
      if (!this.visible()) return; // Theresa nascosta: nessuna scorciatoia
      // Ctrl+Maiusc+Spazio: accende o spegne l'ascolto della chiamata «Theresa».
      if (e.ctrlKey && e.shiftKey && e.code === 'Space' && !e.repeat) { e.preventDefault(); this.setWake(!this.settings.wake); return; }
      if (e.ctrlKey && e.code === 'Space' && !e.repeat) { e.preventDefault(); if (!this.el?.isConnected) this.toggle(true); if (this.voice?.state === 'idle' && !this.micBtn.hidden) this.listen(); }
      if (e.key === 'Escape' && this.speaker.state !== 'idle') { this.speaker.stop(); this.token += 1; }
    }, true);
    window.addEventListener('keyup', (e) => {
      if ((e.code === 'Space' || e.key === 'Control') && this.voice?.state === 'listening') { e.preventDefault(); this.hear(); }
    }, true);
    // Chiamata a voce «Theresa» (spenta per impostazione).
    this.wake = new WakeListener({
      onCommand: (text) => this.wakeCommand(text),
      onState: (st, info) => this.syncWake(st, info),
      isBusy: () => this.speaker.state === 'speaking' || (this.voice && this.voice.state !== 'idle') || !!this.pendingVoiceCheck,
    });
    setTimeout(() => { if (this.visible() && this.settings.wake) this.setWake(true, { quiet: true }); }, 1200);
  }

  // Theresa è visibile solo se attivata nel menu Impostazioni (per impostazione è nascosta).
  visible() { return !!this.app.settings?.prefs?.theresa; }

  // Nasconde o mostra Theresa: nascosta chiude il pannello e il microfono, senza cambiare le sue impostazioni.
  setHidden(hidden) {
    if (hidden) {
      if (this.el?.isConnected) this.toggle(false);
      this.speaker.stop();
      this.wake.enable(false);
      document.body.classList.remove('wake-on', 'wake-attentive', 'wake-paused');
    } else if (this.settings.wake) this.setWake(true, { quiet: true });
  }

  // Accende o spegne l'ascolto della chiamata «Theresa».
  async setWake(on, { quiet = false } = {}) {
    if (on && !(await (window.PostillaNative?.voiceAvailable ? window.PostillaNative.voiceAvailable() : host.voiceAvailable?.()))) {
      if (!quiet) toast('La voce non è disponibile su questo dispositivo.', 'warn');
      on = false;
    }
    this.settings.wake = !!on;
    this.save();
    if (this.wakeSwitch) this.wakeSwitch.checked = !!on;
    await this.wake.enable(!!on);
    if (!quiet && this.el) this.say(on ? 'Chiamata a voce accesa: di\' «Theresa» seguito dal comando. Ascolto solo con Postilla in primo piano e mai mentre leggo ad alta voce.' : 'Chiamata a voce spenta: il microfono è chiuso.');
  }

  syncWake(st, info) {
    if (st === 'error') { toast(`Non riesco ad accendere il microfono (${info}).`, 'error'); }
    if (st === 'called') { this.chime(880, 0.12); if (!this.el?.isConnected) this.toggle(true); this.say('Dimmi pure: ti ascolto.'); }
    const s = this.wake.state;
    document.body.classList.toggle('wake-on', s === 'listening' || s === 'checking');
    document.body.classList.toggle('wake-attentive', s === 'attentive');
    document.body.classList.toggle('wake-paused', s === 'paused');
    if (this.wakeLabel) this.wakeLabel.textContent = { off: '', listening: 'In ascolto della chiamata «Theresa»', checking: 'Ho sentito parlare…', attentive: 'Ti ascolto: di\' il comando', paused: 'In pausa: Postilla non è in primo piano' }[s] || '';
  }

  async wakeCommand(text) {
    this.chime(660, 0.08);
    if (!this.el?.isConnected) this.toggle(true);
    return this.run(text, { voice: true });
  }

  // Segnale breve (nessun file audio): conferma che Theresa ha sentito la chiamata.
  chime(freq, dur) {
    try {
      const c = new AudioContext();
      const o = c.createOscillator(); const g = c.createGain();
      o.frequency.value = freq; g.gain.value = 0.06;
      o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + dur);
      o.onended = () => c.close();
    } catch { /* senza audio si va avanti */ }
  }

  get settings() {
    const s = this.app.settings;
    if (!s.claudia) s.claudia = { folders: [], docs: {}, notes: [] };
    s.claudia.docs ||= {}; s.claudia.notes ||= []; s.claudia.folders ||= [];
    return s.claudia;
  }

  save() { host.settingsSet({ claudia: this.settings }); }

  // --- Interfaccia ----------------------------------------------------------------------------
  toggle(force) {
    const show = force ?? !this.el?.isConnected;
    if (!show) { this.el?.remove(); document.body.classList.remove('claudia-open'); return; }
    if (!this.el) this.build();
    document.body.append(this.el);
    document.body.classList.add('claudia-open');
    setTimeout(() => this.input.focus(), 30);
  }

  build() {
    this.input = h('input', { type: 'text', class: 'claudia-input', placeholder: 'Scrivi un comando, per esempio: apri il regolamento pagamenti e cerca l\'articolo 3', 'aria-label': 'Comando per Claudia', autocomplete: 'off' });
    this.input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && this.input.value.trim()) this.submit(); });
    this.log = h('div', { class: 'claudia-log', 'aria-live': 'polite' });
    this.speechBar = h('div', { class: 'claudia-speech', hidden: true },
      h('span', { class: 'claudia-speech-label' }, 'Lettura'),
      h('button', { 'data-act': 'pausa', onclick: () => this.run('pausa') }, 'Pausa'),
      h('button', { 'data-act': 'riprendi', onclick: () => this.run('riprendi') }, 'Riprendi'),
      h('button', { 'data-act': 'stop', class: 'danger', onclick: () => this.run('fermati') }, 'Ferma'));
    this.el = h('aside', { id: 'claudia', 'aria-label': 'Theresa, segreteria documentale' },
      h('header', {},
        h('div', {}, h('b', {}, 'Theresa'), h('span', { class: 'claudia-sub' }, 'segreteria documentale · sul dispositivo')),
        iconBtn('folder', 'Raccolta dei documenti di Theresa', () => this.openCollection()),
        iconBtn('close', 'Chiudi Theresa', () => this.toggle(false))),
      h('p', { class: 'claudia-note' }, 'Funzione locale di Postilla: legge solo i documenti della raccolta che autorizzi. Risponde al bot «Claudia» di Grok Bot solo se accendi il collegamento nella raccolta, e solo per i documenti segnati «condivisibili».'),
      this.log, this.speechBar, this.micBar(), this.wakeBar(),
      h('div', { class: 'claudia-form' }, this.micBtn, this.input, h('button', { class: 'primary', onclick: () => this.submit() }, 'Invia')));
    if (!this.settings.folders.length && !(this.settings.files || []).length) this.quiet(() => this.say(h('p', {}, 'Per cominciare indica le cartelle o i singoli file che posso consultare e modificare: ', h('button', { class: 'link', onclick: () => this.openCollection() }, 'apri la raccolta'), '.')));
  }

  wakeBar() {
    this.wakeSwitch = h('input', { type: 'checkbox', class: 'wake-switch' });
    this.wakeSwitch.checked = !!this.settings.wake;
    this.wakeSwitch.addEventListener('change', () => this.setWake(this.wakeSwitch.checked));
    this.wakeLabel = h('span', { class: 'wake-label' });
    this.replySwitch = h('input', { type: 'checkbox', class: 'reply-switch' });
    this.replySwitch.checked = this.settings.speakReplies !== false;
    this.replySwitch.addEventListener('change', () => { this.settings.speakReplies = this.replySwitch.checked; this.save(); if (!this.replySwitch.checked) this.speaker.stop(); });
    const bar = h('div', { class: 'wake-bar' }, h('label', { class: 'check' }, this.wakeSwitch, ' Ascolta quando dico «Theresa»'),
      h('label', { class: 'check' }, this.replySwitch, ' Rispondimi a voce'), this.wakeLabel);
    setTimeout(() => this.syncWake(this.wake.state), 0);
    return bar;
  }

  // --- Voce: pulsante da tenere premuto ----------------------------------------------------------
  micBar() {
    this.level = h('i', {});
    this.micState = h('div', { class: 'claudia-mic', hidden: true, role: 'status', 'aria-live': 'assertive' },
      h('span', { class: 'claudia-mic-dot' }), h('span', { class: 'claudia-mic-label' }, 'Ti ascolto…'), h('span', { class: 'claudia-mic-level' }, this.level));
    this.voice = new Voice({
      onLevel: (v) => { this.level.style.width = `${Math.round(v * 100)}%`; },
      onState: (s) => {
        this.micState.hidden = s === 'idle';
        this.micState.dataset.state = s;
        this.micState.querySelector('.claudia-mic-label').textContent = s === 'listening' ? 'Microfono acceso: ti ascolto… (rilascia per inviare)' : 'Trascrivo sul dispositivo…';
        this.micBtn.classList.toggle('on', s === 'listening');
        document.body.classList.toggle('mic-on', s === 'listening');
      },
    });
    this.micBtn = h('button', { class: 'ib claudia-micbtn', title: 'Tieni premuto per parlare (oppure Ctrl+Spazio)', 'aria-label': 'Tieni premuto per parlare', html: icon('mic') });
    const down = (e) => { e.preventDefault(); this.micBtn.setPointerCapture?.(e.pointerId); this.listen(); };
    const up = (e) => { e.preventDefault(); this.hear(); };
    this.micBtn.addEventListener('pointerdown', down);
    this.micBtn.addEventListener('pointerup', up);
    this.micBtn.addEventListener('pointercancel', () => this.voice.cancel());
    this.micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    this.voice.available().then((ok) => {
      this.micBtn.hidden = !ok;
      this.voiceInfo = ok ? `Voce: ${this.voice.engine()}.` : 'Voce non disponibile su questo dispositivo: usa i comandi scritti.';
      this.el?.querySelector('.claudia-note')?.append(` ${this.voiceInfo}`);
    });
    return this.micState;
  }

  // Si preme: la lettura in corso si ferma subito e il microfono si accende.
  async listen() {
    this.speaker.stop();
    this.token += 1;
    try { await this.voice.start(); } catch (e) {
      this.say(`Non riesco ad accendere il microfono (${e.message || e}). Controlla le impostazioni sulla privacy del microfono, oppure scrivi il comando.`);
    }
  }

  // Si rilascia: il microfono si spegne, l'audio viene trascritto e scartato, il comando eseguito.
  async hear() {
    const r = await this.voice.stop();
    if (!r) return null;
    if (r.discarded === 'silenzio') { this.say('Non ho sentito nessun comando. Tieni premuto il pulsante mentre parli.'); return r; }
    if (r.discarded) { this.say(`Non ho capito${r.text ? ` («${r.text}»)` : ''}. Riprova oppure scrivi il comando.`); return r; }
    if (!r.confident) {
      // Trascrizione incerta: si chiede conferma; il testo resta modificabile nella casella.
      this.input.value = r.text;
      const box = this.say(h('p', {}, 'Ho capito: ', h('b', {}, `«${r.text}»`), '. È giusto?'),
        r.weak.length ? h('p', { class: 'hint' }, `Parole incerte: ${r.weak.join(', ')}.`) : null,
        h('div', { class: 'claudia-actions' },
          h('button', { class: 'primary', 'data-act': 'conferma-voce', onclick: () => { box.querySelector('.claudia-actions').remove(); this.input.value = ''; this.run(r.text, { voice: true }); } }, 'Sì, esegui'),
          h('button', { onclick: () => { box.querySelector('.claudia-actions').replaceWith(h('p', { class: 'hint' }, 'Correggi il testo nella casella e premi Invia, oppure riprova a voce.')); this.input.focus(); } }, 'No')));
      return { ...r, asked: true };
    }
    return { ...r, result: await this.run(r.text, { voice: true }) };
  }

  submit() {
    const t = this.input.value.trim();
    this.input.value = '';
    this.run(t);
  }

  you(text, voice = false, source = null) {
    const grok = source === 'grok';
    this.log.append(h('div', { class: `claudia-you${voice ? ' voice' : ''}${grok ? ' grok' : ''}`, title: voice ? 'Comando a voce (trascrizione)' : (grok ? 'Comando dal bot Claudia di Grok Bot' : null) },
      voice ? h('span', { html: icon('mic') }) : null, grok ? h('b', {}, 'Grok Bot: ') : null, text));
    this.scroll();
  }

  // I comandi del bot di Grok valgono solo per i documenti delle cartelle condivise con Theresa
  // (o solo per quelli segnati «condivisibili», se così è impostato il collegamento).
  allowed(file) {
    if (this.source !== 'grok') return true;
    return this.app.grok?.allows(file) ?? false;
  }

  say(...content) {
    const el = h('div', { class: 'claudia-says' }, ...content);
    this.log.append(el);
    this.scroll();
    this.reply(el);
    return el;
  }

  quiet(fn) { this.muted = true; try { return fn(); } finally { this.muted = false; } }

  // Risposta a voce: le frasi di Theresa si dicono anche ad alta voce (si può spegnere nel pannello).
  // Si raccolgono le risposte dello stesso comando e si dicono insieme; se nel frattempo è partita la
  // lettura di una citazione, la risposta parlata non la interrompe. Per le schede con la citazione si dice
  // solo il riassunto (data-say). Le risposte al bot di Grok non si dicono: il bot le riceve per iscritto.
  reply(el) {
    if (this.settings.speakReplies === false || this.source === 'grok' || this.muted) return;
    (this.replyQueue ||= []).push(el);
    if (this.replyTimer) return;
    this.replyTimer = setTimeout(() => {
      const els = this.replyQueue; this.replyQueue = []; this.replyTimer = null;
      if (this.speaker.state !== 'idle') return;
      const text = els.map((x) => {
        if (x.dataset.say != null) return x.dataset.say;
        const c = x.cloneNode(true);
        c.querySelectorAll('button, .hint, .claudia-actions, blockquote, .claudia-ctx, .claudia-refs, h4, .ocr-tag').forEach((n) => n.remove());
        return c.textContent;
      }).join(' ').replace(/[«»"]/g, '').replace(/\s+/g, ' ').trim();
      if (text) this.speaker.speak(text, 'it');
    }, 0);
  }

  scroll() { this.log.scrollTop = this.log.scrollHeight; }

  syncSpeech() {
    if (!this.speechBar) return;
    const st = this.speaker.state;
    this.speechBar.hidden = st === 'idle';
    this.speechBar.querySelector('[data-act=pausa]').hidden = st !== 'speaking';
    this.speechBar.querySelector('[data-act=riprendi]').hidden = st !== 'paused';
    this.speechBar.querySelector('.claudia-speech-label').textContent = st === 'paused' ? 'Lettura in pausa' : 'Lettura in corso';
  }

  // --- Comandi ----------------------------------------------------------------------------------
  async run(text, { voice = false, source } = {}) {
    if (!this.el) this.build();
    const cmd = parseCommand(text);
    const src = source || (voice ? 'voce' : 'scritto');
    this.source = src;
    if (src === 'grok') cmd.read = false; // la lettura ad alta voce avverrebbe sul PC, non serve al bot
    this.you(text, voice, src);
    // Conferma di un'azione delicata (per esempio «elimina questa pagina»).
    if (this.pendingAction && (cmd.control === 'si' || cmd.control === 'no')) {
      const pa = this.pendingAction; this.pendingAction = null;
      if (cmd.control === 'no') { this.say('Va bene, lascio tutto com\'è.'); return { cancelled: true }; }
      return pa.run();
    }
    this.pendingAction = null;
    // «tutte»: risposta alla domanda «quale occorrenza?» di sottolinea/evidenzia/barra.
    if (this.pending?.all && /^\s*(?:(?:ehi\s+)?t[eh]+resa[\s,]*)?(?:tutte|tutti|ovunque|dappertutto)\b/i.test(text)) {
      const p = this.pending; this.pending = null; return p.all();
    }
    if (cmd.action) { this.pending = null; this.speaker.stop(); return runAction(this, cmd.action); }
    if (cmd.annot?.pronoun) { this.pending = null; return this.annotateCurrent(cmd.annot); }
    // Da Grok, senza il permesso di modificare, «evidenzia…» resta una ricerca con evidenziazione provvisoria.
    if (cmd.annot && src === 'grok' && !this.app.settings.grok?.canEdit) cmd.annot = null;
    if (cmd.annot?.phrase) { this.pending = null; this.speaker.stop(); return this.annotatePhrase(cmd.annot); }
    if (cmd.control === 'si' || cmd.control === 'conferma-forte' || cmd.control === 'no') {
      if (this.pendingEdit || cmd.control !== 'no' || !this.pending) return this.confirmEdit(cmd.control);
      this.pending = null; this.say('Va bene.'); return { cancelled: true };
    }
    if (cmd.control) return this.control(cmd.control);
    if (cmd.choice == null) this.cancelPreview(); // un comando nuovo toglie l'anteprima della modifica non confermata
    if (cmd.edit) { this.pending = null; this.speaker.stop(); this.app.tools.placeHook = null; return runEdit(this, cmd.edit, { voice, source: src }); }
    // Un PDF indicato con il percorso completo («apri il file P:\…\documento.pdf»): si apre direttamente.
    const pathHit = String(text).match(/(?:^|\s|«|")((?:[a-z]:[\\/]|\\\\)[^"«»]+?\.pdf)(?=$|[\s"»,;.!?])/i);
    if (pathHit) {
      const file = pathHit[1].trim();
      if (!this.allowed(file)) { this.say('Questo file è fuori dalle cartelle condivise con Theresa.'); return { error: 'fuori-raccolta' }; }
      if (!(await host.exists(file))) { this.say(`Non trovo il file «${file}».`); return { error: 'file' }; }
      const entry = { path: file, title: baseName(file), lang: null };
      const tok = (this.token += 1);
      if (!cmd.article && !cmd.keywords) return this.proceed({ entry, result: null }, cmd, tok);
      return this.searchIn([{ entry }], cmd, tok, () => tok !== this.token);
    }
    const token = (this.token += 1); // un comando nuovo rende superati quelli ancora in corso
    const stale = () => token !== this.token;
    this.speaker.stop();
    if (cmd.choice == null) this.clearMark(); // l'evidenziazione della risposta precedente non deve confondere

    if (cmd.choice != null) {
      if (!this.pending) { this.say('Non c\'è nessuna scelta in sospeso.'); return null; }
      const p = this.pending;
      const k = cmd.choice === -1 ? p.options.length - 1 : cmd.choice - 1;
      if (!p.options[k]) { this.say(`Scegli un numero da 1 a ${p.options.length}.`); return null; }
      this.pending = null;
      return p.resolve(p.options[k], token);
    }
    this.pending = null;

    if (cmd.note) return this.askNote(cmd.note);
    if (cmd.reopenLast) return this.reopenLast();
    if (cmd.explain || cmd.translate) {
      if (!cmd.doc && !cmd.article && !cmd.keywords) return this.unavailable(cmd);
    }

    // Documento richiesto, oppure quello già aperto se l'utente chiede solo articolo o parole.
    if (!cmd.doc && !cmd.article && !cmd.keywords) {
      this.say(h('p', {}, 'Non ho capito. Puoi dire per esempio: «apri il file UCP 600», «evidenzia l\'articolo 14», «sottolinea la frase banca emittente», «vai a pagina 3», «ingrandisci», «stampa», «modifica la data di emissione in 1° novembre», «annulla», «non ascoltare».'));
      return null;
    }
    if (!cmd.doc) {
      const v = this.app.view && this.allowed(this.app.view.tab.path) ? this.app.view : null;
      if (!v) { this.say('In quale documento devo cercare? Indicalo nel comando, per esempio «apri il regolamento pagamenti e cerca l\'articolo 3».'); return null; }
      return this.searchIn([{ entry: { path: v.tab.path, title: v.tab.name, lang: null }, view: v }], cmd, token, stale);
    }
    let ranked = rank(this.app, cmd.doc).filter((x) => this.allowed(x.entry.path));
    // Non trovato: se l'indice dei file del dispositivo non è recente lo si aggiorna e si riprova una volta.
    const idx = this.app.fileIndex;
    if (!ranked.length && idx && this.source !== 'grok' && Date.now() - idx.at > 60e3) {
      const wait = this.quiet(() => this.say(h('span', { class: 'claudia-busy' }, 'Cerco il file sul dispositivo…')));
      await idx.refresh();
      wait.remove();
      if (token !== this.token) return null;
      ranked = rank(this.app, cmd.doc).filter((x) => this.allowed(x.entry.path));
    }
    if (!ranked.length) {
      this.say(this.source === 'grok' ? `Nella raccolta non trovo un documento che corrisponda a «${cmd.doc}».`
        : h('p', {}, `Non trovo un PDF che corrisponda a «${cmd.doc}», né nella raccolta né nelle cartelle del dispositivo. Prova con un'altra parola del nome del file, oppure `, h('button', { class: 'link', onclick: () => this.openCollection() }, 'aggiungi la cartella o il file'), '.'));
      return null;
    }
    const top = ranked[0].score;
    const all = ranked.filter((r) => r.score >= top * 0.75);
    const plausible = all.slice(0, 8);
    if (!cmd.article && !cmd.keywords) {
      const q = all.length > 8 ? `Ho trovato ${all.length} file che corrispondono; questi sono i più probabili. Quale apro? Se non c'è, aggiungi una parola del nome o della cartella.` : 'Ho trovato più documenti che corrispondono. Quale apro?';
      if (plausible.length > 1) return this.choose(plausible.map((r) => ({ entry: r.entry })), cmd, q, token);
      return this.proceed({ entry: plausible[0].entry, result: null }, cmd, token);
    }
    return this.searchIn(plausible.map((r) => ({ entry: r.entry })), cmd, token, stale);
  }

  // Cerca il passaggio in ogni documento plausibile: se lo contiene uno solo si procede, altrimenti si chiede.
  async searchIn(cands, cmd, token, stale) {
    // Messaggio di attesa: solo scritto (a voce si dice il risultato).
    const busy = this.quiet(() => this.say(h('span', { class: 'claudia-busy' }, cands.length > 1 ? `Controllo ${cands.length} documenti…` : 'Cerco…')));
    const found = [];
    const missed = [];
    for (const c of cands) {
      if (stale()) { busy.remove(); return null; }
      const open = c.view || this.app.tabs.find((t) => t.path.toLowerCase() === c.entry.path.toLowerCase())?.view;
      let doc = open;
      let headless = null;
      try {
        if (!doc) { headless = await HeadlessDoc.open(c.entry.path); doc = headless; } else await doc.ready;
        const r = await locate(doc, cmd, stale);
        (r.found ? found : missed).push({ ...c, result: r });
      } catch (e) {
        missed.push({ ...c, result: { found: false, reason: 'errore', error: String(e.message || e) } });
      } finally { headless?.destroy(); }
    }
    busy.remove();
    if (stale()) return null;
    if (found.length === 1) {
      const others = cands.length > 1 ? missed.map((m) => card(m.entry).title) : [];
      return this.proceed(found[0], cmd, token, others.length ? `Ho scelto questo documento perché è l'unico, fra quelli che corrispondono, in cui ${what(cmd)}. Ho controllato anche: ${others.join('; ')}.` : '');
    }
    if (found.length > 1) return this.choose(found, cmd, `${cap(what(cmd))} in più documenti. Quale intendi?`, token);
    // Nessuno: si spiega il motivo, documento per documento, senza inventare risposte.
    if (missed.length === 1) { this.say(this.titleLine(missed[0].entry), h('p', {}, explain(missed[0].result))); return missed[0].result; }
    this.say(h('p', {}, `Non ho trovato ${what(cmd).replace(/^c'è /, '')} in nessuno dei documenti che corrispondono:`),
      h('ul', {}, missed.map((m) => h('li', {}, h('b', {}, card(m.entry).title), ': ', explain(m.result)))));
    return null;
  }

  choose(options, cmd, question, token) {
    this.pending = { options, resolve: (o, t) => this.proceed(o, cmd, t) };
    this.say(h('p', {}, question),
      h('ol', { class: 'claudia-choices' }, options.map((o, i) => h('li', {},
        h('button', { onclick: () => this.run(String(i + 1)) }, this.describeEntry(o.entry, o.result))))),
      h('p', { class: 'hint' }, 'Tocca una voce oppure scrivi «il primo», «il secondo»…'));
    return { pending: true, count: options.length, token };
  }

  describeEntry(entry, result) {
    const c = card(entry);
    const bits = [c.edition, LANG_NAME[c.lang], c.jurisdiction].filter(Boolean).join(' · ');
    const page = result?.found ? ` — pagina ${result.numbering.index} del PDF` : '';
    // File trovati per nome sul dispositivo: spesso ci sono copie con lo stesso nome, si mostra la cartella.
    const dir = entry.indexed ? entry.path.split(/[\\/]/).slice(0, -1) : null;
    const where = dir ? ` · cartella ${dir.length > 3 ? `…\\${dir.slice(-2).join('\\')}` : dir.join('\\')}` : '';
    return h('span', {}, h('b', {}, c.title), bits ? h('span', { class: 'claudia-meta' }, ` ${bits}`) : null, where ? h('span', { class: 'claudia-meta' }, where) : null, page);
  }

  titleLine(entry) {
    const c = card(entry);
    return h('p', { class: 'claudia-doc' }, h('span', { html: icon('open') }), h('b', {}, c.title), h('span', { class: 'claudia-meta' }, ` ${[c.edition, LANG_NAME[c.lang], c.jurisdiction].filter(Boolean).join(' · ')}`));
  }

  // Apre il documento alla pagina giusta, evidenzia il passaggio e mostra la risposta.
  async proceed(option, cmd, token, why = '') {
    const prev = this.app.active ? { tab: this.app.active, page: this.app.view.current, top: this.app.view.scroller.scrollTop } : null;
    const tab = await this.app.open(option.entry.path);
    if (!tab || token !== this.token) return null;
    await tab.view.ready;
    const view = tab.view;
    this.clearMark();
    const r = option.result;
    if (!r) {
      view.goto(0);
      this.current = { view, prev, result: null };
      this.say(this.titleLine(option.entry), h('p', {}, 'Documento aperto.'));
      return { opened: option.entry.path };
    }
    const full = !cmd.keywords && r.fullHighlight ? r.fullHighlight : null;
    await this.mark(view, r, full);
    this.current = { view, prev, result: r, entry: option.entry, marked: full || r.highlight };
    // «evidenzia / sottolinea / barra l'articolo …»: l'evidenziazione diventa subito un'annotazione vera.
    if (cmd.annot) {
      const items = [...(full || r.highlight).entries()].map(([page, hl]) => ({ page, quads: hl.quads, text: r.quote }));
      this.applyMarks(view, items, cmd.annot);
      const pages = [...new Set(items.map((x) => x.page + 1))];
      const name = r.article?.num ? `l'articolo ${r.article.num}` : 'il passaggio';
      this.say(this.titleLine(option.entry), h('p', {}, `Ho ${VERB_DONE[cmd.annot.type]} ${name} (${pages.length > 1 ? `pagine ${pages[0]}–${pages[pages.length - 1]}` : `pagina ${pages[0]}`} del PDF). Di' «annulla» per toglierlo; al salvataggio Postilla crea una copia.`));
      r.annotated = items.length;
      return r;
    }
    const lang = card(option.entry).lang || 'it';
    const n = r.numbering;
    const pageLine = `pagina ${n.index} di ${n.total} nel PDF · etichetta di pagina: ${n.label ? `«${n.label}»` : 'nessuna'} · numero stampato: ${n.printed ? `«${n.printed}»` : 'non rilevato'}`;
    const head = r.headingNumbering ? ` (il titolo dell'articolo è a pagina ${r.headingNumbering.index} del PDF)` : '';
    const card$ = this.say(
      this.titleLine(option.entry),
      why ? h('p', { class: 'hint' }, why) : null,
      h('h4', {}, 'Citazione', r.ocr ? h('span', { class: `ocr-tag${r.unsure ? ' unsure' : ''}` }, r.unsure ? 'OCR · da verificare' : 'OCR') : null),
      h('blockquote', { class: 'claudia-quote', lang }, r.quote),
      r.ocr ? h('p', { class: 'hint' }, 'Testo riconosciuto automaticamente (OCR): confrontalo con la pagina prima di citarlo.') : null,
      r.truncated && full ? h('p', { class: 'hint' }, `Ho evidenziato tutto l'articolo (${r.fullPages.length > 1 ? `pagine ${r.fullPages[0] + 1}–${r.fullPages[r.fullPages.length - 1] + 1}` : `pagina ${r.fullPages[0] + 1}`} del PDF); la citazione qui sotto riporta titolo e primo comma.`) : (r.truncated ? h('p', { class: 'hint' }, 'L\'articolo è più lungo: ho riportato titolo e primo comma.') : null),
      (r.context.before || r.context.after) ? h('h4', {}, 'Contesto') : null,
      r.context.before ? h('p', { class: 'claudia-ctx' }, `… ${r.context.before}`) : null,
      r.context.after ? h('p', { class: 'claudia-ctx' }, `${r.context.after} …`) : null,
      h('h4', {}, 'Riferimenti'),
      h('ul', { class: 'claudia-refs' },
        r.article ? h('li', {}, r.article.title) : null,
        h('li', {}, `Documento: ${card(option.entry).title} (${baseName(option.entry.path)})`),
        h('li', {}, `${cap(pageLine)}${head}`)),
      h('div', { class: 'claudia-actions' },
        h('button', { onclick: () => this.speaker.speak(r.quote, lang), html: `${icon('speaker')} Leggi la citazione` }),
        h('button', { onclick: () => this.saveHighlight(), html: `${icon('mark')} Salva evidenziazione` }),
        h('button', { onclick: () => { navigator.clipboard?.writeText(r.quote); toast('Citazione copiata.'); }, html: `${icon('copy')} Copia` })));
    card$.dataset.quote = r.quote;
    card$.dataset.say = `Trovato${r.article?.title ? ` ${String(r.article.title).split(/[.:—-]/)[0].trim()}` : ''}, pagina ${n.index} di ${card(option.entry).title}. Di' leggi se vuoi che te lo legga.`;
    if (cmd.explain || cmd.translate) this.unavailable(cmd);
    if (cmd.read) this.speaker.speak(r.quote, lang);
    return r;
  }

  async mark(view, r, override = null) {
    for (const [page, hl] of (override || r.highlight)) {
      await view.getPage(page);
      const p = view.pages[page];
      const layer = this.app.tools.selLayer(p);
      layer.querySelectorAll('.claudia-mark').forEach((n) => n.remove());
      layer.insertAdjacentHTML('beforeend', hl.quads.map((q) => { const { tl, tr, bl, br } = quadDisp(p, q); return `<polygon class="claudia-mark" points="${tl} ${tr} ${br} ${bl}" fill="#5fb3ff" fill-opacity=".38"/>`; }).join('')
        + hl.unsure.map((q) => { const { tl, tr, bl, br } = quadDisp(p, q); return `<polygon class="claudia-mark ocr-unsure" points="${tl} ${tr} ${br} ${bl}" fill="none" stroke="#b3261e" stroke-width="1.5" stroke-dasharray="4 3"/>`; }).join(''));
    }
    const first = (override || r.highlight).get(r.page) || [...(override || r.highlight).values()][0];
    const p = view.pages[r.page];
    const c = first ? quadDisp(p, first.quads[0]).tl : [0, 0];
    view.reveal(r.page, c[0], c[1]);
  }

  clearMark() { document.querySelectorAll('.claudia-mark').forEach((n) => n.remove()); }

  // L'evidenziazione diventa un'annotazione vera solo su richiesta (si salva poi in copia, come sempre).
  saveHighlight() {
    const cur = this.current;
    if (!cur?.result) return;
    const color = this.app.prefs.hlColor;
    const add = [...(cur.marked || cur.result.highlight).entries()].map(([page, hl]) => ({ id: uid(), type: 'hl', page, color, quads: hl.quads, text: cur.result.quote }));
    this.app.tools.apply(cur.view, { add });
    this.clearMark();
    toast('Evidenziazione aggiunta al documento. L\'originale resta intatto: al salvataggio Postilla crea una copia.');
  }

  // Aggiunge evidenziazioni, sottolineature o barrature vere; «annulla» le toglie (come Ctrl+Z).
  applyMarks(view, items, annot) {
    const prefs = this.app.prefs;
    const color = annot.color || (annot.type === 'hl' ? prefs.hlColor : prefs.color);
    const add = items.map((x) => ({ id: uid(), type: annot.type, page: x.page, color, quads: x.quads, text: x.text || '' }));
    this.app.tools.apply(view, { add });
    this.clearMark();
    this.lastEdit = { view };
    const first = items[0];
    if (first) { const p = view.pages[first.page]; const c = p ? quadDisp(p, first.quads[0]).tl : [0, 0]; view.reveal(first.page, c[0], c[1]); }
    return add.length;
  }

  // «evidenzialo», «sottolinealo»: si applica a quello che Theresa ha appena trovato.
  annotateCurrent(annot) {
    const cur = this.current;
    if (!cur?.result || !this.app.tabs.some((t) => t.view === cur.view)) {
      this.say('Dimmi cosa: per esempio «sottolinea la frase banca emittente» oppure «evidenzia l\'articolo 14 delle UCP».');
      return { error: 'niente-da-annotare' };
    }
    const items = [...(cur.marked || cur.result.highlight).entries()].map(([page, hl]) => ({ page, quads: hl.quads, text: cur.result.quote }));
    this.applyMarks(cur.view, items, annot);
    this.say(`Fatto: ho ${VERB_DONE[annot.type]} il passaggio. Di' «annulla» per toglierlo.`);
    return { annotated: items.length };
  }

  // «sottolinea la frase …»: cerca la frase nel documento indicato (o in quello aperto) e, se compare più volte, chiede quale.
  async annotatePhrase(annot) {
    const token = (this.token += 1);
    const view = annot.doc ? await targetView(this, annot.doc) : this.app.view;
    if (token !== this.token) return null;
    if (!view) { this.say(annot.doc ? `Non trovo il documento «${annot.doc}».` : 'Apri prima un documento, oppure dimmi in quale documento: «… nel documento certificato di origine».'); return { error: 'nessun-documento' }; }
    await view.ready;
    if (annot.page && (annot.page < 1 || annot.page > view.pages.length)) { this.say(`Il documento ha ${view.pages.length} pagine.`); return { error: 'pagina' }; }
    const hits = await findPhrase(view, annot.phrase, { page: annot.page ? annot.page - 1 : null, cancelled: () => token !== this.token });
    if (token !== this.token) return null;
    const where = annot.page ? ` a pagina ${annot.page}` : '';
    if (!hits.length) { this.say(`Non trovo «${annot.phrase}»${where} in ${view.tab.name}.`); return { found: false }; }
    const done = (list) => {
      this.applyMarks(view, list, annot);
      const pages = [...new Set(list.map((x) => x.page + 1))];
      this.say(list.length === 1
        ? `Ho ${VERB_DONE[annot.type]} «${list[0].text}» a pagina ${pages[0]}. Di' «annulla» per toglierlo.`
        : `Ho ${VERB_DONE[annot.type]} ${list.length} volte «${annot.phrase}» (pagine ${pages.join(', ')}). Di' «annulla» per togliere tutto.`);
      return { annotated: list.length, pages };
    };
    if (hits.length === 1 || annot.all) return done(hits);
    const shown = hits.slice(0, 9);
    this.pending = { options: shown, resolve: (o) => done([o]), all: () => done(hits) };
    this.say(h('p', {}, `«${annot.phrase}» compare ${hits.length} volte. Quale? Di' «tutte» oppure il numero.`),
      h('ol', { class: 'claudia-choices' }, shown.map((o, i) => h('li', {},
        h('button', { onclick: () => this.run(String(i + 1)) }, h('b', {}, `Pagina ${o.page + 1}: `), `… ${o.snippet} …`)))),
      h('div', { class: 'claudia-actions' }, h('button', { onclick: () => this.run('tutte') }, `Tutte (${hits.length})`)));
    return { pending: true, count: shown.length, total: hits.length };
  }

  cancelPreview() { return cancelPreview(this); }

  confirmEdit(kind) { return confirmEdit(this, kind); }

  async saveCurrent() {
    const v = this.app.view;
    if (!v) { this.say('Non c\'è nessun documento aperto da salvare.'); return { error: 'nessun-documento' }; }
    if (!this.allowed(v.tab.path)) { this.say('Questo documento è fuori dalle cartelle condivise con Theresa.'); return { error: 'fuori-raccolta' }; }
    const ok = await this.app.save(v);
    this.say(ok ? `Salvato: ${v.tab.name}. L'originale resta intatto.` : 'Salvataggio non riuscito.');
    return ok ? { saved: v.tab.name } : { error: 'salvataggio' };
  }

  control(kind) {
    if (kind === 'salva') return this.saveCurrent();
    // Fermati, pausa e riprendi riguardano la lettura in corso: si risponde solo per iscritto.
    if (kind === 'stop') { const was = this.speaker.stop(); this.token += 1; this.quiet(() => this.say(was ? 'Lettura fermata.' : 'Fermata.')); return { control: 'stop' }; }
    if (kind === 'pausa') { this.quiet(() => this.say(this.speaker.pause() ? 'In pausa. Di\' «riprendi» per continuare.' : 'Non sto leggendo nulla.')); return { control: 'pausa' }; }
    if (kind === 'riprendi') { this.quiet(() => this.say(this.speaker.resume() ? 'Riprendo.' : 'Non c\'è una lettura in pausa.')); return { control: 'riprendi' }; }
    // Annulla: toglie l'evidenziazione di Claudia, ferma la lettura e torna dov'eri prima.
    this.speaker.stop();
    this.token += 1;
    this.pending = null;
    this.app.tools.placeHook = null;
    // Prima la modifica proposta e non confermata, poi l'ultima modifica applicata da Theresa.
    if (this.cancelPreview()) { this.say('Modifica annullata: il documento non è cambiato.'); return { control: 'annulla', edit: 'preview' }; }
    if (this.lastEdit && this.app.tabs.some((t) => t.view === this.lastEdit.view)) {
      this.app.tools.undo(this.lastEdit.view);
      this.lastEdit = null;
      this.say('Ho annullato l’ultima modifica.');
      return { control: 'annulla', edit: 'undo' };
    }
    const cur = this.current;
    if (!cur) { this.say('Non c\'è nulla da annullare.'); return { control: 'annulla' }; }
    this.clearMark();
    if (cur.prev?.tab && this.app.tabs.includes(cur.prev.tab)) {
      this.app.activate(cur.prev.tab);
      cur.prev.tab.view.goto(cur.prev.page);
      cur.prev.tab.view.scroller.scrollTop = cur.prev.top;
    } else this.app.showHome();
    this.current = null;
    this.say('Annullato: evidenziazione tolta e vista riportata a prima.');
    return { control: 'annulla' };
  }

  async reopenLast() {
    const last = this.app.settings.recents?.[0];
    if (!last) { this.say('Non ci sono documenti recenti.'); return null; }
    const tab = await this.app.open(last.path);
    if (!tab) return null;
    await tab.view.ready;
    if (last.page) tab.view.goto(last.page);
    this.say(h('p', {}, 'Ho riaperto ', h('b', {}, last.name), last.page ? ` alla pagina ${last.page + 1}.` : '.'));
    return { reopened: last.path };
  }

  unavailable(cmd) {
    this.say(h('p', {}, `${cmd.translate ? 'La traduzione' : 'La spiegazione'} non è disponibile: richiederebbe un servizio esterno, che non è attivo. Ti riporto solo il testo esatto del documento.`));
    return { unavailable: true };
  }

  askNote(text) {
    const v = this.app.view;
    const ref = v ? { path: v.tab.path, name: v.tab.name, page: v.current } : null;
    const box = this.say(h('p', {}, 'Vuoi che salvi questa nota?'), h('blockquote', {}, text),
      ref ? h('p', { class: 'hint' }, `Collegata a ${ref.name}, pagina ${ref.page + 1}.`) : null,
      h('div', { class: 'claudia-actions' },
        h('button', { class: 'primary', 'data-act': 'salva-nota', onclick: () => { this.settings.notes.push({ id: uid(), text, ref, at: Date.now() }); this.save(); box.querySelector('.claudia-actions').replaceWith(h('p', {}, 'Nota salvata.')); } }, 'Salva la nota'),
        h('button', { onclick: () => box.querySelector('.claudia-actions').replaceWith(h('p', {}, 'Non salvata.')) }, 'No')));
    return { noteAsked: true };
  }

  // --- Raccolta autorizzata e schede ------------------------------------------------------------
  openCollection() {
    const c = this.settings;
    modal((box, done) => {
      const list = h('div', { class: 'claudia-cat' });
      const status = h('p', { class: 'hint' });
      const render = () => {
        list.textContent = '';
        const docs = Object.values(c.docs).sort((a, b) => card(a).title.localeCompare(card(b).title));
        if (!docs.length) list.append(h('p', { class: 'hint' }, 'Nessun documento nella raccolta.'));
        for (const e of docs) {
          const k = card(e);
          list.append(h('div', { class: 'claudia-cat-row' },
            h('div', {}, h('b', {}, k.title), h('div', { class: 'claudia-meta' }, [k.edition, LANG_NAME[k.lang] || 'lingua ?', k.jurisdiction || 'giurisdizione ?', k.scanned ? 'scansione senza testo' : null, e.error ? `errore: ${e.error}` : null].filter(Boolean).join(' · ')), h('div', { class: 'claudia-path' }, baseName(e.path)), k.condivisibile ? h('span', { class: 'grok-tag' }, 'condivisibile con Grok') : null),
            iconBtn('edit', 'Correggi la scheda', () => this.editCard(e, render))));
        }
      };
      const folders = h('div', { class: 'chips' });
      const renderFolders = () => {
        folders.textContent = '';
        for (const f of c.folders) folders.append(h('span', { class: 'chip', title: f }, baseName(f) || f, iconBtn('close', `Togli ${f}`, async () => { c.folders = c.folders.filter((x) => x !== f); this.save(); renderFolders(); await refresh(); })));
        for (const f of c.files || []) folders.append(h('span', { class: 'chip chip-file', title: f }, `📄 ${baseName(f)}`, iconBtn('close', `Togli ${f}`, async () => { c.files = c.files.filter((x) => x !== f); this.save(); renderFolders(); await refresh(); })));
      };
      const refresh = async () => {
        status.textContent = 'Aggiorno le schede…';
        const n = await refreshCatalog(this.app, (i, tot, name) => { status.textContent = `Leggo ${i} di ${tot}: ${name}`; });
        status.textContent = `Schede aggiornate (${n} lette ora, ${Object.keys(c.docs).length} in tutto).`;
        render();
      };
      box.append(h('h2', {}, 'Raccolta di Theresa'),
        h('p', {}, 'Theresa consulta e modifica i PDF di queste cartelle e i singoli file che aggiungi. Le schede sono proposte in automatico: correggi titolo, lingua, giurisdizione ed edizione quando serve.'),
        folders,
        h('div', { class: 'modal-actions left' },
          h('button', { html: `${icon('plus')} Aggiungi cartella`, onclick: async () => { const f = await host.pickFolder(); if (f && !c.folders.includes(f)) { c.folders.push(f); this.save(); renderFolders(); await refresh(); } } }),
          h('button', { class: 'add-files', html: `${icon('plus')} Aggiungi file`, onclick: async () => { const fs = await host.pickPdf(); c.files ||= []; let n = 0; for (const f of fs || []) if (!c.files.includes(f)) { c.files.push(f); n += 1; } if (n) { this.save(); renderFolders(); await refresh(); } } }),
          h('button', { onclick: refresh }, 'Aggiorna le schede')),
        status, list,
        this.app.grok?.available ? this.grokSection(render) : null,
        h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: () => done() }, 'Chiudi')));
      renderFolders();
      render();
    });
  }

  // Collegamento con Grok Bot: interruttore (spento per impostazione), cartella di scambio e registro.
  grokSection(renderList = () => {}) {
    const g = this.app.grok;
    const s = { enabled: false, folder: 'P:\\Postilla-Grok', ...(this.app.settings.grok || {}) };
    const on = h('input', { type: 'checkbox', class: 'grok-switch' });
    on.checked = !!s.enabled;
    const canEdit = h('input', { type: 'checkbox', class: 'grok-edit-switch' });
    canEdit.checked = !!s.canEdit;
    const scope = h('select', { class: 'grok-scope', 'aria-label': 'Documenti visibili a Grok' },
      h('option', { value: 'tutta' }, 'tutta la raccolta di Theresa (tutte le cartelle condivise)'),
      h('option', { value: 'condivisibili' }, 'solo i documenti segnati «condivisibili»'));
    scope.value = s.scope === 'condivisibili' ? 'condivisibili' : 'tutta';
    const folder = h('input', { type: 'text', value: s.folder, class: 'grok-folder', 'aria-label': 'Cartella di scambio con Grok Bot' });
    folder.addEventListener('keydown', (e) => e.stopPropagation());
    const logEl = h('ol', { class: 'grok-log' });
    const n = () => g.shareable().length;
    const count = h('p', { class: 'hint' });
    const renderLog = (log) => {
      logEl.textContent = '';
      if (!log.length) logEl.append(h('li', { class: 'hint' }, 'Nessuna richiesta ricevuta in questa sessione.'));
      for (const r of log.slice(0, 12)) logEl.append(h('li', {}, `${new Date(r.at).toLocaleTimeString('it-IT')} · ${r.strumento || 'richiesta non valida'} · ${r.esito}${r.documento ? ` · ${r.documento}` : ''}`));
    };
    const apply = () => {
      const grok = { enabled: on.checked, folder: folder.value.trim() || 'P:\\Postilla-Grok', canEdit: canEdit.checked, scope: scope.value };
      this.app.settings.grok = grok;
      host.settingsSet({ grok });
      document.body.classList.toggle('grok-on', grok.enabled);
      count.textContent = grok.enabled
        ? `Acceso. Documenti condivisibili: ${n()}. Grok vede solo questi, e riceve solo citazioni e riferimenti.`
        : 'Spento: Postilla non legge la cartella e non risponde.';
    };
    on.addEventListener('change', apply);
    canEdit.addEventListener('change', apply);
    scope.addEventListener('change', apply);
    const shareAll = (v) => {
      for (const e of Object.values(this.settings.docs)) e.user = { ...(e.user || {}), condivisibile: v };
      this.save(); renderList(); apply();
    };
    folder.addEventListener('change', apply);
    g.onLog = renderLog;
    renderLog(g.log);
    count.textContent = s.enabled ? `Acceso. Documenti condivisibili: ${n()}.` : 'Spento: Postilla non legge la cartella e non risponde.';
    return h('section', { class: 'grok-section' },
      h('h3', {}, 'Collegamento con Grok Bot'),
      h('p', { class: 'hint' }, 'Il bot scrive le richieste in questa cartella pCloud e Postilla risponde nella stessa cartella. Funziona solo con Postilla aperta. Per i documenti segnati "condivisibili", citazioni e testi modificati escono dal PC verso Grok (xAI).'),
      h('label', { class: 'check' }, on, ' Collegamento acceso'),
      h('label', {}, 'Grok vede', scope),
      h('label', { class: 'check' }, canEdit, ' Grok può modificare (sempre in una copia, con registro)'),
      h('p', { class: 'hint' }, 'Il bot può dare a Theresa qualsiasi comando, come se lo scrivessi tu: cercare, evidenziare, modificare, confermare, salvare. Solo sui documenti che vede.'),
      h('div', { class: 'modal-actions left' },
        h('button', { class: 'grok-share-all', onclick: () => shareAll(true) }, 'Condividi tutta la raccolta con Grok'),
        h('button', { onclick: () => shareAll(false) }, 'Non condividere nessun documento')),
      h('label', {}, 'Cartella di scambio', folder),
      count,
      h('h4', {}, 'Ultime richieste'), logEl);
  }

  editCard(entry, after) {
    const k = card(entry);
    modal((box, done) => {
      const f = (label, key, value) => { const i = h('input', { type: 'text', value: value || '', 'data-key': key }); i.addEventListener('keydown', (e) => e.stopPropagation()); return h('label', {}, label, i); };
      const lang = h('select', { 'data-key': 'lang' }, h('option', { value: 'it' }, 'italiano'), h('option', { value: 'en' }, 'inglese'), h('option', { value: '' }, 'non indicata'));
      lang.value = k.lang || '';
      const share = h('input', { type: 'checkbox', class: 'grok-share' });
      share.checked = k.condivisibile === true;
      box.append(h('h2', {}, 'Scheda del documento'), h('p', { class: 'hint' }, baseName(entry.path)),
        f('Titolo', 'title', k.title), h('label', {}, 'Lingua', lang), f('Giurisdizione', 'jurisdiction', k.jurisdiction), f('Edizione o versione', 'edition', k.edition),
        h('label', { class: 'check' }, share, ' Condivisibile con Grok Bot (citazioni e modifiche passano a Grok)'),
        h('div', { class: 'modal-actions' },
          h('button', { onclick: () => done() }, 'Annulla'),
          h('button', { class: 'primary', onclick: () => {
            const user = {};
            for (const el of box.querySelectorAll('[data-key]')) user[el.dataset.key] = el.value.trim() || null;
            user.condivisibile = share.checked;
            entry.user = user;
            this.save();
            done();
            after();
          } }, 'Salva')));
    });
  }
}

function what(cmd) {
  if (cmd.article && cmd.keywords) return `l'articolo ${cmd.article} contiene «${cmd.keywords}»`;
  if (cmd.article) return `c'è l'articolo ${cmd.article}`;
  return `compare «${cmd.keywords}»`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function explain(r) {
  if (r.reason === 'errore') return `non sono riuscita ad aprirlo (${r.error}).`;
  return (REASONS[r.reason] || (() => 'non trovato.'))(r);
}

export { describe };
