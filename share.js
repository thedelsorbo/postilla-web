// Condividi il PDF (WhatsApp, posta e altre app).
// Prima si salva, così chi riceve il file vede anche annotazioni e modifiche.
// Android: si apre l'elenco delle app del sistema. Windows: WhatsApp, posta (Outlook) o copia del file da incollare.
import { ask, baseName, toast } from './core.js';

export async function shareDoc(a, v) {
  if (!v?.tab) return false;
  if (v.tab.dirty) {
    const c = await ask('Prima salvo il PDF', 'Così anche chi lo riceve vede le annotazioni e le modifiche.',
      [{ label: 'Annulla', value: 'x' }, { label: 'Condividi senza le modifiche', value: 'no' }, { label: 'Salva e condividi', value: 'yes', primary: true }]);
    if (c === 'x' || c === undefined) return false;
    if (c === 'yes' && !(await a.save(v))) return false;
  }
  const file = v.tab.path;
  const name = baseName(file);
  const targets = await host.shareTargets();
  // Android: l'elenco delle app lo mostra il sistema (WhatsApp, Gmail, Drive, Bluetooth…).
  if (targets === null) {
    if (!(await host.shareSystem(file))) { toast('Condivisione non riuscita: il file non è leggibile.', 'error'); return false; }
    return true;
  }
  const choices = [{ label: 'Annulla', value: 'x' }];
  choices.push({ label: 'Copia il file', value: 'copy' });
  if (targets.mail) choices.push({ label: 'Posta (Outlook)', value: 'mail' });
  if (targets.whatsapp) choices.push({ label: 'WhatsApp', value: 'whatsapp', primary: true });
  const c = await ask(`Condividi «${name}»`,
    targets.whatsapp ? 'Per WhatsApp: Postilla copia il PDF e apre WhatsApp; scegli la chat e premi Ctrl + V, poi Invio.' : 'Postilla copia il PDF: poi lo incolli con Ctrl + V dove vuoi (chat, posta, cartella).',
    choices);
  if (c === 'x' || c === undefined) return false;
  if (c === 'mail') {
    if (!(await host.shareMail(file))) { toast('Non riesco ad aprire Outlook. Usa «Copia il file» e incollalo nel messaggio.', 'error'); return false; }
    toast('Si apre un nuovo messaggio di posta con il PDF allegato.');
    return true;
  }
  if (!(await host.shareCopy(file))) { toast('Non riesco a copiare il file.', 'error'); return false; }
  if (c === 'whatsapp') {
    await host.shareWhatsapp();
    toast('PDF copiato. In WhatsApp apri la chat, premi Ctrl + V e poi Invio.');
  } else toast('PDF copiato: incollalo con Ctrl + V nella chat, nel messaggio o in una cartella.');
  return true;
}
