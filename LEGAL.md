# Legal notes — Ambraia

*English · [Italiano](#italiano)* — last updated: version 1.0.1. See also [PRIVACY.md](PRIVACY.md), [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Who publishes it
Ambraia is free and open-source software by **d4ruerk1**, published on GitHub at [github.com/d4ruerk1/Obsidian-Ambraia](https://github.com/d4ruerk1/Obsidian-Ambraia). It is developed and distributed without any commercial activity: no paid features, no sales, no data monetisation. Donations (Ko-fi) are voluntary gifts, unlock nothing and are not a purchase of goods or services (EU Cyber Resilience Act, Regulation (EU) 2024/2847, recitals 15–19).

## Licence and warranty
- Licence: **MIT** ([LICENSE](LICENSE)). Third-party components and their licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); licence notices are also kept at the top of the released `main.js`.
- The software is provided **"as is"**, without warranty of any kind, to the extent permitted by applicable law. Nothing here limits liability that cannot be excluded by law (e.g. for wilful misconduct or gross negligence, art. 1229 of the Italian Civil Code) or the mandatory rights of consumers (e.g. Italian Consumer Code, D.Lgs. 206/2005).
- **Keep your own backups.** Sync is not a backup. The encryption master key cannot be recovered by anyone: if you lose it, encrypted cloud copies stay unreadable.

## Obsidian developer policies
Ambraia follows the [Obsidian developer policies](https://docs.obsidian.md/Developer+policies): no telemetry, no ads, no obfuscated or closed code, no self-updating, network use and accounts disclosed in the [README](README.md#disclosures). Obsidian settings it may change are disclosed there too (ribbon visibility on request; "Automatically update internal links" while Ambraia's "Update links automatically" is on — default on, turning it off restores Obsidian's previous value). Ambraia is an independent project, not affiliated with or endorsed by Obsidian (Dynalist Inc.).

## GitHub
The source and the static reading page of shared links (`docs/share/`, GitHub Pages) are hosted by GitHub, Inc. under the [GitHub Terms of Service](https://docs.github.com/site-policy/github-terms/github-terms-of-service) and [Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). GitHub Pages is used only to serve a static page; no notes or links are stored on GitHub.

## Artificial intelligence (EU AI Act, Regulation (EU) 2024/1689; Italian Law 132/2025)
- The assistant is **off by default** and runs on the provider you choose (or locally). Ambraia is not a general-purpose AI model provider; it is a tool that connects to models you select.
- **Transparency (art. 50(1))**: the chat is a separate view clearly labelled as an AI assistant.
- **Marking (art. 50(2))**: notes created by the AI get the property `ai-generated: true`, notes edited or completed with AI text get `ai-assisted: true`; saved chats are marked too. You can turn marking off, but if you **publish** AI-generated text on matters of public interest you must disclose it yourself (art. 50(4)).
- Answers may be wrong: check them. The agent never edits a note without your confirmation (unless you choose otherwise in the settings).
- Do not send other people's personal data or special categories of data to cloud AI providers; prefer a local model. Under Italian Law 132/2025 (art. 4) people under 14 need parental consent to use AI tools.

## Your content and shared links
You are responsible for what you sync, send to an AI provider or share with a link: share only content you have the right to distribute and respect the terms of the services you use (cloud, AI, ntfy relay, websites read by the AI web tools).

## Third-party services used by the AI web tools
Only official APIs are used, never scraping: Google Gemini API (Google Search grounding and YouTube video understanding, only with your own key, under the [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) — Google Search Suggestions are shown under answers as those terms require), YouTube Data API v3 (only with your own key, under the [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service)), YouTube and X oEmbed, DuckDuckGo Instant Answer API and the Wikipedia (MediaWiki) API. You use them under your own account and their terms; Ambraia is not affiliated with them. Wikipedia texts are under CC BY-SA.

## Trademarks
All product names, logos and brands (Obsidian, Google Drive, Dropbox, Microsoft OneDrive, pCloud, MEGA, Proton Drive, OpenAI, Anthropic, Google Gemini, Mistral AI, Ollama, LM Studio, OpenRouter, DeepSeek, Unsplash, GitHub, ntfy, Ko-fi…) belong to their owners and are used only to identify the corresponding service (nominative use); no affiliation or endorsement is implied. Service marks in the settings come from [Simple Icons](https://simpleicons.org) (CC0) and are drawn in one colour; OneDrive and pCloud are shown with generic cloud glyphs drawn for Ambraia, not their official logos. "Ambraia" is not a registered trademark.

## Fonts and images
Ambraia bundles and downloads **no fonts**: the "Standard", "Serif" and "Mono" options only reference fonts already installed on your system. Cover photos come from [Unsplash](https://unsplash.com/license) via [Lorem Picsum](https://picsum.photos) under the Unsplash Licence.

## Encryption
Encryption software may be subject to import/export rules in some countries. The full source code is public (EU Regulation 2021/821, General Software Note).

---

<a id="italiano"></a>
# Note legali — Ambraia (italiano)

Vedi anche [PRIVACY.md](PRIVACY.md#italiano), [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Chi lo pubblica
Ambraia è software libero e open source di **d4ruerk1**, pubblicato su [GitHub](https://github.com/d4ruerk1/Obsidian-Ambraia), sviluppato e distribuito senza attività commerciale: nessuna funzione a pagamento, vendita o monetizzazione dei dati. Le donazioni (Ko-fi) sono liberalità volontarie, non sbloccano nulla e non sono acquisti di beni o servizi (Cyber Resilience Act, Reg. UE 2024/2847, considerando 15–19).

## Licenza e garanzia
- Licenza **MIT** ([LICENSE](LICENSE)); componenti di terze parti in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Il software è fornito **«così com'è»**, senza garanzie, nei limiti consentiti dalla legge: restano salve le responsabilità non escludibili (dolo o colpa grave, art. 1229 c.c.) e i diritti inderogabili dei consumatori (Codice del consumo, D.Lgs. 206/2005).
- **Tieni sempre un backup**: la sincronizzazione non è un backup. La chiave principale della cifratura non è recuperabile da nessuno.

## Regole per gli sviluppatori di Obsidian
Ambraia rispetta le [regole per gli sviluppatori di Obsidian](https://docs.obsidian.md/Developer+policies): niente telemetria, pubblicità, codice chiuso od offuscato o aggiornamenti automatici; uso della rete, account e impostazioni di Obsidian modificate sono dichiarati nel [README](README.it.md) (barra multifunzione su richiesta; «Aggiorna automaticamente i link interni» mentre è attivo «Aggiorna i link in automatico» di Ambraia — attivo di default, spegnendolo torna il valore precedente). Progetto indipendente, non affiliato né approvato da Obsidian (Dynalist Inc.).

## GitHub
Il codice e la pagina statica di lettura dei link (`docs/share/`, GitHub Pages) sono ospitati da GitHub, Inc. secondo i suoi [Termini di servizio](https://docs.github.com/site-policy/github-terms/github-terms-of-service) e la sua [informativa privacy](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). Su GitHub non vengono salvati note né link.

## Intelligenza artificiale (Reg. UE 2024/1689 «AI Act»; Legge 132/2025)
- L'assistente è **spento di default** e usa il fornitore che scegli tu (o un modello locale).
- **Trasparenza (art. 50, par. 1)**: la chat è una vista separata, chiaramente indicata come assistente AI.
- **Marcatura (art. 50, par. 2)**: le note create dall'AI ricevono `ai-generated: true`, quelle modificate o completate con testo AI `ai-assisted: true`; anche le chat salvate sono marcate. Puoi disattivarla, ma se **pubblichi** testi generati dall'AI su questioni di interesse pubblico devi dichiararlo tu (art. 50, par. 4).
- Le risposte possono essere sbagliate: verificale. L'agente non modifica note senza conferma (salvo tua diversa scelta nelle impostazioni).
- Non inviare ai fornitori cloud dati personali di altri o categorie particolari di dati; preferisci un modello locale. Legge 132/2025, art. 4: sotto i 14 anni serve il consenso di chi esercita la responsabilità genitoriale.

## Contenuti e link condivisi
Sei responsabile di ciò che sincronizzi, invii a un fornitore AI o condividi con un link: condividi solo ciò che hai diritto di diffondere e rispetta i termini dei servizi usati.

## Servizi di terzi usati dagli strumenti web dell'AI
Solo API ufficiali, mai scraping: Google Gemini API (Grounding with Google Search e lettura dei video YouTube, solo con una tua chiave, secondo i [termini aggiuntivi di Gemini API](https://ai.google.dev/gemini-api/terms) — i suggerimenti di ricerca Google vengono mostrati sotto le risposte come richiesto), YouTube Data API v3 (solo con una tua chiave, secondo i [termini dei servizi API di YouTube](https://developers.google.com/youtube/terms/api-services-terms-of-service)), oEmbed di YouTube e X, Instant Answer API di DuckDuckGo e API di Wikipedia (MediaWiki). Li usi con il tuo account e secondo le loro condizioni; Ambraia non è affiliato a questi servizi. I testi di Wikipedia sono in licenza CC BY-SA.

## Marchi
Nomi, loghi e marchi citati appartengono ai rispettivi titolari e sono usati solo per identificare il servizio (uso descrittivo), senza affiliazione o approvazione. I loghi dei servizi provengono da [Simple Icons](https://simpleicons.org) (CC0) e sono disegnati in un solo colore; OneDrive e pCloud usano simboli generici di nuvola disegnati per Ambraia, non i loghi ufficiali. «Ambraia» non è un marchio registrato.

## Caratteri e immagini
Ambraia **non include e non scarica font**: «Standard», «Serif» e «Mono» richiamano solo caratteri già installati nel sistema. Le foto di copertina provengono da Unsplash tramite Lorem Picsum, secondo la [licenza Unsplash](https://unsplash.com/license).

## Cifratura
Il software di cifratura può essere soggetto a norme di import/export in alcuni Paesi; il codice sorgente completo è pubblico (Reg. UE 2021/821, nota generale sul software).
