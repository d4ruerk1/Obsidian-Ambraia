# Ambraia

*English · [Italiano](README.it.md)* — by [d4ruerk1](https://github.com/d4ruerk1) · MIT licence · [Legal notes](LEGAL.md) · [Privacy](PRIVACY.md) · [Donate](https://ko-fi.com/d4ruerk1) (optional)

**A Notion-like workspace for Obsidian**: page icons and covers, databases, calendar, a template gallery, `/` and `@` menus, a clean formatting toolbar, a refreshed interface, optional end-to-end encrypted sync with one or more clouds, shareable links and an optional AI assistant (off by default) that also works with local models. Your notes stay plain Markdown files.

The name comes from Italian *ambra* (amber, which keeps things intact for ages, like your notes) with **AI** inside: Ambr**ai**a, pronounced *am-BRY-ah*.

The interface follows Obsidian's language: English, Italiano, Español, Deutsch, Français, العربية, Русский, 中文, 日本語.

## Highlights
| | |
|---|---|
| 🗂️ **Pages** | icons, covers, folder notes, favourites, 50 templates |
| 🗃️ **Databases** | table, board, gallery, list and calendar over a folder or tag, with formulas |
| 📅 **Calendar** | month view, daily/weekly notes, tasks, drag and drop |
| ☁️ **Sync** | Google Drive, Dropbox, OneDrive, pCloud, MEGA, Proton Drive — several at once, end-to-end encryption, no server in between |
| 🔗 **Shared links** | end-to-end encrypted links to read (or edit) a note in the browser |
| ✨ **AI** | chat, vault Q&A, agent with confirmation — cloud or local (LM Studio, Ollama), off by default |

## Install
Requires Obsidian 1.13.0 or later (desktop and mobile).
- **Community plugins**: Ambraia has been submitted to the Obsidian community plugin directory and is **under review**: until it is approved it does not appear in Settings → Community plugins → Browse.
- **Manually**: download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/d4ruerk1/Obsidian-Ambraia/releases) into `<vault>/.obsidian/plugins/ambraia/`, then enable Ambraia in Settings → Community plugins.
- **BRAT**: with the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, add the beta plugin `d4ruerk1/Obsidian-Ambraia`.

Everything Ambraia needs on a device lives inside its own plugin folder: settings in `data.json`, sync state, merge base and AI index in `state/`. Updating keeps the folder; uninstalling (or deleting the folder) removes it (see *Uninstalling*).

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

**Calendar** — month view whose header follows the day columns (‹ over the first day, month and year in the middle, › over the last). The "Month Year ▾" button opens the month/year picker, with **Today** and the short guide. Daily and weekly notes, dated pages and tasks (`📅 2026-10-05`, `⏳`, `[due:: …]`), drag and drop. Each day shows one blue dot per open task or dated page (up to three), three red dots when there are more. Tasks added from the agenda (Enter or the **+** button) go to `Calendar/<date>.md` (folder name in your language).

**Ribbon and status bar** — right-click the ribbon to add a shortcut to any command (with its icon) or remove it; if you hid the ribbon, right-click an empty area of the file explorer to show it again. The status bar shows one sync icon per sync really in use: with an Ambraia cloud service and Obsidian Sync not linked, only Ambraia's icon (Obsidian's idle one is hidden); without an Ambraia service, only Obsidian's; with both in use, both. The AI icon sits right under the calendar icon while the AI is on.

**Sync** — Google Drive, Dropbox, OneDrive, pCloud, and MEGA / Proton Drive / any folder through their desktop apps. Several at once, optional end-to-end encryption (AES-256-GCM, XChaCha20-Poly1305 or AES-CTR+HMAC, Argon2id), line-level merging, safety stops on mass deletions.
- **Connect another device** with a one-time 8-character code (the new device looks for it inside the vault folder in the cloud, usually preselected): valid for 5 minutes, usable once, and cancelled as soon as you close the window that shows it. The code carries no secret: the new device signs in to the same account itself and the code only lets the two devices find each other. They agree on a one-off key (ECDH P-256) and both show the same **6-digit check code**; nothing (folder, encryption key, device list key) is sent until you press **Approve** on the device that is already connected. You can also **Reject** it.
- **Connected devices (all equal)**: each service lists the devices that use it, with their last sync. There are no owners or administrators: from **any** device (the first PC, a phone, …) you can link new devices and choose which ones to remove from sync, including the first one. Each device is introduced by the device that approved it (a signed certificate) and every removal is signed and checked by all devices, so a removed device cannot send commands or come back without a new code; a device that no device introduced is marked **Unverified**. A removal can be undone until it runs. From the ⋯ menu you can also **disconnect and delete the data** on a device (the vault notes and Ambraia's data on it). Commands run the next time that device is online; for a lost device also revoke access in your cloud account. The list is stored encrypted, with opaque file names, in a small `.ambraia` folder inside the vault folder in the cloud (1.0.0 kept it at the top of the cloud space: it is moved there by itself).
- **Cloud folder chosen for you**: when you pick a service, the folder step lists the vault folders already on that account and which of your devices uses them, and preselects the one the other devices of your chain use (or the one named after the vault), so a new device joins the existing folder instead of creating a new one; the same path typed with different capitals is matched to the existing folder. On Google Drive, which allows two folders with the same name, twin vault folders (created at the same moment by two devices or by older versions, including a duplicate `Ambraia` parent) are folded into the oldest one by themselves: contents are moved and merged, the empty twin goes to the trash.
- **Expired access**: "Sign in again" keeps folder, encryption and settings.
- **Turning encryption on or changing it** shows each step (last sync, key derivation, key file) and closes as soon as the new key is saved; the old cloud copies are moved to the cloud trash in the background, with progress in the status bar.
- **Two devices with notes already in them** (e.g. PC and phone): the first sync merges both instead of overwriting.

**Shared links** — share a note with anyone through a link (command "Share the note with a link", the note menu or the file explorer). The reader opens it in a browser, without Obsidian or an account. Ready to use: press **Create link** and you get a read-only link without a password; everything else is optional.
- **How it works**: the link holds only a 256-bit key, in the part after `#`, which browsers never send to any server. When someone opens it, one of your devices with Obsidian open (any synced device, desktop or phone in the foreground) checks profile, password, expiry, revocation and number of openings and answers with the current version of the note through an ntfy relay (`ntfy.sh` by default, or your own server), end-to-end encrypted. If no device is online the reader is asked to try again later. Ten wrong passwords pause a link for 15 minutes.
- **Validity**: valid from now or from a date and time, for 1 hour, 1 day, 7, 30 or 90 days, 1 year, until a date or with no expiry. The dialog shows the real limits of the free relay (see *Known limits*).
- **Profiles**: one link can have several profiles, each with its own password, edit or read-only rights, maximum number of openings and expiry (never beyond the link's). The reader gets the profile of the password they enter; only one profile can be without a password. Example: "Edit" with a password, one opening, can edit; "Read" without a password, unlimited openings for one day.
- **Editing from the browser**: a profile allowed to edit sees the full text of the note (except the properties, which stay private and untouched) and can save it. Changes are merged line by line with those made in the vault in the meantime, including edits made offline on your devices and synced later, so the note ends up consistent. If the same lines changed on both sides nothing is overwritten: the editor sees the current text and their own version to copy back. If no device is reachable the page keeps the change and retries by itself. Only one of your devices applies each change, even with several online. An editing session lasts at most 12 hours from opening (never beyond the profile's expiry); once the openings are used up, the open session can still save.
- **Managing**: change expiry and profiles, reset the opening count, revoke or delete a link at any time, from any of your devices: the list of links travels encrypted and signed in the device list of your sync service.
- Readers get only the text: properties (frontmatter), `%% comments %%`, embeds and local images are left out, and internal links become plain text. The reading page shows Markdown as plain formatted text: no HTML, scripts or remote images.
- The reading page is a static page in this repository (`docs/share/`, published with GitHub Pages at `https://d4ruerk1.github.io/Obsidian-Ambraia/share/`); you can host it anywhere and set its address, and the relay's, in Settings → Ambraia → Sharing.
- **Does publishing the page on GitHub Pages make the links visible to everyone?** No. GitHub only hosts the page and its code, the same for everyone: links and notes are never stored on GitHub or on the relay, there is no list of links, and the key after `#` never reaches any server. A note opens only with its link (and the profile's password, if any); relay topics have random names and carry only encrypted data.

**AI (off by default)** — enable it in Settings → AI. Chat, vault Q&A, an agent with confirmation before edits, actions on selected text, custom prompts. Works with LM Studio, Ollama or cloud providers. Saved chats are plain Markdown with simple headings and properties, easy to read for people and models. AI output can be inaccurate: always check it.

## Updates
Ambraia has no update checker of its own: install a newer release by hand or through BRAT (and, once approved, from Settings → Community plugins). It never downloads or installs code by itself.

## Risks: master key and uninstalling
- **The master key cannot be recovered.** It is never stored outside your devices. If you lose it, the encrypted files in the cloud are unreadable forever.
- **Uninstalling**: just use Obsidian's own **Uninstall** (Settings → Community plugins). Obsidian deletes the plugin folder, and with it everything Ambraia keeps on disk (settings, sync state, AI index). Ambraia does not intercept that button and uses no private API: right after being turned off it checks, with the public file API, whether its own `manifest.json` still exists. Only if it is gone (= uninstalled; turning it off, updating or closing Obsidian leave it in place) it finishes the cleanup: this device leaves the device list, Ambraia's keychain entries and local-storage keys are deleted, and "Automatically update internal links" gets back its previous value. A notice confirms it. Notes, attachments, icons and covers stay as normal Markdown and properties; encrypted copies in the cloud stay readable only with Ambraia and the master key, so keep it. Changes made in the last seconds and not yet synced stay on this device. If you delete the plugin folder by hand while Obsidian is closed, the device stays in the list (remove it from another device). To start over without uninstalling, use Settings → Ambraia → General → "Restore default settings".
- Keep your own backups. Sync is not a backup.

## Disclosures <a id="disclosures"></a>
As required by the [Obsidian developer policies](https://docs.obsidian.md/Developer+policies):
- **Network use** — only:
  1. the cloud services you connect (and only them), including their sign-in pages;
  2. the AI provider you configure, only if AI is enabled; the AI web tools, only when AI is on and only through official APIs: web search (on by default with AI: Google Search through the Gemini API if you add a Gemini key, otherwise DuckDuckGo Instant Answers `api.duckduckgo.com` and Wikipedia `*.wikipedia.org`; or your own SearXNG), the pages you ask it to read, YouTube videos (oEmbed title; with your keys the Gemini API, which receives the video address, or the YouTube Data API), X posts via `publish.twitter.com` oEmbed. Search engines' and YouTube's pages are never scraped;
  3. `picsum.photos` (photos from Unsplash) only when you **pick** a photo cover — gallery previews are bundled;
  4. for **shared links**, only if you create one: the relay set in Settings → Ambraia → Sharing (`ntfy.sh` by default), to which your devices keep a connection while Obsidian is open and at least one link is active; the reading page (GitHub Pages by default) is opened by the people you send a link to, not by the plugin.
  The GitHub, donation, legal and privacy links in the settings open in your browser only if you click them.
- **Accounts**: cloud sync requires an account with the chosen provider; cloud AI requires an account/API key with the chosen AI provider. Gemini use is subject to Google's age and regional service requirements: users in the EEA, Switzerland and UK must use Paid Services, and Gemini users must be 18 or older. Everything else works without accounts.
- **Payments**: free and complete. The only payment-related element is an optional donation link (Ko-fi) in the settings footer and the manifest's `fundingUrl`. No pop-ups, no reminders, nothing unlocked by donating.
- **No telemetry, no ads, no analytics.** The developer receives no data — see [PRIVACY.md](PRIVACY.md).
- **Files outside the vault**: only the "local folder" sync option (desktop) writes to the folder you choose, e.g. the MEGA or Proton Drive folder.
- **Obsidian settings changed**: "Automatically update internal links" (`alwaysUpdateLinks`) is turned on while Ambraia's "Update links automatically" is on (default; turning it off restores the previous value), and the ribbon visibility (`showRibbon`) only when you choose "Show the ribbon". Hidden properties and the new interface are CSS only. Ambraia adds entries to Obsidian's context menus (removed when it is turned off); it does not patch or intercept Obsidian's own actions such as Uninstall.
- **Automatic changes to notes**: a short maintenance runs at most once a week when Obsidian is idle and only removes what Ambraia itself wrote and is empty or default (empty `icon`/`banner`, centred cover position, empty frontmatter). Note text and other properties are never touched by Ambraia, except by people you allow to edit through a shared link.
- **Source**: no closed-source or obfuscated code; the full source is in this repository.

## AI, privacy and legal
- The AI assistant is **off by default**, clearly presented as AI, marks AI-generated notes (`ai-generated` / `ai-assisted`, EU AI Act art. 50) and never edits a note without your confirmation. Answers may be wrong: check them.
- Your notes go directly from your devices to the services you choose; the developer runs no server and collects nothing.
- Details: [PRIVACY.md](PRIVACY.md) (GDPR, Italian Privacy Code) · [LEGAL.md](LEGAL.md) (licence and warranty, AI Act and Italian Law 132/2025, Obsidian and GitHub policies, trademarks, fonts and images, encryption).

## Known limits
- Tested with automated tests (including faithful emulations of the Google Drive, Dropbox, OneDrive and pCloud APIs and hundreds of random failure scenarios), but not inside every real Obsidian setup or against every real server: please report anything odd.
- **Shared links** answer only while at least one of your devices has Obsidian open (on phones, in the foreground). The free `ntfy.sh` relay puts no expiry on links, but accepts about 250 messages a day per device (≈ 120 openings a day in total); notes up to about 1.4 MB; a browser editing session lasts at most 12 hours. For heavy use, run your own ntfy server.
- **Web search and YouTube**: without a Gemini key the free sources (DuckDuckGo Instant Answers, Wikipedia) answer well for facts, people, places and definitions but are not a full web search. Gemini is available only with **Paid Services** for users in the European Economic Area, Switzerland and the United Kingdom; Gemini requires the user to be **18 or older**. For users outside those regions, a free Gemini tier may be available subject to Google's current terms and quotas. For users in the EEA, Switzerland and UK, Google says data is not used to improve its services under the applicable Gemini API terms. See the [Gemini API terms](https://ai.google.dev/gemini-api/terms).
- MEGA and Proton Drive have no suitable public API: they work through their desktop app's folder, so only on computers.
- Translations other than Italian are machine-generated and only partly reviewed.

## Licence
MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Ambraia is an independent project, not affiliated with or endorsed by Obsidian or any service mentioned; names and trademarks belong to their owners ([LEGAL.md](LEGAL.md#trademarks)).
