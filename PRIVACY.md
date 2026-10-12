# Privacy — Ambraia

*English · [Italiano](#italiano)* — last updated: version 1.0.1

This notice explains which data Ambraia handles and where it goes. It is written with the GDPR (Regulation (EU) 2016/679), the Italian Privacy Code (D.Lgs. 196/2003 as amended by D.Lgs. 101/2018) and the [Obsidian developer policies](https://docs.obsidian.md/Developer+policies) in mind.

## In short
- **The developer collects nothing.** Ambraia has no server, no account, no telemetry, no analytics, no ads and no crash reporting. The developer (d4ruerk1) does not receive, store or process any personal data of users.
- Your notes stay on your devices and go **directly** to the services *you* choose (cloud storage, AI provider, sharing relay). For that data you decide; the developer is neither controller nor processor.
- Everything that talks to the network is **optional** and off until you set it up, except the features you explicitly use (see the table).

## What goes where
| Feature | When | Who receives what |
|---|---|---|
| Cloud sync (Google Drive, Dropbox, OneDrive, pCloud) | only if you connect a service | that provider: your files (encrypted, if you turn encryption on), sign-in tokens; it sees your IP address like any app |
| MEGA / Proton Drive / local folder | only if you choose it (desktop) | nothing over the network from Ambraia: it writes into the folder of their desktop app, which uploads it |
| Device list and pairing | while sync is on | a small `.ambraia` folder **inside your vault folder in the cloud** with encrypted, opaquely named records (device name, platform, public keys, certificate, last seen, your shared-link list) and short-lived pairing files (deleted after use or after 5 minutes) |
| AI assistant | off by default; only when you use it | the AI provider you configure: your prompt, selected text and the notes you attach or that the assistant retrieves. With a local model (LM Studio, Ollama) nothing leaves your computer. Excluded folders are never sent |
| AI web tools | only with AI on; web search is on by default with AI | official APIs only: Google Search and YouTube videos through the Gemini API (only if you add a Gemini key; Google receives the query or the video address — on the free tier Google may use it to improve its services), YouTube Data API (only with your key), YouTube oEmbed (title), DuckDuckGo Instant Answers and Wikipedia (free search without a key), your SearXNG, the pages you ask it to read, `publish.twitter.com` oEmbed (X posts): IP address and user agent `Ambraia/1.0` |
| Photo covers | only when you **pick** a photo | `picsum.photos` and its CDN: IP address and user agent (gallery previews are bundled, browsing sends nothing) |
| Shared links | only if you create a link | the relay (`ntfy.sh` by default, or your server): IP addresses, random topic names, time and size of end-to-end encrypted messages, kept for about 12 hours. The reading page (GitHub Pages by default) is opened by the people you send the link to; GitHub sees their IP address and user agent |
| Donation link, GitHub links | only if you click them | your browser opens Ko-fi / GitHub |

## Shared links
- Content is **end-to-end encrypted**: the key is in the part of the link after `#`, which browsers never send to any server. Neither the developer, GitHub nor the relay can read notes.
- While Obsidian is open and at least one link is active, your devices keep a connection to the relay to answer readers.
- The reading page sets no cookies, uses no storage, analytics or third-party resources (strict Content-Security-Policy) and removes the key from the address bar after opening.
- A profile that **can edit** sees the full text of the note (properties excluded) and what it writes goes into your vault: give it only to people you trust.
- You decide what to share and with whom. If a note contains other people's personal data, you are the controller of that sharing (unless it is purely personal or household use).

## On your device
- Keys and tokens are kept in Obsidian's secret storage (the system keychain), never in `data.json`. Logs contain no tokens.
- Settings live in the plugin folder (`data.json`, `state/`). A few local-storage keys (device id/name, small UI flags) are used. Obsidian's Uninstall deletes the plugin folder (with `data.json` and `state/`); Ambraia then notices that its manifest is gone and deletes its keychain entries and local-storage keys.
- AI chats you save are ordinary Markdown notes in your vault.

## Your rights
Your GDPR rights (access, rectification, erasure, restriction, portability, objection) apply towards the providers that actually process your data (your cloud, AI or relay provider) under their own privacy policies. You can lodge a complaint with your supervisory authority — in Italy the [Garante per la protezione dei dati personali](https://www.garanteprivacy.it).

## Minors
Under Italian Law 132/2025 (art. 4) people under 14 may use AI tools only with the consent of whoever holds parental responsibility. Ambraia's AI is off by default.

## Contact
Questions about this notice: open an issue at [github.com/d4ruerk1/Obsidian-Ambraia](https://github.com/d4ruerk1/Obsidian-Ambraia/issues). Do not post personal data or note contents in public issues.

---

<a id="italiano"></a>
# Privacy — Ambraia (italiano)

Questa informativa spiega quali dati tratta Ambraia e dove vanno, tenendo conto del GDPR (Reg. UE 2016/679), del Codice privacy (D.Lgs. 196/2003 come modificato dal D.Lgs. 101/2018) e delle [regole per gli sviluppatori di Obsidian](https://docs.obsidian.md/Developer+policies).

## In breve
- **Lo sviluppatore non raccoglie nulla.** Ambraia non ha server, account, telemetria, statistiche, pubblicità né segnalazioni automatiche di errori. Lo sviluppatore (d4ruerk1) non riceve, non conserva e non tratta dati personali degli utenti.
- Le note restano sui tuoi dispositivi e vanno **direttamente** ai servizi che scegli tu (cloud, fornitore AI, servizio di inoltro dei link). Su quei dati decidi tu: lo sviluppatore non è titolare né responsabile del trattamento.
- Tutto ciò che usa la rete è **facoltativo** e resta spento finché non lo configuri o lo usi.

## Cosa va dove
- **Sincronizzazione** (Google Drive, Dropbox, OneDrive, pCloud): solo se colleghi un servizio; il fornitore riceve i file (cifrati, se attivi la cifratura) e i token di accesso. **MEGA / Proton Drive / cartella locale** (computer): Ambraia scrive solo nella cartella della loro app desktop.
- **Elenco dispositivi e collegamento**: una piccola cartella `.ambraia` **dentro la cartella del vault nel cloud**, con record cifrati e dal nome anonimo (nome del dispositivo, piattaforma, chiavi pubbliche, certificato, ultimo accesso, elenco dei link condivisi) e file temporanei di collegamento (cancellati dopo l'uso o dopo 5 minuti).
- **Assistente AI** (spento di default): il fornitore che configuri riceve richiesta, testo selezionato e note allegate o recuperate; con un modello locale (LM Studio, Ollama) nulla lascia il computer. Le cartelle escluse non vengono mai inviate.
- **Strumenti web dell'AI** (solo con l'AI attiva; la ricerca web è attiva di default con l'AI), solo tramite API ufficiali: Ricerca Google e video YouTube tramite l'API Gemini (solo se aggiungi una chiave Gemini; Google riceve la ricerca o l'indirizzo del video — sul piano gratuito può usarli per migliorare i suoi servizi), YouTube Data API (solo con la tua chiave), oEmbed di YouTube (titolo), DuckDuckGo Instant Answers e Wikipedia (ricerca gratuita senza chiave), il tuo SearXNG, le pagine che chiedi di leggere, l'oEmbed di `publish.twitter.com`: vedono IP e user agent `Ambraia/1.0`.
- **Foto di copertina**: solo quando ne **scegli** una, `picsum.photos` e la sua CDN vedono IP e user agent.
- **Link condivisi** (solo se ne crei): il servizio di inoltro (`ntfy.sh` di default o un tuo server) vede indirizzi IP, nomi di canale casuali, orario e dimensione dei messaggi cifrati end-to-end, conservati per circa 12 ore; la pagina di lettura (GitHub Pages) è aperta da chi riceve il link e GitHub ne vede IP e user agent. Mentre Obsidian è aperto ed esiste almeno un link attivo, i tuoi dispositivi restano collegati al servizio di inoltro per rispondere.
- **Link a donazioni e GitHub**: si aprono nel browser solo se li clicchi.

## Link condivisi
Il contenuto è **cifrato end-to-end**: la chiave sta dopo `#` e il browser non la invia a nessun server. La pagina di lettura non usa cookie, archiviazione, statistiche o risorse di terzi e toglie la chiave dalla barra degli indirizzi. Un profilo che **può modificare** vede il testo completo (proprietà escluse) e ciò che scrive entra nel vault: dallo solo a persone di fiducia. Sei tu a decidere cosa condividere; per note con dati personali di altri sei titolare di quella condivisione, salvo l'uso esclusivamente personale o domestico.

## Sul dispositivo
Chiavi e token stanno nell'archivio sicuro di Obsidian (portachiavi di sistema), mai in `data.json`; i registri non contengono token. Impostazioni nella cartella del plugin (`data.json`, `state/`) e poche chiavi di memoria locale; «Disinstalla» di Obsidian elimina la cartella del plugin (con `data.json` e `state/`); Ambraia si accorge che il suo manifest non c'è più ed elimina le sue credenziali nel portachiavi e le chiavi nella memoria locale.

## Diritti
I diritti previsti dal GDPR (accesso, rettifica, cancellazione, limitazione, portabilità, opposizione) si esercitano verso i fornitori che trattano effettivamente i tuoi dati, secondo le loro informative. Puoi proporre reclamo al [Garante per la protezione dei dati personali](https://www.garanteprivacy.it).

## Minori
Secondo la Legge 132/2025 (art. 4) chi ha meno di 14 anni può usare strumenti di AI solo con il consenso di chi esercita la responsabilità genitoriale. L'AI di Ambraia è spenta di default.

## Contatti
Per domande su questa informativa apri una segnalazione su [GitHub](https://github.com/d4ruerk1/Obsidian-Ambraia/issues), senza inserire dati personali o contenuti delle note.
