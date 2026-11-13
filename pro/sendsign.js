// «Invia per la firma» (0.9.0): prepara il PDF da far firmare a un'altra persona, senza servizi a pagamento.
// 1) Nel documento si mette un campo firma (Crea un modulo → Firma digitale); 2) si salva; 3) Postilla prepara
// il testo del messaggio e apre «Condividi» (posta, WhatsApp…): l'invio lo fa sempre l'utente.
// Chi riceve firma nel campo con il proprio certificato (Acrobat Reader, Postilla o altro programma di firma);
// quando il PDF torna, «Verifica le firme digitali» dice chi ha firmato e se il documento è integro.
import { h, modal, toast, ask, clipWrite } from '../core.js';
import { emptySigFields } from './signature.js';

export async function sendForSignature(app, view) {
  view = view || app.view;
  if (!view) return null;
  await view.ready;
  // Campi appena disegnati: diventano veri solo salvando.
  if (view.annots.some((a) => a.type === 'field') || view.tab.dirty) {
    const c = await ask('Prima salvo il documento', 'Per inviarlo serve la versione salvata, con il campo firma vero.', [{ label: 'Annulla', value: 'no' }, { label: 'Salva', value: 'yes', primary: true }]);
    if (c !== 'yes' || !(await app.save(view))) return null;
  }
  const fields = await emptySigFields(await view.ensureBytes()).catch(() => []);
  if (!fields.length) {
    const c = await ask('Manca il campo per la firma', 'Disegna sulla pagina il riquadro dove l\'altra persona deve firmare; poi scegli di nuovo «Invia per la firma».', [{ label: 'Annulla', value: 'no' }, { label: 'Aggiungi il campo firma', value: 'yes', primary: true }]);
    if (c === 'yes') { app.tools.fieldKind = 'sig'; app.tools.set('field'); toast('Disegna il riquadro della firma, oppure tocca dove metterlo.'); }
    return null;
  }
  const where = fields.map((f) => `«${f.name}» (pagina ${f.page + 1})`).join(', ');
  const text = `Buongiorno,\nle invio il documento «${view.tab.name}» da firmare digitalmente nel campo ${where}.\nPuò firmarlo con il suo certificato di firma digitale (per esempio con Adobe Acrobat Reader o con Postilla) e poi rimandarmelo.\nGrazie.`;
  return modal((box, done) => {
    box.classList.add('sendsign-dialog');
    const ta = h('textarea', { rows: '7', class: 'para-input', 'aria-label': 'Testo del messaggio' }, text);
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    box.append(h('h2', {}, 'Invia per la firma'),
      h('p', {}, `Campi da firmare: ${where}.`),
      h('label', {}, 'Testo del messaggio (puoi cambiarlo)', ta),
      h('p', { class: 'hint' }, 'Postilla non invia nulla da sola: copia il testo, poi con «Condividi il PDF» scegli posta o WhatsApp e invii tu. Quando il documento torna firmato, aprilo e usa Documento → «Verifica le firme digitali».'),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'sendsign-copy', onclick: async () => { if (await clipWrite(ta.value)) toast('Testo copiato: incollalo nel messaggio.'); else toast('Non riesco a copiare il testo.', 'error'); } }, 'Copia il testo'),
        h('button', { onclick: () => done(false) }, 'Chiudi'),
        h('button', { class: 'primary sendsign-share', onclick: async () => { done(true); const { shareDoc } = await import('../share.js'); shareDoc(app, view); } }, 'Condividi il PDF…')));
  });
}
