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
/**
 * Durations offered for links and profiles. The public relay (ntfy.sh) keeps no copy of the note
 * and puts no time limit on a link: a link works for the whole period chosen, whenever one of the
 * devices of the vault is on with Obsidian open. What the relay does limit is shown next to the
 * choice (RELAY_LIMITS), so nobody picks something that cannot really happen.
 */
const DURATIONS: [string, number, () => string][] = [
	['1h', HOUR, () => tx('1 ora')],
	['1d', DAY, () => tx('1 giorno')],
	['7d', 7 * DAY, () => tx('7 giorni')],
	['30d', 30 * DAY, () => tx('30 giorni')],
	['90d', 90 * DAY, () => tx('90 giorni')],
	['1y', 365 * DAY, () => tx('1 anno')],
];

/** End of the validity, counted from its start (the link's own start, or now). */
function expiryFrom(choice: string, custom: string, from = Date.now()): number | null {
	const d = DURATIONS.find(([v]) => v === choice);
	if (d) return from + d[1];
	if (choice === 'date') {
		const t = Date.parse(custom);
		return Number.isFinite(t) ? t : NaN;
	}
	return null;
}

/** Real limits of the public relay, in words (only shown when the public ntfy.sh is in use). */
function relayLimits(relay: string): string[] {
	const out = [tx('Il link si apre solo mentre almeno un tuo dispositivo è acceso con Obsidian aperto (sul telefono, in primo piano).')];
	if (/^https:\/\/ntfy\.sh\/?$/i.test(relay))
		out.push(tx('Il servizio di inoltro gratuito (ntfy.sh) non mette scadenze ai link, ma accetta circa 250 messaggi al giorno per dispositivo: circa 120 aperture al giorno in tutto.'));
	out.push(tx('Note fino a 1,4 MB. Una sessione di modifica dal browser dura al massimo 12 ore, poi basta riaprire il link.'));
	return out;
}

/** Link no longer usable (a link that starts later is still a valid link). */
const ended = (r: ShareRecord) => {
	const st = shareState(r);
	return st === 'revoked' || st === 'expired';
};

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
		case 'notyet':
			return tx('Il link non è ancora attivo: riprova più tardi.');
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
	if (st === 'notyet') return { text: tx('Dal {0}', when(r.starts!)), warn: false };
	if (r.profiles.every((p) => profileState(r, p) === 'exhausted' || profileState(r, p) === 'expired')) return { text: tx('Aperture esaurite'), warn: true };
	return { text: tx('Attivo'), warn: false };
}

export function profileSummary(r: ShareRecord, p: ShareProfile): string {
	const parts = [p.canEdit ? tx('può modificare') : tx('sola lettura'), p.password ? tx('con password') : tx('senza password')];
	parts.push(p.maxUses != null ? tx('aperture {0}/{1}', usesOf(p), p.maxUses) : tx('aperture: {0}', usesOf(p)));
	const exp = Math.min(p.expires ?? Infinity, r.expires ?? Infinity);
	parts.push(exp !== Infinity ? tx('scade il {0}', when(exp)) : tx('senza scadenza'));
	const st = profileState(r, p);
	if (st === 'exhausted') parts.push(tx('Aperture esaurite'));
	else if (st === 'expired' && !shareState(r)) parts.push(tx('Scaduto'));
	return parts.join(' · ');
}

function profileChips(parent: HTMLElement, r: ShareRecord) {
	const box = parent.createDiv({ cls: 'ambraia-share-profiles' });
	for (const p of r.profiles) {
		const c = box.createDiv({ cls: 'ambraia-share-pchip' });
		setIcon(c.createSpan({ cls: 'ambraia-share-pchip-icon' }), p.canEdit ? 'pencil' : 'eye');
		c.createSpan({ cls: 'ambraia-share-pchip-name', text: p.label });
		c.createSpan({ cls: 'ambraia-share-pchip-meta', text: profileSummary(r, p) });
	}
}

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(tx('Link copiato.'));
	} catch {
		new Notice(tx('Impossibile copiare: seleziona il link e copialo a mano.'));
	}
}

/** Card of a link with its actions (used by the note dialog and by the list of every link). */
function renderRow(feature: SharingFeature, parent: HTMLElement, r: ShareRecord, redraw: () => void, showNote: boolean) {
	const row = parent.createDiv({ cls: 'ambraia-share-row' + (ended(r) ? ' is-ended' : '') });
	const head = row.createDiv({ cls: 'ambraia-share-row-head' });
	setIcon(head.createDiv({ cls: 'ambraia-share-row-icon' }), ended(r) ? 'link-2-off' : 'link-2');
	const text = head.createDiv({ cls: 'ambraia-share-row-text' });
	const st = stateText(r);
	const title = text.createDiv({ cls: 'ambraia-share-row-title' });
	title.createSpan({ text: showNote ? r.title || r.path : tx('Creato il {0}', when(r.created)) });
	title.createSpan({ cls: 'ambraia-share-chip' + (st.warn ? ' is-warn' : ' is-ok'), text: st.text });
	const range = [r.starts ? tx('dal {0}', when(r.starts)) : '', r.expires ? tx('fino al {0}', when(r.expires)) : tx('senza scadenza')].filter(Boolean).join(' ');
	text.createDiv({ cls: 'ambraia-share-row-meta', text: (showNote ? tx('creato il {0}', when(r.created)) + ' · ' : '') + range });
	const actions = head.createDiv({ cls: 'ambraia-share-row-actions' });
	const btn = (ic: string, label: string, fn: () => void | Promise<void>, danger = false) => {
		const b = actions.createEl('button', { cls: 'clickable-icon' + (danger ? ' mod-warning' : ''), attr: { 'aria-label': label } });
		setIcon(b, ic);
		b.onclick = () => void fn();
	};
	if (!ended(r)) btn('copy', tx('Copia link'), () => copy(r.url));
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
	profileChips(row, r);
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

/** Small card with a title, used to group the fields of the link dialogs. */
function card(parent: HTMLElement, icon: string, title: string, desc?: string): HTMLElement {
	const c = parent.createDiv({ cls: 'ambraia-share-card' });
	const h = c.createDiv({ cls: 'ambraia-share-card-head' });
	setIcon(h.createSpan({ cls: 'ambraia-share-card-icon' }), icon);
	const t = h.createDiv({ cls: 'ambraia-share-card-text' });
	t.createDiv({ cls: 'ambraia-share-card-title', text: title });
	if (desc) t.createDiv({ cls: 'ambraia-share-card-desc', text: desc });
	return c.createDiv({ cls: 'ambraia-share-card-body' });
}

/**
 * Settings of a link: when it is valid (from / until) and its profiles. Returns the values to
 * save, or an error text.
 */
class LinkForm {
	start: 'now' | 'date';
	startAt: string;
	expiry: string;
	custom: string;
	profiles: ProfileDraft[];

	constructor(private rec: ShareRecord | null) {
		this.start = rec?.starts && rec.starts > Date.now() ? 'date' : 'now';
		this.startAt = localInput(rec?.starts && rec.starts > Date.now() ? rec.starts : Date.now() + HOUR);
		this.expiry = rec ? (rec.expires ? 'date' : 'never') : '7d';
		this.custom = localInput(rec?.expires ?? Date.now() + 7 * DAY);
		this.profiles = rec ? rec.profiles.map(draftOf) : [newDraft(0)];
	}

	/** Start of the validity chosen in the form (now when not set or not valid). */
	private from(): number {
		if (this.start !== 'date') return Date.now();
		const t = Date.parse(this.startAt);
		return Number.isFinite(t) && t > Date.now() ? t : Date.now();
	}

	private durationDropdown(st: Setting, value: string, first: [string, string], onChange: (v: string) => void) {
		st.addDropdown((d) => {
			d.addOption(first[0], first[1]);
			for (const [v, , label] of DURATIONS) d.addOption(v, label());
			d.addOption('date', tx('Data e ora…'));
			d.setValue(value).onChange(onChange);
		});
	}

	draw(el: HTMLElement, redraw: () => void, relay: string) {
		const when_ = card(el, 'calendar-clock', tx('Validità'), tx('Vale per tutti i profili: prima dell’inizio e dopo la fine il link non si apre.'));
		const st = new Setting(when_).setName(tx('Valido da'));
		st.addDropdown((d) =>
			d
				.addOption('now', tx('Subito'))
				.addOption('date', tx('Data e ora…'))
				.setValue(this.start)
				.onChange((v) => {
					this.start = v as LinkForm['start'];
					redraw();
				}),
		);
		if (this.start === 'date')
			st.addText((t) => {
				t.inputEl.type = 'datetime-local';
				t.inputEl.min = localInput(Date.now());
				t.setValue(this.startAt).onChange((v) => {
					this.startAt = v;
					updateEnd();
				});
			});
		const exp = new Setting(when_).setName(tx('Durata'));
		this.durationDropdown(exp, this.expiry, ['never', tx('Senza scadenza')], (v) => {
			this.expiry = v;
			redraw();
		});
		if (this.expiry === 'date')
			exp.addText((t) => {
				t.inputEl.type = 'datetime-local';
				t.inputEl.min = localInput(Date.now());
				t.setValue(this.custom).onChange((v) => {
					this.custom = v;
					updateEnd();
				});
			});
		const endLine = when_.createDiv({ cls: 'ambraia-share-when' });
		const updateEnd = () => {
			const from = this.from();
			const to = this.expiry === 'never' ? null : expiryFrom(this.expiry, this.custom, from);
			endLine.setText(
				to === null
					? tx('Si apre {0}, senza scadenza.', this.start === 'date' ? tx('dal {0}', when(from)) : tx('da subito'))
					: Number.isFinite(to) && to > from
						? tx('Si apre {0} fino al {1}.', this.start === 'date' ? tx('dal {0}', when(from)) : tx('da subito'), when(to))
						: tx('La fine deve venire dopo l’inizio.'),
			);
		};
		updateEnd();
		const lim = when_.createDiv({ cls: 'ambraia-share-limits' });
		setIcon(lim.createSpan({ cls: 'ambraia-share-limits-icon' }), 'info');
		const ul = lim.createEl('ul');
		for (const t of relayLimits(relay)) ul.createEl('li', { text: t });

		const prof = card(el, 'users', tx('Profili di accesso'), tx('Con lo stesso link ogni profilo si apre con la sua password e ha i suoi permessi. Un solo profilo può essere senza password.'));
		this.profiles.forEach((p, i) => this.drawProfile(prof, p, i, redraw));
		const add = prof.createEl('button', { cls: 'ambraia-share-add' });
		setIcon(add.createSpan(), 'plus');
		add.createSpan({ text: tx('Aggiungi profilo') });
		add.onclick = () => {
			this.profiles.push(newDraft(this.profiles.length, true));
			redraw();
		};
	}

	private drawProfile(parent: HTMLElement, p: ProfileDraft, i: number, redraw: () => void) {
		const box = parent.createDiv({ cls: 'ambraia-share-profile' });
		const top = box.createDiv({ cls: 'ambraia-share-profile-top' });
		setIcon(top.createSpan({ cls: 'ambraia-share-profile-icon' }), p.canEdit ? 'pencil' : 'eye');
		const name = top.createEl('input', { cls: 'ambraia-share-profile-name', attr: { type: 'text', 'aria-label': tx('Nome del profilo'), placeholder: tx('Nome del profilo') } });
		name.value = p.label;
		name.oninput = () => (p.label = name.value);
		if (this.profiles.length > 1) {
			const del = top.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tx('Togli il profilo') } });
			setIcon(del, 'trash-2');
			del.onclick = () => {
				this.profiles.splice(i, 1);
				redraw();
			};
		}
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
			.setDesc(tx('Le modifiche fatte dal browser vengono unite a quelle fatte nel frattempo, anche offline.'))
			.addToggle((t) =>
				t.setValue(p.canEdit).onChange((v) => {
					p.canEdit = v;
					redraw();
				}),
			);
		const uses = new Setting(box)
			.setName(tx('Aperture massime'))
			.setDesc(p.id ? tx('Finora: {0}. Vuoto = nessun limite.', p.uses) : tx('Vuoto = nessun limite.'))
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
		const exp = new Setting(box).setName(tx('Durata del profilo'));
		this.durationDropdown(exp, p.expiry, ['link', tx('Come il link')], (v) => {
			p.expiry = v;
			redraw();
		});
		if (p.expiry === 'date')
			exp.addText((t) => {
				t.inputEl.type = 'datetime-local';
				t.setValue(p.custom).onChange((v) => (p.custom = v));
			});
	}

	/** Values to save, or a message for the user. */
	values(): { expires: number | null; starts: number | null; profiles: ProfileInput[]; reset: string[] } | string {
		let starts: number | null = null;
		if (this.start === 'date') {
			const t = Date.parse(this.startAt);
			if (!Number.isFinite(t)) return tx('Scegli quando il link inizia a valere.');
			// a start already passed simply means "now"
			starts = t > Date.now() ? t : null;
		}
		const from = starts ?? Date.now();
		const expires = this.expiry === 'never' ? null : expiryFrom(this.expiry, this.custom, from);
		if (expires !== null && (!Number.isFinite(expires) || expires <= Date.now())) return tx('Scegli una scadenza nel futuro.');
		if (expires !== null && expires <= from) return tx('La fine deve venire dopo l’inizio.');
		const out: ProfileInput[] = [];
		let open = 0;
		for (const p of this.profiles) {
			let maxUses: number | null = null;
			if (p.maxUses.trim()) {
				maxUses = Number(p.maxUses);
				if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) return tx('Il numero di aperture deve essere un intero da 1 in su.');
			}
			let pexp = p.expiry === 'link' ? null : expiryFrom(p.expiry, p.custom, from);
			if (pexp !== null && (!Number.isFinite(pexp) || pexp <= from)) return tx('Scegli una scadenza nel futuro.');
			if (pexp !== null && expires !== null && pexp > expires) pexp = expires;
			if (p.pwMode === 'set' && p.password.length < 6) return tx('Usa una password di almeno 6 caratteri (meglio una frase).');
			const none = p.pwMode === 'none' || (p.pwMode === 'keep' && !p.had);
			if (none) open++;
			out.push({ id: p.id, label: p.label, password: p.pwMode === 'set' ? p.password : p.pwMode === 'none' ? '' : undefined, canEdit: p.canEdit, maxUses, expires: pexp });
		}
		if (open > 1) return tx('Un solo profilo può essere senza password.');
		return { expires, starts, profiles: out, reset: this.profiles.filter((p) => p.reset && p.id).map((p) => p.id!) };
	}

	get slow() {
		return this.profiles.some((p) => p.pwMode === 'set');
	}
}

const saveError = (e: unknown) => (e instanceof DuplicatePasswordError ? tx('Due profili non possono avere la stessa password.') : tx('Errore: {0}', (e as Error).message));

/** Bottom bar of the link dialogs: status text on the left, buttons on the right. */
function footerBar(el: HTMLElement): { status: HTMLElement; buttons: HTMLElement } {
	const bar = el.createDiv({ cls: 'ambraia-share-footer' });
	const status = bar.createDiv({ cls: 'ambraia-share-status', attr: { 'aria-live': 'polite' } });
	const buttons = bar.createDiv({ cls: 'ambraia-share-footer-buttons' });
	return { status, buttons };
}

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
		this.titleEl.empty();
		const t = this.titleEl.createDiv({ cls: 'ambraia-share-title' });
		setIcon(t.createSpan({ cls: 'ambraia-share-title-icon' }), 'share-2');
		const tt = t.createDiv();
		tt.createDiv({ cls: 'ambraia-share-title-main', text: tx('Condividi la nota') });
		tt.createDiv({ cls: 'ambraia-share-title-sub', text: this.file.basename });
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
			const { buttons } = footerBar(el);
			const b = buttons.createEl('button', { cls: 'mod-cta', text: tx('Nuovo link') });
			b.onclick = () => {
				this.creating = true;
				this.draw();
			};
			return;
		}
		if (!existing.length) {
			const intro = el.createDiv({ cls: 'ambraia-share-intro' });
			setIcon(intro.createSpan({ cls: 'ambraia-share-intro-icon' }), 'shield-check');
			intro.createDiv({ text: tx('Chi riceve il link legge la versione attuale della nota nel browser, senza account. Il contenuto è cifrato end-to-end: la chiave resta nel link, dopo “#”.') });
		} else el.createDiv({ cls: 'ambraia-share-section', text: tx('Nuovo link') });
		this.form.draw(el, () => this.draw(), this.feature.plugin.settings.shareRelayUrl);
		const { status, buttons } = footerBar(el);
		if (existing.length) {
			const cancel = buttons.createEl('button', { text: tx('Annulla') });
			cancel.onclick = () => {
				this.creating = false;
				this.form = new LinkForm(null);
				this.draw();
			};
		}
		const b = buttons.createEl('button', { cls: 'mod-cta', text: tx('Crea link') });
		b.onclick = async () => {
			if (this.busy) return;
			const v = this.form.values();
			if (typeof v === 'string') return void status.setText(v);
			this.busy = true;
			b.disabled = true;
			status.setText(this.form.slow ? tx('Preparo il link (la password richiede qualche secondo)…') : tx('Preparo il link…'));
			try {
				this.result = await this.feature.create(this.file, { expires: v.expires, starts: v.starts, profiles: v.profiles });
				this.form = new LinkForm(null);
				this.creating = false;
				this.draw();
			} catch (e) {
				status.setText(saveError(e));
			} finally {
				this.busy = false;
				b.disabled = false;
			}
		};
	}

	private drawResult(el: HTMLElement, r: ShareRecord) {
		const box = el.createDiv({ cls: 'ambraia-share-result' });
		const head = box.createDiv({ cls: 'ambraia-share-result-head' });
		setIcon(head.createSpan({ cls: 'ambraia-share-result-icon' }), 'check-circle-2');
		head.createSpan({ text: tx('Link pronto') });
		const line = box.createDiv({ cls: 'ambraia-share-result-line' });
		const input = line.createEl('input', { cls: 'ambraia-share-link', attr: { type: 'text', readonly: '', 'aria-label': tx('Link') } });
		input.value = r.url;
		input.onclick = () => input.select();
		const b = line.createEl('button', { cls: 'mod-cta' });
		setIcon(b.createSpan(), 'copy');
		b.createSpan({ text: tx('Copia') });
		b.onclick = () => void copy(r.url);
		const ul = box.createEl('ul', { cls: 'ambraia-share-tips' });
		if (r.starts) ul.createEl('li', { text: tx('Il link inizia a funzionare il {0}.', when(r.starts)) });
		ul.createEl('li', { text: tx('La chiave è dopo il simbolo #: non arriva a nessun server. Condividi il link solo con chi deve leggerlo.') });
		if (r.profiles.some((p) => p.password)) ul.createEl('li', { text: tx('Invia ogni password per un canale diverso dal link: chi la inserisce entra nel profilo corrispondente.') });
		ul.createEl('li', { text: tx('Il link si apre mentre uno dei tuoi dispositivi ha Obsidian aperto e non in pausa.') });
		const { buttons } = footerBar(el);
		buttons.createEl('button', { text: tx('Nuovo link') }).onclick = () => {
			this.result = null;
			this.creating = true;
			this.draw();
		};
		buttons.createEl('button', { cls: 'mod-cta', text: tx('Fine') }).onclick = () => this.close();
	}
}

/** Validity and profiles of an existing link. */
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
		this.titleEl.empty();
		const t = this.titleEl.createDiv({ cls: 'ambraia-share-title' });
		setIcon(t.createSpan({ cls: 'ambraia-share-title-icon' }), 'settings-2');
		const tt = t.createDiv();
		tt.createDiv({ cls: 'ambraia-share-title-main', text: tx('Gestisci il link') });
		tt.createDiv({ cls: 'ambraia-share-title-sub', text: this.rec.title || this.rec.path });
		this.draw();
	}

	private draw() {
		const el = this.contentEl;
		el.empty();
		const r = this.rec;
		const st = stateText(r);
		const info = el.createDiv({ cls: 'ambraia-share-linkinfo' });
		info.createSpan({ cls: 'ambraia-share-chip' + (st.warn ? ' is-warn' : ' is-ok'), text: st.text });
		info.createSpan({ cls: 'ambraia-share-row-meta', text: tx('Creato il {0} da {1}', when(r.created), r.by || '—') });
		if (!ended(r)) {
			const cp = info.createEl('button', { cls: 'ambraia-share-copy-small' });
			setIcon(cp.createSpan(), 'copy');
			cp.createSpan({ text: tx('Copia link') });
			cp.onclick = () => void copy(r.url);
		}
		if (r.revoked) {
			const back = el.createDiv({ cls: 'ambraia-share-revoked' });
			back.createSpan({ text: tx('Il link è revocato: nessuno può aprirlo.') });
			back.createEl('button', { text: tx('Riattiva') }).onclick = async () => {
				await this.feature.store.update(r.id, { revoked: false });
				this.done();
				this.close();
			};
		}
		this.form.draw(el, () => this.draw(), r.relay);
		const { status, buttons } = footerBar(el);
		buttons.createEl('button', { text: tx('Annulla') }).onclick = () => this.close();
		const save = buttons.createEl('button', { cls: 'mod-cta', text: tx('Salva') });
		save.onclick = async () => {
			const v = this.form.values();
			if (typeof v === 'string') return void status.setText(v);
			save.disabled = true;
			status.setText(tx('Salvo…'));
			try {
				await this.feature.store.update(r.id, v);
				this.done();
				this.close();
			} catch (e) {
				save.disabled = false;
				status.setText(saveError(e));
			}
		};
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
		this.titleEl.empty();
		const t = this.titleEl.createDiv({ cls: 'ambraia-share-title' });
		setIcon(t.createSpan({ cls: 'ambraia-share-title-icon' }), 'link-2');
		t.createDiv({ cls: 'ambraia-share-title-main', text: tx('Link condivisi') });
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
		if (all.some((r) => ended(r)))
			new Setting(el).addButton((b) =>
				destructive(b.setButtonText(tx('Elimina i link non più attivi'))).onClick(() => {
					for (const r of this.feature.store.all()) if (ended(r)) this.feature.store.remove(r.id);
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
