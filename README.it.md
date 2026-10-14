# Ambraia

*[English](README.md) · Italiano* — di [d4ruerk1](https://github.com/d4ruerk1) · licenza MIT · [Note legali](LEGAL.md#italiano) · [Privacy](PRIVACY.md#italiano) · [Donazione](https://ko-fi.com/d4ruerk1) (facoltativa)

Plugin per Obsidian che aggiunge icone e copertine alle pagine, database, modelli, calendario e un'interfaccia rinnovata, sincronizza il vault quasi in tempo reale con uno o più servizi insieme tra Google Drive, Dropbox, OneDrive, pCloud, MEGA e Proton Drive (con cifratura end-to-end opzionale) e include un assistente AI facoltativo (cloud o locale, ad esempio LM Studio), **disattivato per impostazione predefinita**.

Il nome viene da *ambra* (che conserva intatto ciò che custodisce, come le tue note) con dentro **AI**: Ambr**ai**a, si pronuncia *am-BRÀI-a*.

L'interfaccia segue la lingua di Obsidian: English (predefinita), Italiano, Español, Deutsch, Français, العربية, Русский, 中文, 日本語. Puoi forzarla in Impostazioni → Ambraia → Lingua.

## Installazione

Richiede Obsidian 1.13.0 o successivo (desktop e mobile).

> **Plugin della community: in revisione.** Ambraia è stato proposto per l'elenco dei plugin della community di Obsidian ed è in attesa di approvazione: finché non viene approvato **non** compare in Impostazioni → Plugin della community → Sfoglia. Per ora installalo a mano (qui sotto) oppure con il plugin [BRAT](https://github.com/TfTHacker/obsidian42-brat) (aggiungi il plugin beta `d4ruerk1/Obsidian-Ambraia`).

1. Dalla [release più recente](https://github.com/d4ruerk1/Obsidian-Ambraia/releases) scarica i tre file `main.js`, `manifest.json` e `styles.css` (oppure estrai `Ambraia-<versione>.zip`, che contiene una cartella `ambraia` con gli stessi tre file).
2. Mettili nella cartella `<tuo vault>/.obsidian/plugins/ambraia` (creala se non c'è) (la cartella `.obsidian` è nascosta: su macOS `Cmd+Shift+.`, su Windows "Mostra elementi nascosti").
   Tutto ciò che Ambraia usa sul dispositivo sta nella sua cartella: impostazioni in `data.json`, stato della sincronizzazione, base per le unioni e indice AI in `state/`. Aggiornando la cartella resta; disinstallando (o eliminando la cartella) viene rimossa (vedi «Disinstallazione»).
3. In Obsidian apri Impostazioni → Plugin della community, disattiva la modalità con restrizioni se è attiva, poi attiva **Ambraia** (dopo un aggiornamento: disattiva e riattiva, oppure riavvia Obsidian).
4. Apri Impostazioni → **Ambraia**.

Repository e codice sorgente: [github.com/d4ruerk1/Obsidian-Ambraia](https://github.com/d4ruerk1/Obsidian-Ambraia).

**Manutenzione automatica**: qualche minuto dopo l'avvio, al massimo una volta a settimana e solo quando Obsidian è inattivo, Ambraia compatta ciò che ha scritto lui stesso: chiavi `icon`/`banner` vuote, posizione predefinita della copertina, blocchi di frontmatter vuoti (sulle note una sola volta per versione), impostazioni di file che non esistono più, cache rigenerabili. Il testo delle note e le altre proprietà non vengono mai modificati.

## Sincronizzazione nel cloud
Servizi supportati: **Google Drive**, **Dropbox**, **Microsoft OneDrive**, **pCloud** (collegamento diretto su computer, iPhone e Android) e **MEGA** / **Proton Drive** (tramite la cartella della loro app desktop, solo su computer).

Viene sincronizzata **tutta la cartella del vault**: note, allegati e, per impostazione predefinita, anche impostazioni di Obsidian, temi, snippet e plugin della community (codice e impostazioni). Non vengono mai sincronizzati il layout delle finestre di ogni dispositivo (`workspace*.json`), cache, cestino, lo stato interno di Ambraia e le credenziali. Quando arrivano impostazioni o plugin da un altro dispositivo compare il pulsante **Ricarica ora**. Le impostazioni di Ambraia stesso si applicano subito, mantenendo su ogni dispositivo i propri interruttori di sync.

### Primo dispositivo
1. Impostazioni → Ambraia → Sincronizzazione → **Configura**.
2. Scegli il servizio e premi **Accedi con …**. Ambraia sceglie da solo il metodo più semplice per il dispositivo:
   - **computer**: si apre il browser, accedi e consenti; Ambraia continua da solo;
   - **telefono** (Google Drive, OneDrive): compare un codice breve, già copiato negli appunti; si apre la pagina del servizio, incolli il codice e accedi. Puoi farlo anche da un altro dispositivo;
   - **Dropbox / pCloud**: dopo l'accesso il servizio mostra un codice; premi **Incolla**.
   - MEGA e Proton Drive: installa la loro app desktop e scegli la cartella che sincronizza (incolla il percorso o tocca uno dei suggerimenti automatici).
3. Scegli la **cartella nel cloud** (predefinita `Ambraia/<nome del vault>`). Ambraia mostra le cartelle di vault già presenti su quell'account e quale tuo dispositivo le usa, e preseleziona quella usata dagli altri dispositivi della catena (o quella con il nome del vault): così, scegliendo per esempio Google Drive su un nuovo dispositivo, si unisce alla cartella esistente invece di crearne una nuova. Lo stesso percorso scritto con maiuscole diverse viene ricondotto alla cartella esistente. Puoi cambiarla in seguito.
4. Facoltativo ma consigliato: attiva la **cifratura end-to-end**.

### Più servizi insieme
Puoi tenere attivi contemporaneamente più servizi, ad esempio Google Drive e MEGA: Impostazioni → Ambraia → Sincronizzazione → **Aggiungi un servizio**.
- Ogni servizio ha la sua scheda con interruttore, **Sincronizza ora**, cartella nel cloud, cifratura, registro, **Riallinea da zero** e **Rimuovi**. Credenziali, chiave e stato di sincronizzazione sono separati per ogni servizio.
- Il vault fa da centro: ciò che arriva da un servizio viene inviato anche agli altri. I servizi si alternano (mai due sincronizzazioni insieme sugli stessi file), quindi non si pestano i piedi.
- **Chiave principale uguale per tutti o dedicata**: quando aggiungi un servizio cifrato puoi usare la stessa chiave principale degli altri (una sola chiave da ricordare, un solo sblocco all'avvio, e "Cambia chiave principale" la cambia su tutti) oppure una chiave dedicata solo a quel servizio, ad esempio per MEGA. Puoi passare dall'una all'altra in qualsiasi momento dalla scheda del servizio (menu **Chiave principale**). In entrambi i casi ogni cartella nel cloud ha un proprio file della chiave.
- La barra di stato mostra lo stato più urgente tra i servizi; il menu elenca lo stato di ciascuno. Compare un'icona per ogni sincronizzazione davvero in uso: con un servizio di Ambraia e Obsidian Sync non collegato solo quella di Ambraia (l'icona inattiva di Obsidian viene nascosta); senza servizi di Ambraia solo quella di Obsidian; con entrambi in uso, tutte e due.
- Aggiornando da una versione precedente, il servizio già configurato diventa il primo della lista, senza ricollegarlo e senza riconfrontare i file.

### Accesso con un clic (app integrate)
Google, Dropbox, Microsoft e pCloud richiedono che ogni programma sia registrato come "app OAuth". Ci sono due modi:
- **App integrata (consigliato per chi distribuisce il plugin)**: registri le app una sola volta, copi `apps.example.json` in `apps.json`, inserisci gli ID e lanci `npm run build`. Gli utenti vedono solo il pulsante **Accedi**, senza ID né segreti. Per Google crea un client di tipo **"TVs and Limited Input devices"** (funziona su computer e telefono) con il solo scope `drive.file`, che è un permesso non sensibile. Per Microsoft attiva "Allow public client flows". `apps.json` non viene mai messo nello zip né in Git.
- **App personale**: senza `apps.json`, la procedura chiede Client ID e Secret; il pulsante **(?)** spiega come ottenerli in 2–3 minuti. Con un'app integrata la stessa opzione si trova in "Avanzato: usa la tua app".

### Cifratura end-to-end
- Tutto viene cifrato sul dispositivo prima di uscire: contenuto dei file e, se vuoi, anche i nomi di file e cartelle.
- Scegli l'algoritmo: **AES-256-GCM** (predefinito, accelerato in hardware), **XChaCha20-Poly1305** (ottimo su telefoni senza AES hardware) oppure **AES-256-CTR + HMAC-SHA-256**. Tutti sono autenticati: qualsiasi modifica ai file nel cloud viene rilevata e rifiutata.
- La **chiave principale** viene trasformata con Argon2id (64 MiB) o PBKDF2-SHA-256 (600.000 iterazioni) e protegge una chiave dati casuale; cambiare la chiave principale non richiede di ricaricare i file.
- La chiave principale non lascia mai i tuoi dispositivi e **non si può recuperare**: conservala in un password manager. Puoi scegliere se ricordarla su ogni dispositivo (archivio sicuro di Obsidian) o inserirla a ogni avvio.
- Se la cartella nel cloud è già cifrata, gli altri dispositivi lo rilevano e chiedono la chiave.

### Altri dispositivi (anche iPhone e Android)
- Sul dispositivo già configurato apri Sincronizzazione → **Collega un dispositivo**: compare un **codice di 8 caratteri** (es. `K7QM-3XRD`).
- Sul nuovo dispositivo apri Configura → **Ho già Ambraia su un altro dispositivo**, scegli lo stesso servizio, accedi con lo stesso account, controlla la **cartella del vault nel cloud** (di solito è già selezionata) e digita il codice.
- Il codice **vale 5 minuti, si usa una sola volta e viene annullato appena chiudi la finestra** che lo mostra. Puoi generarne uno nuovo in qualsiasi momento.
- Il codice **non contiene alcun segreto** né le credenziali del cloud: il nuovo dispositivo accede da solo al tuo account e il codice serve solo a far trovare i due dispositivi. Questi concordano una chiave usa e getta (ECDH P-256) e mostrano entrambi lo stesso **codice di verifica di 6 cifre**: niente (cartella, chiave di cifratura, chiave dell'elenco dispositivi) viene inviato finché non premi **Approva** sul dispositivo già collegato. Puoi anche **Rifiutare**.
- **Dispositivi collegati (tutti uguali)**: nella scheda di ogni servizio trovi l'elenco dei dispositivi che lo usano, con l'ultimo accesso. Non ci sono proprietari né amministratori: da **qualsiasi** dispositivo (il primo PC, il telefono, …) puoi collegarne di nuovi e scegliere quali togliere dalla sincronizzazione, anche il primo. Ogni dispositivo è presentato da quello che lo ha approvato (un certificato firmato) e ogni rimozione è firmata e verificata da tutti i dispositivi: un dispositivo rimosso non può inviare comandi né rientrare senza un nuovo codice; un dispositivo che nessuno ha presentato è segnato come **Non verificato**. Una rimozione si può annullare finché non viene eseguita. Dal menu ⋯ puoi anche **scollegare ed eliminare i dati** di un dispositivo (le note del vault e i dati di Ambraia su quel dispositivo). I comandi vengono eseguiti la prossima volta che quel dispositivo è online; per un dispositivo smarrito revoca anche l'accesso dalle impostazioni del tuo account cloud. L'elenco è cifrato, con nomi di file anonimi, in una piccola cartella `.ambraia` **dentro la cartella del vault nel cloud** (la 1.0.0 la teneva nella radice del cloud: viene spostata da sola).
- **Accesso scaduto o revocato**: compare «Accedi di nuovo»; cartella, cifratura e impostazioni restano invariate.
- **Attivare o cambiare la cifratura** mostra ogni passaggio (ultima sincronizzazione, generazione della chiave, file della chiave) e chiude la finestra appena la nuova chiave è salvata; le vecchie copie nel cloud finiscono nel cestino in background, con l'avanzamento nella barra di stato.
- **PC e telefono con note già presenti**: la prima sincronizzazione unisce i due contenuti, senza sovrascrivere.

### Quando qualcosa va storto nel cloud
Ambraia si adatta da solo ai problemi dei servizi, senza bisogno di aggiornamenti, e ti avvisa una volta sola (niente raffiche di avvisi). Se Obsidian è in background ricevi anche una notifica di sistema (disattivabile in Avanzate).
- **Spazio esaurito o piano declassato** (es. Google Drive passato a un piano più piccolo): prima di caricare, Ambraia controlla lo spazio libero. Se non basta, **non inizia** il caricamento invece di lasciare un backup a metà: i file restano sul dispositivo, i download dagli altri dispositivi continuano e il servizio appare come "pieno". Ogni 30 minuti ricontrolla e riprende da solo appena c'è posto (o subito con **Sincronizza ora**). Ti avvisa anche quando lo spazio sta per finire, e la scheda del servizio mostra lo spazio libero. Prima di attivare o cambiare la cifratura verifica che ci sia posto per riscrivere tutto.
- **Servizio irraggiungibile o guasto** (es. OneDrive con errori del server): riprova in automatico con attese crescenti; se il problema dura più di 10 minuti mentre la connessione funziona ti avvisa, e ti avvisa di nuovo quando torna tutto a posto. Se sei semplicemente offline non disturba.
- **Limiti di utilizzo** (troppe richieste, limiti giornalieri): rispetta i tempi indicati dal servizio e ti dice a che ora riprende.
- **Risposte inattese** (API cambiate, proxy, Wi-Fi con pagina di accesso): una risposta strana non viene mai scambiata per "file eliminati"; la sincronizzazione si ferma, riprova sempre più di rado e ti avvisa se continua. Un token che non si rinnova per un guasto temporaneo non ti chiede di ricollegare l'account.
- **Cartella nel cloud sparita**: nulla viene toccato; Ambraia ricontrolla ogni 15 minuti e riprende da solo se la cartella torna (es. ripristinata dal cestino).
- **File rifiutati più volte** (nome non accettato, file bloccato): un solo avviso con l'elenco, il resto continua. **Disco del dispositivo pieno**: ti avvisa e riprova ogni 10 minuti senza cancellare nulla altrove.

### Come funziona
- Le modifiche locali partono circa 1 secondo dopo che smetti di scrivere; quelle remote vengono controllate ogni pochi secondi (lista modifiche del servizio quando disponibile, quindi una sola richiesta leggera).
- **Esiste sempre una sola versione di ogni file, ovunque** (nel cloud e su ogni dispositivo): niente copie "(conflitto …)" né backup extra. Tutto avviene da solo, senza domande né avvisi (solo una riga nel registro). Se la stessa nota viene modificata su due dispositivi contemporaneamente:
  - modifiche a **parti diverse** (righe diverse) vengono **unite** automaticamente, come fa git;
  - se le **stesse righe** cambiano su entrambi, per quelle righe vince la versione **più recente**;
  - la stessa nota creata su due dispositivi nello stesso momento diventa un unico file con il contenuto di entrambe (le righe in comune una volta sola);
  - per file non di testo (immagini, PDF, `.canvas`…) vince la versione più recente.
- Le vecchie copie "(conflitto …)" (create da versioni precedenti o da dispositivi non aggiornati) vengono ripulite in automatico: tra l'originale e le sue copie prevale quella modificata più di recente, che prende il nome originale; le altre vanno nel cestino.
  Per unire, Ambraia tiene solo per uso interno l'ultima versione sincronizzata delle note (cartella `state/sync-base` nella cartella del plugin, compressa, mai sincronizzata, ripulita da sola).
- Su Google Drive, che permette due cartelle con lo stesso nome, eventuali cartelle gemelle del vault (create insieme da due dispositivi o da versioni precedenti, compresa una doppia cartella `Ambraia`) vengono riunite da sole nella più vecchia: il contenuto viene spostato e unito, la gemella vuota va nel cestino.
- Se dovessero sparire molti file in una volta (o tutti, anche in un vault piccolo), o la cartella nel cloud venisse eliminata, la sincronizzazione si ferma e chiede conferma invece di cancellare.
- Chiavi e token sono salvati solo nell'archivio sicuro di Obsidian (mai in chiaro in `data.json`); i registri non contengono token.

## Link condivisi
Condividi una nota con chiunque tramite un link (comando «Condividi la nota con un link», menu della nota o esplora file). Chi lo riceve la apre nel browser, senza Obsidian e senza account. Pronto all'uso: premi **Crea link** e hai subito un link di sola lettura senza password; tutto il resto è facoltativo.
- **Come funziona**: il link contiene solo una chiave a 256 bit, nella parte dopo `#`, che il browser non invia mai a nessun server. Quando qualcuno lo apre, uno dei tuoi dispositivi con Obsidian aperto (qualsiasi dispositivo sincronizzato, computer o telefono in primo piano) controlla profilo, password, scadenza, revoca e numero di aperture e risponde con la versione attuale della nota tramite un servizio di inoltro ntfy (`ntfy.sh` di default, oppure un tuo server). Tutto è cifrato end-to-end. Se nessun dispositivo è online, a chi apre il link viene chiesto di riprovare più tardi. Dieci password errate sospendono il link per 15 minuti.
- **Validità**: valido da subito o da una data e ora, per 1 ora, 1 giorno, 7, 30 o 90 giorni, 1 anno, fino a una data o senza scadenza. La finestra mostra i limiti reali del servizio di inoltro gratuito (vedi «Limiti noti»).
- **Profili**: lo stesso link può avere più profili, ognuno con la sua password, il permesso di modificare o solo leggere, un numero massimo di aperture e una scadenza (mai oltre quella del link). Chi apre il link entra nel profilo della password che inserisce; un solo profilo può essere senza password. Esempio: «Modifica» con password, una sola apertura, può modificare; «Lettura» senza password, aperture illimitate per un giorno.
- **Modifica dal browser**: chi entra con un profilo che può modificare vede il testo completo della nota (tranne le proprietà, che restano private e intatte) e può salvarlo. Le modifiche vengono unite riga per riga a quelle fatte nel frattempo nel vault, anche quelle fatte offline sui tuoi dispositivi e sincronizzate dopo: quando tutto si risincronizza la nota è coerente. Se le stesse righe sono cambiate da entrambe le parti, niente viene sovrascritto: chi modifica vede il testo attuale e la sua versione da ricopiare. Se nessun dispositivo è raggiungibile, la pagina tiene la modifica e riprova da sola. Una sola delle tue macchine applica ogni modifica, anche con più dispositivi accesi. La sessione di modifica dura al massimo 12 ore dall'apertura (e mai oltre la scadenza del profilo); finite le aperture si può continuare a salvare nella sessione già aperta.
- **Gestione**: puoi cambiare scadenza e profili, azzerare il conteggio delle aperture, revocare o eliminare il link in ogni momento e da qualsiasi tuo dispositivo: l'elenco dei link viaggia cifrato e firmato nell'elenco dispositivi del servizio di sincronizzazione.
- Chi legge riceve solo il testo: proprietà (frontmatter), commenti `%% … %%`, incorporamenti e immagini locali sono esclusi e i link interni diventano testo semplice. La pagina di lettura mostra il Markdown come testo formattato: niente HTML, script o immagini remote.
- La pagina di lettura è una pagina statica di questo repository (`docs/share/`, pubblicata con GitHub Pages su `https://d4ruerk1.github.io/Obsidian-Ambraia/share/`); puoi ospitarla altrove e indicarne l'indirizzo, insieme a quello del servizio di inoltro, in Impostazioni → Ambraia → Condivisione.
- **Pubblicare la pagina su GitHub Pages rende visibili i link a tutti?** No. GitHub ospita solo la pagina e il suo codice, uguali per tutti: i link e le note non vengono mai salvati su GitHub né sul servizio di inoltro, non esiste un elenco dei link e la chiave dopo `#` non arriva a nessun server. Una nota si apre solo con il suo link (e la password del profilo, se c'è); i canali sul servizio di inoltro hanno nomi casuali e contengono solo dati cifrati.

## Aspetto e pagine
- Tema, carattere, larghezza della pagina e **Nuova Interfaccia**. Colori del testo opachi: le emoji nelle note sono sempre nitide.
- **Ogni nota può avere un'icona**, la stessa ovunque: esplora file, intestazione sopra la copertina, link, calendario, database e lavagne. Se vuoi (spento di default), le note senza icona ne ricevono una adatta al nome (un calendario per le note datate, un libro per le letture…). Salvata nel frontmatter (`icon`); le cartelle con nota della cartella mostrano l'icona della nota e cambiarla da una delle due aggiorna entrambe.
- Copertina per ogni pagina (`banner`): galleria con decine di **colori** sfumati e **foto** in molte categorie (natura, mare, cielo, fiori, stagioni, città, scrivania, texture, arte, cibo), oppure caricamento e link. Le anteprime sono incluse nel plugin; la foto scelta viene scaricata da picsum.photos (licenza Unsplash) e salvata tra gli allegati.
- **Galleria modelli**: 50 modelli pronti in sei gruppi (lavoro, pianificazione, vita personale, studio, scrittura e creatività, conoscenza), con ricerca, anteprima e modelli recenti, più le note della cartella del plugin principale «Modelli» di Obsidian. Comandi «Nuova pagina dalla galleria modelli» e «Inserisci un modello nella nota», voce «Galleria modelli…» nel menu «Nuova nota», voce «Modello» nel menu `/`.
- **Pulsante «Nuova nota»** dell'esplora file con menu: nota, lavagna, nota giornaliera, da modello.
- **Barra multifunzione**: clic destro sulla barra per aggiungere una scorciatoia a qualsiasi comando (con la sua icona) o toglierla; se hai nascosto la barra, clic destro in un punto vuoto dell'esplora file → «Mostra la barra multifunzione».
- **Pulsanti dell'esplora file personalizzabili** (Impostazioni → Generale → Esplora file): nascondi quelli di Obsidian, sostituiscili o aggiungi pulsanti che eseguono qualsiasi comando, con l'icona che preferisci.
- **Esplora file integrato**: preferiti e spazi in cima all'esplora file di Obsidian, "+" al passaggio del mouse sulle cartelle per creare una pagina; pulsanti in cima personalizzabili.
- Note delle cartelle: cliccando una cartella si apre la sua nota.
- **Le proprietà possono essere nascoste dentro le note** (con una regola di stile, nessuno spazio vuoto): restano nel file e si modificano dal pannello laterale «Proprietà del file» di Obsidian. Le impostazioni di Obsidian non vengono cambiate; si disattiva in Impostazioni → Ambraia.
- **Menu della nota essenziale**: il menu ⋯ in alto a destra mostra solo le azioni davvero usate (disattivabile).
- **Nuova Interfaccia** (facoltativa): barre laterali morbide, schede e menu arrotondati, selezioni discrete e più spazio alla pagina.
- Carattere: **Standard** (font di sistema), Serif o Mono — vedi «Caratteri».
- **Aggiorna i link in automatico** (attivo di default): rinominando o spostando una nota i link vengono aggiornati senza chiedere (usa l'opzione di Obsidian «Aggiorna automaticamente i link interni»).

## Editor
- **Menu `/`** con titoli, liste, to-do, callout, toggle, codice, tabelle, database, immagini, data, indice e altro.
- **Menzioni `@`**: digita `@` per collegare una pagina (con icona e cartella), *Oggi*, *Domani*, *Ieri*, oppure creare una pagina nuova.
- **Icone nei link**: i link a una pagina (`[[Pagina]]`) mostrano la sua icona e si riconoscono subito. Clic sull'icona → "Togli l'emoji da questo link" (il link diventa `[[Pagina|Pagina]]`) o "Cambia icona della pagina". Si può spegnere del tutto nelle impostazioni.
- **Barra di formattazione** essenziale: grassetto, corsivo, sottolineato, barrato, codice, evidenziato, colore · Link (pagina, nuova pagina o sito web) · AI per ultima, solo se configurata. Su più righe: stili per riga, elenchi, sposta in una nuova pagina.
- **Barra immagini**: allineamento, larghezza, testo alternativo, apri, copia, imposta come copertina, rinomina ed elimina.
- **Scorciatoie da tastiera** aggiuntive (comando "Mostra le scorciatoie da tastiera"): `Ctrl/Cmd+U` sottolineato, `Ctrl/Cmd+Shift+S` barrato, `Ctrl/Cmd+Shift+H` evidenziato, `Ctrl/Cmd+Shift+E` codice, `Ctrl/Cmd+Shift+K` collega una pagina, `Ctrl+Shift+0…8` (`Cmd+Option+0…8` su Mac) per testo, titoli, to-do, elenchi, toggle e codice, `Ctrl/Cmd+Shift+↑/↓` sposta le righe. Tutti i comandi si possono riassegnare in Impostazioni → Tasti di scelta rapida.

## Lavagna (Canvas)
- Pulsante **Nuova pagina** nei controlli della lavagna: crea una nota e la aggiunge al centro della vista.
- **Disponi**: allinea a sinistra o in alto, distribuisci in orizzontale o in verticale, disponi a griglia gli elementi selezionati (anche come comandi).
- Le schede delle note mostrano l'icona della pagina.

## Database
Inserisci un blocco di codice `ambraia`:

````
```ambraia
source: Progetti             # cartella, oppure "#lavoro" (tag), oppure this (cartella della nota)
view: table                  # table | board | gallery | list | calendar
groupBy: stato               # per la vista board
dateField: scadenza          # per la vista calendar
columns: [stato, priorità, scadenza]
formulas:
  urgente: 'if(prop("priorità") <= 1, "🔥", "")'
```
````

Puoi anche aprire qualunque cartella come database dal menu contestuale: "Apri come database".

## Assistente AI
Pannello laterale di chat e azioni AI direttamente nell'editor. Funziona con modelli **cloud** e **locali**. **È disattivato per impostazione predefinita**: attivalo in Impostazioni → Ambraia → AI. Finché è spento non compaiono comandi né icone AI e non parte nessuna richiesta. Le risposte dell'AI possono essere inesatte: verificale sempre.

### Configurazione rapida
Comando **AI: configura modello (locale o cloud)** oppure Impostazioni → Ambraia → AI → **Configura**. La procedura guidata prova la connessione, elenca i modelli disponibili e salva tutto.

**LM Studio (locale)**
1. In LM Studio scarica e carica un modello.
2. Vai in **Developer** e premi **Start Server** (indirizzo predefinito `http://localhost:1234/v1`).
3. Per usarlo da telefono o da un altro PC attiva **Serve on local network** e inserisci l'IP del computer, ad esempio `http://192.168.1.20:1234/v1`.

È supportato anche **Ollama** (`http://localhost:11434`), insieme a qualsiasi server compatibile con OpenAI.

**Cloud**: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI o un endpoint personalizzato compatibile con OpenAI. Incolla la chiave API: viene salvata solo nell'archivio sicuro di Obsidian (secret storage). Puoi configurare più modelli e cambiarli dalla chat.

### Modalità della chat
- **Chat**: conversazione libera. Puoi aggiungere la nota corrente, altre note `[[...]]` o la selezione come contesto.
- **Domande sul vault**: cerca le note pertinenti (ricerca BM25, più ricerca semantica opzionale con embeddings) e risponde citando le fonti.
- **Agente**: il modello usa strumenti per cercare, leggere ed elencare note, aprire la nota del giorno, creare note, aggiungere testo, modificare note e leggere data e ora. Quando l'AI vuole modificare il vault, l'impostazione *Scritture AI* decide cosa succede: **chiedi conferma** (predefinito), **automatico** o **mai**. Se il modello non supporta gli strumenti, Ambraia passa da solo alla modalità senza strumenti.

Le chat si salvano in `Ambraia/Chat` e le ritrovi nella cronologia. Puoi interrompere una risposta in qualsiasi momento.

### Funzioni avanzate, tutte in locale
Funzionano con qualsiasi modello, anche locale, senza licenze né servizi esterni a pagamento. Le trovi in Impostazioni → Ambraia → AI.
- **Documenti**: puoi allegare alla chat (graffetta o `[[...]]`) e far leggere all'agente PDF, Word (`.docx`), PowerPoint (`.pptx`), Excel (`.xlsx`), OpenDocument (`.odt`, `.odp`, `.ods`), EPUB, Canvas, HTML, TXT, CSV e JSON. Il testo viene estratto sul dispositivo.
- **Link nei messaggi**: se scrivi un URL nel messaggio (fino a 4), la pagina viene scaricata dal tuo dispositivo e aggiunta al contesto.
  - **Video YouTube**, solo tramite API ufficiali (le pagine e i sottotitoli di YouTube non vengono mai scaricati): con una **chiave Google Gemini** il video viene «guardato» da Gemini, che restituisce trascrizione con i tempi o, per i video lunghi, un riassunto per sezioni; Gemini richiede almeno 18 anni e, per utenti nello Spazio economico europeo, in Svizzera o nel Regno Unito, l'uso di **Paid Services** secondo i termini Google; con una **chiave YouTube Data API** (facoltativa) si leggono titolo, canale, durata e descrizione; senza chiavi solo il titolo (oEmbed). Puoi sempre incollare la trascrizione o allegare un file di sottotitoli `.srt`/`.vtt`. In Impostazioni → Ambraia → AI → «Video YouTube» puoi scegliere «Solo titolo».
  - Per i post di X/Twitter viene letto il testo del post tramite l'oEmbed ufficiale (`publish.twitter.com`).
  - Funziona anche con link diretti a PDF e documenti Office.
  - L'agente ha anche lo strumento `read_web_page`.
- **Ricerca web** (attiva di default appena accendi l'AI, sempre tramite API ufficiali; le pagine dei risultati dei motori di ricerca non vengono mai lette): con una chiave Google Gemini cerca con **Ricerca Google** (Grounding with Google Search) e sotto la risposta mostra i suggerimenti di ricerca di Google, come richiesto dai termini. Gemini richiede almeno 18 anni e, per utenti nello Spazio economico europeo, in Svizzera o nel Regno Unito, è consentito solo con **Paid Services**; per questi utenti i dati non vengono usati per migliorare i servizi secondo i termini Gemini API applicabili. Senza chiave usa fonti gratuite senza account, **DuckDuckGo Instant Answers** e **Wikipedia** nella tua lingua; in alternativa un tuo server **SearXNG** (`http://localhost:8080`, con il formato JSON attivo in `settings.yml`). Si cambia in Impostazioni → Ambraia → AI → «Ricerca web per l'agente». L'agente ha lo strumento `web_search`.
- **Memoria** (spenta per impostazione predefinita): una nota, `Ambraia/Memoria.md`, che viene inviata al modello in ogni chat. L'agente può aggiungere fatti con lo strumento `update_memory`. È una normale nota: puoi aprirla, modificarla o svuotarla quando vuoi (comando **AI: apri la memoria**).
- **Progetti**: ogni nota in `Ambraia/Progetti` è un progetto. Lo scegli dal pulsante progetto nella barra della chat oppure lo crei con il comando **AI: nuovo progetto**.
  - Il testo della nota contiene le istruzioni per il modello.
  - Chiavi del frontmatter:
    - `cartelle` / `folders`: limita la ricerca nel vault a queste cartelle
    - `tag` / `tags`: limita la ricerca alle note con questi tag
    - `contesto` / `context`: note, documenti o URL sempre inclusi
    - `modello`: il modello da usare
    - `modalita`: `chat`, `vault` o `agent`

### Azioni e prompt personalizzati
- Puoi riassumere, correggere, tradurre, accorciare, allungare, cambiare il tono o spiegare il testo. Queste azioni sono disponibili dalla barra di selezione, dal menu contestuale dell'editor, dagli elementi **AI** del menu `/` e dai comandi.
- **Prompt personalizzati**: ogni nota nella cartella `Ambraia/Prompt` diventa un prompt. Nel testo puoi usare:
  - `{}` per la selezione o la nota corrente
  - `{nota}` per la nota attiva
  - `{[[Nota]]}` per una nota specifica
  - `{#tag}` per le note con quel tag
  - `{data}` per la data di oggi
- Nel frontmatter dei prompt puoi impostare `mostra-nel-menu`, `sostituisci` (sostituisce la selezione invece di inserire sotto), `modello` e `icon`.
- **Note correlate**: suggerimenti basati sul contenuto della nota aperta.

## Calendario
Comando **Calendario: apri** (oppure l'icona nella barra laterale).
- L'intestazione segue le colonne dei giorni: ‹ sopra il primo giorno, mese e anno al centro, › sopra l'ultimo.
- Vista **Mese**: il pulsante «Mese Anno ▾» apre la scelta del mese, con **Oggi** e la breve guida (?); un clic sull'anno mostra gli anni.
- **Pallini**: uno blu per ogni attività aperta o pagina con quella data (fino a tre); tre pallini rossi quando sono più di tre. Con il pannello largo il mese mostra i titoli di pagine e attività dentro i giorni.
- Un clic su un giorno apre la nota del giorno (o la crea, se vuoi); il numero di settimana apre la nota settimanale. Impostazioni proprie (cartella, formato, modello) oppure quelle del plugin "Note del giorno" di Obsidian.
- **Agenda** del giorno: attività da spuntare, **aggiunta rapida** di un'attività con Invio o con il pulsante **+** (finisce in `Calendario/<data>.md`, cartella creata se manca, con la scadenza), pagine con quella data, note modificate quel giorno.
- **In ritardo**: le attività scadute e non fatte degli ultimi 60 giorni, sotto la giornata di oggi.
- **Trascina** attività e pagine su un altro giorno per spostarle; menu "Sposta a oggi / domani / prossima settimana".
- Tastiera: frecce per muoversi, PagSu/PagGiù per cambiare mese, Invio apre la nota, `T` torna a oggi, Esc chiude la scelta del mese.
- Attività riconosciute: `📅 2026-10-05`, `⏳ 2026-10-05`, `[due:: 2026-10-05]`, `[scadenza:: 2026-10-05]`.
- **Chiedi all'AI di questo giorno**: invia alla chat nota del giorno, attività e pagine con quella data.

## Aggiornamenti
Ambraia non ha un controllo aggiornamenti proprio: installa a mano una release più recente oppure usa BRAT (e, dopo l'approvazione, Impostazioni → Plugin della community). Non scarica né installa mai codice da solo.

## Rischi: chiave principale e disinstallazione
- **La chiave principale non si può recuperare.** Non viene mai salvata fuori dai tuoi dispositivi: se la perdi, i file cifrati nel cloud restano illeggibili per sempre. Ambraia ti chiede di confermare di averla salvata (ad esempio in un gestore di password) prima di usarla, e lo ricorda quando rimuovi un servizio cifrato.
- **Disinstallazione**: usa semplicemente **Disinstalla** di Obsidian (Impostazioni → Plugin della community). Obsidian elimina la cartella del plugin e con essa tutto ciò che Ambraia tiene sul disco (impostazioni, stato della sincronizzazione, indice AI). Ambraia non intercetta quel pulsante e non usa API private: appena viene disattivato controlla, con l'API pubblica dei file, se il suo `manifest.json` esiste ancora. Solo se è sparito (= disinstallato; disattivarlo, aggiornarlo o chiudere Obsidian lo lasciano al suo posto) completa la pulizia: questo dispositivo esce dall'elenco dei dispositivi, vengono eliminate le credenziali di Ambraia nel portachiavi e le sue chiavi nella memoria locale, e «Aggiorna automaticamente i link interni» torna al valore precedente. Un avviso lo conferma. Note, allegati, icone e copertine restano normali file Markdown e proprietà; le copie cifrate nel cloud restano leggibili solo con Ambraia e la chiave principale, quindi conservala. Le modifiche degli ultimi secondi non ancora sincronizzate restano su questo dispositivo. Se elimini a mano la cartella del plugin a Obsidian chiuso, il dispositivo resta nell'elenco (toglilo da un altro dispositivo). Per ricominciare senza disinstallare: Impostazioni → Ambraia → Generale → «Ripristina le impostazioni predefinite».
- Tieni sempre un backup: la sincronizzazione non è un backup.

## Informative (regole per gli sviluppatori di Obsidian)
- **Uso della rete**: solo (a) i servizi cloud che colleghi (comprese le loro pagine di accesso), (b) il fornitore AI che configuri, solo se l'AI è attiva, (c) gli strumenti web dell'AI, solo con l'AI attiva e sempre tramite API ufficiali: la ricerca web (attiva di default con l'AI: Ricerca Google tramite l'API Gemini se aggiungi una chiave Gemini, altrimenti DuckDuckGo Instant Answers `api.duckduckgo.com` e Wikipedia `*.wikipedia.org`; oppure il tuo SearXNG), le pagine che chiedi di leggere, i video YouTube (titolo via oEmbed; con le tue chiavi l'API Gemini, che riceve l'indirizzo del video, o la YouTube Data API), i post di X tramite l'oEmbed `publish.twitter.com`, (d) picsum.photos solo quando **scegli** una foto come copertina (sfogliare la galleria non fa richieste), (e) per i **link condivisi**, solo se li usi: il servizio di inoltro indicato in Impostazioni → Ambraia → Condivisione (`ntfy.sh` di default) — i tuoi dispositivi vi tengono aperta una connessione mentre Obsidian è aperto ed esiste almeno un link — e la pagina di lettura (GitHub Pages di default), che viene aperta da chi riceve il link, non dal plugin. I link a GitHub, donazione, note legali e privacy nelle impostazioni si aprono nel browser solo se li clicchi.
- **Account**: la sincronizzazione richiede un account presso il servizio scelto; l'AI cloud un account/chiave API presso il fornitore scelto. Gemini richiede almeno 18 anni e, per utenti nello Spazio economico europeo, in Svizzera o nel Regno Unito, solo Paid Services. Tutto il resto funziona senza account.
- **Pagamenti**: il plugin è gratuito e completo. L'unico elemento legato a pagamenti è un link facoltativo alle donazioni su Ko-fi nel piè di pagina delle impostazioni (e il `fundingUrl` del manifest). Nessun popup né promemoria.
- **Nessuna telemetria, pubblicità o analisi d'uso.** Lo sviluppatore non riceve alcun dato.
- **File fuori dal vault**: l'opzione «cartella locale» (solo computer) scrive nella cartella che scegli, ad esempio quella di MEGA o Proton Drive.
- **Impostazioni di Obsidian modificate**: «Aggiorna automaticamente i link interni» (`alwaysUpdateLinks`) viene attivata mentre è acceso «Aggiorna i link in automatico» di Ambraia (attivo di default; spegnendolo torna il valore precedente), e la visibilità della barra multifunzione (`showRibbon`) solo quando scegli tu «Mostra la barra multifunzione». Proprietà nascoste e nuova interfaccia sono solo CSS e si possono disattivare. Ambraia aggiunge voci ai menu contestuali di Obsidian (tolte quando si disattiva); non modifica né intercetta azioni di Obsidian come «Disinstalla».
- **Modifiche automatiche alle note**: solo la manutenzione automatica descritta sopra, che sulle note toglie esclusivamente ciò che Ambraia stesso ha scritto ed è vuoto o predefinito (`icon`/`banner` vuoti, copertina centrata, frontmatter vuoto), una sola volta per versione. Il testo e le altre proprietà non vengono mai toccati da Ambraia. Fa eccezione solo ciò che decidi tu: se crei un link condiviso con un profilo che **può modificare**, chi entra con quel profilo può cambiare il testo di quella nota (mai le proprietà); le modifiche vengono unite a quelle esistenti e puoi togliere il permesso o revocare il link in ogni momento.
- Nessun codice chiuso od offuscato: il sorgente completo è nel repository.

## AI (Regolamento UE 2024/1689 sull'IA e Legge 132/2025)
- L'assistente AI è **spento di default**. Quando è attivo, ciò che invii (richiesta, testo selezionato, note allegate o trovate nel vault) va al fornitore che hai configurato, oppure resta sul computer con un modello locale (LM Studio, Ollama). Le note nelle cartelle escluse non vengono mai inviate.
- La chat è una vista separata presentata chiaramente come assistente AI, così sai sempre di interagire con un sistema di AI (art. 50, par. 1). Le risposte sono generate da un modello di AI e **possono essere sbagliate**: verificale prima di farci affidamento.
- **Marcatura dei testi generati** (art. 50, par. 2, AI Act): le note create dall'AI ricevono la proprietà `ai-generated: true`, quelle in cui l'AI inserisce testo o che l'agente modifica `ai-assisted: true`; anche le chat salvate sono marcate. Puoi disattivarla in Impostazioni → AI, ma se **pubblichi** testi generati dall'AI su questioni di interesse pubblico devi dichiararlo tu (art. 50, par. 4).
- L'agente non modifica mai una nota senza la tua conferma.
- Evita di inviare ai fornitori cloud dati personali di altre persone o categorie particolari di dati (salute ecc.): per questi usa un modello locale.
- Secondo la Legge 132/2025 (art. 4), chi ha meno di 14 anni può usare strumenti di AI solo con il consenso di chi esercita la responsabilità genitoriale. **Google Gemini richiede comunque che l'utente abbia almeno 18 anni**.

## Privacy (GDPR, Reg. UE 2016/679, e Codice privacy, D.Lgs. 196/2003 come modificato dal D.Lgs. 101/2018) <a id="privacy"></a>
Informativa completa: [PRIVACY.md](PRIVACY.md#italiano). Note legali (licenza, garanzia, AI Act, marchi, GitHub): [LEGAL.md](LEGAL.md#italiano).
- Lo sviluppatore (d4ruerk1) non raccoglie, non riceve e non tratta dati personali e non gestisce server. Le note restano sui tuoi dispositivi e vanno **direttamente** ai servizi che scegli tu. Lo sviluppatore non è titolare né responsabile del trattamento dei dati del tuo vault.
- Quando colleghi un servizio cloud o AI, quel fornitore tratta i dati secondo i propri termini e la propria informativa (sei tu a sceglierlo e ad avere il rapporto con lui). Con la cifratura attiva, contenuti (e facoltativamente nomi) dei file sono cifrati prima di lasciare il dispositivo.
- Il collegamento dei dispositivi salva nella cartella del cloud solo file temporanei cifrati (cancellati dopo l'uso o dopo 5 minuti) e, per ogni dispositivo, nome, piattaforma, chiavi pubbliche, certificato e ultimo accesso (più l'elenco dei tuoi link condivisi, se ne hai), cifrati con una chiave condivisa solo dai tuoi dispositivi e salvati con nomi anonimi nella cartella `.ambraia` dentro la cartella del vault nel cloud. Vengono rimossi quando scolleghi un dispositivo o disinstalli Ambraia.
- Il download delle foto e gli strumenti web dell'AI sono normali richieste HTTPS: picsum.photos (con la sua CDN) e i siti che l'AI legge o in cui cerca vedono indirizzo IP e user agent. Gli strumenti web dell'AI si presentano in modo trasparente con lo user agent `Ambraia/1.0` e il link a questo repository; YouTube, X, Google, DuckDuckGo e Wikipedia vengono contattati solo tramite le loro API ufficiali; per le altre pagine che chiedi di leggere resta a tuo carico rispettarne le condizioni d'uso. Le foto si scaricano solo su richiesta.
- Chiavi e token stanno nell'archivio sicuro di Obsidian (secret storage), mai in `data.json`.
- I diritti previsti dal Regolamento (UE) 2016/679 e dal D.Lgs. 196/2003 si esercitano verso i fornitori che trattano effettivamente i tuoi dati. Puoi anche proporre reclamo al Garante per la protezione dei dati personali.

### Link condivisi e privacy
- Decidi tu cosa condividere e con chi, e sei responsabile dei contenuti che condividi (condividi solo ciò che hai il diritto di diffondere ed evita dati personali di altri senza una base giuridica). Il contenuto è cifrato end-to-end: né lo sviluppatore, né GitHub, né il servizio di inoltro possono leggerlo.
- Se dai a un profilo il permesso di modificare, chi lo usa vede il testo completo della nota (commenti `%% … %%` compresi, proprietà escluse) e ciò che scrive entra nel tuo vault: dai questo permesso solo a persone di fiducia e controlla le modifiche ricevute. Le modifiche viaggiano cifrate end-to-end come le note; la pagina di lettura le tiene solo in memoria finché non vengono salvate. Per le note che contengono dati personali di altri, sei tu a decidere se e con chi condividerle (titolare del trattamento, salvo l'uso esclusivamente personale o domestico).
- La pagina di lettura non usa cookie, archiviazione locale, statistiche o risorse di terze parti (Content-Security-Policy restrittiva) e toglie la chiave dalla barra degli indirizzi dopo l'apertura; GitHub, che la ospita, vede indirizzo IP e user agent di chi la apre come per qualsiasi pagina web (si applica l'informativa privacy di GitHub).
- Il servizio di inoltro (ntfy.sh, gestito dal suo fornitore secondo i propri termini e la propria informativa, oppure un tuo server) vede indirizzi IP, nomi di canale casuali, orario e dimensione di richieste e risposte cifrate, e li conserva per circa 12 ore; i messaggi sono inviati con l'inoltro push disattivato. Lo sviluppatore non gestisce nessuno dei due servizi e non riceve dati da essi.

## Caratteri (font)
Ambraia **non include e non scarica alcun font**. Le opzioni «Standard», «Serif» e «Mono» indicano solo, in una lista CSS `font-family` con alternative generiche, caratteri già installati nel sistema (Standard: `ui-sans-serif`, `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `Roboto`, `Helvetica Neue`, `Arial` e i font emoji di sistema; Serif: `ui-serif`, `Georgia`, `Cambria`, `Times New Roman`; Mono: `ui-monospace`, `SFMono-Regular`, `Menlo`, `Consolas`, `Liberation Mono`). Il loro uso è regolato dalle licenze del sistema operativo: Ambraia non aggiunge restrizioni e non ridistribuisce file di font. Non vengono richiamati font proprietari di altre applicazioni.

## Immagini
Le foto di copertina provengono da [Unsplash](https://unsplash.com) tramite [Lorem Picsum](https://picsum.photos) e sono usate secondo la [licenza Unsplash](https://unsplash.com/license) (uso libero, senza permesso). Il nome del fotografo compare passando sopra la foto nella galleria. Vedi [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Marchi
Ambraia è un progetto indipendente, non affiliato né approvato da Obsidian (Dynalist Inc.), Google, Dropbox, Microsoft, pCloud, MEGA, Proton, OpenAI, Anthropic, Google Gemini, Mistral AI, Ollama, LM Studio, OpenRouter, DeepSeek, Unsplash o altre aziende citate. Nomi e marchi appartengono ai rispettivi titolari e sono usati solo per indicare compatibilità (uso descrittivo). I piccoli loghi dei servizi nelle impostazioni provengono da [Simple Icons](https://simpleicons.org) (CC0) e compaiono solo accanto al servizio che identificano; tutti sono disegnati in un solo colore; per OneDrive e pCloud si usano simboli generici di nuvola disegnati per Ambraia (non i loghi ufficiali). Dettagli in [LEGAL.md](LEGAL.md#italiano). «Ambraia» non è un marchio registrato; una ricerca su TMview (EUIPO, tutti gli uffici aderenti) non ha trovato marchi identici o simili per software (classi di Nizza 9 e 42).

## Licenza e garanzia
MIT — vedi [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); gli avvisi di licenza sono riportati anche in testa al `main.js` pubblicato. Il software è fornito «così com'è», senza garanzie, nei limiti consentiti dalla legge applicabile: restano salve le responsabilità che la legge non permette di escludere (ad esempio per dolo o colpa grave, art. 1229 c.c.) e i diritti dei consumatori (Codice del consumo, D.Lgs. 206/2005). Il software di cifratura può essere soggetto a norme di import/export in alcuni Paesi; il codice sorgente completo è pubblico (Reg. UE 2021/821, nota generale sul software).

Ambraia è software libero e open source, sviluppato e pubblicato senza attività commerciale: nessuna funzione a pagamento, vendita o monetizzazione dei dati; le donazioni sono volontarie e non sbloccano nulla (Cyber Resilience Act, Reg. UE 2024/2847, considerando 15–19).

## Comandi principali
Nuova pagina, collega una pagina, mostra le scorciatoie, lavagna (nuova pagina, allinea, distribuisci, griglia), database (tabella o bacheca), galleria modelli, inserisci modello, icona e copertina, Sync (sincronizza, collega, sblocca la cifratura; pausa e registro quando un servizio è collegato), AI (chat, nuova chat, configura modello, azioni sulla selezione, prompt personalizzati, aggiungi selezione alla chat, ricostruisci indice), Calendario (apri, oggi, giorno precedente o successivo, questa settimana).

## File salvati, il più piccoli possibile
- `data.json` contiene solo le impostazioni diverse da quelle predefinite.
- Le note non ricevono proprietà vuote; la posizione della copertina viene scritta solo se diversa dal centro.
- Stato di sincronizzazione compresso, indice AI con vettori compatti (8 bit), immagini caricate ottimizzate.

## Limiti noti
- Il plugin è stato verificato con test automatici (anche su emulazioni fedeli delle API di Google Drive, Dropbox, OneDrive e pCloud, e con centinaia di scenari casuali di guasti: rete, server, limiti, spazio esaurito) e build TypeScript, ma **non dentro una vera finestra di Obsidian né contro i server reali** dei servizi cloud. Segnala qualsiasi comportamento strano.
- L'accesso con un clic richiede che chi distribuisce il plugin registri le app OAuth una volta (`apps.json`); altrimenti ogni utente usa la propria app. Non c'è un server ospitato. Se l'app Google integrata è di tipo "Desktop app", sui telefoni si torna al metodo "incolla l'indirizzo".
- Con più servizi attivi ogni modifica viene caricata su ciascuno: il traffico e le richieste crescono di conseguenza.
- Lo spazio libero si legge da Google Drive, OneDrive, pCloud, Dropbox (se l'app ha il permesso `account_info.read`) e dal disco per MEGA/Proton; per questi ultimi Ambraia non vede la quota dell'account, che gestisce la loro app desktop. Dove lo spazio non è leggibile, Ambraia se ne accorge dal primo caricamento rifiutato.
- MEGA e Proton Drive non offrono un'API pubblica adatta: si usano tramite la cartella della loro app desktop, quindi solo su computer. Su telefono usa uno degli altri servizi.
- Le traduzioni dell'interfaccia (tranne l'italiano) sono generate automaticamente e riviste solo in parte.
- Senza chiave Gemini la ricerca web usa DuckDuckGo Instant Answers e Wikipedia: ottime per fatti, persone, luoghi e definizioni, ma non sono una ricerca completa del web; con Gemini hai la Ricerca Google e i video YouTube secondo i termini Google. Gemini richiede almeno 18 anni e, per utenti nello Spazio economico europeo, in Svizzera o nel Regno Unito, sono consentiti solo **Paid Services**; per questi utenti i dati non vengono usati per migliorare i servizi Google secondo i termini Gemini API applicabili. Se non vuoi usare Gemini, scegli SearXNG o «Solo titolo».
- I PDF scansionati (solo immagini) non hanno testo e non c'è OCR. PDF e documenti Office si possono allegare e far leggere, ma non entrano nell'indice di ricerca del vault.
- Leggere un link significa scaricarlo dal tuo dispositivo: i siti che richiedono login o JavaScript possono restituire poco testo.
- Le risposte arrivano tutte insieme alla fine: le richieste passano dalla funzione di rete di Obsidian (`requestUrl`), che non supporta lo streaming ma non richiede CORS.
- Un server locale deve essere raggiungibile dal dispositivo: su telefono non funziona `localhost`, serve l'IP del PC.
- Su mobile gli embeddings non vengono calcolati in background.
- I link condivisi rispondono solo mentre almeno uno dei tuoi dispositivi ha Obsidian aperto (sul telefono, in primo piano). Il limite di aperture è rispettato anche con più dispositivi accesi, ma un'apertura registrata da un dispositivo che resta offline per più di qualche minuto prima della successiva sincronizzazione potrebbe non essere contata dagli altri. Il servizio pubblico ntfy.sh non mette scadenze ai link, ma accetta circa 250 messaggi al giorno per dispositivo (circa 120 aperture al giorno in tutto); una sessione di modifica dal browser dura al massimo 12 ore. Per un uso intenso usa un tuo server ntfy.
- Le note condivise sono limitate a circa 1,4 MB di testo.
