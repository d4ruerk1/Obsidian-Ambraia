import { App, Modal, Notice, setIcon } from 'obsidian';
import type AmbraiaPlugin from './main';
import { tx } from './i18n';

export interface RiskOptions {
	title: string;
	intro: string;
	risks: string[];
	/** Every box must be ticked before the action is allowed. */
	checks: string[];
	cta: string;
	/** What stays as it is (shown under the risks, reassuring). */
	keep?: string[];
	/** Optional extra choice (unchecked by default), returned as `extra`. */
	extra?: string;
}

/** A warning that cannot be skipped by mistake: the action stays disabled until every risk is acknowledged. */
export class RiskModal extends Modal {
	private done = false;
	private extra = false;
	constructor(
		app: App,
		private o: RiskOptions,
		private resolve: (v: { ok: boolean; extra: boolean }) => void,
	) {
		super(app);
	}
	onOpen() {
		const o = this.o;
		this.modalEl.addClass('ambraia-risk-modal');
		this.titleEl.setText(o.title);
		const el = this.contentEl;
		const head = el.createDiv('ambraia-risk-head');
		setIcon(head.createDiv('ambraia-risk-icon'), 'alert-triangle');
		head.createDiv({ cls: 'ambraia-risk-intro', text: o.intro });
		if (o.risks.length) {
			const ul = el.createEl('ul', { cls: 'ambraia-risk-list' });
			for (const r of o.risks) ul.createEl('li', { text: r });
		}
		if (o.keep?.length) {
			el.createDiv({ cls: 'ambraia-risk-sub', text: tx('Cosa resta') });
			const ul = el.createEl('ul', { cls: 'ambraia-risk-list is-keep' });
			for (const k of o.keep) ul.createEl('li', { text: k });
		}
		const boxes: HTMLInputElement[] = [];
		const checks = el.createDiv('ambraia-risk-checks');
		for (const c of o.checks) {
			const l = checks.createEl('label', { cls: 'ambraia-risk-check' });
			const cb = l.createEl('input', { type: 'checkbox' });
			l.createSpan({ text: c });
			boxes.push(cb);
			cb.onchange = () => update();
		}
		if (o.extra) {
			const l = checks.createEl('label', { cls: 'ambraia-risk-check is-optional' });
			const cb = l.createEl('input', { type: 'checkbox' });
			l.createSpan({ text: o.extra });
			cb.onchange = () => (this.extra = cb.checked);
		}
		const row = el.createDiv({ cls: 'modal-button-container' });
		row.createEl('button', { text: tx('Annulla') }).onclick = () => this.close();
		const go = row.createEl('button', { text: o.cta, cls: 'mod-warning' });
		const update = () => (go.disabled = !boxes.every((b) => b.checked));
		update();
		go.onclick = () => {
			if (go.disabled) return;
			this.done = true;
			this.resolve({ ok: true, extra: this.extra });
			this.close();
		};
	}
	onClose() {
		this.contentEl.empty();
		if (!this.done) this.resolve({ ok: false, extra: false });
	}
}

export function riskConfirm(app: App, o: RiskOptions): Promise<{ ok: boolean; extra: boolean }> {
	return new Promise((res) => new RiskModal(app, o, res).open());
}

/** Text of the master-key warning, shared by every place where a key is created or changed. */
export const KEY_WARNING = () => tx('La chiave principale non viene salvata da nessuna parte fuori dai tuoi dispositivi e non si può recuperare. Se la perdi, i file cifrati nel cloud diventano illeggibili per sempre.');

/**
 * Required acknowledgement under a new master key: returns a getter for its state.
 * The box is unticked every time the key changes, so the user confirms the key actually in use.
 */
export function keyAcknowledgement(parent: HTMLElement) {
	const box = parent.createDiv('ambraia-key-ack');
	const warn = box.createDiv('ambraia-key-ack-warn');
	setIcon(warn.createSpan('ambraia-key-ack-icon'), 'alert-triangle');
	warn.createSpan({ text: KEY_WARNING() });
	const l = box.createEl('label', { cls: 'ambraia-risk-check' });
	const cb = l.createEl('input', { type: 'checkbox' });
	l.createSpan({ text: tx('Ho salvato la chiave principale in un posto sicuro (es. un gestore di password).') });
	return {
		el: box,
		get ok() {
			return cb.checked;
		},
		reset() {
			cb.checked = false;
		},
		flash() {
			box.addClass('is-required');
			window.setTimeout(() => box.removeClass('is-required'), 1200);
		},
	};
}

/** What stops working when Ambraia is removed from this vault. */
export function uninstallRisks(plugin: AmbraiaPlugin): string[] {
	const sync = plugin.sync;
	const out: string[] = [];
	const encrypted = sync?.managers.filter((m) => m.t.encrypt) ?? [];
	if (sync?.managers.length) out.push(tx('La sincronizzazione si ferma su questo dispositivo, che viene tolto dall’elenco dei dispositivi collegati.'));
	if (encrypted.length)
		out.push(tx('I file nel cloud di {0} sono cifrati: senza Ambraia e la chiave principale non si possono leggere. Le note su questo dispositivo restano in chiaro.', encrypted.map((m) => m.label).join(', ')));
	out.push(tx('Database, calendario, menu “/” e “@”, icone e copertine non vengono più mostrati.'));
	out.push(tx('I blocchi “ambraia” (viste database) appaiono come normali blocchi di codice.'));
	return out;
}

/** What is left untouched by the uninstall. */
export function uninstallKeeps(): string[] {
	return [
		tx('Tutte le note, gli allegati e le cartelle, come normali file Markdown.'),
		tx('Icone, copertine e campi dei database: sono proprietà delle note (frontmatter) che Obsidian continua a mostrare nel pannello Proprietà.'),
		tx('Le impostazioni di Obsidian tornano come prima: proprietà nel documento, pulsanti dell’esplora file, tema e aspetto.'),
		tx('Le chat salvate dell’AI e i modelli restano note normali.'),
	];
}
