import { keyAcknowledgement } from '../safety';
import { App, Modal, Notice, Platform, Setting, setIcon } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { createPkce, parseRedirect, startLoopback, waitListening, Loopback } from './oauth';
import { authUrl, Credentials, DeviceAuth, devicePoll, deviceStart, exchangeCode, GOOGLE_MOBILE_REDIRECT, MS_MOBILE_REDIRECT, PROVIDERS, ProviderId, providerMeta, supportsDevice } from './providers';
import { builtinApp } from './apps';
import { AuthError } from './engine';
import { isDesktopFs, suggestFolders } from './providers/localFolder';
import { defaultFolder, deviceSignKeys, EncryptionChoice, obsidianHttp, SyncManager } from './manager';
import { Alg, ALGS, ALG_NAMES, generateMasterKey, Keyfile, MIN_STRENGTH, normalizePairCode, strength, WrongKeyError } from './crypto';
import { brandBadge } from '../ui/brands';
import { deviceId, deviceName, isControlPath, PAIR_FOLDER, pairFolder, PairingOffer, platformName, redeemCode } from './devices';
import { cleanPath } from './http';
import { helpButton, link } from './help';
import { tx } from '../i18n';

type Step = 'choose' | 'link' | 'connect' | 'code' | 'folder' | 'encrypt' | 'done' | 'reauth-warn';
/** new: add a service · pair: this vault already syncs elsewhere · reauth: sign in again, keeping everything */
export type SetupMode = 'new' | 'pair' | 'reauth';
type HelpStep = string | ((li: HTMLElement) => void);

const withLink =
	(before: string, text: string, href: string, after: string): HelpStep =>
	(li) => {
		li.appendText(before);
		link(li, text, href);
		li.appendText(after);
	};

/** Short tutorials behind the (?) buttons. */
function tutorial(p: ProviderId): HelpStep[] {
	switch (p) {
		case 'gdrive':
			return [
				withLink(tx('Apri '), 'Google Auth Platform', 'https://console.cloud.google.com/auth/overview', tx(', crea un progetto (es. "Ambraia") e premi "Get started": nome app, tua email, pubblico "External".')),
				withLink(tx('Attiva '), 'Google Drive API', 'https://console.cloud.google.com/apis/library/drive.googleapis.com', tx(' (pulsante "Enable").')),
				withLink(tx('In '), 'Audience', 'https://console.cloud.google.com/auth/audience', tx(' premi "Publish app": in modalità "Testing" Google scollega l’accesso ogni 7 giorni.')),
				withLink(tx('In '), 'Clients → Create client', 'https://console.cloud.google.com/auth/clients/create', tx(' scegli "TVs and Limited Input devices" (funziona su computer e telefoni; "Desktop app" va bene solo su computer), premi "Create" e copia qui Client ID e Client secret.')),
				tx('Ambraia usa solo il permesso "drive.file": vede soltanto i file che crea, non il resto del tuo Drive.'),
			];
		case 'dropbox':
			return [
				withLink(tx('Apri '), 'Dropbox App Console', 'https://www.dropbox.com/developers/apps/create', tx(' e crea un’app: "Scoped access" → "App folder" → un nome qualsiasi.')),
				tx('Nella scheda "Permissions" spunta files.metadata.read, files.content.read e files.content.write, poi premi "Submit".'),
				tx('Nella scheda "Settings" copia la "App key" e incollala qui. Il secret non serve.'),
				tx('I file finiranno in Dropbox → Apps → <nome app> → cartella scelta.'),
			];
		case 'onedrive':
			return [
				withLink(tx('Apri '), 'Microsoft Entra → App registrations', 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', tx(' e premi "New registration".')),
				tx('Nome a piacere; tipo di account: "Accounts in any organizational directory and personal Microsoft accounts".'),
				tx('In "Authentication" → "Add a platform" → "Mobile and desktop applications": spunta l’indirizzo che termina con "nativeclient" e aggiungi anche http://localhost.'),
				tx('Sempre in "Authentication" imposta "Allow public client flows" su "Yes" e salva.'),
				tx('Dalla pagina "Overview" copia "Application (client) ID" e incollalo qui.'),
			];
		case 'pcloud':
			return [
				withLink(tx('Apri '), 'pCloud My applications', 'https://docs.pcloud.com/my_apps/', tx(' (accedi con il tuo account) e crea una nuova app.')),
				tx('Concedi i permessi di lettura e modifica dei file.'),
				tx('Copia "Client ID" e "Client secret" e incollali qui. Non serve un indirizzo di reindirizzamento.'),
			];
		case 'mega':
			return [
				withLink(tx('Installa '), tx('l’app desktop di MEGA'), 'https://mega.io/desktop', tx(' e accedi.')),
				tx('Verifica che una cartella del computer sia sincronizzata con MEGA (di solito "MEGA" o "MEGAsync" nella tua cartella utente).'),
				tx('Scegli qui quella cartella: Ambraia scrive al suo interno e l’app di MEGA la carica nel cloud, con la sua cifratura.'),
			];
		default:
			return [
				withLink(tx('Installa '), tx('l’app desktop di Proton Drive'), 'https://proton.me/drive/download', tx(' (Windows o macOS) e accedi.')),
				tx('Trova la cartella "Proton Drive" (su Windows dentro "My files", su macOS in Finder → Posizioni).'),
				tx('Scegli qui quella cartella: Ambraia scrive al suo interno e l’app di Proton la carica nel cloud, con la sua cifratura.'),
			];
	}
}

const ALG_HELP = (): HelpStep[] => [
	tx('AES-256-GCM: lo standard più diffuso, accelerato dall’hardware. Consigliato.'),
	tx('XChaCha20-Poly1305: molto veloce anche su telefoni senza accelerazione AES, con nonce lunghi.'),
	tx('AES-256-CTR + HMAC-SHA-256: costruzione classica "encrypt-then-MAC", indipendente da GCM.'),
	tx('Tutti e tre sono sicuri e autenticati: qualsiasi modifica ai file nel cloud viene rilevata. La chiave principale è rafforzata con Argon2id (o PBKDF2) e ogni file ha una chiave propria.'),
	tx('La chiave principale non lascia mai i tuoi dispositivi e non si può recuperare: conservala in un gestore di password.'),
];

/** What the plugin can see on each service. */
function scopeNote(p: ProviderId): string {
	if (p === 'gdrive') return tx('Ambraia usa solo il permesso "drive.file": vede soltanto i file che crea, non il resto del tuo Drive.');
	if (p === 'dropbox') return tx('Ambraia lavora solo nella sua cartella Dropbox → Apps.');
	if (p === 'onedrive') return tx('Ambraia legge e scrive solo nella cartella che scegli al passo successivo.');
	return tx('Ambraia legge e scrive solo nella cartella che scegli al passo successivo.');
}

/** Human-readable sign-in errors. */
function authMessage(e: unknown): string {
	const m = (e as Error)?.message ?? String(e);
	if (m === 'access_denied') return tx('Accesso negato. Riprova e premi "Consenti".');
	if (m === 'expired') return tx('Il codice è scaduto: premi di nuovo "Accedi".');
	if (m === 'timeout') return tx('Tempo scaduto: premi di nuovo "Accedi".');
	return tx('Errore: {0}', m);
}

const STRENGTH = () => [tx('molto debole'), tx('debole'), tx('discreta'), tx('buona'), tx('ottima')];

export class SetupModal extends Modal {
	private step: Step = 'choose';
	private provider: ProviderId;
	private clientId = '';
	private clientSecret = '';
	private folder: string;
	private localBase: string;
	private creds: Credentials | null = null;
	private account = '';
	private loopback: Loopback | null = null;
	private useOwnApp = false;
	private loginEl: HTMLElement | null = null;
	private authRun = 0;
	/** waiting for the approval on the other device (cancelled when the window closes) */
	private pairWait: { cancelled: boolean } | null = null;
	private isOpen = false;
	private remote: { keyfile: Keyfile | null; hasFiles: boolean } | null = null;
	/** Service being configured: an existing one, or a draft added to the services at the end of step 3. */
	private mgr: SyncManager;
	private isNew: boolean;
	/** Linking to a vault that already syncs on another device (sign in, then one-time code). */
	private pairing = false;

	constructor(
		app: App,
		private plugin: AmbraiaPlugin,
		existing?: SyncManager,
		private mode: SetupMode = 'new',
	) {
		super(app);
		this.isNew = !existing;
		const used = new Set(plugin.sync.managers.map((m) => m.provider));
		const mgr = (this.mgr = existing ?? plugin.sync.draft(PROVIDERS.find((p) => !used.has(p.id))?.id ?? 'gdrive'));
		this.provider = mgr.provider;
		const c = mgr.credentials;
		if (c) {
			this.clientId = c.clientId ?? '';
			this.clientSecret = c.clientSecret ?? '';
		}
		this.folder = mgr.t.folder || defaultFolder(app.vault.getName());
		this.localBase = mgr.localBase;
		if (mode === 'pair') {
			this.pairing = true;
			this.step = existing ? 'connect' : 'link';
		} else if (mode === 'reauth' && existing) this.step = 'connect';
	}

	onOpen() {
		this.isOpen = true;
		this.modalEl.addClass('ambraia-setup');
		this.render();
	}

	onClose() {
		if (this.pairWait) this.pairWait.cancelled = true;
		this.isOpen = false;
		this.authRun++;
		this.loopback?.close();
		this.contentEl.empty();
	}

	private go(s: Step) {
		this.authRun++;
		this.step = s;
		this.render();
	}

	private render() {
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText(
			this.mode === 'reauth'
				? tx('Accedi di nuovo a {0}', providerMeta(this.provider).name)
				: this.step === 'choose' || this.step === 'link'
					? this.isNew && this.plugin.sync.managers.length
						? tx('Aggiungi un servizio cloud')
						: tx('Sincronizzazione nel cloud')
					: providerMeta(this.provider).name,
		);
		const steps: Step[] = this.mode === 'reauth' ? [] : this.pairing ? ['connect', 'code', 'done'] : ['connect', 'folder', 'encrypt', 'done'];
		const i = steps.indexOf(this.step);
		if (i >= 0) {
			const bar = el.createDiv({ cls: 'ambraia-steps-bar' });
			for (let k = 0; k < steps.length; k++) bar.createDiv({ cls: 'ambraia-steps-dot' + (k <= i ? ' is-done' : '') });
		}
		if (this.step === 'choose') return this.renderChoose(el);
		if (this.step === 'link') return this.renderLink(el);
		if (this.step === 'connect') return this.renderConnect(el);
		if (this.step === 'code') return this.renderCode(el);
		if (this.step === 'reauth-warn') return this.renderReauthWarn(el);
		if (this.step === 'folder') return this.renderFolder(el);
		if (this.step === 'encrypt') return void this.renderEncrypt(el);
		return void this.renderDone(el);
	}

	private buttons(el: HTMLElement, back: Step | null, next: string, onNext: (btn: HTMLButtonElement) => void | Promise<void>) {
		const row = el.createDiv({ cls: 'modal-button-container' });
		if (back) row.createEl('button', { text: tx('Indietro') }).onclick = () => this.go(back);
		const btn = row.createEl('button', { text: next, cls: 'mod-cta' });
		btn.onclick = async () => {
			if (btn.disabled) return;
			btn.disabled = true;
			try {
				await onNext(btn);
			} finally {
				btn.disabled = false;
			}
		};
		return btn;
	}

	// ---------------------------------------------------------------- 1. choose

	private renderChoose(el: HTMLElement) {
		el.createEl('p', { text: tx('Scegli dove salvare le note. Funziona tra computer, iPhone e Android; i dati vanno direttamente dal dispositivo al cloud, senza server intermedi.') });
		const active = this.plugin.sync.managers.filter((m) => m !== this.mgr);
		if (this.isNew && active.length) el.createEl('p', { cls: 'setting-item-description', text: tx('Già attivi: {0}. Il nuovo servizio si aggiunge a questi: il vault resta sincronizzato con tutti contemporaneamente.', active.map((m) => m.label).join(', ')) });
		const link = el.createDiv({ cls: 'ambraia-choice is-primary' });
		setIcon(link.createDiv({ cls: 'ambraia-choice-icon' }), 'smartphone');
		const lt = link.createDiv();
		lt.createDiv({ cls: 'ambraia-choice-title', text: tx('Ho già Ambraia su un altro dispositivo') });
		lt.createDiv({ cls: 'ambraia-choice-desc', text: tx('Accedi allo stesso servizio e inserisci il codice di 8 caratteri mostrato dall’altro dispositivo.') });
		link.onclick = () => {
			this.pairing = true;
			this.go('link');
		};
		el.createDiv({ cls: 'ambraia-choice-sep', text: tx('Oppure configura un nuovo servizio') });
		this.providerGrid(el, active);
	}

	private providerGrid(el: HTMLElement, active: SyncManager[]) {
		const grid = el.createDiv({ cls: 'ambraia-provider-grid' });
		const desktop = isDesktopFs();
		for (const p of PROVIDERS) {
			const off = p.flow === 'folder' && !desktop;
			const c = grid.createDiv({ cls: 'ambraia-provider' + (off ? ' is-disabled' : '') });
			c.setCssProps({ '--ambraia-provider': p.color });
			brandBadge(c, p.id, p.name, p.color, 'ambraia-provider-mark');
			c.createDiv({ cls: 'ambraia-provider-name', text: p.name });
			c.createDiv({ cls: 'ambraia-provider-desc', text: p.flow === 'folder' ? (off ? tx('Solo su computer') : tx('Tramite app desktop')) : tx('Accesso diretto') });
			if (active.some((m) => m.provider === p.id)) c.createDiv({ cls: 'ambraia-provider-desc mod-active', text: tx('già attivo') });
			if (!off)
				c.onclick = () => {
					this.provider = p.id;
					if (this.isNew) this.mgr.t.provider = p.id;
					if (this.mgr.credentials?.provider !== p.id) this.clientId = this.clientSecret = '';
					this.go('connect');
				};
		}
	}

	// ---------------------------------------------------------------- link: which service

	private renderLink(el: HTMLElement) {
		el.createEl('p', { text: tx('Su quale servizio è sincronizzato il vault sull’altro dispositivo? Accederai con lo stesso account, poi inserirai il codice monouso.') });
		this.providerGrid(el, []);
		const row = el.createDiv({ cls: 'modal-button-container' });
		row.createEl('button', { text: tx('Indietro') }).onclick = () => {
			this.pairing = false;
			this.go('choose');
		};
	}

	// ---------------------------------------------------------------- link: one-time code

	private renderCode(el: HTMLElement) {
		if (this.account) el.createEl('p', { cls: 'setting-item-description', text: tx('Collegato a {0}.', this.account) });
		el.createEl('p', { text: tx('Sull’altro dispositivo apri Impostazioni → Ambraia → Sincronizzazione → “Collega un dispositivo” e inserisci qui il codice di 8 caratteri.') });
		const inp = el.createEl('input', { cls: 'ambraia-pair-input', attr: { type: 'text', placeholder: tx('Codice'), maxlength: '9', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', 'aria-label': tx('Codice') } });
		inp.addEventListener('input', () => {
			const raw = inp.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
			inp.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
		});
		// the code is looked up inside the vault folder: the folder the other devices use is picked by itself
		let folders: string[] = [];
		const fs = new Setting(el)
			.setName(tx('Cartella del vault nel cloud'))
			.setDesc(tx('La stessa cartella usata sull’altro dispositivo. Di solito è già selezionata.'))
			.addText((t) => t.setPlaceholder(defaultFolder(this.app.vault.getName())).setValue(this.folder).onChange((v) => (this.folder = v)));
		fs.settingEl.addClass('ambraia-wide', 'ambraia-pair-folder');
		const folderInput = fs.controlEl.querySelector('input');
		const chips = el.createDiv({ cls: 'ambraia-folder-chips' });
		void this.folderSuggestions().then(({ list, chain }) => {
			folders = list;
			const pick = [...chain.keys()].find((f) => list.includes(f)) ?? (list.length === 1 ? list[0] : undefined);
			if (pick && cleanPath(this.folder) === defaultFolder(this.app.vault.getName())) {
				this.folder = pick;
				if (folderInput) folderInput.value = pick;
			}
			for (const f of list) {
				const c = chips.createEl('button', { cls: 'ambraia-folder-chip', text: f, attr: { 'data-folder': f } });
				c.toggleClass('is-active', f === cleanPath(this.folder));
				c.onclick = () => {
					this.folder = f;
					if (folderInput) folderInput.value = f;
					chips.querySelectorAll('.ambraia-folder-chip').forEach((x) => x.toggleClass('is-active', x === c));
				};
			}
		});
		const status = el.createDiv({ cls: 'ambraia-setup-status' });
		const btn = this.buttons(el, 'connect', tx('Collega'), async () => {
			const code = normalizePairCode(inp.value);
			if (!code) {
				status.setText(tx('Il codice ha 8 caratteri, ad esempio 7K3M-9QXD.'));
				return;
			}
			status.setText(tx('Cerco l’altro dispositivo… (qualche secondo)'));
			try {
				if (this.creds?.provider === 'mega' || this.creds?.provider === 'proton') this.mgr.setLocalBase(this.localBase);
				const spub = (await deviceSignKeys(this.app)).pub;
				const me = { id: deviceId(this.app), name: deviceName(this.app), platform: platformName(), spub };
				// chosen folder first, then the other vault folders of the account, then the place used by 1.0.0
				const places = [...new Set([pairFolder(cleanPath(this.folder)), ...folders.filter((f) => !isControlPath(f)).map((f) => pairFolder(f)), PAIR_FOLDER])];
				let claim: Awaited<ReturnType<typeof redeemCode>> = null;
				for (const place of places) {
					claim = await redeemCode(this.mgr.controlRemote(place, this.creds), code, me).catch((e) => (place === places[0] ? Promise.reject(e) : null));
					if (claim) break;
				}
				if (claim === 'outdated') {
					status.setText(tx('L’altro dispositivo usa una versione precedente di Ambraia: aggiornala e genera un nuovo codice.'));
					return;
				}
				if (!claim) {
					status.setText(tx('Codice non valido o scaduto. Controlla di aver effettuato l’accesso allo stesso account e che la finestra del codice sia ancora aperta sull’altro dispositivo.'));
					return;
				}
				if (claim.provider !== this.provider) {
					status.setText(tx('Il codice appartiene a un altro servizio.'));
					return;
				}
				// nothing secret has arrived yet: the other device must approve this one
				btn.disabled = true;
				inp.disabled = true;
				inp.hide();
				btn.hide();
				status.empty();
				const wait = status.createDiv('ambraia-pair-wait');
				wait.createDiv({ cls: 'ambraia-pair-wait-title', text: tx('In attesa di approvazione…') });
				wait.createDiv({ text: tx('Conferma su “{0}”: deve mostrare lo stesso codice di verifica.', claim.from.name) });
				wait.createDiv({ cls: 'ambraia-pair-check', text: claim.check });
				this.pairWait = { cancelled: false };
				const res = await claim.wait(this.pairWait);
				btn.disabled = false;
				inp.disabled = false;
				inp.show();
				btn.show();
				if (res === 'denied') {
					status.setText(tx('Collegamento rifiutato sull’altro dispositivo.'));
					return;
				}
				if (!res) {
					if (this.pairWait.cancelled) return;
					status.setText(tx('Tempo scaduto: genera un nuovo codice sull’altro dispositivo.'));
					return;
				}
				const p = res;
				this.folder = cleanPath(p.folder) || this.folder;
				const known = this.isNew ? this.plugin.sync.findUnlinked(this.provider, this.folder) : null;
				if (known) {
					this.mgr = known;
					this.isNew = false;
				}
				status.setText(tx('Collego…'));
				await this.apply();
				if (await this.mgr.adoptPairing(p)) this.go('done');
				else {
					this.remote = await this.mgr.inspectRemote();
					this.go('encrypt');
				}
			} catch (e) {
				status.setText(tx('Errore: {0}', (e as Error).message));
			}
		});
		inp.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') btn.click();
		});
		window.setTimeout(() => inp.focus(), 50);
		const manual = el.createEl('a', { cls: 'ambraia-own-app', text: tx('Non ho un codice: scelgo la cartella a mano'), attr: { href: '#' } });
		manual.onclick = (e) => {
			e.preventDefault();
			this.go('folder');
		};
	}

	/** Signed in again but the folder cannot be seen with the new access (other app / project). */
	private renderReauthWarn(el: HTMLElement) {
		el.createEl('p', { text: tx('Con questo accesso la cartella “{0}” non è visibile. Succede se hai usato un’altra app o un altro progetto (per esempio un nuovo Client ID di Google): ogni app vede solo i file che ha creato.', this.mgr.folder) });
		el.createEl('p', { cls: 'setting-item-description', text: tx('Se continui, la sincronizzazione resta in pausa finché non usi “Riallinea da zero”, che ricarica le note di questo dispositivo in una nuova cartella. Nessun file viene eliminato.') });
		const row = el.createDiv({ cls: 'modal-button-container' });
		row.createEl('button', { text: tx('Indietro') }).onclick = () => this.go('connect');
		row.createEl('button', { cls: 'mod-cta', text: tx('Continua') }).onclick = async () => {
			if (this.creds) await this.mgr.reauthenticate(this.creds);
			new Notice(tx('Accesso rinnovato.'));
			this.close();
		};
	}

	/** After a successful sign-in: next step depends on why the wizard was opened. */
	private async afterSignIn(creds: Credentials) {
		this.creds = creds;
		if (this.mode === 'reauth') {
			if (creds.provider === 'mega' || creds.provider === 'proton') this.mgr.setLocalBase(this.localBase);
			const root = await this.mgr
				.controlRemote(this.mgr.folder, creds)
				.findRoot()
				.catch(() => null);
			if (!root && this.mgr.state.lastSync) return this.go('reauth-warn');
			await this.mgr.reauthenticate(creds);
			new Notice(tx('Accesso a {0} rinnovato: la sincronizzazione riprende con le stesse impostazioni.', this.mgr.providerName));
			this.close();
			return;
		}
		this.go(this.pairing ? 'code' : 'folder');
	}

	// ---------------------------------------------------------------- 2. connect

	private renderConnect(el: HTMLElement) {
		const meta = providerMeta(this.provider);
		const builtin = builtinApp(this.provider);
		const own = !builtin || this.useOwnApp;
		const status = el.createDiv({ cls: 'ambraia-setup-status' });
		if (meta.flow === 'folder') {
			const intro = el.createDiv({ cls: 'ambraia-help-row' });
			intro.createSpan({ text: tx('{0} cifra i dati sul tuo computer con la sua app desktop: Ambraia usa la cartella sincronizzata da quell’app.', meta.name) });
			helpButton(intro, tx('Come configurare {0}', meta.name), tutorial(this.provider));
			el.append(status);
			return this.renderLocalFolder(el, status);
		}
		if (this.mode === 'reauth') el.createEl('p', { text: tx('L’accesso a {0} è scaduto o è stato revocato. Accedi di nuovo: cartella, cifratura e impostazioni restano invariate.', meta.name) });
		else if (this.pairing) el.createEl('p', { text: own ? tx('Accedi con lo stesso account usato sull’altro dispositivo, usando la stessa app (stesso Client ID).') : tx('Accedi con lo stesso account usato sull’altro dispositivo.') });
		if (!own) {
			if (this.mode === 'new') el.createEl('p', { text: tx('Accedi con il tuo account {0} e consenti l’accesso: non serve altro.', meta.name) });
			el.createEl('p', { cls: 'setting-item-description', text: scopeNote(this.provider) });
		} else if (this.provider === 'gdrive') {
			// Google Drive: the four steps on screen, no hidden tutorial
			el.createEl('p', { text: tx('Una volta sola (circa 3 minuti) crei un accesso personale gratuito su Google Cloud:') });
			const ol = el.createEl('ol', { cls: 'ambraia-steps' });
			for (const step of tutorial('gdrive').slice(0, 4)) {
				const li = ol.createEl('li');
				if (typeof step === 'string') li.setText(step);
				else step(li);
			}
			el.createEl('p', { cls: 'setting-item-description', text: scopeNote('gdrive') + ' ' + tx('Puoi anche incollare il file JSON scaricato da Google: Client ID e secret vengono letti da soli.') });
		} else {
			const intro = el.createDiv({ cls: 'ambraia-help-row' });
			intro.createSpan({
				text:
					meta.fields.length > 1
						? tx('Serve una "app" personale gratuita su {0} (una volta sola, circa 3 minuti). Guida passo passo nel pulsante “?”.', meta.name)
						: tx('Serve un ID applicazione personale gratuito di {0} (una volta sola, circa 2 minuti). Guida passo passo nel pulsante “?”.', meta.name),
			});
			helpButton(intro, tx('Come configurare {0}', meta.name), tutorial(this.provider));
		}
		// own app: the fields to fill (Google Drive included: its guide is on screen above)
		if (own) {
			if (meta.fields.includes('clientId'))
				new Setting(el).setName(this.provider === 'dropbox' ? 'App key' : this.provider === 'onedrive' ? 'Application (client) ID' : 'Client ID').addText((t) =>
					t
						.setPlaceholder(this.provider === 'gdrive' ? '…apps.googleusercontent.com' : '')
						.setValue(this.clientId)
						.onChange((v) => {
							this.clientId = v.trim();
							// the JSON downloaded from Google Cloud ("installed" or "web" client)
							if (this.clientId.startsWith('{')) {
								try {
									const j = JSON.parse(this.clientId) as Record<string, { client_id?: string; client_secret?: string }>;
									const c = j.installed ?? j.web ?? Object.values(j)[0];
									if (c?.client_id) {
										this.clientId = c.client_id;
										if (c.client_secret) this.clientSecret = c.client_secret;
										this.render();
									}
								} catch {
									/* still typing */
								}
							}
						}),
				).settingEl.addClass('ambraia-wide');
			if (meta.fields.includes('clientSecret'))
				new Setting(el).setName('Client secret').addText((t) => {
					t.inputEl.type = 'password';
					t.inputEl.autocomplete = 'off';
					t.setValue(this.clientSecret).onChange((v) => (this.clientSecret = v.trim()));
				}).settingEl.addClass('ambraia-wide');
		}
		el.append(status);
		const login = el.createEl('button', { cls: 'mod-cta ambraia-login-btn', text: tx('Accedi con {0}', meta.name) });
		this.loginEl = login;
		const box = el.createDiv({ cls: 'ambraia-auth-box' });
		login.setCssProps({ '--ambraia-provider': meta.color });
		login.onclick = async () => {
			if (login.disabled) return;
			const keys = own ? { clientId: this.clientId, clientSecret: this.clientSecret || undefined } : builtin;
			const filled = meta.fields.every((f) => (f === 'clientId' ? keys.clientId : keys.clientSecret));
			if (!filled) {
				status.setText(this.provider === 'gdrive' && own ? tx('Inserisci Client ID e Client secret (vedi i passaggi qui sopra).') : tx('Compila i campi richiesti (la guida è nel pulsante “?”).'));
				return;
			}
			if (this.provider === 'gdrive' && !keys.clientId.endsWith('.apps.googleusercontent.com')) {
				status.setText(tx('Il Client ID di Google termina con “.apps.googleusercontent.com”: controlla di averlo copiato per intero.'));
				return;
			}
			login.disabled = true;
			try {
				await this.signIn({ provider: this.provider, clientId: keys.clientId, clientSecret: keys.clientSecret }, status, box);
			} catch (e) {
				status.setText(authMessage(e));
			} finally {
				login.disabled = false;
				login.removeClass('ambraia-hidden');
			}
		};
		if (own && this.provider === 'gdrive') this.renderGoogleAdvanced(el, status);
		if (builtin) {
			const sw = el.createEl('a', { cls: 'ambraia-own-app', text: own ? tx('Usa l’accesso semplice') : tx('Avanzato: usa la tua app') , attr: { href: '#' } });
			sw.onclick = (e) => {
				e.preventDefault();
				this.useOwnApp = !own;
				this.render();
			};
		}
		const row = el.createDiv({ cls: 'modal-button-container' });
		if (this.mode === 'reauth') row.createEl('button', { text: tx('Annulla') }).onclick = () => this.close();
		else row.createEl('button', { text: tx('Indietro') }).onclick = () => this.go(this.pairing ? (this.isNew ? 'link' : 'choose') : 'choose');
	}

	/** Picks the simplest sign-in available on this device. */
	private async signIn(base: Credentials, status: HTMLElement, box: HTMLElement) {
		const run = ++this.authRun;
		const alive = () => run === this.authRun && this.isOpen;
		const p = base.provider;
		const desktop = Platform.isDesktopApp;
		this.loopback?.close();
		this.loopback = null;
		box.empty();
		const done = async (creds: Credentials) => {
			if (!alive()) return;
			status.setText(tx('Accesso ricevuto, verifico…'));
			this.account = await this.mgr.test(creds);
			await this.afterSignIn(creds);
		};
		// 1. device code: Google (TV-type app) everywhere, Microsoft on phones
		if (supportsDevice(p) && (p === 'gdrive' || !desktop)) {
			try {
				status.setText(tx('Preparo l’accesso…'));
				const d = await deviceStart(obsidianHttp, base);
				this.renderDeviceCode(box, d, status);
				const creds = await devicePoll(obsidianHttp, base, d, () => !alive());
				if (creds) await done(creds);
				return;
			} catch (e) {
				if (!(e instanceof AuthError) || e.message !== 'device-unsupported') throw e;
				box.empty();
			}
		}
		const { verifier, challenge, state } = await createPkce();
		// 2. desktop: browser + automatic return
		if (providerMeta(p).flow === 'loopback' && desktop) {
			try {
				this.loopback = startLoopback((good) => loopbackPage(good));
				const port = await waitListening(this.loopback);
				const redirect = p === 'onedrive' ? `http://localhost:${port}` : `http://127.0.0.1:${port}`;
				window.open(authUrl(p, base.clientId ?? '', challenge, state, redirect));
				status.setText(tx('Completa l’accesso nel browser: Ambraia continuerà da solo.'));
				const res = await this.loopback.wait;
				if (res.state !== state) throw new Error(tx('Risposta non valida (state)'));
				status.setText(tx('Accesso ricevuto, verifico…'));
				await done(await exchangeCode(obsidianHttp, base, res.code, verifier, redirect));
			} finally {
				this.loopback?.close();
				this.loopback = null;
			}
			return;
		}
		// 3. paste the code shown by the provider (Dropbox, pCloud) or the final address (fallback)
		const redirect = p === 'gdrive' ? GOOGLE_MOBILE_REDIRECT : p === 'onedrive' ? MS_MOBILE_REDIRECT : undefined;
		window.open(authUrl(p, base.clientId ?? '', challenge, state, redirect));
		status.setText('');
		box.createEl('p', {
			text: redirect
				? tx('Dopo aver consentito l’accesso il browser mostrerà una pagina vuota o di errore: è normale. Copia l’indirizzo completo di quella pagina e incollalo qui:')
				: tx('Dopo aver consentito l’accesso, {0} mostra un codice: copialo e torna qui.', providerMeta(p).name),
		});
		const inp = box.createEl('textarea', { cls: 'ambraia-code-input', attr: { rows: '2', spellcheck: 'false', placeholder: redirect ? 'http://…' : tx('Codice') } });
		const row = box.createDiv({ cls: 'ambraia-auth-actions' });
		const submit = async () => {
			const v = inp.value.trim();
			const code = redirect ? parseRedirect(v, state) : (parseRedirect(v) ?? v);
			if (!code) {
				status.setText(tx('Codice o indirizzo non valido.'));
				return;
			}
			ok.disabled = true;
			try {
				status.setText(tx('Accesso ricevuto, verifico…'));
				await done(await exchangeCode(obsidianHttp, base, code, verifier, redirect));
			} catch (e) {
				status.setText(authMessage(e));
				ok.disabled = false;
			}
		};
		row.createEl('button', { text: tx('Incolla') }).onclick = async () => {
			try {
				inp.value = (await navigator.clipboard.readText()).trim();
				if (inp.value) await submit();
			} catch {
				inp.focus();
			}
		};
		const ok = row.createEl('button', { text: tx('Conferma'), cls: 'mod-cta' });
		ok.onclick = submit;
		inp.addEventListener('paste', () => window.setTimeout(() => void (inp.value.trim().length > 8 && !ok.disabled && submit()), 0));
	}

	private renderDeviceCode(box: HTMLElement, d: DeviceAuth, status: HTMLElement) {
		box.empty();
		this.loginEl?.addClass('ambraia-hidden');
		const host = d.verifyUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
		box.createEl('p', { text: tx('Apri {0} e inserisci questo codice (puoi farlo anche da un altro dispositivo):', host) });
		box.createDiv({ cls: 'ambraia-device-code', text: d.userCode });
		const row = box.createDiv({ cls: 'ambraia-auth-actions' });
		const open = row.createEl('button', { cls: 'mod-cta', text: tx('Copia il codice e apri la pagina') });
		const go = async () => {
			try {
				await navigator.clipboard.writeText(d.userCode);
			} catch {
				/* the code is on screen anyway */
			}
			if (/^https:\/\//i.test(d.verifyUrl)) window.open(d.verifyUrl);
		};
		open.onclick = go;
		status.setText(tx('In attesa dell’accesso…'));
	}

	private renderGoogleAdvanced(el: HTMLElement, status: HTMLElement) {
		const d = el.createEl('details', { cls: 'ambraia-settings-details' });
		d.createEl('summary', { text: tx('Avanzato: refresh token esistente') });
		let refresh = '';
		let endpoint = '';
		new Setting(d).setName('Refresh token').addText((t) => {
			t.inputEl.type = 'password';
			t.onChange((v) => (refresh = v.trim()));
		});
		new Setting(d)
			.setName(tx('Endpoint token personalizzato (opzionale)'))
			.setDesc(tx('Riceve {"refresh_token"} e risponde {"access_token","expires_in"}. Solo https.'))
			.addText((t) => t.onChange((v) => (endpoint = v.trim())));
		const b = d.createEl('button', { text: tx('Verifica e continua') });
		b.onclick = async () => {
			if (!refresh || (!endpoint && (!this.clientId || !this.clientSecret)) || (endpoint && !/^https:\/\//.test(endpoint))) {
				status.setText(tx('Servono refresh token e Client ID + secret, oppure un endpoint https.'));
				return;
			}
			const creds: Credentials = { provider: 'gdrive', clientId: this.clientId, clientSecret: this.clientSecret, refreshToken: refresh, tokenEndpoint: endpoint || undefined };
			b.disabled = true;
			status.setText(tx('Verifico…'));
			try {
				this.account = await this.mgr.test(creds);
				await this.afterSignIn(creds);
			} catch (e) {
				status.setText(tx('Errore: {0}', (e as Error).message));
				b.disabled = false;
			}
		};
	}

	private renderLocalFolder(el: HTMLElement, status: HTMLElement) {
		const name = providerMeta(this.provider).name;
		if (!isDesktopFs()) {
			status.setText(tx('{0} è disponibile solo su computer: sui telefoni usa un altro servizio.', name));
			this.buttons(el, 'choose', tx('Indietro'), () => this.go('choose'));
			return;
		}
		let input: HTMLInputElement | null = null;
		const s = new Setting(el)
			.setName(tx('Cartella dell’app {0}', name))
			.setDesc(tx('Incolla il percorso della cartella che l’app desktop mantiene sincronizzata, oppure tocca uno dei suggerimenti qui sotto.'))
			.addText((t) => {
				input = t.inputEl;
				t.setValue(this.localBase).onChange((v) => (this.localBase = v.trim()));
			});
		s.settingEl.addClass('ambraia-wide');
		const sugg = el.createDiv({ cls: 'ambraia-suggest-row' });
		void suggestFolders(this.provider === 'mega' ? 'mega' : 'proton').then((list) => {
			for (const p of list) {
				sugg.createEl('button', { text: p, cls: 'ambraia-chip' }).onclick = () => {
					if (input) input.value = this.localBase = p;
				};
			}
		});
		this.buttons(el, 'choose', tx('Continua'), async () => {
			if (!this.localBase) {
				status.setText(tx('Scegli la cartella.'));
				return;
			}
			try {
				const fs = (window as unknown as { require: (m: string) => typeof import('fs') }).require('fs');
				if (!fs.statSync(this.localBase).isDirectory()) throw new Error();
			} catch {
				status.setText(tx('La cartella non esiste.'));
				return;
			}
			this.account = this.localBase;
			await this.afterSignIn({ provider: this.provider });
		});
	}

	// ---------------------------------------------------------------- 3. folder

	private renderFolder(el: HTMLElement) {
		const name = providerMeta(this.provider).name;
		el.createEl('p', { text: this.account ? tx('Collegato a {0}.', this.account) : '' });
		const s = new Setting(el)
			.setName(tx('Cartella nel cloud'))
			.setDesc(
				this.provider === 'dropbox'
					? tx('Percorso dentro la cartella dell’app su Dropbox. Usa lo stesso su tutti i dispositivi.')
					: tx('Percorso della cartella su {0} (le sottocartelle si separano con /). Usa lo stesso su tutti i dispositivi.', name),
			)
			.addText((t) => t.setPlaceholder(defaultFolder(this.app.vault.getName())).setValue(this.folder).onChange((v) => (this.folder = v)));
		s.settingEl.addClass('ambraia-wide');
		let input: HTMLInputElement | null = s.controlEl.querySelector('input');
		// folders already in the cloud: joining one of them never makes a twin of the same vault
		const found = el.createDiv({ cls: 'ambraia-folder-found' });
		let existing: string[] = [];
		void this.folderSuggestions().then(({ list, chain }) => {
			existing = list;
			if (!list.length) return;
			found.createDiv({ cls: 'ambraia-set-group-desc', text: tx('Cartelle già presenti su {0}: scegline una per unire questo dispositivo, senza creare doppioni.', name) });
			const chips = found.createDiv({ cls: 'ambraia-folder-chips' });
			const mark = () => chips.querySelectorAll('.ambraia-folder-chip').forEach((c) => c.toggleClass('is-active', (c as HTMLElement).dataset.folder === cleanPath(this.folder)));
			for (const f of list) {
				const who = chain.get(f);
				const c = chips.createEl('button', { cls: 'ambraia-folder-chip', text: f, attr: { 'data-folder': f } });
				if (who?.length) c.createSpan({ cls: 'ambraia-folder-who', text: ' · ' + tx('usata da {0}', who.join(', ')) });
				c.onclick = () => {
					this.folder = f;
					if (input) input.value = f;
					mark();
				};
			}
			// a folder the other devices already use, or one named like this vault, is the natural choice
			const vault = defaultFolder(this.app.vault.getName()).toLowerCase();
			const pick = [...chain.keys()].find((f) => list.includes(f)) ?? list.find((f) => f.toLowerCase() === vault);
			if (pick && (!this.mgr.t.folder || cleanPath(this.folder) === defaultFolder(this.app.vault.getName()))) {
				this.folder = pick;
				if (input) input.value = pick;
			}
			mark();
		});
		input = s.controlEl.querySelector('input');
		const status = el.createDiv({ cls: 'ambraia-setup-status' });
		this.buttons(el, null, tx('Continua'), async () => {
			let f = cleanPath(this.folder);
			// same folder written with other capitals: use the existing one (no twin folder)
			const same = existing.find((x) => x.toLowerCase() === f.toLowerCase());
			if (same) f = same;
			if (!f) {
				status.setText(tx('Indica una cartella.'));
				return;
			}
			this.folder = f;
			status.setText(tx('Controllo la cartella…'));
			try {
				await this.apply();
				this.remote = await this.mgr.inspectRemote();
				this.go('encrypt');
			} catch (e) {
				status.setText(tx('Errore: {0}', (e as Error).message));
			}
		});
	}

	/** Existing vault folders on the account, and which devices of the chain use them. */
	private async folderSuggestions(): Promise<{ list: string[]; chain: Map<string, string[]> }> {
		try {
			if (this.creds && this.mgr.credentials !== this.creds) await this.mgr.saveCredentials(this.creds);
			const [own, chain] = await Promise.all([this.mgr.vaultFolders(), this.mgr.chainFolders(this.provider)]);
			const list = [...new Set([...chain.keys(), ...own].map((f) => cleanPath(f)).filter((f) => !!f && !isControlPath(f)))].sort();
			return { list, chain };
		} catch {
			return { list: [], chain: new Map() };
		}
	}

	/** Saves credentials and folder; sync stays off until the encryption step is done. */
	private async apply() {
		const mgr = this.mgr;
		const t = mgr.t;
		mgr.stop('off');
		if (this.creds?.provider === 'mega' || this.creds?.provider === 'proton') mgr.setLocalBase(this.localBase);
		t.folder = this.folder;
		t.provider = this.provider;
		t.enabled = false;
		t.encrypt = false;
		await this.plugin.sync.adopt(mgr);
		await this.plugin.saveSettings();
		await mgr.saveCredentials(this.creds);
		await mgr.resetState();
	}

	// ---------------------------------------------------------------- 4. encryption

	private renderEncrypt(el: HTMLElement) {
		const r = this.remote ?? { keyfile: null, hasFiles: false };
		const status = el.createDiv({ cls: 'ambraia-setup-status' });
		const t = this.mgr.t;
		const hub = this.plugin.sync;
		const peers = hub.sharedPeers(this.mgr);
		let shared = peers.length > 0;
		/** "Same master key as the other services" switch (only when other encrypted services exist). */
		const sharedSwitch = (parent: HTMLElement, onToggle?: (v: boolean) => void) => {
			if (!peers.length) return;
			const st = new Setting(parent)
				.setName(tx('Stessa chiave principale degli altri servizi'))
				.setDesc(tx('Una sola chiave per {0}. Disattiva per usare una chiave dedicata solo a questo servizio.', peers.map((p) => p.label).join(', ')))
				.addToggle((tg) =>
					tg.setValue(shared).onChange((v) => {
						shared = v;
						onToggle?.(v);
					}),
				);
			helpButton(st.nameEl, tx('Chiave condivisa o dedicata'), KEYMODE_HELP());
		};
		/** Checks the password against the services that share the key. */
		const checkShared = async (pw: string) => {
			if (!shared) return true;
			try {
				await hub.verifyShared(pw, this.mgr);
				return true;
			} catch (e) {
				status.setText(e instanceof WrongKeyError ? tx('La chiave non coincide con quella condivisa dagli altri servizi. Disattiva "Stessa chiave principale" per usarne una dedicata.') : tx('Errore: {0}', (e as Error).message));
				return false;
			}
		};
		if (r.keyfile) {
			const kf = r.keyfile;
			el.createEl('p', { text: tx('Questa cartella è cifrata end-to-end ({0}). Inserisci la chiave principale per continuare.', ALG_NAMES[kf.alg]) });
			let pw = '';
			let remember = t.remember;
			new Setting(el).setName(tx('Chiave principale')).addText((x) => {
				x.inputEl.type = 'password';
				x.inputEl.autocomplete = 'current-password';
				x.onChange((v) => (pw = v));
			});
			sharedSwitch(el);
			new Setting(el).setName(tx('Ricorda su questo dispositivo')).addToggle((x) => x.setValue(remember).onChange((v) => (remember = v)));
			this.buttons(el, 'folder', tx('Sblocca e sincronizza'), async () => {
				if (!pw) return;
				status.setText(tx('Verifico la chiave…'));
				try {
					if (!(await checkShared(pw))) return;
					t.sharedKey = shared || !peers.length;
					t.enabled = true;
					await this.plugin.saveSettings();
					await this.mgr.unlock(pw, remember);
					this.go('done');
				} catch (e) {
					t.enabled = false;
					await this.plugin.saveSettings();
					status.setText(e instanceof WrongKeyError ? tx('Chiave non corretta.') : tx('Errore: {0}', (e as Error).message));
				}
			});
			return;
		}

		let on = true;
		let alg: Alg = t.alg;
		let names = t.names;
		let pw = '';
		let pw2 = '';
		let remember = t.remember;
		const head = new Setting(el)
			.setName(tx('Cifratura end-to-end'))
			.setDesc(tx('I file vengono cifrati sul dispositivo prima dell’invio: il servizio cloud vede solo dati illeggibili.'))
			.addToggle((x) =>
				x.setValue(on).onChange((v) => {
					on = v;
					box.toggleClass('ambraia-hidden', !v);
				}),
			);
		helpButton(head.nameEl, tx('Come funziona la cifratura'), ALG_HELP());
		const box = el.createDiv();
		new Setting(box).setName(tx('Algoritmo')).addDropdown((d) => {
			for (const a of ALGS) d.addOption(a, ALG_NAMES[a]);
			d.setValue(alg).onChange((v) => (alg = v as Alg));
		});
		new Setting(box)
			.setName(tx('Cifra anche i nomi di file e cartelle'))
			.setDesc(tx('Consigliato: nel cloud non si vede nemmeno come si chiamano le note.'))
			.addToggle((x) => x.setValue(names).onChange((v) => (names = v)));
		const keys = newKeyFields(box, (a, b) => {
			pw = a;
			pw2 = b;
		});
		sharedSwitch(box, (v) => keys.setShared(v));
		keys.setShared(shared);
		new Setting(box)
			.setName(tx('Ricorda su questo dispositivo'))
			.setDesc(tx('La chiave dei dati resta nel portachiavi protetto del sistema.'))
			.addToggle((x) => x.setValue(remember).onChange((v) => (remember = v)));
		if (r.hasFiles)
			el.createEl('p', { cls: 'ambraia-note', text: tx('Nella cartella ci sono già file non cifrati: prima vengono sincronizzati, poi ricaricati cifrati e la versione in chiaro va nel cestino del cloud.') });
		this.buttons(el, 'folder', tx('Avvia la sincronizzazione'), async () => {
			t.remember = remember;
			if (!on) {
				t.enabled = true;
				t.encrypt = false;
				await this.plugin.saveSettings();
				this.plugin.sync.settingsChanged();
				this.go('done');
				return;
			}
			if (shared) {
				if (!pw) return;
				status.setText(tx('Verifico la chiave…'));
				if (!(await checkShared(pw))) return;
			} else {
				if (strength(pw) < MIN_STRENGTH) {
					status.setText(tx('Chiave troppo debole: usa almeno 12 caratteri misti o premi il dado per generarne una.'));
					return;
				}
				if (pw !== pw2) {
					status.setText(tx('Le due chiavi non coincidono.'));
					return;
				}
				if (!keys.acknowledged()) {
					status.setText(tx('Conferma di aver salvato la chiave principale: senza di essa i file cifrati non si recuperano.'));
					return;
				}
			}
			status.setText(tx('Preparo la cifratura… (può richiedere qualche secondo)'));
			try {
				t.sharedKey = shared || !peers.length;
				const choice: EncryptionChoice = { password: pw, alg, names, kdf: this.plugin.settings.syncKdf };
				await this.mgr.setupEncryption(choice);
				pw = pw2 = '';
				this.go('done');
			} catch (e) {
				status.setText(tx('Errore: {0}', (e as Error).message));
			}
		});
	}

	// ---------------------------------------------------------------- 5. done

	private async renderDone(el: HTMLElement) {
		const s = this.plugin.settings;
		setIcon(el.createDiv({ cls: 'ambraia-done-icon' }), 'check-circle-2');
		el.createEl('h3', { text: tx('Sincronizzazione attiva') });
		el.createEl('p', {
			text: tx('Cartella "{0}" su {1}{2}. Le modifiche vengono inviate dopo circa un secondo e ricevute entro {3} secondi.', this.mgr.folder, this.mgr.providerName, this.mgr.t.encrypt ? ' · ' + tx('cifrata end-to-end') : '', s.pollSeconds),
		});
		const others = this.plugin.sync.managers.filter((m) => m !== this.mgr);
		if (others.length) el.createEl('p', { cls: 'setting-item-description', text: tx('Servizi attivi insieme: {0}.', [this.mgr, ...others].map((m) => m.label).join(', ')) });
		if (!this.pairing) el.createEl('p', { cls: 'setting-item-description', text: tx('Per aggiungere un altro dispositivo (anche iPhone o Android) usa “Collega un dispositivo” nelle impostazioni: riceverai un codice monouso di 8 caratteri.') });
		const row = el.createDiv({ cls: 'modal-button-container' });
		if (!this.pairing)
			row.createEl('button', { text: tx('Collega un dispositivo') }).onclick = () => {
				this.close();
				new PairModal(this.app, this.mgr).open();
			};
		row.createEl('button', { text: tx('Fine'), cls: 'mod-cta' }).onclick = () => this.close();
	}
}

/** Page shown in the browser after the OAuth redirect (no scripts, no external resources). */
function loopbackPage(ok: boolean) {
	const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
	return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Ambraia</title><body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;margin:0;color:#37352f"><div style="text-align:center;max-width:28rem"><h2 style="font-weight:600">${esc(ok ? tx('Collegato ad Ambraia') : tx('Accesso annullato'))}</h2><p style="color:#787774">${esc(tx('Puoi chiudere questa scheda e tornare su Obsidian.'))}</p></div></body>`;
}

/**
 * Shows a one-time code for a new device. The code works once, for 5 minutes, and stops working
 * as soon as this window is closed; the new device is linked only after the user approves it here.
 */
export class PairModal extends Modal {
	private offer: PairingOffer | null = null;
	private timers: number[] = [];
	private open_ = false;
	private linked = false;
	private run = 0;

	constructor(
		app: App,
		private mgr: SyncManager,
	) {
		super(app);
	}

	onOpen() {
		this.open_ = true;
		this.modalEl.addClass('ambraia-setup', 'ambraia-pair');
		this.titleEl.setText(tx('Collega un altro dispositivo'));
		void this.start();
	}

	private clearTimers() {
		for (const t of this.timers) window.clearInterval(t);
		this.timers = [];
	}

	private async start() {
		const run = ++this.run;
		this.clearTimers();
		const old = this.offer;
		this.offer = null;
		void old?.revoke();
		const el = this.contentEl;
		el.empty();
		el.createDiv({ cls: 'ambraia-setup-status', text: tx('Preparo il codice…') });
		let offer: PairingOffer;
		try {
			offer = await this.mgr.startPairing();
		} catch (e) {
			if (run !== this.run) return;
			el.empty();
			el.createEl('p', { text: tx('Non riesco a preparare il codice: {0}', (e as Error)?.message ?? e) });
			this.footer(el, true);
			return;
		}
		if (!this.open_ || run !== this.run) {
			void offer.revoke();
			return;
		}
		this.offer = offer;
		el.empty();
		const meta = providerMeta(this.mgr.provider);
		const ol = el.createEl('ol', { cls: 'ambraia-pair-steps' });
		ol.createEl('li', { text: tx('Sull’altro dispositivo installa Ambraia e apri Impostazioni → Ambraia → Sincronizzazione → Configura (o Collega, se il servizio compare già).') });
		ol.createEl('li', { text: tx('Scegli “Ho già Ambraia su un altro dispositivo”, poi {0}, e accedi con lo stesso account.', meta.name) });
		ol.createEl('li', { text: tx('Inserisci questo codice:') });
		const codeRow = el.createDiv({ cls: 'ambraia-pair-code-row' });
		codeRow.createDiv({ cls: 'ambraia-pair-code', text: offer.display });
		const copy = codeRow.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tx('Copia il codice') } });
		setIcon(copy, 'copy');
		copy.onclick = async () => {
			try {
				await navigator.clipboard.writeText(offer.code);
				new Notice(tx('Codice copiato.'));
			} catch {
				/* the code is on screen */
			}
		};
		const timer = el.createDiv({ cls: 'ambraia-pair-timer' });
		const c = this.mgr.credentials;
		if (c?.clientId && !builtinApp(this.mgr.provider)) {
			const d = el.createEl('details', { cls: 'ambraia-settings-details' });
			d.createEl('summary', { text: tx('Usi una tua app? Dati da inserire sull’altro dispositivo') });
			const row = d.createDiv({ cls: 'ambraia-pair-client' });
			row.createEl('code', { text: c.clientId });
			const b = row.createEl('button', { text: tx('Copia Client ID') });
			b.onclick = () => void navigator.clipboard.writeText(c.clientId ?? '').catch(() => undefined);
			if (c.clientSecret) {
				const b2 = row.createEl('button', { text: tx('Copia Client secret') });
				b2.onclick = () => void navigator.clipboard.writeText(c.clientSecret ?? '').catch(() => undefined);
			}
		}
		const note = el.createEl('p', { cls: 'setting-item-description' });
		note.setText(
			this.mgr.t.encrypt
				? this.mgr.unlocked
					? tx('Il codice vale una volta sola per 5 minuti. Dopo la tua approvazione la chiave dei dati arriva cifrata solo all’altro dispositivo: lì non servirà digitare la chiave principale. Nessun accesso al tuo account viene trasferito.')
					: tx('Il codice vale una volta sola per 5 minuti. Sull’altro dispositivo servirà la chiave principale. Nessun accesso al tuo account viene trasferito.')
				: tx('Il codice vale una volta sola per 5 minuti e dovrai approvare il nuovo dispositivo. Nessun accesso al tuo account viene trasferito: l’altro dispositivo accede per conto suo.'),
		);
		const status = el.createDiv({ cls: 'ambraia-setup-status' });
		this.footer(el, false);
		const tick = () => {
			const left = Math.max(0, offer.expires - Date.now());
			const mm = Math.floor(left / 60000);
			const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
			timer.setText(tx('Valido ancora {0}', `${mm}:${ss}`));
			if (left <= 0) {
				this.clearTimers();
				void offer.revoke();
				codeRow.addClass('is-expired');
				timer.setText(tx('Codice scaduto.'));
			}
		};
		tick();
		this.timers.push(window.setInterval(tick, 1000));
		let busy = false;
		this.timers.push(
			window.setInterval(() => void poll(), 4000),
		);
		const poll = async () => {
			if (busy || this.linked || offer.ack) return;
			busy = true;
			try {
				const ack = await offer.checkAck();
				if (ack && run === this.run) {
					this.clearTimers();
					this.approval(el, offer, ack.name, ack.platform);
				}
			} catch {
				status.setText(tx('Connessione al cloud non riuscita: riprovo…'));
			} finally {
				busy = false;
			}
		};
	}

	/** The code was used: the user checks the 6 digits and approves (or refuses) the new device. */
	private approval(el: HTMLElement, offer: PairingOffer, name: string, platform?: string) {
		el.empty();
		const box = el.createDiv('ambraia-pair-approve');
		setIcon(box.createDiv('ambraia-pair-approve-icon'), /iphone|android|ipad|tablet/i.test(platform ?? '') ? 'smartphone' : 'monitor');
		box.createEl('h3', { text: tx('“{0}” vuole collegarsi', name) });
		box.createEl('p', { text: tx('Approva solo se l’altro dispositivo mostra lo stesso codice di verifica e lo stai collegando tu.') });
		box.createDiv({ cls: 'ambraia-pair-check', text: offer.check });
		const status = el.createDiv({ cls: 'ambraia-setup-status' });
		const row = el.createDiv({ cls: 'modal-button-container' });
		const no = row.createEl('button', { text: tx('Rifiuta') });
		const yes = row.createEl('button', { cls: 'mod-cta', text: tx('Approva') });
		no.onclick = async () => {
			no.disabled = yes.disabled = true;
			await offer.reject().catch(() => undefined);
			this.close();
		};
		yes.onclick = async () => {
			no.disabled = yes.disabled = true;
			status.setText(tx('Invio cifrato delle impostazioni…'));
			try {
				await offer.approve();
				this.linked = true;
				el.empty();
				setIcon(el.createDiv({ cls: 'ambraia-done-icon' }), 'check-circle-2');
				el.createEl('h3', { text: tx('Dispositivo collegato') });
				el.createEl('p', { text: tx('“{0}” è ora collegato e compare nell’elenco dei dispositivi.', name) });
				this.footer(el, true);
				this.mgr.hub.emit();
			} catch (e) {
				no.disabled = yes.disabled = false;
				status.setText(tx('Errore: {0}', (e as Error).message));
			}
		};
	}

	private footer(el: HTMLElement, done: boolean) {
		const row = el.createDiv({ cls: 'modal-button-container' });
		if (!done) row.createEl('button', { text: tx('Nuovo codice') }).onclick = () => void this.start();
		row.createEl('button', { text: done ? tx('Fine') : tx('Chiudi'), cls: done ? 'mod-cta' : '' }).onclick = () => this.close();
	}

	onClose() {
		this.open_ = false;
		this.run++;
		this.clearTimers();
		// closing the window invalidates the code (and refuses a device waiting for approval)
		if (this.offer && !this.linked) void (this.offer.ack ? this.offer.reject() : this.offer.revoke());
		this.offer = null;
		this.contentEl.empty();
	}
}

/** Password + repeat + dice + strength meter for a new master key; one field when the shared key is reused. */
function newKeyFields(box: HTMLElement, changed: (pw: string, pw2: string) => void) {
	let pw = '';
	let pw2 = '';
	let i1!: HTMLInputElement;
	let i2!: HTMLInputElement;
	const update = () => {
		const n = strength(pw);
		meter.empty();
		meter.dataset.level = String(n);
		meter.createDiv({ cls: 'ambraia-meter-bar' }).setCssStyles({ width: `${(n + 1) * 24}px` });
		meter.createSpan({ text: pw ? tx('Robustezza: {0}', STRENGTH()[n]) : '' });
		changed(pw, pw2);
	};
	const k1 = new Setting(box).setName(tx('Chiave principale')).addText((t) => {
		i1 = t.inputEl;
		t.inputEl.type = 'password';
		t.inputEl.autocomplete = 'new-password';
		t.onChange((v) => {
			pw = v;
			update();
		});
	});
	k1.addExtraButton((b) =>
		b
			.setIcon('dice')
			.setTooltip(tx('Genera una chiave casuale'))
			.onClick(() => {
				pw = pw2 = generateMasterKey();
				i1.value = i2.value = pw;
				i1.type = i2.type = 'text';
				ack.reset();
				update();
				new Notice(tx('Chiave generata: salvala subito in un gestore di password.'), 8000);
			}),
	);
	k1.addExtraButton((b) =>
		b.setIcon('eye').setTooltip(tx('Mostra / nascondi')).onClick(() => {
			i1.type = i2.type = i1.type === 'password' ? 'text' : 'password';
		}),
	);
	const dice = k1.controlEl.querySelectorAll<HTMLElement>('.clickable-icon')[0];
	const meter = box.createDiv({ cls: 'ambraia-meter' });
	const k2 = new Setting(box).setName(tx('Ripeti la chiave')).addText((t) => {
		i2 = t.inputEl;
		t.inputEl.type = 'password';
		t.inputEl.autocomplete = 'new-password';
		t.onChange((v) => {
			pw2 = v;
			changed(pw, pw2);
		});
	});
	k1.addExtraButton((b) =>
		b
			.setIcon('copy')
			.setTooltip(tx('Copia la chiave'))
			.onClick(async () => {
				if (!pw) return;
				try {
					await navigator.clipboard.writeText(pw);
					new Notice(tx('Chiave copiata: incollala nel gestore di password, poi svuota gli appunti.'), 6000);
				} catch {
					new Notice(tx('Copia non riuscita: selezionala e copiala a mano.'));
				}
			}),
	);
	// a new key cannot be confirmed until the user says it is stored somewhere safe
	const ack = keyAcknowledgement(box);
	let shared = false;
	i1.addEventListener('input', () => ack.reset());
	return {
		/** true when the key is shared (already exists) or its loss risk was acknowledged */
		acknowledged() {
			if (shared || ack.ok) return true;
			ack.flash();
			return false;
		},
		setShared(on: boolean) {
			shared = on;
			ack.el.toggleClass('ambraia-hidden', on);
			k1.setName(on ? tx('Chiave principale condivisa') : tx('Chiave principale'));
			i1.autocomplete = on ? 'current-password' : 'new-password';
			k2.settingEl.toggleClass('ambraia-hidden', on);
			meter.toggleClass('ambraia-hidden', on);
			dice?.toggleClass('ambraia-hidden', on);
		},
	};
}

const KEYMODE_HELP = (): HelpStep[] => [
	tx('Chiave condivisa: la stessa chiave principale sblocca tutti i servizi con un solo inserimento, e cambiandola cambia ovunque.'),
	tx('Chiave dedicata: il servizio ha una chiave sua. Utile per separare un cloud di cui ti fidi meno o che condividi con altri.'),
	tx('In entrambi i casi ogni cartella nel cloud ha un proprio file della chiave: i dati di un servizio non permettono di leggere quelli degli altri senza la chiave.'),
];

/** Turn on / change / recreate the encryption of a cloud folder, or move it to the shared key. */
export class EncryptionModal extends Modal {
	constructor(
		app: App,
		private plugin: AmbraiaPlugin,
		private mgr: SyncManager,
		private mode: 'enable' | 'change' | 'recreate' | 'join',
		private done: () => void,
	) {
		super(app);
	}
	onOpen() {
		const el = this.contentEl;
		const s = this.plugin.settings;
		const mgr = this.mgr;
		const t = mgr.t;
		const hub = this.plugin.sync;
		const peers = hub.sharedPeers(mgr);
		const mode = this.mode;
		this.modalEl.addClass('ambraia-setup');
		this.titleEl.setText(
			mode === 'change' ? tx('Cambia chiave principale') : mode === 'recreate' ? tx('Ricrea cifratura') : mode === 'join' ? tx('Usa la chiave condivisa') : tx('Attiva la cifratura end-to-end'),
		);
		el.createEl('p', { cls: 'setting-item-description', text: mgr.label + ' · ' + mgr.folder });
		el.createEl('p', {
			text:
				mode === 'change'
					? tx('I file non vengono ricaricati: cambia solo la chiave che li protegge. Gli altri dispositivi continuano a funzionare; quelli che non ricordano la chiave chiederanno quella nuova.')
					: mode === 'recreate'
						? tx('Usalo se hai perso la chiave principale. I file di questo dispositivo vengono ricaricati con una nuova chiave; il contenuto attuale nel cloud va nel cestino. Gli altri dispositivi chiederanno la nuova chiave.')
						: mode === 'join'
							? tx('Questo servizio passerà alla stessa chiave principale di {0}. I file non vengono ricaricati.', peers.map((p) => p.label).join(', '))
							: tx('I file di questo dispositivo vengono sincronizzati, poi ricaricati cifrati; la copia in chiaro va nel cestino del cloud. Gli altri dispositivi chiederanno la chiave.'),
		});
		if (mode === 'change' && t.sharedKey && peers.length)
			el.createEl('p', { cls: 'ambraia-note', text: tx('Chiave condivisa: verrà cambiata anche su {0}.', peers.map((p) => p.label).join(', ')) });
		let cur = '';
		let pw = '';
		let pw2 = '';
		let alg: Alg = t.alg;
		let names = t.names;
		let shared = (mode === 'enable' || mode === 'recreate') && t.sharedKey && peers.length > 0;
		if (mode === 'change' || mode === 'join')
			new Setting(el).setName(mode === 'join' ? tx('Chiave attuale di questo servizio') : tx('Chiave attuale')).addText((x) => {
				x.inputEl.type = 'password';
				x.inputEl.autocomplete = 'current-password';
				x.onChange((v) => (cur = v));
			});
		else {
			const a = new Setting(el).setName(tx('Algoritmo')).addDropdown((d) => {
				for (const x of ALGS) d.addOption(x, ALG_NAMES[x]);
				d.setValue(alg).onChange((v) => (alg = v as Alg));
			});
			helpButton(a.nameEl, tx('Come funziona la cifratura'), ALG_HELP());
			new Setting(el).setName(tx('Cifra anche i nomi di file e cartelle')).addToggle((x) => x.setValue(names).onChange((v) => (names = v)));
		}
		const keys = newKeyFields(el, (a, b) => {
			pw = a;
			pw2 = b;
		});
		if (mode === 'join') {
			shared = true;
			keys.setShared(true);
		} else if (mode === 'change') keys.setShared(false);
		else if (peers.length) {
			const st = new Setting(el)
				.setName(tx('Stessa chiave principale degli altri servizi'))
				.addToggle((x) =>
					x.setValue(shared).onChange((v) => {
						shared = v;
						keys.setShared(v);
					}),
				);
			helpButton(st.nameEl, tx('Chiave condivisa o dedicata'), KEYMODE_HELP());
			keys.setShared(shared);
		} else keys.setShared(false);
		const status = el.createDiv({ cls: 'ambraia-setup-status' });
		const row = el.createDiv({ cls: 'modal-button-container' });
		row.createEl('button', { text: tx('Annulla') }).onclick = () => this.close();
		const btn = row.createEl('button', { text: tx('Conferma'), cls: mode === 'recreate' ? 'mod-warning' : 'mod-cta' });
		btn.onclick = async () => {
			if (shared) {
				if (!pw) return;
			} else {
				if (strength(pw) < MIN_STRENGTH) return void status.setText(tx('Chiave troppo debole: usa almeno 12 caratteri misti o premi il dado per generarne una.'));
				if (pw !== pw2) return void status.setText(tx('Le due chiavi non coincidono.'));
				if (!keys.acknowledged()) return void status.setText(tx('Conferma di aver salvato la chiave principale: senza di essa i file cifrati non si recuperano.'));
			}
			btn.disabled = true;
			status.setText(tx('Attendi…'));
			try {
				if (shared && peers.length && !(await hub.verifyShared(pw, mgr).catch((e) => Promise.reject(e instanceof WrongKeyError ? new Error(tx('La chiave non coincide con quella condivisa dagli altri servizi.')) : e instanceof Error ? e : new Error(String(e)))))) throw new Error(tx('Nessun altro servizio cifrato raggiungibile.'));
				if (mode === 'change') await hub.changeKey(mgr, cur, pw);
				else if (mode === 'join') {
					await mgr.changeMasterKey(cur, pw);
					t.sharedKey = true;
					await this.plugin.saveSettings();
				} else {
					t.sharedKey = shared || !peers.length;
					// the dialog shows each stage and closes as soon as the new key is saved:
					// the old cloud copies are then moved to the trash in the background (progress in the status bar)
					let committed = false;
					let markCommitted = () => {};
					const saved = new Promise<void>((r) => (markCommitted = r));
					const job = mgr.reformat({ password: pw, alg, names, kdf: s.syncKdf }, mode === 'enable', {
						onProgress: (msg) => {
							if (!committed) status.setText(msg);
						},
						onCommitted: () => {
							committed = true;
							markCommitted();
						},
					});
					// whichever comes first: the key saved (go on in background) or the whole job (done or failed)
					await Promise.race([saved, job]);
					if (committed) {
						job.then(
							() => new Notice(tx('Pulizia del cloud completata.')),
							(e) => new Notice(tx('Errore: {0}', (e as Error).message)),
						);
						new Notice(tx('Cifratura aggiornata. Pulisco i vecchi file nel cloud in background: puoi continuare a lavorare.'));
						this.close();
						this.done();
						return;
					}
				}
				new Notice(tx('Fatto.'));
				this.close();
				this.done();
			} catch (e) {
				status.setText(e instanceof WrongKeyError ? tx('Chiave non corretta.') : tx('Errore: {0}', (e as Error).message));
				btn.disabled = false;
			}
		};
	}
	onClose() {
		this.contentEl.empty();
	}
}
