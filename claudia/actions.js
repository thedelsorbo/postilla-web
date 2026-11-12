// Theresa: comandi per le funzioni di Postilla (le stesse del Menu), con regole fisse e senza servizi esterni.
// «vai a pagina 5», «ingrandisci», «ruota la pagina a sinistra», «stampa», «chiudi il documento», «prendi la penna»…
// Ogni comando corrisponde a una voce del Menu (o a un'azione equivalente), così Theresa e il Menu fanno la stessa cosa.
// (Il Menu si carica solo quando serve: così le regole si possono provare anche fuori dal programma.)

const NUMS = { una: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20, trenta: 30, quaranta: 40, cinquanta: 50 };
const num = (s) => { const t = String(s || '').trim().toLowerCase(); return /^\d+$/.test(t) ? Number(t) : NUMS[t] ?? null; };
const NUMW = String.raw`(\d{1,4}|${Object.keys(NUMS).join('|')})`;

const TOOLS = {
  penna: 'pen', matita: 'pen', evidenziatore: 'hl', gomma: 'eraser', mano: 'hand', manina: 'hand', selezione: 'select',
  rettangolo: 'rect', ellisse: 'ellipse', cerchio: 'ellipse', linea: 'line', freccia: 'arrow', 'casella di testo': 'text',
  nota: 'note', puntatore: 'laser', laser: 'laser', 'puntatore laser': 'laser', 'puntatore virtuale': 'laser',
};
const TOOL_LABEL = { pen: 'Penna', hl: 'Evidenzia', eraser: 'Gomma', hand: 'Sposta la pagina', select: 'Seleziona testo e annotazioni', rect: 'Rettangolo', ellipse: 'Ellisse', line: 'Linea', arrow: 'Freccia', text: 'Casella di testo', note: 'Nota', laser: 'Puntatore virtuale' };

// Forma "nuda" del comando: senza cortesie («puoi…», «per favore») e punteggiatura finale.
export function bare(s) {
  return String(s || '').toLowerCase().replace(/[’‘]/g, "'").trim()
    .replace(/[?!.\s]+$/, '')
    .replace(/[\s,]+(?:per favore|per cortesia|per piacere|grazie)$/, '')
    .replace(/^(?:per favore|per cortesia)[\s,]+/, '')
    .replace(/^(?:mi\s+|me\s+|ci\s+)?(?:puoi|potresti|può|riesci a|vorrei che (?:tu\s+)?)\s+/, '')
    .replace(/^(?:mi|me|ci)\s+/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^(\S+)/, (w) => VERB_FORM[w] || w);
}
// «puoi stampare…», «mi stampi…» → «stampa…»
const VERB_FORM = {
  stampare: 'stampa', stampi: 'stampa', chiudere: 'chiudi', ruotare: 'ruota', ruoti: 'ruota', girare: 'gira', giri: 'gira',
  ingrandire: 'ingrandisci', rimpicciolire: 'rimpicciolisci', ridurre: 'riduci', andare: 'vai', tornare: 'torna', torni: 'torna',
  passare: 'passa', passi: 'passa', mostrare: 'mostra', mostri: 'mostra', aprire: 'apri', salvare: 'salva', salvi: 'salva',
  inserire: 'inserisci', aggiungere: 'aggiungi', eliminare: 'elimina', elimini: 'elimina', cancellare: 'cancella', cancelli: 'cancella',
  togliere: 'togli', usare: 'usa', usi: 'usa', prendere: 'prendi', adattare: 'adatta', adatti: 'adatta', fare: 'fai', riconoscere: 'riconosci',
  nascondere: 'nascondi', mettere: 'metti', unire: 'unisci', dividere: 'dividi', estrarre: 'estrai', ripetere: 'ripeti', copiare: 'copia', copi: 'copia',
  smettere: 'smetti', ascoltare: 'ascolta', rispondere: 'rispondi', ascoltarmi: 'ascoltami',
};

// [regola, azione]: l'azione è { id, ... }. L'ordine conta: le regole più precise prima.
const RULES = [
  // Ascolto della chiamata «Theresa» e risposte a voce
  [/^(?:non ascoltare|non ascoltarmi|smetti di ascoltar(?:e|mi)|basta ascoltare|spegni (?:l'ascolto|il microfono)|chiudi il microfono|disattiva l'ascolto|metti in pausa l'ascolto|pausa ascolto|dormi|vai a dormire)(?:\s+per ora)?$/, () => ({ id: 'ascolto-off' })],
  [/^(?:ascoltami|accendi l'ascolto|attiva l'ascolto|riattiva l'ascolto|ascolta quando (?:ti chiamo|dico theresa))$/, () => ({ id: 'ascolto-on' })],
  [/^(?:non rispondermi a voce|rispondimi (?:solo )?per iscritto|non parlare|smetti di parlare|niente voce)$/, () => ({ id: 'voce-off' })],
  [/^(?:rispondimi a voce|parlami|rispondi a voce)$/, () => ({ id: 'voce-on' })],

  // Navigazione
  [new RegExp(String.raw`^(?:vai|va|passa|torna|portami|salta|spostati|mostrami|apri)?\s*(?:a|alla|al)?\s*pagina\s+(?:numero\s+)?${NUMW}$`), (m) => ({ id: 'pagina', n: num(m[1]) })],
  [/^(?:(?:vai|passa)\s+(?:alla\s+)?)?(?:pagina\s+)?(?:successiva|seguente|prossima)(?:\s+pagina)?$|^(?:gira|volta)\s+(?:la\s+)?pagina$|^avanti(?:\s+di\s+una\s+pagina)?$|^pagina avanti$/, () => ({ id: 'pagina-su' })],
  [/^(?:(?:vai|torna)\s+(?:alla\s+)?)?pagina\s+precedente$|^(?:vai\s+|torna\s+)?(?:alla\s+)?precedente$|^(?:vai|torna)\s+indietro\s+di\s+una\s+pagina$|^pagina indietro$/, () => ({ id: 'pagina-giu' })],
  [/^(?:vai|torna|portami)?\s*(?:alla\s+)?prima pagina$|^(?:vai\s+|torna\s+)?all'inizio(?: del documento)?$/, () => ({ menu: 'Prima pagina' })],
  [/^(?:vai|portami)?\s*(?:all'|alla\s+)?ultima pagina$|^(?:vai\s+)?alla fine(?: del documento)?$/, () => ({ menu: 'Ultima pagina' })],

  // Zoom e vista
  [new RegExp(String.raw`^(?:metti\s+(?:lo\s+)?|imposta\s+(?:lo\s+)?)?zoom\s+(?:al|a)\s*${NUMW}\s*(?:%|per\s*cento)?$|^ingrandisci\s+(?:al|a)\s*${NUMW}\s*(?:%|per\s*cento)$`), (m) => ({ id: 'zoom', pct: num(m[1] || m[2]) })],
  [/^(?:ingrandisci|ingrandiscilo|ingrandiscila|zoom(?: avanti| in)?|aumenta (?:lo zoom|la dimensione)|più grande|fai più grande)(?:\s+(?:lo zoom|la pagina|il documento|il testo|la vista))?$/, () => ({ menu: 'Ingrandisci' })],
  [/^(?:riduci|rimpicciolisci|riducilo|riducila|zoom (?:indietro|out)|diminuisci lo zoom|più piccolo|fai più piccolo)(?:\s+(?:lo zoom|la pagina|il documento|il testo|la vista))?$/, () => ({ menu: 'Riduci' })],
  [/^(?:adatta|adattalo|adattala)?\s*(?:alla|a tutta la)\s+larghezza(?: della pagina)?$|^larghezza (?:della )?pagina$/, () => ({ menu: 'Adatta alla larghezza' })],
  [/^(?:mostra(?:mi)?\s+)?(?:tutta la pagina|la pagina intera|pagina intera)$|^adatta(?:la)? alla pagina$/, () => ({ menu: 'Pagina intera' })],
  [/^(?:dimensione reale|grandezza reale|zoom (?:al )?100(?: ?%| per cento)?|cento per cento)$/, () => ({ menu: 'Dimensione reale (100%)' })],
  [/^(?:esci dal(?:la)?|chiudi (?:il|la))\s+(?:tutto schermo|schermo intero|modalità lettura|lettura a tutto schermo)$/, () => ({ id: 'schermo-off' })],
  [/^(?:(?:metti|vai|passa)\s+(?:a|in)\s+)?(?:tutto schermo|schermo intero|modalità lettura|lettura a tutto schermo)$/, () => ({ menu: 'Lettura a tutto schermo' })],
  [/^(?:mostra(?:mi)?|apri|visualizza)\s+(?:le\s+)?miniature(?: delle pagine)?$/, () => ({ menu: 'Miniature delle pagine' })],
  [/^(?:mostra(?:mi)?|apri|visualizza)\s+l'indice(?: del documento)?$/, () => ({ menu: 'Indice del documento' })],
  [/^(?:mostra(?:mi)?|apri|visualizza)\s+(?:i\s+)?segnalibri$/, () => ({ menu: 'Segnalibri' })],
  [/^(?:mostra(?:mi)?|apri|visualizza)\s+(?:l'elenco delle\s+|le\s+)?annotazioni$/, () => ({ menu: 'Elenco delle annotazioni' })],
  [/^(?:nascondi|chiudi)\s+(?:il\s+)?pannello(?: laterale)?$/, () => ({ menu: 'Nascondi il pannello laterale' })],

  // Pagine
  [/^ruota(?:\s+(?:la|questa)\s+pagina)?(?:\s+(?:a|verso)\s+(destra|sinistra)|\s+(?:in senso )?(orario|antiorario))?$/, (m) => ({ menu: (m[1] === 'sinistra' || m[2] === 'antiorario') ? 'Ruota questa pagina a sinistra' : 'Ruota questa pagina a destra' })],
  [/^(?:inserisci|aggiungi|metti)\s+una\s+pagina\s+(?:bianca|vuota)(?:\s+dopo(?: questa)?)?$/, () => ({ menu: 'Inserisci una pagina bianca dopo questa' })],
  [new RegExp(String.raw`^(?:elimina|cancella|togli|rimuovi)\s+(?:questa pagina|la pagina(?:\s+(?:numero\s+)?${NUMW})?)$`), (m) => ({ id: 'elimina-pagina', n: m[1] ? num(m[1]) : null, confirm: true })],
  [/^(?:aggiungi|metti|inserisci|crea)\s+(?:un\s+)?segnalibro(?:\s+(?:su|a)\s+questa pagina)?$|^segnalibro(?: su questa pagina)?$/, () => ({ menu: 'Segnalibro su questa pagina' })],
  [/^(?:gestisci|organizza)\s+le\s+pagine$/, () => ({ menu: 'Gestisci le pagine…' })],
  [/^estrai\s+(?:le\s+)?pagine$/, () => ({ menu: 'Estrai le pagine scelte in un nuovo PDF…' })],
  [/^unisci(?:\s+(?:con|a)\s+un\s+altro\s+(?:pdf|file|documento))?$/, () => ({ menu: 'Unisci con un altro PDF…' })],
  [/^dividi(?:\s+il\s+(?:pdf|file|documento))?$/, () => ({ menu: 'Dividi il PDF…' })],

  // File
  [/^salva con nome$|^salva(?:lo|la)? in un altro file$/, () => ({ menu: 'Salva con nome…' })],
  [/^salva (?:la )?versione definitiva$/, () => ({ menu: 'Salva versione definitiva (annotazioni fissate)…' })],
  [/^stampa(?:lo|la)?(?:\s+(?:il documento|il file|il pdf|questo documento|tutto))?$/, () => ({ menu: 'Stampa…' })],
  [/^condividi(?:lo|la)?(?:\s+(?:il documento|il file|il pdf|questo documento))?(?:\s+(?:su|con|via|per)\s+(?:whatsapp|la posta|posta|email|e-mail|mail))?$|^(?:mandalo|invialo|mandala|inviala)\s+(?:su|con|via|per)\s+(?:whatsapp|posta|email|mail)$/, () => ({ menu: 'Condividi…' })],
  [/^chiudi\s+(?:tutti i documenti|tutto|tutti i file)$/, () => ({ menu: 'Chiudi tutti i documenti' })],
  [/^chiudi(?:lo|la)?(?:\s+(?:il|questo)\s+(?:documento|file|pdf))?$/, () => ({ menu: 'Chiudi il documento' })],
  [/^(?:apri|scegli)\s+(?:un|un altro)\s+(?:pdf|file|documento)$/, () => ({ menu: 'Apri PDF…' })],
  [/^(?:mostra(?:lo)?|apri)\s+(?:nella|la)\s+cartella(?: del (?:documento|file))?$/, () => ({ menu: 'Mostra nella cartella' })],
  [/^(?:torna|vai)\s+(?:all'elenco(?: dei documenti)?|alla home|alla schermata iniziale|all'inizio di postilla)$/, () => ({ menu: 'Torna all\'elenco dei documenti' })],
  [/^(?:(?:vai|passa)\s+al\s+)?(?:documento|file)\s+successivo$|^(?:vai|passa)\s+al\s+prossimo\s+(?:documento|file)$/, () => ({ id: 'doc-su' })],
  [/^(?:(?:vai|passa|torna)\s+al\s+)?(?:documento|file)\s+precedente$/, () => ({ id: 'doc-giu' })],
  [/^(?:documenti recenti|recenti|preferiti|mostra(?:mi)? i (?:documenti )?recenti)$/, () => ({ menu: 'Documenti recenti e preferiti…' })],

  // Modifica
  [/^(?:ripeti|rifai|ripristina)(?:\s+l'ultima modifica)?$/, () => ({ menu: 'Ripeti' })],
  [/^copia(?:\s+(?:il testo|la selezione|il testo selezionato))?$/, () => ({ menu: 'Copia il testo selezionato' })],
  [/^(?:elimina|cancella)\s+l'annotazione(?: selezionata)?$/, () => ({ menu: 'Elimina l\'annotazione selezionata' })],

  // Strumenti
  [/^(?:fai\s+l'|esegui\s+l'|avvia\s+l')?ocr$|^riconosci(?:\s+il)?\s+testo(?:\s+(?:delle pagine scansionate|della scansione))?$/, () => ({ menu: 'Riconosci il testo delle pagine scansionate (OCR)' })],
  [/^(?:mostra(?:mi)?|apri)\s+(?:il\s+)?registro(?: delle modifiche)?$/, () => ({ menu: 'Registro delle modifiche…' })],
  [/^(?:usa|prendi|attiva|scegli|passa\s+(?:a|al|alla|allo))\s+(?:lo strumento\s+|la\s+|il\s+|lo\s+|l')?(penna|matita|evidenziatore|gomma|manina|mano|selezione|rettangolo|ellisse|cerchio|linea|freccia|casella di testo|nota|puntatore laser|puntatore virtuale|puntatore|laser)$/, (m) => ({ id: 'strumento', tool: TOOLS[m[1]] })],
  [/^(?:metti|aggiungi|inserisci)\s+(?:un\s+)?timbro$|^timbro$/, () => ({ menu: 'Timbro…' })],
  [/^(?:metti|aggiungi|inserisci)\s+(?:la\s+)?firma(?: visiva)?$|^firma(?: il documento)?$/, () => ({ menu: 'Firma visiva…' })],

  // Theresa e aiuto
  [/^(?:apri\s+la\s+raccolta|mostra(?:mi)?\s+la\s+raccolta|aggiungi\s+(?:una\s+cartella|un\s+file)\s+alla\s+raccolta)$/, () => ({ id: 'raccolta' })],
  [/^(?:aggiorna|ricostruisci)\s+(?:l'indice|l'elenco dei file)$|^cerca di nuovo i file$/, () => ({ id: 'indice' })],
  [/^(?:mostra(?:mi)?\s+)?(?:le\s+)?scorciatoie(?: da tastiera)?$/, () => ({ menu: 'Scorciatoie da tastiera' })],
  [/^(?:informazioni su postilla|che versione (?:è|hai)|versione di postilla)$/, () => ({ menu: 'Informazioni su Postilla' })],
];

const DIALOG_SAY = {
  'Stampa…': 'Ho aperto la stampa: scegli le pagine e tocca Stampa.',
  'Salva con nome…': 'Scegli dove salvare la copia.',
  'Apri PDF…': 'Scegli il PDF da aprire.',
};

export function parseAction(text) {
  const s = bare(text);
  if (!s) return null;
  for (const [re, make] of RULES) {
    const m = s.match(re);
    if (m) { const a = make(m); if (a.n === null && a.id === 'pagina') return null; return a; }
  }
  return null;
}

// Esegue un'azione. Restituisce il testo della risposta (detto anche a voce) e un esito per le prove e per Grok.
export async function runAction(panel, a) {
  const app = panel.app;
  const v = app.view;
  const needDoc = () => { panel.say('Apri prima un documento.'); return { error: 'nessun-documento' }; };
  const { MainMenu } = await import('../menu.js');
  const menuItem = (label) => {
    const items = (app.menu || (app.menu = new MainMenu(app))).sections().flatMap(([, list]) => list).filter((x) => x !== '-');
    return items.find((x) => x.label === label);
  };
  if (a.menu) {
    const it = menuItem(a.menu);
    if (!it) { panel.say(`La funzione «${a.menu}» non è disponibile.`); return { error: 'funzione' }; }
    if (it.off) {
      if (it.need === 'doc' && !v) return needDoc();
      panel.say(it.need === 'sel' ? 'Prima seleziona il testo sul documento.' : `«${a.menu.replace(/…$/, '')}» adesso non si può usare.`);
      return { error: 'non-disponibile' };
    }
    // Le voci che aprono una finestra (stampa, salva con nome…) restano aperte per l'utente: Theresa non le aspetta.
    const dialog = /…$/.test(a.menu);
    const p = Promise.resolve().then(() => it.run());
    if (dialog) { p.catch((e) => console.error(e)); await new Promise((r) => setTimeout(r, 150)); } else await p;
    if (dialog) { panel.say(DIALOG_SAY[a.menu] || `Ho aperto «${a.menu.replace(/…$/, '')}».`); return { action: a.menu }; }
    const done = { 'Ingrandisci': 'Ingrandito.', 'Riduci': 'Ridotto.', 'Adatta alla larghezza': 'Adattato alla larghezza.', 'Pagina intera': 'Pagina intera.', 'Prima pagina': 'Prima pagina.', 'Ultima pagina': 'Ultima pagina.', 'Chiudi il documento': 'Documento chiuso.', 'Ripeti': 'Fatto.', 'Segnalibro su questa pagina': 'Segnalibro aggiornato.' }[a.menu];
    panel.say(done || `${a.menu.replace(/…$/, '')}: fatto.`);
    return { action: a.menu };
  }
  switch (a.id) {
    case 'ascolto-off': await panel.setWake(false, { quiet: true }); panel.say('Va bene, non ascolto più. Per riattivarmi spunta «Ascolta quando dico Theresa» o premi Ctrl+Maiusc+Spazio.'); return { action: a.id };
    case 'ascolto-on': await panel.setWake(true, { quiet: true }); panel.say(panel.settings.wake ? 'Ascolto acceso: chiamami con «Theresa».' : 'Su questo dispositivo la voce non è disponibile.'); return { action: a.id };
    case 'voce-off': panel.settings.speakReplies = false; panel.save(); if (panel.replySwitch) panel.replySwitch.checked = false; panel.say('Va bene, ti rispondo solo per iscritto.'); return { action: a.id };
    case 'voce-on': panel.settings.speakReplies = true; panel.save(); if (panel.replySwitch) panel.replySwitch.checked = true; panel.say('Va bene, ti rispondo anche a voce.'); return { action: a.id };
    case 'raccolta': panel.openCollection(); return { action: a.id };
    case 'indice': { panel.say('Aggiorno l\'elenco dei PDF del dispositivo…'); const n = await app.fileIndex?.refresh(); panel.say(`Fatto: conosco ${n || 0} PDF.`); return { action: a.id, files: n }; }
    default: break;
  }
  if (!v) return needDoc();
  switch (a.id) {
    case 'pagina': {
      if (a.n < 1 || a.n > v.pages.length) { panel.say(`Il documento ha ${v.pages.length} pagine: scegli un numero da 1 a ${v.pages.length}.`); return { error: 'pagina' }; }
      v.goto(a.n - 1); panel.say(`Pagina ${a.n}.`); return { action: a.id, page: a.n };
    }
    case 'pagina-su': if (v.current >= v.pages.length - 1) { panel.say('Sei già all\'ultima pagina.'); return { action: a.id }; } v.goto(v.current + 1); panel.say(`Pagina ${v.current + 1}.`); return { action: a.id };
    case 'pagina-giu': if (v.current <= 0) { panel.say('Sei già alla prima pagina.'); return { action: a.id }; } v.goto(v.current - 1); panel.say(`Pagina ${v.current + 1}.`); return { action: a.id };
    case 'zoom': { const p = Math.max(25, Math.min(400, a.pct || 100)); v.setScale((p / 100) * (96 / 72)); panel.say(`Zoom al ${p}%.`); return { action: a.id, pct: p }; }
    case 'schermo-off': app.setReading(false); panel.say('Uscita dal tutto schermo.'); return { action: a.id };
    case 'strumento': app.tools.set(a.tool); panel.say(`Strumento: ${TOOL_LABEL[a.tool]}.`); return { action: a.id, tool: a.tool };
    case 'doc-su': case 'doc-giu': {
      if (app.tabs.length < 2) { panel.say('C\'è un solo documento aperto.'); return { action: a.id }; }
      const i = app.tabs.indexOf(app.active); const k = (i + (a.id === 'doc-su' ? 1 : -1) + app.tabs.length) % app.tabs.length;
      app.activate(app.tabs[k]); panel.say(`Documento: ${app.tabs[k].name}.`); return { action: a.id };
    }
    case 'elimina-pagina': {
      const n = a.n || v.current + 1;
      if (n < 1 || n > v.pages.length) { panel.say(`Il documento ha ${v.pages.length} pagine.`); return { error: 'pagina' }; }
      if (v.pages.length < 2) { panel.say('Il documento ha una sola pagina: non la elimino.'); return { error: 'una-pagina' }; }
      panel.pendingAction = { run: async () => { v.goto(n - 1); await new Promise((r) => setTimeout(r, 50)); await menuItem('Elimina questa pagina').run(); panel.say(`Pagina ${n} eliminata dal documento aperto. Il file cambia solo quando salvi, e Postilla salva in una copia.`); return { action: 'elimina-pagina', page: n }; } };
      panel.say(`Elimino la pagina ${n} di ${v.pages.length}? Di' «sì» per confermare o «no».`);
      return { pending: true, action: a.id, page: n };
    }
    default: panel.say('Non so ancora farlo.'); return { error: 'azione' };
  }
}
