import { App, Modal, Notice, Setting, setIcon, TFile } from 'obsidian';
import { tx } from '../i18n';
import { confirm, destructive } from '../ui/util';
import type { SharingFeature } from './feature';
import { ConflictError, ShareFailure, ShareError } from './format';
import { renderMarkdown } from './markdown';
import { shareableMarkdown } from './content';
import { DuplicatePasswordError, ProfileInput, profileState, ShareProfile, ShareRecord, shareState, usesOf } from './store';
import type { OpenedLink } from './client';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const PRESETS: [string, () => string][] = [
	['1h', () => tx('Tra 1 ora')],
	['1d', () => tx('Tra 1 giorno')],
	['7d', () => tx('Tra 7 giorni')],
	['30d', () => tx('Tra 30 giorni')],
	['date', () => tx('Data e ora…')],
];

function expiryFrom(choice: string, custom: string): number | null {
	const now = Date.now();
	if (choice === '1h') return now + HOUR;
	if (choice === '1d') return now + DAY;
	if (choice === '7d') return now + 7 * DAY;
	if (choice === '30d') return now + 30 * DAY;
	if (choice === 'date') {
		const t = Date.parse(custom);
		return Number.isFinite(t) ? t : NaN;
	}
	return null;
}

const localInput = (t: number) => {
	const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
	return d.toISOString().slice(0, 16);
};

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function failureText(code: ShareFailure): string {
	switch (code) {
		case 'password':
			return tx('Password errata.');
		case 'expired':
			return tx('Il link è scaduto.');
		case 'revoked':
			return tx('Il link è stato revocato da chi lo ha condiviso.');
		case 'exhausted':
			return tx('Il link ha raggiunto il numero massimo di aperture.');
		case 'gone':
			return tx('La nota non esiste più.');
		case 'locked':
			return tx('Troppi tentativi con una password errata: riprova tra 15 minuti.');
		case 'too-large':
			return tx('La nota è troppo grande per essere inviata.');
		case 'offline':
			return tx('Nessun dispositivo di chi ha condiviso la nota risponde: riprova quando uno dei suoi dispositivi è acceso con Obsidian aperto.');
		case 'unsupported':
			return tx('Questo dispositivo non supporta il formato del link.');
		case 'readonly':
			return tx('Questo profilo può solo leggere la nota.');
		case 'session':
			return tx('La sessione di modifica è scaduta: riapri il link.');
		case 'conflict':
			return tx('La nota è cambiata nel frattempo e le modifiche non si possono unire.');
		default:
			return tx('Link non valido o danneggiato.');
	}
}

function stateText(r: ShareRecord): { text: string; warn: boolean } {
	const st = shareState(r);
	if (st === 'revoked') return { text: tx('Revocato'), warn: true };
	if (st === 'expired') return { text: tx('Scaduto'), warn: true };
	if (r.profiles.every((p) => profileState(r, p))) return { text: tx('Aperture esaurite'), warn: true };
	return { text: tx('Attivo'), warn: false };
}

export function profileSummary(r: ShareRecord, p: ShareProfile): string {
	const parts = [p.label, p.canEdit ? tx('può modificare') : tx('sola lettura'), p.password ? tx('con password') : tx('senza password')];
	parts.push(p.maxUses != null ? tx('aperture {0}/{1}', usesOf(p), p.maxUses) : tx('aperture: {0}', usesOf(p)));
	const exp = Math.min(p.expires ?? Infinity, r.expires ?? Infinity);
	parts.push(exp !== Infinity ? tx('scade il {0}', when(exp)) : tx('senza scadenza'));
	const st = profileState(r, p);
	if (st === 'exhausted') parts.push(tx('Aperture esaurite'));
	else if (st === 'expired' && !shareState(r)) parts.push(tx('Scaduto'));
	return parts.join(' · ');
}

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(tx('Link copiato.'));
	} catch {
		new Notice(tx('Impossibile copiare: seleziona il link e copialo a mano.'));
	}
}

/** Row of a link with its actions (used by the note dialog and by the list of every link). */
function renderRow(feature: SharingFeature, parent: HTMLElement, r: ShareRecord, redraw: () => void, showNote: boolean) {
	const row = parent.createDiv({ cls: 'ambraia-share-row' });
	setIcon(row.createDiv({ cls: 'ambraia-share-row-icon' }), 'link');
	const text = row.createDiv({ cls: 'ambraia-share-row-text' });
	const st = stateText(r);
	const title = text.createDiv({ cls: 'ambraia-share-row-title', text: showNote ? r.title || r.path : tx('Creato il {0}', when(r.created)) });
	title.createSpan({ cls: 'ambraia-share-chip' + (st.warn ? ' is-warn' : ' is-ok'), text: st.text });
	for (const p of r.profiles) text.createDiv({ cls: 'ambraia-share-row-meta', text: profileSummary(r, p) });
	if (showNote) text.createDiv({ cls: 'ambraia-share-row-meta', text: tx('creato il {0}', when(r.created)) });
	const actions = row.createDiv({ cls: 'ambraia-share-row-actions' });
	const btn = (ic: string, label: string, fn: () => void | Promise<void>, danger = false) => {
		const b = actions.createEl('button', { cls: 'clickable-icon' + (danger ? ' mod-warning' : ''), attr: { 'aria-label': label, title: label } });
		setIcon(b, ic);
		b.onclick = () => void fn();
	};
	if (!shareState(r)) btn('copy', tx('Copia link'), () => copy(r.url));
	if (showNote)
		btn('file-text', tx('Apri la nota'), async () => {
			const f = feature.app.vault.getAbstractFileByPath(r.path);
			if (f instanceof TFile) await feature.app.workspace.getLeaf(false).openFile(f);
			else new Notice(tx('La nota non esiste più.'));
		});
	btn('settings-2', tx('Gestisci'), () => new EditLinkModal(feature, r, redraw).open());
	if (!r.revoked)
		btn(
			'ban',
			tx('Revoca'),
			async () => {
				if (!(await confirm(feature.app, tx('Revocare il link?'), tx('Il link smette subito di aprirsi, anche per chi lo ha già ricevuto.'), tx('Revoca'), true))) return;
				feature.store.revoke(r.id);
				redraw();
			},
			true,
		);
	btn(
		'trash-2',
		tx('Elimina dall’elenco'),
		async () => {
			if (!(await confirm(feature.app, tx('Eliminare il link?'), tx('Il link smette di aprirsi e viene tolto dall’elenco su tutti i tuoi dispositivi.'), tx('Elimina'), true))) return;
			feature.store.remove(r.id);
			redraw();
		},
		true,
	);
}

// ------------------------------------------------------------------ link and profile editor

interface ProfileDraft {
	id?: string;
	label: string;
	/** existing profiles: whether it has a password now */
	had: boolean;
	pwMode: 'keep' | 'set' | 'none';
	password: string;
	canEdit: boolean;
	maxUses: string;
	expiry: string;
	custom: string;
	uses: number;
	reset: boolean;
}

const newDraft = (n: number, canEdit = false): ProfileDraft => ({
	label: canEdit ? tx('Modifica') : n ? tx('Profilo {0}', n + 1) : tx('Lettura'),
	had: false,
	pwMode: n ? 'set' : 'none',
	password: '',
	canEdit,
	maxUses: '',
	expiry: 'link',
	custom: localInput(Date.now() + 7 * DAY),
	uses: 0,
	reset: false,
});

const draftOf = (p: ShareProfile): ProfileDraft => ({
	id: p.id,
	label: p.label,
	had: p.password,
	pwMode: 'keep',
	password: '',
	canEdit: p.canEdit,
	maxUses: p.maxUses == null ? '' : String(p.maxUses),
	expiry: p.expires ? 'date' : 'link',
	custom: localInput(p.expires ?? Date.now() + 7 * DAY),
	uses: usesOf(p),
	reset: false,
});

/**
 * Settings of a link: its expiry and its profiles. Returns the values to save, or an error text.
 */
class LinkForm {
	expiry: string;
	custom: string;
	profiles: ProfileDraft[];

	constructor(private rec: ShareRecord | null) {
		this.expiry = rec ? (rec.expires ? 'date' : 'never') : '7d';
		this.custom = localInput(rec?.expires ?? Date.now() + 7 * DAY);
		this.profiles = rec ? rec.profiles.map(draftOf) : [newDraft(0)];
	}

	draw(el: HTMLElement, redraw: () => void) {
		const exp = new Setting(el)
			.setName(tx('Scadenza del link'))
			.setDesc(tx('Vale per tutti i profili: dopo questa data il link non si apre più.'))
			.addDropdown((d) => {
				d.addOption('never', tx('Mai'));
				for (const [v, label] of PRESETS) d.addOption(v, label());
				d.setValue(this.expiry).onChange((v) => {
					this.expiry = v;
					redraw();
				});
			});
		if (this.expiry === 'date')
			exp.addText((t) => {
				t.inputEl.type = 'datetime-local';
				t.setValue(this.custom).onChange((v) => (this.custom = v));
			});

		el.createDiv({ cls: 'ambraia-share-section', text: tx('Profili') });
		el.createEl('p', { cls: 'setting-item-description', text: tx('Con lo stesso link, ogni profilo si apre con la sua password e ha i suoi permessi, aperture e scadenza (mai oltre quella del link). Un solo profilo può essere senza password.') });
		this.profiles.forEach((p, i) => this.drawProfile(el, p, i, redraw));
		new Setting(el).addButton((b) =>
			b
				.setButtonText(tx('Aggiungi profilo'))
				.onClick(() => {
					this.profiles.push(newDraft(this.profiles.length, true));
					redraw();
				}),
		);
	}

	private drawProfile(parent: HTMLElement, p: ProfileDraft, i: number, redraw: () => void) {
		const box = parent.createDiv({ cls: 'ambraia-share-profile' });
		const head = new Setting(box).setName(tx('Nome del profilo')).addText((t) => t.setValue(p.label).onChange((v) => (p.label = v)));
		if (this.profiles.length > 1)
			head.addExtraButton((b) =>
				b
					.setIcon('trash-2')
					.setTooltip(tx('Togli il profilo'))
					.onClick(() => {
						this.profiles.splice(i, 1);
						redraw();
					}),
			);
		const pw = new Setting(box).setName(tx('Password')).addDropdown((d) => {
			if (p.id) d.addOption('keep', p.had ? tx('Mantieni quella attuale') : tx('Nessuna password'));
			d.addOption('set', p.id && p.had ? tx('Cambia password') : tx('Con password'));
			if (!p.id || p.had) d.addOption('none', tx('Senza password'));
			d.setValue(p.pwMode).onChange((v) => {
				p.pwMode = v as ProfileDraft['pwMode'];
				redraw();
			});
		});
		if (p.pwMode === 'set')
			pw.addText((t) => {
				t.inputEl.type = 'password';
				t.inputEl.autocomplete = 'new-password';
				t.setPlaceholder(tx('Nuova password'))
					.setValue(p.password)
					.onChange((v) => (p.password = v));
			});
		new Setting(box)
			.setName(tx('Può modificare la nota'))
			.setDesc(tx('Chi entra con questo profilo può cambiare il testo dal browser; le modifiche vengono unite a quelle fatte nel frattempo, anche offline.'))
			.addToggle((t) => t.setValue(p.canEdit).onChange((v) => (p.canEdit = v)));
		const uses = new Setting(box)
			.setName(tx('Numero massimo di aperture'))
			.setDesc(p.id ? tx('Aperture finora: {0}. Vuoto = nessun limite.', p.uses) : tx('Vuoto = nessun limite. Ogni apertura del link conta una volta.'))
			.addText((t) => {
				t.inputEl.type = 'number';
				t.inputEl.min = '1';
				t.setPlaceholder('∞')
					.setValue(p.maxUses)
					.onChange((v) => (p.maxUses = v));
			});
		if (p.id && p.uses)
			uses.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip(tx('Azzera il conteggio delle aperture'))
					.onClick(() => {
						p.reset = true;
						p.uses = 0;
						redraw();
					}),
			);
		const exp = new Setting(box).setName(tx('Scadenza del profilo')).addDropdown((d) => {
			d.addOption('link', tx('Come il link'));
			for (const [v, label] of PRESETS) d.addOption(v, label());
			d.setValue(p.expiry).onChange((v) => {
				p.expiry = v;
				redraw();
			});
		});
		if (p.expiry === 'date')
			exp.addText((t) => {
				t.inputEl.type = 'datetime-local';
				t.setValue(p.custom).onChange((v) => (p.custom = v));
			});
	}

	/** Values to save, or a message for the user. */
	values(): { expires: number | null; profiles: ProfileInput[]; reset: string[] } | string {
		const expires = this.expiry === 'never' ? null : expiryFrom(this.expiry, this.custom);
		if (expires !== null && (!Number.isFinite(expires) || expires <= Date.now())) return tx('Scegli una scadenza nel futuro.');
		const out: ProfileInput[] = [];
		let open = 0;
		for (const p of this.profiles) {
			let maxUses: number | null = null;
			if (p.maxUses.trim()) {
				maxUses = Number(p.maxUses);
				if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) return tx('Il numero di aperture deve essere un intero da 1 in su.');
			}
			let pexp = p.expiry === 'link' ? null : expiryFrom(p.expiry, p.custom);
			if (pexp !== null && (!Number.isFinite(pexp) || pexp <= Date.now())) return tx('Scegli una scadenza nel futuro.');
			if (pexp !== null && expires !== null && pexp > expires) pexp = expires;
			if (p.pwMode === 'set' && p.password.length < 6) return tx('Usa una password di almeno 6 caratteri (meglio una frase).');
			const none = p.pwMode === 'none' || (p.pwMode === 'keep' && !p.had);
			if (none) open++;
			out.push({ id: p.id, label: p.label, password: p.pwMode === 'set' ? p.password : p.pwMode === 'none' ? '' : undefined, canEdit: p.canEdit, maxUses, expires: pexp });
		}
		if (open > 1) return tx('Un solo profilo può essere senza password.');
		return { expires, profiles: out, reset: this.profiles.filter((p) => p.reset && p.id).map((p) => p.id!) };
	}

	get slow() {
		return this.profiles.some((p) => p.pwMode === 'set');
	}
}

const saveError = (e: unknown) => (e instanceof DuplicatePasswordError ? tx('Due profili non possono avere la stessa password.') : tx('Errore: {0}', (e as Error).message));

/** "Share" dialog of one note: its links, and a new link. */
export class ShareModal extends Modal {
	private form = new LinkForm(null);
	private result: ShareRecord | null = null;
	private creating = false;
	private busy = false;

	constructor(
		private feature: SharingFeature,
		private file: TFile,
	) {
		super(feature.app);
	}

	onOpen() {
		this.modalEl.addClass('ambraia-share-modal');
		this.titleEl.setText(tx('Condividi “{0}”', this.file.basename));
		this.draw();
	}

	onClose() {
		this.contentEl.empty();
	}

	private draw() {
		const el = this.contentEl;
		el.empty();
		const existing = this.feature.store.forPath(this.file.path);
		if (existing.length) {
			el.createDiv({ cls: 'ambraia-share-section', text: tx('Link di questa nota') });
			const list = el.createDiv({ cls: 'ambraia-share-list' });
			for (const r of existing) renderRow(this.feature, list, r, () => this.draw(), false);
		}
		if (this.result) return this.drawResult(el, this.result);
		if (existing.length && !this.creating) {
			new Setting(el).addButton((b) =>
				b
					.setButtonText(tx('Nuovo link'))
					.setCta()
					.onClick(() => {
						this.creating = true;
						this.draw();
					}),
			);
			return;
		}
		el.createDiv({ cls: 'ambraia-share-section', text: tx('Nuovo link') });
		el.createEl('p', { cls: 'setting-item-description', text: tx('Chi riceve il link legge la versione attuale della nota nel browser, mentre uno dei tuoi dispositivi ha Obsidian aperto. Puoi cambiare tutto o revocarlo in ogni momento.') });
		this.form.draw(el, () => this.draw());
		const status = el.createDiv({ cls: 'ambraia-share-status' });
		new Setting(el).addButton((b) =>
			b
				.setButtonText(tx('Crea link'))
				.setCta()
				.onClick(async () => {
					if (this.busy) return;
					const v = this.form.values();
					if (typeof v === 'string') return void status.setText(v);
					this.busy = true;
					b.setDisabled(true);
					status.setText(this.form.slow ? tx('Preparo il link (la password richiede qualche secondo)…') : tx('Preparo il link…'));
					try {
						this.result = await this.feature.create(this.file, { expires: v.expires, profiles: v.profiles });
						this.form = new LinkForm(null);
						this.creating = false;
						this.draw();
					} catch (e) {
						status.setText(saveError(e));
					} finally {
						this.busy = false;
						b.setDisabled(false);
					}
				}),
		);
	}

	private drawResult(el: HTMLElement, r: ShareRecord) {
		el.createDiv({ cls: 'ambraia-share-section', text: tx('Link pronto') });
		const box = el.createDiv({ cls: 'ambraia-share-result' });
		const input = box.createEl('input', { cls: 'ambraia-share-link', attr: { type: 'text', readonly: '', 'aria-label': tx('Link') } });
		input.value = r.url;
		input.onclick = () => input.select();
		const b = box.createEl('button', { cls: 'mod-cta', text: tx('Copia') });
		b.onclick = () => void copy(r.url);
		const ul = el.createEl('ul', { cls: 'ambraia-share-tips' });
		ul.createEl('li', { text: tx('Chi riceve il link legge la nota nel browser, senza account e senza installare nulla.') });
		ul.createEl('li', { text: tx('La chiave è dopo il simbolo #: non arriva a nessun server. Condividi il link solo con chi deve leggerlo.') });
		if (r.profiles.some((p) => p.password)) ul.createEl('li', { text: tx('Invia ogni password per un canale diverso dal link: chi la inserisce entra nel profilo corrispondente.') });
		ul.createEl('li', { text: tx('Il link si apre mentre uno dei tuoi dispositivi ha Obsidian aperto e non in pausa.') });
		new Setting(el).addButton((x) =>
			x.setButtonText(tx('Nuovo link')).onClick(() => {
				this.result = null;
				this.creating = true;
				this.draw();
			}),
		);
	}
}

/** Expiry and profiles of an existing link. */
export class EditLinkModal extends Modal {
	private form: LinkForm;

	constructor(
		private feature: SharingFeature,
		private rec: ShareRecord,
		private done: () => void,
	) {
		super(feature.app);
		this.form = new LinkForm(rec);
	}

	onOpen() {
		this.modalEl.addClass('ambraia-share-modal');
		this.titleEl.setText(tx('Gestisci il link'));
		this.draw();
	}

	private draw() {
		const el = this.contentEl;
		el.empty();
		const r = this.rec;
		el.createEl('p', { cls: 'setting-item-description', text: r.title || r.path });
		this.form.draw(el, () => this.draw());
		if (r.revoked)
			new Setting(el)
				.setName(tx('Riattiva il link'))
				.setDesc(tx('Il link revocato torna a funzionare.'))
				.addButton((b) =>
					b.setButtonText(tx('Riattiva')).onClick(async () => {
						await this.feature.store.update(r.id, { revoked: false });
						this.done();
						this.close();
					}),
				);
		const status = el.createDiv({ cls: 'ambraia-share-status' });
		new Setting(el)
			.addButton((b) => b.setButtonText(tx('Annulla')).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(tx('Salva'))
					.setCta()
					.onClick(async () => {
						const v = this.form.values();
						if (typeof v === 'string') return void status.setText(v);
						b.setDisabled(true);
						status.setText(tx('Salvo…'));
						try {
							await this.feature.store.update(r.id, v);
							this.done();
							this.close();
						} catch (e) {
							b.setDisabled(false);
							status.setText(saveError(e));
						}
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Every shared link of the vault. */
export class SharesModal extends Modal {
	private off: (() => void) | null = null;

	constructor(private feature: SharingFeature) {
		super(feature.app);
	}

	onOpen() {
		this.modalEl.addClass('ambraia-share-modal');
		this.titleEl.setText(tx('Link condivisi'));
		this.off = this.feature.store.onChange(() => this.draw());
		this.draw();
	}

	private draw() {
		const el = this.contentEl;
		el.empty();
		const all = this.feature.store.all();
		if (!all.length) {
			el.createEl('p', { cls: 'ambraia-share-empty', text: tx('Nessun link condiviso. Per crearne uno apri una nota e scegli “Condividi con un link” dal menu ⋯ o dalla palette dei comandi.') });
			return;
		}
		const list = el.createDiv({ cls: 'ambraia-share-list' });
		for (const r of all) renderRow(this.feature, list, r, () => this.draw(), true);
		if (all.some((r) => shareState(r)))
			new Setting(el).addButton((b) =>
				destructive(b.setButtonText(tx('Elimina i link non più attivi'))).onClick(() => {
					for (const r of this.feature.store.all()) if (shareState(r)) this.feature.store.remove(r.id);
				}),
			);
	}

	onClose() {
		this.off?.();
		this.contentEl.empty();
	}
}

/** Opens a link received from someone else, inside Obsidian (same checks as the web page). */
export class OpenShareModal extends Modal {
	constructor(
		app: App,
		private feature: SharingFeature,
		private initial = '',
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('ambraia-share-modal', 'ambraia-share-viewer');
		this.titleEl.setText(tx('Apri un link condiviso'));
		const el = this.contentEl;
		const input = el.createEl('input', { cls: 'ambraia-share-link', attr: { type: 'text', placeholder: 'https://…#…', 'aria-label': tx('Link') } });
		input.value = this.initial;
		const pw = el.createEl('input', { cls: 'ambraia-share-link', attr: { type: 'password', placeholder: tx('Password (se richiesta)'), autocomplete: 'off', 'aria-label': tx('Password') } });
		const status = el.createDiv({ cls: 'ambraia-share-status' });
		const out = el.createDiv({ cls: 'ambraia-share-rendered markdown-rendered' });
		const go = async () => {
			out.empty();
			status.setText('');
			const link = input.value.trim();
			if (!link) return;
			try {
				const opened = await this.feature.openLink(link, pw.value, (s) => status.setText(s === 'waiting' ? tx('Attendo un dispositivo di chi ha condiviso la nota…') : tx('Verifico la password…')));
				this.show(out, status, opened);
			} catch (e) {
				const code = e instanceof ShareError ? e.code : 'corrupt';
				status.setText(code === 'password' && !pw.value ? tx('Questa nota è protetta da una password.') : failureText(code));
				if (code === 'password') pw.focus();
			}
		};
		new Setting(el).addButton((b) => b.setButtonText(tx('Apri')).setCta().onClick(() => void go()));
		input.addEventListener('keydown', (e) => e.key === 'Enter' && void go());
		pw.addEventListener('keydown', (e) => e.key === 'Enter' && void go());
		if (this.initial) void go();
	}

	private show(out: HTMLElement, status: HTMLElement, opened: OpenedLink) {
		const note = opened.note;
		let base = note.md;
		const meta = [note.profile ? tx('Profilo: {0}', note.profile) : '', note.expires ? tx('Scade il {0}', when(note.expires)) : ''].filter(Boolean);
		status.setText(meta.join(' · '));
		out.empty();
		out.createEl('h2', { text: note.title });
		const body = out.createDiv();
		renderMarkdown(document, body, opened.save ? shareableMarkdown(base) : base);
		if (!opened.save) return;
		const save = opened.save;
		new Setting(out).addButton((b) =>
			b.setButtonText(tx('Modifica')).onClick(() => {
				body.empty();
				const area = body.createEl('textarea', { cls: 'ambraia-share-editor' });
				area.value = base;
				new Setting(body).addButton((s) =>
					s
						.setButtonText(tx('Salva'))
						.setCta()
						.onClick(async () => {
							s.setDisabled(true);
							status.setText(tx('Salvo…'));
							try {
								const r = await save(base, area.value);
								base = r.text;
								area.value = r.text;
								status.setText(r.merged ? tx('Salvato, unito alle modifiche fatte nel frattempo.') : tx('Salvato.'));
							} catch (e) {
								if (e instanceof ConflictError) base = e.current;
								status.setText(failureText(e instanceof ShareError ? e.code : 'corrupt'));
							} finally {
								s.setDisabled(false);
							}
						}),
				);
			}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}
