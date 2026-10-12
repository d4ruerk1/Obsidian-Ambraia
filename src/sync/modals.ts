import { App, Modal, Notice, Setting } from 'obsidian';
import type { MassDeleteError } from './engine';
import type { LogEntry, SyncManager } from './manager';
import type { SyncHub } from './hub';
import { WrongKeyError } from './crypto';
import { tx } from '../i18n';
import { helpToggle } from './help';

export class MassDeleteModal extends Modal {
	private chosen = false;
	constructor(
		app: App,
		private err: MassDeleteError,
		private where: string,
		private cb: (c: 'allow' | 'restore') => void | Promise<void>,
	) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(tx('Ambraia – conferma eliminazione'));
		contentEl.createEl('p', { text: tx('La sincronizzazione sta per eliminare {0} elementi (in locale o su {1}). Per sicurezza ho messo in pausa: è un’azione voluta?', this.err.count, this.where) });
		const ul = contentEl.createEl('ul', { cls: 'ambraia-list-scroll' });
		for (const p of this.err.paths.slice(0, 50)) ul.createEl('li', { text: p });
		if (this.err.paths.length > 50) ul.createEl('li', { text: tx('… e altri {0}', this.err.paths.length - 50) });
		const row = contentEl.createDiv({ cls: 'modal-button-container' });
		row.createEl('button', { text: tx('No, ripristina i file') }).onclick = () => this.pick('restore');
		row.createEl('button', { text: tx('Sì, elimina'), cls: 'mod-warning' }).onclick = () => this.pick('allow');
	}
	private pick(c: 'allow' | 'restore') {
		this.chosen = true;
		this.close();
		void this.cb(c);
	}
	onClose() {
		this.contentEl.empty();
		if (!this.chosen) void this.cb('restore');
	}
}

export class LogModal extends Modal {
	constructor(
		app: App,
		private mgr: { log: LogEntry[] },
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(tx('Sincronizzazione – registro'));
		const box = this.contentEl.createDiv({ cls: 'ambraia-log' });
		if (!this.mgr.log.length) box.createDiv({ text: tx('Nessuna attività ancora.') });
		for (const l of [...this.mgr.log].reverse()) {
			const row = box.createDiv({ cls: `ambraia-log-row is-${l.level}` });
			row.createSpan({ text: new Date(l.time).toLocaleTimeString(), cls: 'ambraia-log-time' });
			row.createSpan({ text: l.msg });
		}
		const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
		row.createEl('button', { text: tx('Copia registro') }).onclick = async () => {
			await navigator.clipboard.writeText(this.mgr.log.map((l) => `${new Date(l.time).toISOString()} [${l.level}] ${l.msg}`).join('\n'));
			new Notice(tx('Registro copiato'));
		};
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Asks for the master key of an encrypted cloud folder (once for every service sharing it). */
export class UnlockModal extends Modal {
	constructor(
		app: App,
		private hub: SyncHub,
		private mgr: SyncManager,
		private others: SyncManager[],
		private closed?: () => void,
	) {
		super(app);
	}
	onOpen() {
		const el = this.contentEl;
		this.modalEl.addClass('ambraia-setup');
		this.titleEl.setText(tx('Sblocca la sincronizzazione cifrata'));
		el.createEl('p', { text: tx('I file nella cartella "{0}" su {1} sono cifrati. Inserisci la chiave principale scelta quando hai attivato la cifratura.', this.mgr.folder, this.mgr.label) });
		if (this.others.length) el.createEl('p', { cls: 'setting-item-description', text: tx('Chiave condivisa: sblocca anche {0}.', this.others.map((o) => o.label).join(', ')) });
		let pw = '';
		let remember = this.mgr.t.remember;
		const pwSetting = new Setting(el).setName(tx('Chiave principale')).addText((t) => {
			t.inputEl.type = 'password';
			t.inputEl.autocomplete = 'current-password';
			t.onChange((v) => (pw = v));
			t.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') void go();
			});
			window.setTimeout(() => t.inputEl.focus(), 50);
		});
		pwSetting.settingEl.addClass('ambraia-wide');
		new Setting(el)
			.setName(tx('Ricorda su questo dispositivo'))
			.setDesc(tx('La chiave dei dati resta nel portachiavi protetto del sistema: non dovrai reinserirla.'))
			.addToggle((t) => t.setValue(remember).onChange((v) => (remember = v)));
		helpToggle(el, tx('Ho dimenticato la chiave'), [
			tx('Nessuno può recuperarla: è il motivo per cui i dati sono al sicuro.'),
			tx('I file su questo dispositivo non sono toccati e restano leggibili.'),
			tx('Se un altro dispositivo è ancora sbloccato, da lì puoi impostare una nuova chiave (Impostazioni → Sincronizzazione → Cambia chiave principale).'),
			tx('Altrimenti, in Impostazioni → Sincronizzazione usa "Ricrea cifratura": i file di questo dispositivo vengono ricaricati con una nuova chiave e la vecchia copia nel cloud va nel cestino.'),
		]);
		const status = el.createDiv({ cls: 'ambraia-setup-status' });
		const row = el.createDiv({ cls: 'modal-button-container' });
		const btn = row.createEl('button', { text: tx('Sblocca'), cls: 'mod-cta' });
		const go = async () => {
			if (!pw || btn.disabled) return;
			btn.disabled = true;
			status.setText(tx('Verifico la chiave…'));
			try {
				const done = await this.hub.unlock(this.mgr, pw, remember);
				pw = '';
				new Notice(done.length > 1 ? tx('Sincronizzazione sbloccata: {0}', done.map((d) => d.label).join(', ')) : tx('Sincronizzazione sbloccata'));
				this.close();
			} catch (e) {
				status.setText(e instanceof WrongKeyError ? tx('Chiave non corretta.') : tx('Errore: {0}', (e as Error).message));
				btn.disabled = false;
			}
		};
		btn.onclick = () => void go();
	}
	onClose() {
		this.contentEl.empty();
		this.closed?.();
	}
}
