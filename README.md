# Ambraia

*English · [Italiano](README.it.md)* — by [d4ruerk1](https://github.com/d4ruerk1), MIT licence · [Support on Ko-fi](https://ko-fi.com/d4ruerk1) (optional)

A workspace for Obsidian: page icons and covers, databases, calendar, templates, `/` and `@` menus, a clean formatting toolbar, a refreshed interface, optional end-to-end encrypted sync with one or more clouds at the same time, and an optional AI assistant (off by default) that also works with local models.

The name comes from Italian *ambra* (amber, which keeps things intact for ages, like your notes) with **AI** inside: Ambr**ai**a, pronounced *am-BRY-ah*.

The interface follows Obsidian's language: English, Italiano, Español, Deutsch, Français, العربية, Русский, 中文, 日本語.

## Install

Requires Obsidian 1.13.0 or later (desktop and mobile).
- **Community plugins**: Settings → Community plugins → Browse → "Ambraia".
- **Manually**: download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/d4ruerk1/Obsidian-Ambraia/releases) into `<vault>/.obsidian/plugins/ambraia/`, then enable Ambraia.

Everything Ambraia needs on a device lives inside its own plugin folder: settings in `data.json`, sync state, merge base and AI index in `state/`. Update it from Settings → Community plugins (the folder is kept). Deleting the folder, or pressing Obsidian's **Uninstall**, removes Ambraia completely (see *Uninstalling*).

## Features
**Pages**
- Every note can have an icon, shown everywhere (file explorer, page header, links, calendar, databases, canvases). Optionally (off by default) notes without one get an icon that matches their name (e.g. a calendar for dated notes, a book for reading notes). A folder with a folder note shows that note's icon, and changing either updates both.
- Covers: a gallery of colour gradients and photos in several categories (nature, sea, sky, flowers, seasons, cities, desk, textures, art, food), uploads and links. Images are saved as attachments of the note.
- **Template gallery**: 50 ready-made templates in six groups (work, planning, personal life, study, writing and creativity, knowledge), with search, preview and recently used, plus the notes in the folder of Obsidian's core Templates plugin. Open it with the commands "New page from the template gallery" and "Insert a template into the note", the `/` menu or "Template gallery…" in the "New note" menu.
- The **New note** button of the file explorer opens a small menu: note, canvas, daily note, or from a template.
- The file explorer toolbar can be customised: hide Obsidian's buttons, replace them or add buttons that run any command (they are only hidden, never removed).
- Favourites and spaces at the top of Obsidian's own file explorer, "+" on folders, folder notes.
- Properties can be hidden in the note body with a style rule (they stay in the file and are edited from Obsidian's "File properties" panel). Obsidian's own settings are not changed; turn it off in Settings → Ambraia.
- **New interface** (optional): softer sidebars, rounded tabs and menus, discreet selections and more room for the page.

**Editor** — `/` block menu, `@` mentions, link icons, formatting toolbar, extra keyboard shortcuts (command "Show keyboard shortcuts"). In the right-click menu Cut / Copy / Paste come first.

**Databases** — a ```` ```ambraia ```` code block (table, board, gallery, list, calendar) over a folder or a tag, with formulas.

**Calendar** — month view with a "Month Year ▾" button to jump to any month or year, daily and weekly notes, dated pages and tasks (`📅 2026-10-05`, `⏳`, `[due:: …]`), quick add, drag and drop. The legend of the dots is in the (?) guide.

**Ribbon and status bar** — right-click the ribbon to add a shortcut to any command (with its icon) or remove it; if you hid the ribbon, right-click an empty area of the file explorer to show it again. If you use Obsidian Sync and have no Ambraia cloud service, Ambraia's sync icon in the status bar is hidden, so it does not duplicate Obsidian Sync's.

**Sync** — Google Drive, Dropbox, OneDrive, pCloud, and MEGA / Proton Drive / any folder through their desktop apps. Several at once, optional end-to-end encryption (AES-256-GCM, XChaCha20-Poly1305 or AES-CTR+HMAC, Argon2id), line-level merging, safety stops on mass deletions.
- **Connect another device** with a one-time 8-character code: valid for 5 minutes, usable once, and cancelled as soon as you close the window that shows it. The code carries no secret: the new device signs in to the same account itself and the code only lets the two devices find each other. They agree on a one-off key (ECDH P-256) and both show the same **6-digit check code**; nothing (folder, encryption key, device list key) is sent until you press **Approve** on the device that is already connected. You can also **Reject** it.
- **Connected devices (all equal)**: each service lists the devices that use it, with their last sync. There are no owners or administrators: from **any** device (the first PC, a phone, …) you can link new devices and choose which ones to remove from sync, including the first one. Each device is introduced by the device that approved it (a signed certificate) and every removal is signed and checked by all devices, so a removed device cannot send commands or come back without a new code; a device that no device introduced is marked **Unverified**. A removal can be undone until it runs. From the ⋯ menu you can also **disconnect and delete the data** on a device (the vault notes and Ambraia's data on it). Commands run the next time that device is online; for a lost device also revoke access in your cloud account. The list is stored encrypted, with opaque file names.
- **Cloud folder chosen for you**: when you pick a service, the folder step lists the vault folders already on that account and which of your devices uses them, and preselects the one the other devices of your chain use (or the one named after the vault), so a new device joins the existing folder instead of creating a new one; the same path typed with different capitals is matched to the existing folder. On Google Drive, which allows two folders with the same name, twin vault folders (created at the same moment by two devices or by older versions, including a duplicate `Ambraia` parent) are folded into the oldest one by themselves: contents are moved and merged, the empty twin goes to the trash.
- **Expired access**: "Sign in again" keeps folder, encryption and settings.

**Shared links** — share a note with anyone through a link (command "Share the note with a link", the note menu or the file explorer). The reader opens it in a browser, without Obsidian or an account. Ready to use: press **Create link** and you get a read-only link without a password; everything else is optional.
- **How it works**: the link holds only a 256-bit key, in the part after `#`, which browsers never send to any server. When someone opens it, one of your devices with Obsidian open (any synced device, desktop or phone in the foreground) checks profile, password, expiry, revocation and number of openings and answers with the current version of the note through an ntfy relay (`ntfy.sh` by default, or your own server), end-to-end encrypted. If no device is online the reader is asked to try again later. Ten wrong passwords pause a link for 15 minutes.
- **Profiles**: one link can have several profiles, each with its own password, edit or read-only rights, maximum number of openings and expiry (never beyond the link's). The reader gets the profile of the password they enter; only one profile can be without a password. Example: "Edit" with a password, one opening, can edit; "Read" without a password, unlimited openings for one day.
- **Editing from the browser**: a profile allowed to edit sees the full text of the note (except the properties, which stay private and untouched) and can save it. Changes are merged line by line with those made in the vault in the meantime, including edits made offline on your devices and synced later, so the note ends up consistent. If the same lines changed on both sides nothing is overwritten: the editor sees the current text and their own version to copy back. If no device is reachable the page keeps the change and retries by itself. Only one of your devices applies each change, even with several online. An editing session lasts at most 12 hours from opening (never beyond the profile's expiry); once the openings are used up, the open session can still save.
- **Managing**: change expiry and profiles, reset the opening count, revoke or delete a link at any time, from any of your devices: the list of links travels encrypted and signed in the device list of your sync service.
- Readers get only the text: properties (frontmatter), `%% comments %%`, embeds and local images are left out, and internal links become plain text. The reading page shows Markdown as plain formatted text: no HTML, scripts or remote images.
- The reading page is a static page in this repository (`docs/share/`, published with GitHub Pages at `https://d4ruerk1.github.io/Obsidian-Ambraia/share/`); you can host it anywhere and set its address, and the relay's, in Settings → Ambraia → Sharing.
- **Does publishing the page on GitHub Pages make the links visible to everyone?** No. GitHub only hosts the page and its code, the same for everyone: links and notes are never stored on GitHub or on the relay, there is no list of links, and the key after `#` never reaches any server. A note opens only with its link (and the profile's password, if any); relay topics have random names and carry only encrypted data.

**AI (off by default)** — enable it in Settings → AI. Chat, vault Q&A, an agent with confirmation before edits, actions on selected text, custom prompts. Works with LM Studio, Ollama or cloud providers. Saved chats are plain Markdown with simple headings and properties, easy to read for people and models. AI output can be inaccurate: always check it.

## Updates
Ambraia has no update checker of its own: update it from Settings → Community plugins, or install a newer release by hand. It never downloads or installs code by itself.

## Risks: master key and uninstalling
- **The master key cannot be recovered.** It is never stored outside your devices. If you lose it, the encrypted files in the cloud are unreadable forever.
- **Uninstalling**: use Obsidian's own **Uninstall** button (Settings → Community plugins), or simply delete the plugin folder. If a cloud service is encrypted Ambraia first reminds you about the master key. Then it sends pending changes, removes this device from the device list and deletes all its data on the device: the plugin folder with its `state/`, the keychain entries and its few local-storage keys; its styles, classes and menu changes are removed when it is turned off. Notes, attachments, icons and covers stay as normal Markdown and properties; encrypted copies in the cloud stay readable only with Ambraia and the key. To start over without uninstalling, use Settings → Ambraia → General → "Restore default settings".
- Keep your own backups. Sync is not a backup.

## Disclosures (Obsidian developer policies)
- **Network use** — only:
  1. the cloud services you connect (and only them), including their sign-in pages;
  2. the AI provider you configure, only if AI is enabled; web search/reading tools of the AI (DuckDuckGo or your SearXNG, pages you ask it to read, YouTube transcripts, X posts via `publish.twitter.com`) only when you use them;
  3. `picsum.photos` (photos from Unsplash) only when you **pick** a photo cover: the gallery previews are bundled in the plugin, so browsing it sends no request.
  4. for **shared links**, only when you use them: the relay set in Settings → Ambraia → Sharing (`ntfy.sh` by default) — your devices keep a connection open to it while Obsidian is open and at least one link exists (turn off "Answer shared links" to stop it on a device) — and the reading page (GitHub Pages by default), which is opened by the people you send a link to, not by the plugin.
  The Ko-fi link opens in your browser only if you click it.
- **Accounts**: cloud sync requires an account with the chosen provider; cloud AI requires an account/API key with the chosen AI provider. Everything else works without accounts.
- **Payments**: the plugin is free and complete. The only payment-related element is an optional donation link to Ko-fi in the settings footer (and the `fundingUrl` of the manifest). No pop-ups or reminders.
- **No telemetry, no ads, no analytics.** The developer does not receive any data.
- **Files outside the vault**: only the "local folder" sync option (desktop) writes to the folder you choose, e.g. the MEGA or Proton Drive folder.
- **Obsidian settings changed**: only the ribbon visibility (`showRibbon`), and only when you choose "Show the ribbon" yourself. Hidden properties and the new interface are CSS only and can be turned off. Ambraia adds entries to Obsidian's context menus and wraps the "Uninstall" action for its own id only (to clean up); both are restored when it is turned off.
- **Automatic changes to notes**: a short, safe maintenance runs by itself a few minutes after start, at most once a week and only when Obsidian is idle. On notes it only removes what Ambraia itself wrote and is empty or default (empty `icon`/`banner`, a centred cover position, empty frontmatter blocks), once per Ambraia version; note text and any other property are never touched by Ambraia. The only exception is what you decide: if you create a shared link with a profile that **can edit**, whoever enters with that profile can change the text of that note (never its properties); changes are merged with the existing text and you can remove the right or revoke the link at any time. It also forgets settings for deleted files and removes regenerable device data (AI index when AI is off, merge base when no cloud is configured).
- Closed-source or obfuscated code: none. The full source is in this repository.

## AI (EU AI Act, Regulation (EU) 2024/1689, and Italian Law 132/2025)
- The AI assistant is **off by default**. When on, what you send (prompt, selected text, notes you attach or that it finds in the vault) goes to the provider you configured, or stays on your computer with a local model (LM Studio, Ollama). Notes in excluded folders are never sent.
- The chat is a separate view clearly presented as an AI assistant, so you always know you are talking to an AI system (art. 50(1)). Answers are generated by an AI model and **may be wrong**: check them before relying on them.
- **Marking of AI-generated text** (art. 50(2) AI Act): notes created by the AI get the property `ai-generated: true`, notes where AI text is inserted or that the agent edits get `ai-assisted: true`, saved chats are marked too. You can turn it off in Settings → AI, but if you **publish** AI-generated text on matters of public interest you must disclose it yourself (art. 50(4)).
- The agent never changes a note without your confirmation.
- Avoid sending other people's personal data, or special categories of data (health, etc.), to cloud AI providers; prefer a local model for them.
- Under Italian Law 132/2025 (art. 4), people under 14 may use AI tools only with the consent of whoever holds parental responsibility.

## Privacy (GDPR, Regulation (EU) 2016/679, and Italian Privacy Code, D.Lgs. 196/2003 as amended by D.Lgs. 101/2018) <a id="privacy"></a>
- The developer (d4ruerk1) does not collect, receive or process any personal data and runs no server. Your notes stay on your devices and go **directly** to the providers you choose. For your own vault you decide which services to use; the developer is neither controller nor processor of that data.
- When you connect a cloud or AI service, that provider processes your data under its own terms and privacy policy. With encryption on, file contents (and optionally names) are encrypted before leaving the device.
- Device pairing stores in your cloud folder only short-lived, encrypted pairing files (deleted after use or after 5 minutes) and, per device, a device name, platform, public keys, certificate and last-seen time (plus the list of your shared links, if any), encrypted with a key shared only by your devices and saved under opaque names. They are removed when you disconnect a device or uninstall.
- Photo downloads and the AI web tools are standard HTTPS requests: your IP address and user agent are visible to picsum.photos / its CDN and to the sites the AI reads or searches, respectively. The AI web tools identify themselves honestly with the user agent `Ambraia/1.0` and a link to this repository; some sites (e.g. YouTube, DuckDuckGo) may limit automated requests, and you are responsible for respecting their terms of use. Photo covers are downloaded only on demand.
- **Shared links**: you decide what to share and with whom, and you are responsible for the content you share (share only what you have the right to distribute, and avoid other people's personal data unless you have a legal basis). The content is end-to-end encrypted, so neither the developer, nor GitHub, nor the relay can read it. The reading page sets no cookies, uses no storage, analytics or third-party resources (strict Content-Security-Policy) and removes the key from the address bar after opening; GitHub, which hosts it, sees the reader's IP address and user agent as for any web page (GitHub's privacy statement applies). The relay (ntfy.sh, operated by its own provider under its own terms and privacy policy, or your own server) sees IP addresses, random topic names, the time and size of encrypted requests and answers, and keeps them for up to about 12 hours; messages are sent with push forwarding disabled. The developer runs neither service and receives no data from them.
- If you let a profile edit, whoever uses it sees the full text of the note (`%% comments %%` included, properties excluded) and what they write goes into your vault: give this right only to people you trust and check the changes you receive. Changes travel end-to-end encrypted like notes; the reading page keeps them only in memory until they are saved. For notes containing other people's personal data, you decide whether and with whom to share them (as controller, unless the use is purely personal or household).
- Keys and tokens are kept in Obsidian's secret storage (the system keychain), never in `data.json`; logs contain no tokens.
- Your rights under the GDPR apply to the providers that actually process your data; you can also lodge a complaint with the Garante per la protezione dei dati personali.

## Fonts
Ambraia bundles and downloads **no fonts**. The "Standard", "Serif" and "Mono" options only list fonts already installed on your system in a CSS `font-family` stack (Standard: `ui-sans-serif`, `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `Roboto`, `Helvetica Neue`, `Arial` and the system emoji fonts; Serif: `ui-serif`, `Georgia`, `Cambria`, `Times New Roman`; Mono: `ui-monospace`, `SFMono-Regular`, `Menlo`, `Consolas`, `Liberation Mono`) with generic fallbacks (`sans-serif`, `serif`, `monospace`). Their use is governed by your operating system's font licences; Ambraia does not redistribute any font file. "Theme" uses your Obsidian theme's font.

## Images
Cover photos come from [Unsplash](https://unsplash.com) through [Lorem Picsum](https://picsum.photos) and are used under the [Unsplash Licence](https://unsplash.com/license) (free to use, no permission needed). The photographer's name is shown when you hover a photo in the gallery. Small previews are bundled; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Trademarks
Ambraia is an independent project, not affiliated with or endorsed by Obsidian (Dynalist Inc.), Google, Dropbox, Microsoft, pCloud, MEGA, Proton, OpenAI, Anthropic, Google Gemini, Mistral AI, Ollama, LM Studio, OpenRouter, DeepSeek, Unsplash or any other company mentioned. All names and trademarks belong to their owners and are used only to describe compatibility (nominative use). The small service logos in the settings come from [Simple Icons](https://simpleicons.org) (CC0) and are shown only next to the service they identify; services whose brand guidelines do not allow such use get a coloured initial instead. "Ambraia" is not a registered trademark; a search on TMview (EUIPO, all participating offices) found no identical or similar marks for software (Nice classes 9 and 42).

## Licence and warranty
MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the licence notices are also kept at the top of the released `main.js`. The software is provided "as is", without warranty, to the extent permitted by applicable law (nothing here limits liability that cannot be limited by law, e.g. for wilful misconduct or gross negligence, art. 1229 of the Italian Civil Code, or the rights of consumers under the Italian Consumer Code, D.Lgs. 206/2005). Encryption software may be subject to import/export rules in some countries; the full source is public (EU Regulation 2021/821, General Software Note).

Ambraia is free and open-source software, developed and published without any commercial activity: there are no paid features, sales or data monetisation, and donations are voluntary and do not unlock anything (EU Cyber Resilience Act, Regulation (EU) 2024/2847, recitals 15–19).

## Build
```
npm install
npm test
npm run build      # type-check, main.js, styles.css and docs/share/viewer.js
npm run release    # dist/ambraia and dist/Ambraia-<version>.zip
npm run i18n       # regenerate the language packs (needs xz)
```
To publish a release, push a tag equal to the version in `manifest.json` (e.g. `1.0.0`): the GitHub workflow tests, builds and drafts the release with `main.js`, `manifest.json` and `styles.css`.

The reading page of shared links is `docs/share/` (built `viewer.js` included, commit it after `npm run build`). Publish it with GitHub Pages (Settings → Pages → Deploy from a branch → `main`, folder `/docs`), or on any static HTTPS host, and keep `shareViewerUrl` in `src/settings.ts` pointing to it.

One-click cloud sign-in needs your own OAuth apps in `apps.json` (see `apps.example.json`); without it users enter their own client ID. Re-translating strings with `scripts/i18n_translate.py` requires your own `GOOGLE_TRANSLATE_API_KEY`.
