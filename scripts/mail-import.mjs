// Returix Mail-Import: holt Bestell-Weiterleitungen aus dem Strato-Postfach
// und übergibt sie an die Supabase-Funktion "inbound-order".
// Läuft per GitHub Action alle 10 Minuten. Verarbeitete Mails werden in den
// Ordner "Returix-verarbeitet" verschoben; alles andere im Postfach bleibt unberührt.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const IMPORT_ADDRESS = 'import@returix.de';
const DONE_FOLDER = 'Returix-verarbeitet';

const { IMAP_HOST, IMAP_USER, IMAP_PASS, INBOUND_URL } = process.env;
if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS || !INBOUND_URL) {
  console.error('Fehlende Secrets: IMAP_HOST, IMAP_USER, IMAP_PASS, INBOUND_URL');
  process.exit(1);
}

const client = new ImapFlow({
  host: IMAP_HOST,
  port: 993,
  secure: true,
  auth: { user: IMAP_USER, pass: IMAP_PASS },
  logger: false,
});

// Prüft, ob die Mail an die Import-Adresse gerichtet war (To/Cc/Delivered-To/X-Forwarded-To)
function isForImport(parsed) {
  const fields = [];
  for (const key of ['to', 'cc']) {
    const v = parsed[key];
    if (v?.value) fields.push(...v.value.map(a => a.address ?? ''));
  }
  for (const h of ['delivered-to', 'x-forwarded-to', 'x-original-to', 'envelope-to']) {
    const v = parsed.headers.get(h);
    if (typeof v === 'string') fields.push(v);
    else if (v?.text) fields.push(v.text);
  }
  return fields.some(f => String(f).toLowerCase().includes(IMPORT_ADDRESS));
}

// Bei manuellen Weiterleitungen steht der Shop-Absender oft im Text ("Von: Zalando <...>")
function findOriginalFrom(text) {
  const m = text.match(/(?:^|\n)\s*(?:Von|From):\s*([^\n]{0,120})/i);
  return m ? m[1].trim() : '';
}

const run = async () => {
  await client.connect();

  // Zielordner sicherstellen
  try { await client.mailboxCreate(DONE_FOLDER); } catch { /* existiert schon */ }

  const lock = await client.getMailboxLock('INBOX');
  let processed = 0, skipped = 0;
  try {
    const unseen = await client.search({ seen: false });
    if (!unseen || unseen.length === 0) { console.log('Keine neuen Mails.'); return; }

    for (const uid of unseen) {
      const { content } = await client.download(String(uid));
      const raw = [];
      for await (const chunk of content) raw.push(chunk);
      const parsed = await simpleParser(Buffer.concat(raw));

      if (!isForImport(parsed)) { skipped++; continue; } // private Mail → nicht anfassen

      const text = (parsed.text || parsed.html || '').slice(0, 20000);
      const payload = {
        from: parsed.from?.value?.[0]?.address ?? '',
        orig_from: findOriginalFrom(parsed.text || ''),
        subject: parsed.subject ?? '',
        text,
      };

      const res = await fetch(INBOUND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      console.log(`Mail "${payload.subject.slice(0, 50)}" → ${res.status} ${body.slice(0, 120)}`);

      if (res.ok) {
        // aus dem Posteingang in den Verarbeitet-Ordner verschieben
        await client.messageMove(String(uid), DONE_FOLDER, { uid: true });
        processed++;
      }
    }
  } finally {
    lock.release();
  }
  console.log(`Fertig: ${processed} verarbeitet, ${skipped} ignoriert (nicht an ${IMPORT_ADDRESS}).`);
  await client.logout();
};

run().catch(err => { console.error(err); process.exit(1); });
