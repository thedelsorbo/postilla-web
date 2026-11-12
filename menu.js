// Menu principale: tutte le funzioni di Postilla in un posto solo, divise per argomento, con le scorciatoie.
// Le voci che richiedono un documento aperto (o una selezione) sono disattivate quando non servono.
import { $, ask, h, icon, modal, promptText, toast } from './core.js';
import { deletePages, insertBlank, rotatePages } from './pdfio.js';
import { printDoc } from './print.js';
import { shareDoc } from './share.js';
import { docTrusted, manageTrust, setDocTrusted } from './links.js';
import { editTitles, isThirdParty, logEntry, setThirdParty, showLog } from './thirdparty.js';
import { startEdit } from './edits.js';
import { buildPdf } from './pdfio.js';

// I moduli di modifica avanzata si caricano solo quando servono: l'avvio resta veloce.
const pro = (name) => import(`./pro/${name}`);

const SHORTCUTS = [
  ['Ctrl + O', 'Apri PDF (anche più di uno)'], ['Ctrl + Maiusc + O', 'Apri a voce: di\' il nome del file'], ['Ctrl + S', 'Salva'], ['Ctrl + Maiusc + S', 'Salva con nome'], ['Ctrl + P', 'Stampa'],
  ['Ctrl + W', 'Chiudi il documento'], ['Ctrl + Tab', 'Documento successivo'], ['Ctrl + Z / Ctrl + Y', 'Annulla / Ripeti'],
  ['Ctrl + F', 'Cerca nel documento'], ['Ctrl + K', 'Assistente AI (o Theresa, se è visibile)'], ['Ctrl + Spazio (tenuti premuti)', 'Parla con Theresa'], ['Ctrl + Maiusc + Spazio', 'Accendi o spegni l\'ascolto di «Theresa»'],
  ['Ctrl + + / Ctrl + −', 'Ingrandisci / Riduci'], ['Ctrl + 0', 'Adatta alla larghezza'], ['Pag↑ / Pag↓', 'Pagina precedente / successiva'],
  ['Home', 'Prima pagina'], ['Canc', 'Elimina l\'annotazione selezionata'], ['Esc', 'Ferma la lettura, esce dalla selezione o dal tutto schermo'],
];

export class MainMenu {
  constructor(app) { this.app = app; }

  get v() { return this.app.view; }

  // Operazione su una sola pagina del documento aperto (ruota, elimina, inserisci).
  async pageOp(fn, mapping, done) {
    const v = this.v;
    if (!v || !this.app.tools.guardEdit(v)) return;
    const i = v.current;
    await this.app.pageOp(v, (b) => fn(b, i, v), (p) => mapping(p, i));
    toast(done);
  }

  // Operazioni sull'intero documento che producono un file nuovo (o una finestra): confronto, compressione,
  // password, firma, Word. Il documento salvato include sempre le annotazioni e le modifiche fatte.
  async docOp(kind) {
    const a = this.app; const v = this.v;
    const base = v ? v.tab.path.replace(/\.pdf$/i, '') : '';
    const saveAs = async (bytes, suffix, msg) => {
      const dest = await host.pickSave(`${base} - ${suffix}.pdf`);
      if (!dest) return null;
      await host.writeFile(dest, bytes);
      toast(msg);
      return dest;
    };
    const current = async () => { await v.ready; a.tools.commitEditor(); return buildPdf(v); };
    try {
      if (kind === 'compare') {
        const [other] = (await host.pickPdf(false)) || [];
        if (!other) return;
        const m = await pro('compare.js');
        const { data } = await host.readFile(other);
        await m.showComparison(a, v.tab.name, await v.ensureBytes(), other.split(/[\\/]/).pop(), new Uint8Array(data));
      } else if (kind === 'compress') {
        const m = await pro('compress.js');
        const out = await m.compressDialog(a, v, await current());
        if (out) await saveAs(out, 'compresso', 'Copia compressa salvata.');
      } else if (kind === 'protect') {
        const m = await pro('crypt.js');
        const opts = await m.askProtection();
        if (!opts) return;
        const dest = await saveAs(await m.encryptPdf(await current(), opts), 'protetto', 'Copia protetta da password salvata. Conserva la password: senza non si apre.');
        if (dest) logEntry(a, v, { kind: 'protezione', page: 0, before: '', after: 'Copia protetta da password' });
      } else if (kind === 'sign') {
        if (v.tab.dirty) toast('La firma include anche le modifiche non ancora salvate.');
        const m = await pro('signature.js');
        const opts = await m.signDialog(a, v);
        if (!opts) return;
        const dest = await saveAs(await m.signPdf(await current(), opts), 'firmato', 'Copia firmata digitalmente salvata.');
        if (dest && await ask('Aprire il documento firmato?', 'Ogni modifica successiva, anche un\'annotazione, va in una nuova copia senza firma valida.', [{ label: 'No', value: 'no' }, { label: 'Apri', value: 'yes', primary: true }]) === 'yes') a.open(dest);
      } else if (kind === 'verify') {
        const m = await pro('signature.js');
        const { data } = await host.readFile(v.sourcePath || v.tab.path);
        await m.showSignatures(a, v, new Uint8Array(data));
      } else if (kind === 'word-out') {
        const m = await pro('word.js');
        await m.exportWordFlow(a, v);
      } else if (kind === 'word-in') {
        const m = await pro('word.js');
        await m.importWordFlow(a);
      }
    } catch (e) {
      console.error(e);
      toast(e?.message || String(e), 'error');
    }
  }

  sections() {
    const a = this.app; const v = this.v; const t = a.tools;
    const doc = !!v; const sel = !!t.textSel?.words?.length && t.textSel.view === v;
    const tool = (id, label) => ({ label, check: t.tool === id, need: 'doc', run: () => t.set(id) });
    return [
      ['File', [
        { label: 'Apri PDF…', key: 'Ctrl+O', run: () => a.pickAndOpen() },
        { label: 'Apri a voce (di\' il nome del file)…', key: 'Ctrl+Maiusc+O', id: 'voice-open', run: () => a.openByVoice() },
        ...(host.archiveDialog ? [{ label: 'Archivio del browser (scarica o elimina i file)…', id: 'web-archive', run: () => host.archiveDialog() }] : []),
        { label: 'Operazioni su più PDF insieme…', id: 'batch', run: () => pro('batch.js').then((m) => m.batchDialog(a)) },
        { label: 'Crea un PDF da immagini o scanner…', id: 'create', run: () => pro('create.js').then((m) => m.createDialog(a)) },
        { label: 'Documenti recenti e preferiti…', run: () => a.openQuick($('#quick')) },
        { label: 'Torna all\'elenco dei documenti', run: () => a.showHome() },
        '-',
        { label: 'Salva', key: 'Ctrl+S', need: 'doc', run: () => a.save(v) },
        { label: 'Salva con nome…', key: 'Ctrl+Maiusc+S', need: 'doc', run: () => a.save(v, { as: true }) },
        { label: 'Salva versione definitiva (annotazioni fissate)…', need: 'doc', run: () => a.save(v, { flatten: true }) },
        { label: 'Stampa…', key: 'Ctrl+P', need: 'doc', id: 'print', run: () => printDoc(a, v) },
        { label: 'Condividi…', need: 'doc', id: 'share', run: () => shareDoc(a, v) },
        { label: 'Esporta in Excel, PowerPoint, immagini o testo…', need: 'doc', id: 'export', run: () => pro('export.js').then((m) => m.exportDialog(a, v)) },
        '-',
        { label: 'Estrai le pagine scelte in un nuovo PDF…', need: 'doc', run: () => a.pm.open() },
        { label: 'Unisci con un altro PDF…', need: 'doc', run: async () => { await a.pm.open(); a.pm.merge(); } },
        { label: 'Dividi il PDF…', need: 'doc', run: async () => { await a.pm.open(); a.pm.split(); } },
        { label: 'Mostra nella cartella', need: 'doc', run: () => host.reveal(v.tab.path) },
        '-',
        { label: 'Chiudi il documento', key: 'Ctrl+W', need: 'doc', run: () => a.closeTab(a.active) },
        { label: 'Chiudi tutti i documenti', need: 'doc', run: async () => { for (const x of [...a.tabs]) if (!(await a.closeTab(x))) break; } },
      ]],
      ['Modifica', [
        { label: 'Annulla', key: 'Ctrl+Z', need: 'doc', run: () => t.undo(v) },
        { label: 'Ripeti', key: 'Ctrl+Y', need: 'doc', run: () => t.redo(v) },
        '-',
        { label: 'Sostituisci il testo selezionato…', need: 'sel', run: () => { const s = t.textSel; t.clearTextSel(); startEdit(a, v, s.p, s.words, 'replace'); } },
        { label: 'Modifica il paragrafo (va a capo da solo, come in Word)…', need: 'sel', id: 'para', run: () => { const s = t.textSel; t.clearTextSel(); import('./pro/paragraph.js').then((m) => m.editParagraph(a, v, s.p, s.words)); } },
        { label: 'Aggiungi testo dopo la selezione…', need: 'sel', run: () => { const s = t.textSel; t.clearTextSel(); startEdit(a, v, s.p, s.words, 'add'); } },
        { label: 'Copia il testo selezionato', need: 'sel', run: () => { navigator.clipboard?.writeText(t.textSel.text); toast('Testo copiato'); } },
        { label: 'Elimina l\'annotazione selezionata', key: 'Canc', need: 'doc', run: () => t.deleteSelected() },
        '-',
        { label: 'Cerca nel documento…', key: 'Ctrl+F', need: 'doc', run: () => { a.prefs.panel = true; a.panel.show(true); a.panel.setMode('search'); } },
        { label: 'Cerca in tutti i PDF delle cartelle…', key: 'Ctrl+Maiusc+F', id: 'library', run: () => import('./library-ui.js').then((m) => m.openLibrary(a)) },
      ]],
      ['Modifica PDF', [
        { label: 'Oscura: disegna le zone da cancellare', need: 'doc', check: t.tool === 'redact', run: () => { t.set('redact'); toast('Disegna un riquadro su ciò che vuoi oscurare. Si cancella davvero solo con «Applica gli oscuramenti».'); } },
        { label: 'Cerca e oscura (parole, IBAN, e-mail…)…', need: 'doc', run: () => pro('redact.js').then((m) => m.searchAndRedact(a, v)) },
        { label: 'Applica gli oscuramenti…', need: 'doc', disabled: !v?.annots.some((x) => x.type === 'redact'), run: () => pro('redact.js').then((m) => m.applyRedactions(a, v)) },
        '-',
        { label: 'Crea un modulo: aggiungi campi compilabili…', need: 'doc', id: 'fields', check: t.tool === 'field', run: () => pro('formbuilder.js').then((m) => m.startFieldTool(a)) },
        '-',
        { label: 'Inserisci un\'immagine…', need: 'doc', run: () => pro('imagetool.js').then((m) => m.insertImage(a, v)) },
        { label: 'Modifica le immagini di questa pagina…', need: 'doc', run: () => pro('imagetool.js').then((m) => { a.pageImages = a.pageImages || new m.PageImages(a); a.pageImages.open(v); }) },
        '-',
        { label: 'Filigrana…', need: 'doc', run: () => pro('pages.js').then((m) => m.watermarkDialog(a, v)) },
        { label: 'Numeri di pagina, intestazioni, piè di pagina…', need: 'doc', run: () => pro('pages.js').then((m) => m.numbersDialog(a, v)) },
        { label: 'Colore di sfondo…', need: 'doc', run: () => pro('pages.js').then((m) => m.backgroundDialog(a, v)) },
        { label: 'Ritaglia le pagine…', need: 'doc', run: () => pro('pages.js').then((m) => m.cropDialog(a, v)) },
      ]],
      ['Documento', [
        { label: 'Confronta con un altro PDF…', need: 'doc', run: () => this.docOp('compare') },
        { label: 'Comprimi (file più leggero)…', need: 'doc', run: () => this.docOp('compress') },
        { label: 'Converti in PDF/A (archiviazione a norma)…', need: 'doc', id: 'pdfa', run: () => pro('pdfa.js').then((m) => m.pdfaFlow(a, v)) },
        { label: 'Allegati del PDF…', need: 'doc', id: 'attach', run: () => pro('attach.js').then((m) => m.attachmentsDialog(a, v)) },
        { label: 'Controllo di accessibilità…', need: 'doc', id: 'access', run: () => pro('access.js').then((m) => m.accessibilityDialog(a, v)) },
        '-',
        { label: 'Proteggi con password…', need: 'doc', run: () => this.docOp('protect') },
        { label: 'Firma digitale con certificato…', need: 'doc', run: () => this.docOp('sign') },
        { label: 'Verifica le firme digitali', need: 'doc', run: () => this.docOp('verify') },
        { label: 'Invia per la firma a un’altra persona…', need: 'doc', id: 'sendsign', run: () => pro('sendsign.js').then((m) => m.sendForSignature(a, v)) },
        '-',
        { label: 'Esporta in Word (.docx)…', need: 'doc', run: () => this.docOp('word-out') },
        { label: 'Converti un documento Word in PDF…', run: () => this.docOp('word-in') },
      ]],
      ['Annota', [
        tool('hand', 'Sposta la pagina'), tool('select', 'Seleziona testo e annotazioni'), tool('pen', 'Penna'),
        tool('hl', 'Evidenzia'), tool('ul', 'Sottolinea'), tool('so', 'Barra'),
        tool('rect', 'Rettangolo'), tool('ellipse', 'Ellisse'), tool('line', 'Linea'), tool('arrow', 'Freccia'),
        tool('text', 'Casella di testo'), tool('note', 'Nota'), tool('label', 'Etichetta'),
        { label: 'Timbro…', need: 'doc', run: () => { t.set('stamp'); a.openStampMenu(); } },
        { label: 'Firma visiva…', need: 'doc', run: () => { t.set('sig'); a.openSignMenu(); } },
        tool('eraser', 'Gomma'), tool('laser', 'Puntatore virtuale'),
        tool('measure', 'Misura una distanza'), tool('area', 'Misura un\'area (tocca i vertici)'),
        { label: 'Scala delle misure…', run: () => pro('measure.js').then((m) => m.measureSettings(a)) },
        '-',
        { label: 'Scrivi anche col dito', check: !!a.prefs.fingerDraw, run: () => a.fingerBtn.click() },
        { label: 'Barra delle penne a destra', check: a.prefs.rail !== false, run: () => { a.prefs.rail = a.prefs.rail === false; a.savePrefs(); a.rail.hidden = !a.prefs.rail; } },
      ]],
      ['Visualizza', [
        { label: 'Ingrandisci', key: 'Ctrl++', need: 'doc', run: () => a.zoomStep(1.25) },
        { label: 'Riduci', key: 'Ctrl+−', need: 'doc', run: () => a.zoomStep(0.8) },
        { label: 'Dimensione reale (100%)', need: 'doc', run: () => v.setScale(96 / 72) },
        { label: 'Adatta alla larghezza', key: 'Ctrl+0', need: 'doc', run: () => v.setFit('width') },
        { label: 'Pagina intera', need: 'doc', run: () => v.setFit('page') },
        { label: 'Lettura a tutto schermo', need: 'doc', run: () => a.setReading(true) },
        '-',
        ...[['thumbs', 'Miniature delle pagine'], ['outline', 'Indice del documento'], ['marks', 'Segnalibri'], ['annots', 'Elenco delle annotazioni']].map(([m, label]) => ({ label, need: 'doc', check: a.prefs.panel && a.panel.mode === m, run: () => { a.prefs.panel = true; a.savePrefs(); a.panel.show(true); a.panel.setMode(m); } })),
        { label: 'Nascondi il pannello laterale', need: 'doc', run: () => { a.prefs.panel = false; a.savePrefs(); a.panel.show(false); } },
        '-',
        { label: 'Vai alla pagina…', need: 'doc', run: async () => { const n = await promptText('Vai alla pagina', `Numero da 1 a ${v.pages.length}`, String(v.current + 1)); const k = parseInt(n, 10); if (k >= 1 && k <= v.pages.length) v.goto(k - 1); } },
        { label: 'Prima pagina', key: 'Home', need: 'doc', run: () => v.goto(0) },
        { label: 'Ultima pagina', need: 'doc', run: () => v.goto(v.pages.length - 1) },
      ]],
      ['Pagine', [
        { label: 'Gestisci le pagine…', need: 'doc', run: () => a.pm.open() },
        { label: 'Ruota questa pagina a destra', need: 'doc', run: () => this.pageOp((b, i) => rotatePages(b, [i], 90), (p) => p, 'Pagina ruotata. Si salva in una copia.') },
        { label: 'Ruota questa pagina a sinistra', need: 'doc', run: () => this.pageOp((b, i) => rotatePages(b, [i], -90), (p) => p, 'Pagina ruotata. Si salva in una copia.') },
        { label: 'Inserisci una pagina bianca dopo questa', need: 'doc', run: () => this.pageOp((b, i, vv) => insertBlank(b, i + 1, [vv.pages[i].w, vv.pages[i].h]), (p, i) => (p > i ? p + 1 : p), 'Pagina bianca inserita.') },
        { label: 'Elimina questa pagina', need: 'doc', run: async () => { if (v.pages.length < 2) { toast('Il documento ha una sola pagina.'); return; } await this.pageOp((b, i) => deletePages(b, [i]), (p, i) => (p === i ? -1 : p > i ? p - 1 : p), 'Pagina eliminata dal documento aperto: il file cambia solo quando salvi.'); } },
        '-',
        { label: 'Segnalibro su questa pagina', need: 'doc', run: () => { a.toggleBookmark(v, v.current); toast('Segnalibro aggiornato.'); } },
      ]],
      ['Strumenti', [
        { label: 'Riconosci il testo delle pagine scansionate (OCR)', need: 'doc', run: () => a.ocr.run(v) },
        { label: 'Cancella il testo riconosciuto', need: 'doc', disabled: !v?.ocr, run: () => a.ocr.clear(v) },
        '-',
        { label: 'Documento di terzi', need: 'doc', check: doc && isThirdParty(a, v), run: () => setThirdParty(a, v, !isThirdParty(a, v)) },
        { label: 'Revisione condivisa con altre persone…', need: 'doc', id: 'collab', check: doc && a.collab?.active(v), run: () => import('./collab.js').then((m) => m.collabDialog(a, v)) },
        { label: 'Registro delle modifiche…', need: 'doc', run: () => showLog(a, v) },
        { label: 'Titoli dei documenti di terzi…', run: () => editTitles(a) },
        '-',
        { label: 'Tutti i link di questo documento sono affidabili', need: 'doc', check: doc && docTrusted(a, v), run: () => setDocTrusted(a, v, !docTrusted(a, v)) },
        { label: 'Link affidabili…', run: () => manageTrust(a) },
      ]],
      ['Assistente AI', [
        { label: 'Apri l\'assistente', key: a.prefs.theresa ? null : 'Ctrl+K', run: () => a.openAi?.() },
        { label: 'Traduci il documento mantenendo l’impaginazione…', need: 'doc', id: 'translate', run: () => pro('translate.js').then((m) => m.translateDialog(a, v)) },
        { label: 'Impostazioni dell\'assistente (ChatGPT, Claude, Gemini, Grok, Mistral, DeepSeek, AI locale)…', run: () => a.openAi?.({ settings: true }) },
      ]],
      ...(a.prefs.theresa ? [['Theresa', [
        { label: 'Apri Theresa', key: 'Ctrl+K', run: () => a.claudia.toggle(true) },
        { label: 'Raccolta dei documenti e collegamento con Grok…', run: () => { a.claudia.toggle(true); a.claudia.openCollection(); } },
        { label: 'Parla con Theresa (tieni premuto il microfono o Ctrl+Spazio)', run: () => a.claudia.toggle(true) },
        { label: 'Ascolta quando dico «Theresa»', check: !!a.claudia.settings.wake, run: () => a.claudia.setWake(!a.claudia.settings.wake) },
      ]]] : []),
      ['Impostazioni', [
        { label: 'Trasforma la scrittura a penna in testo', check: a.prefs.inkText !== false, run: () => { a.prefs.inkText = a.prefs.inkText === false; a.savePrefs(); } },
        { label: 'Mostra Theresa (assistente vocale)', check: !!a.prefs.theresa, run: () => a.setTheresa(!a.prefs.theresa) },
        { label: 'Collegamento con il bot Grok…', run: () => a.claudia.openCollection() },
      ]],
      ['Aiuto', [
        { label: 'Scorciatoie da tastiera', run: () => this.shortcuts() },
        { label: 'Informazioni su Postilla', run: () => a.openAbout() },
      ]],
    ].map(([title, items]) => [title, items.map((it) => (it === '-' ? it : { ...it, off: it.disabled || (it.need === 'doc' && !doc) || (it.need === 'sel' && !sel) }))]);
  }

  open(anchor) {
    this.close();
    const back = h('div', { class: 'menu-back', onpointerdown: (e) => { if (e.target === back) this.close(); } });
    const panel = h('div', { class: 'main-menu', role: 'menu', 'aria-label': 'Menu' });
    for (const [title, items] of this.sections()) {
      panel.append(h('section', { class: 'menu-sec' }, h('h3', {}, title), ...items.map((it) => (it === '-' ? h('hr', {})
        : h('button', { class: `menu-item${it.check ? ' checked' : ''}`, role: it.check !== undefined ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': it.check !== undefined ? String(!!it.check) : null, 'data-id': it.id || null, disabled: it.off,
          onclick: () => { this.close(); it.run(); } }, h('span', { class: 'menu-mark' }, it.check ? '✓' : ''), h('span', { class: 'menu-label' }, it.label), it.key ? h('kbd', {}, it.key) : null)))));
    }
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    back.append(panel);
    document.body.append(back);
    this.el = back;
    const r = anchor?.getBoundingClientRect();
    if (r) panel.style.top = `${Math.round(r.bottom + 4)}px`;
    panel.querySelector('button:not([disabled])')?.focus();
  }

  close() { this.el?.remove(); this.el = null; }

  shortcuts() {
    modal((box, done) => box.append(h('h2', {}, 'Scorciatoie da tastiera'),
      h('table', { class: 'keys' }, SHORTCUTS.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))),
      h('div', { class: 'modal-actions' }, h('button', { class: 'primary', onclick: () => done() }, 'Chiudi'))));
  }
}

export const menuIcon = () => icon('menu');
