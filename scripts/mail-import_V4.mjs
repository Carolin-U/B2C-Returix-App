// Returix Mail-Import V4 (= V3 + Fix: Verbindung wird IMMER sauber beendet).
// Ursache des Hängens in V1–V3: Bei "Keine neuen Mails" sprang das Skript vor dem Abmelden heraus,
// die offene Verbindung hielt das Programm am Leben, bis GitHub es abbrach.
// holt Bestell-Weiterleitungen aus dem Strato-Postfach
// und übergibt sie an die Supabase-Funktion "inbound-order".
// Läuft per GitHub Action alle 10 Minuten.
//
// Änderungen gegenüber V1:
//  - Verarbeitete Mails werden GELÖSCHT statt verschoben (Datenschutz-Regel: keine Rohmails
//    aufbewahren). Zum Testen: Secret/Env KEEP_PROCESSED=1 setzen, dann wird wie bisher in den
//    Ordner "Returix-verarbeitet" verschoben.
//  - Mails werden über ihre feste UID angesprochen (V1 mischte Positionsnummer und UID,
//    dadurch konnte die falsche Mail verschoben werden).
//  - Das Datum der Mail wird mitgeschickt (für korrektes Bestelldatum und Frist).
//  - Logs enthalten keine Betreffzeilen oder Adressen mehr.
// Alles im Postfach, das nicht an die Import-Adresse ging, bleibt unberührt.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const IMPORT_ADDRESS = 'import@returix.de';
const DONE_FOLDER = 'Returix-verarbeitet';

const { IMAP_HOST, IMAP_USER, IMAP_PASS, INBOUND_URL } = process.env;
const KEEP_PROCESSED = process.env.KEEP_PROCESSED === '1';
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
  // V3: nicht endlos warten, sondern nach kurzer Zeit mit klarer Meldung abbrechen
  connectionTimeout: 30000,
  greetingTimeout: 20000,
  socketTimeout: 60000,
});

// V3: Schritt-Protokoll ohne persönliche Daten
const step = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

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

// Welche Adresse gehört zum Returix-Nutzer?
// - manuelle Weiterleitung: Absender = Nutzer
// - automatische Weiterleitung (Gmail-Filter): Absender = Shop, Nutzer steht in
//   X-Forwarded-For / Delivered-To / X-Original-To / Return-Path
function collectCandidates(parsed) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    const s = typeof v === 'string' ? v : (v.text ?? '');
    for (const m of String(s).toLowerCase().matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)) out.push(m[0]);
  };
  push(parsed.from?.value?.[0]?.address);
  for (const h of ['x-forwarded-for', 'delivered-to', 'x-original-to', 'envelope-to', 'return-path', 'reply-to']) {
    push(parsed.headers.get(h));
  }
  // Import-Adresse selbst ist nie der Nutzer
  return [...new Set(out)].filter(a => !a.includes(IMPORT_ADDRESS.split('@')[0] + '@'));
}

const run = async () => {
  step(`Verbinde mit ${IMAP_HOST}:993 …`);
  await client.connect();
  step('Verbunden und angemeldet.');

  if (KEEP_PROCESSED) {
    try { await client.mailboxCreate(DONE_FOLDER); } catch { /* existiert schon */ }
  }

  const lock = await client.getMailboxLock('INBOX');
  step('Posteingang geöffnet.');
  let processed = 0, skipped = 0, failed = 0;
  try {
    // UIDs statt Positionsnummern: bleiben stabil, auch wenn zwischendurch Mails entfernt werden
    const unseen = await client.search({ seen: false }, { uid: true });
    step(`Ungelesene Mails: ${unseen ? unseen.length : 0}`);
    if (!unseen || unseen.length === 0) { console.log('Keine neuen Mails.'); return; }

    for (const uid of unseen) {
      const { content } = await client.download(String(uid), undefined, { uid: true });
      const raw = [];
      for await (const chunk of content) raw.push(chunk);
      const parsed = await simpleParser(Buffer.concat(raw));

      if (!isForImport(parsed)) { skipped++; continue; } // private Mail → nicht anfassen

      const text = (parsed.text || parsed.html || '').slice(0, 20000);
      const payload = {
        from: parsed.from?.value?.[0]?.address ?? '',
        candidates: collectCandidates(parsed),            // mögliche Nutzer-Adressen
        orig_from: (parsed.from?.value?.[0]?.address ?? '') + ' ' + findOriginalFrom(parsed.text || ''),
        subject: parsed.subject ?? '',
        text,
        date: parsed.date instanceof Date ? parsed.date.toISOString() : null,
      };

      const res = await fetch(INBOUND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // Nur Ergebnis-Art loggen, keine Inhalte
      let info = {};
      try { info = await res.json(); } catch { /* keine JSON-Antwort */ }
      const result = info.kind ?? (info.skipped ? 'übersprungen' : info.error ? 'Fehler' : 'unbekannt');
      console.log(`Mail UID ${uid} → ${res.status} ${result}`);

      if (res.ok) {
        if (KEEP_PROCESSED) await client.messageMove(String(uid), DONE_FOLDER, { uid: true });
        else await client.messageDelete(String(uid), { uid: true });
        processed++;
      } else {
        failed++; // bleibt ungelesen im Posteingang und wird beim nächsten Lauf erneut versucht
      }
    }
    console.log(`Fertig: ${processed} verarbeitet, ${skipped} ignoriert, ${failed} fehlgeschlagen.`);
  } finally {
    lock.release();
    // V4: Abmelden passiert jetzt in jedem Fall – auch bei "Keine neuen Mails" oder einem Fehler
    await client.logout().catch(() => {});
    step('Abgemeldet.');
  }
};

// V3: verständliche Fehlerausgabe (Art des Fehlers, ohne Zugangsdaten)
run().then(() => process.exit(0)).catch(err => {
  const info = [err.code, err.authenticationFailed ? 'ANMELDUNG FEHLGESCHLAGEN (Benutzer/Passwort prüfen)' : '', err.responseText, err.message]
    .filter(Boolean).join(' | ');
  console.error('FEHLER: ' + info);
  process.exit(1);
});
// V3: Notbremse, falls trotz Zeitlimits etwas hängt
setTimeout(() => { console.error('FEHLER: Abbruch nach 3 Minuten ohne Abschluss.'); process.exit(1); }, 180000).unref();
