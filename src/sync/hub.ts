import { App, Menu, Notice, setIcon } from 'obsidian';
import type AmbraiaPlugin from '../main';
import type { SyncTarget } from '../settings';
import { SyncManager, SyncStatus, LogEntry, HANDOFF_FILE } from './manager';
import { resetDeviceId, type DeviceCommand } from './devices';
import { ObsidianLocal } from './obsidianLocal';
import type { Credentials, ProviderId, Remote } from './providers';
import type { SyncReport } from './types';
import { WrongKeyError } from './crypto';
import { isDesktopFs } from './providers/localFolder';
import { LogModal, UnlockModal } from './modals';
import { cleanPath } from './http';
import { tx } from '../i18n';
import { Alerts } from './health';
import { FileBaseStore } from './baseStore';
import { CONFLICT_COPY, tidyConflictCopies } from './tidy';

/** Worst status first: the status bar shows the most urgent one. */
const PRIORITY: SyncStatus[] = ['locked', 'auth', 'error', 'full', 'paused', 'offline', 'syncing', 'idle', 'off'];

export const newTargetId = () => Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x').padEnd(6, '0');

/** Defaults for a new service. */
export const makeTarget = (provider: ProviderId, folder = '', id = newTargetId()): SyncTarget => ({
	id,
	provider,
	folder,
	enabled: false,
	encrypt: false,
	alg: 'aes-gcm',
	names: true,
	remember: true,
	sharedKey: true,
});

/**
 * Coordinates every cloud service the vault is synced with. Each service has its own
 * SyncManager (credentials, state, key); the vault is the hub: a change downloaded from one
 * service is uploaded to the others. Cycles never run in parallel, so services never race
 * on the same local file.
 */
export class SyncHub {
	managers: SyncManager[] = [];
	readonly local: ObsidianLocal;
	/** Tests replace the cloud backend here. */
	remoteFactory: ((c: Credentials, folder: string) => Remote) | null = null;
	/** Devices publish themselves in the device list after successful cycles (off in some tests). */
	deviceList = true;
	private statusEl: HTMLElement | null = null;
	private listeners: (() => void)[] = [];
	private chain: Promise<unknown> = Promise.resolve();
	private unlockQueue: SyncManager[] = [];
	private unlockOpen = false;
	private reloadNotice: Notice | null = null;
	private ready = false;
	/** Deduplicated notices about broken / full / throttled services. */
	readonly alerts: Alerts;
	/** Last-synced text of notes (common ancestor for merges), shared by all services. */
	readonly bases: FileBaseStore;

	constructor(
		private app: App,
		private plugin: AmbraiaPlugin,
	) {
		this.local = new ObsidianLocal(app, this.localOptions());
		this.alerts = new Alerts(app, () => this.plugin.settings.notifySystem !== false);
		this.bases = new FileBaseStore(app, `${this.plugin.stateDir}/sync-base`);
	}

	get settings() {
		return this.plugin.settings;
	}

	private get pluginDir() {
		return this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/ambraia`;
	}

	private localOptions() {
		const s = this.plugin.settings;
		return {
			configSettings: s.syncConfigSettings,
			configAppearance: s.syncConfigAppearance,
			configPlugins: s.syncConfigPlugins,
			ignorePatterns: s.ignorePatterns,
			pluginDir: this.pluginDir,
		};
	}

	get(id: string) {
		return this.managers.find((m) => m.id === id) ?? null;
	}

	/** First configured service (handy for single-service setups and tests). */
	get primary(): SyncManager | null {
		return this.managers[0] ?? null;
	}

	get connected() {
		return this.managers.some((m) => m.connected);
	}

	get anyEnabled() {
		return this.managers.some((m) => m.t.enabled && m.connected);
	}

	onChange(cb: () => void) {
		this.listeners.push(cb);
	}

	emit() {
		this.renderStatus();
		for (const l of this.listeners) l();
	}

	logChanged() {
		/* hook for future live log views */
	}

	/** Drops stored ancestors that no service needs anymore. */
	async gcBases(force = false) {
		const keep = new Set<string>();
		for (const m of this.managers) for (const b of Object.values(m.state.base)) if (b.md5) keep.add(b.md5);
		await this.bases.gc(keep, force);
	}

	/** Runs sync cycles one at a time across all services. */
	serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	// ------------------------------------------------------------ lifecycle

	async init(statusEl: HTMLElement | null) {
		this.statusEl = statusEl;
		if (statusEl) {
			statusEl.addClass('ambraia-sync-status', 'mod-clickable');
			statusEl.onclick = (e) => this.openMenu(e);
		}
		this.registerEvents();
		// Obsidian Sync can be switched on or off at any time: re-check now and then
		this.plugin.registerInterval(window.setInterval(() => this.renderStatus(), 30_000));
		this.ready = true;
		let missing = false;
		for (const t of this.settings.syncTargets) {
			const m = new SyncManager(this.app, this.plugin, this, t);
			this.managers.push(m);
			// MEGA / Proton Drive work only on computers: phones simply skip them
			if (!(await m.init()) && t.enabled && !(m.isFolderProvider && !isDesktopFs())) missing = true;
		}
		// link files of older versions carried account access: never needed anymore
		void this.removeHandoff();
		this.emit();
		// vault copied from another device: account access stays on that device
		if (missing) this.app.workspace.onLayoutReady(() => this.plugin.offerLink());
	}

	private registerEvents() {
		const p = this.plugin;
		const v = this.app.vault;
		const each = (fn: (m: SyncManager) => void) => {
			for (const m of this.managers) fn(m);
		};
		p.registerEvent(v.on('create', (f) => each((m) => m.onLocal(f.path))));
		p.registerEvent(v.on('modify', (f) => each((m) => m.onLocal(f.path))));
		p.registerEvent(v.on('delete', (f) => each((m) => m.onDelete(f))));
		p.registerEvent(v.on('rename', (f, old) => each((m) => m.onRename(f, old))));
		const wake = () => each((m) => m.wake());
		p.registerDomEvent(window, 'focus', wake);
		p.registerDomEvent(window, 'online', wake);
		p.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') wake();
			else each((m) => m.flush());
		});
	}

	async unload() {
		for (const m of this.managers) await m.unload();
	}

	/** Call after changing services, folders or shared sync options. */
	settingsChanged() {
		this.local.setOptions(this.localOptions());
		void this.reconcile();
		for (const m of this.managers) m.settingsChanged();
		this.emit();
	}

	/** Keeps the managers in line with settings.syncTargets (e.g. after loading settings again). */
	private async reconcile() {
		if (!this.ready) return;
		const targets = this.settings.syncTargets;
		for (const m of [...this.managers]) {
			const t = targets.find((x) => x.id === m.id);
			if (t) m.t = t;
			else {
				this.managers.splice(this.managers.indexOf(m), 1);
				m.stop('off');
			}
		}
		for (const t of targets) {
			if (this.get(t.id)) continue;
			const m = new SyncManager(this.app, this.plugin, this, t);
			this.managers.push(m);
			await m.init();
		}
	}

	/** A manager that is not part of the configuration yet (setup wizard). */
	draft(provider: ProviderId, folder = ''): SyncManager {
		return new SyncManager(this.app, this.plugin, this, makeTarget(provider, folder, this.managers.some((m) => m.id === 'main') || this.settings.syncTargets.length ? newTargetId() : 'main'));
	}

	/** Adds a configured draft to the services. */
	async adopt(m: SyncManager) {
		if (this.managers.includes(m)) return;
		if (!this.settings.syncTargets.includes(m.t)) this.settings.syncTargets.push(m.t);
		this.managers.push(m);
		await this.plugin.saveSettings();
		this.emit();
	}

	/** Adds a service with ready credentials (used by tests and scripts). */
	async add(t: Partial<SyncTarget> & { provider: ProviderId }, creds?: Credentials) {
		const m = this.draft(t.provider, t.folder ?? '');
		Object.assign(m.t, t, { id: t.id ?? m.t.id });
		await this.adopt(m);
		if (creds) await m.saveCredentials(creds);
		return m;
	}

	/** Stops and forgets a service on this device. Files are not deleted anywhere. */
	async remove(m: SyncManager) {
		await m.destroy();
		this.managers = this.managers.filter((x) => x !== m);
		this.settings.syncTargets = this.settings.syncTargets.filter((t) => t.id !== m.id);
		await this.plugin.saveSettings();
		this.emit();
	}

	// ------------------------------------------------------------ fan-out between services

	/** A service changed local files: the other services upload them as well. */
	localChanged(from: SyncManager, r: SyncReport) {
		const paths = [...r.downloaded.map((p) => p.replace(/\/$/, '')), ...r.deletedLocal];
		const renamed = r.renamedLocal.length > 0;
		if (!paths.length && !renamed) return;
		for (const m of this.managers) if (m !== from) m.markDirty(paths, renamed);
	}

	private tidied = false;

	/**
	 * Keeps a single version of every file: old "(conflict …)" copies (made by earlier versions or
	 * by other devices) are folded into the original, the newest one prevailing. Runs once per
	 * session over the whole vault, then only when a cycle brings such copies in.
	 */
	async tidy(r: SyncReport) {
		const hit = [...r.downloaded, ...r.conflicts].filter((p) => CONFLICT_COPY.test(p));
		const full = !this.tidied || r.renamedLocal.some((x) => x.includes('('));
		if (!full && !hit.length) return;
		this.tidied = true;
		try {
			const res = await tidyConflictCopies(this.local, full ? null : hit);
			if (full) await this.dropLegacyTrash();
			const changed = [...res.removed, ...res.updated];
			if (!changed.length) return;
			for (const m of this.managers) {
				m.addLog('info', tx('Copie di conflitto rimosse: ne resta una sola versione per file ({0}).', res.removed.join(', ')));
				m.markDirty(changed);
			}
		} catch {
			/* next session */
		}
	}

	/** Ambraia 1.7.0 kept replaced versions in .trash/Ambraia: no longer needed. */
	private async dropLegacyTrash() {
		const a = this.app.vault.adapter;
		const dir = '.trash/Ambraia';
		if (await a.exists(dir)) await a.rmdir(dir, true);
	}

	async syncNow() {
		if (!this.connected) {
			new Notice(tx('Ambraia: collega prima un servizio cloud dalle impostazioni.'));
			return;
		}
		for (const m of this.managers) if (m.connected) await m.syncNow(true);
	}

	async pauseAll() {
		for (const m of this.managers) if (m.t.enabled) await m.pause();
	}

	async resumeAll() {
		for (const m of this.managers) {
			if (!m.connected) continue;
			m.t.enabled = true;
		}
		await this.plugin.saveSettings();
		this.settingsChanged();
	}

	async idle() {
		for (const m of this.managers) await m.idle();
	}

	// ------------------------------------------------------------ master keys

	/** Encrypted services that share the master key (optionally excluding one). */
	sharedPeers(except?: SyncManager) {
		return this.managers.filter((m) => m !== except && m.t.encrypt && m.t.sharedKey && m.connected);
	}

	/** Checks a password against the shared master key. Returns false when there is nothing to compare with. */
	async verifyShared(password: string, except?: SyncManager): Promise<boolean> {
		let lastError: unknown = null;
		for (const m of this.sharedPeers(except)) {
			try {
				await m.verifyKey(password);
				return true;
			} catch (e) {
				if (e instanceof WrongKeyError) throw e;
				lastError = e; // unreachable service: try another one
			}
		}
		if (lastError) throw lastError instanceof Error ? lastError : new Error(typeof lastError === 'string' ? lastError : JSON.stringify(lastError));
		return false;
	}

	/** Unlocks a service; with a shared key, the other locked services that use it too. */
	async unlock(m: SyncManager, password: string, remember: boolean): Promise<SyncManager[]> {
		await m.unlock(password, remember);
		const done = [m];
		if (m.t.sharedKey)
			for (const o of this.managers) {
				if (o === m || o.status !== 'locked' || !o.t.sharedKey) continue;
				try {
					await o.unlock(password, remember);
					done.push(o);
				} catch {
					/* different key: asked separately */
				}
			}
		this.unlockQueue = this.unlockQueue.filter((x) => !done.includes(x));
		return done;
	}

	/** Changes the shared master key on every service that uses it (checked on all of them first). */
	async changeKey(m: SyncManager, current: string, next: string) {
		const group = m.t.sharedKey ? [m, ...this.sharedPeers(m)] : [m];
		for (const x of group) await x.verifyKey(current);
		for (const x of group) await x.changeMasterKey(current, next);
	}

	requestUnlock(m: SyncManager) {
		if (!this.unlockQueue.includes(m)) this.unlockQueue.push(m);
		this.nextUnlock();
	}

	openUnlock(m?: SyncManager) {
		const target = m ?? this.managers.find((x) => x.status === 'locked');
		if (!target) return;
		this.unlockQueue = [target, ...this.unlockQueue.filter((x) => x !== target)];
		this.nextUnlock();
	}

	private nextUnlock() {
		if (this.unlockOpen) return;
		const m = this.unlockQueue.find((x) => x.status === 'locked');
		this.unlockQueue = this.unlockQueue.filter((x) => x.status === 'locked' && x !== m);
		if (!m) return;
		this.unlockOpen = true;
		const others = m.t.sharedKey ? this.managers.filter((o) => o !== m && o.status === 'locked' && o.t.sharedKey) : [];
		new UnlockModal(this.app, this, m, others, () => {
			this.unlockOpen = false;
			window.setTimeout(() => this.nextUnlock(), 50);
		}).open();
	}

	// ------------------------------------------------------------ remote commands and legacy link files

	/** Link files of older versions (code sealed with a PIN, containing account access). */
	async removeHandoff() {
		for (const p of [`${this.plugin.stateDir}/${HANDOFF_FILE}`, `${this.pluginDir}/${HANDOFF_FILE}`]) {
			try {
				if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
			} catch {
				/* ignore */
			}
		}
	}

	private executing = false;

	/**
	 * Another device asked this one to disconnect (from one service) or to disconnect from every
	 * service and erase the local copy of the vault. Sync stops everywhere before anything is deleted,
	 * so the deletion never reaches the cloud.
	 */
	async runCommand(from: SyncManager, c: DeviceCommand) {
		if (this.executing) return;
		this.executing = true;
		try {
			from.addLog('warn', c.action === 'wipe' ? tx('Richiesta di {0}: scollega ed elimina i dati di questo dispositivo.', c.from.name) : tx('Richiesta di {0}: scollega questo dispositivo.', c.from.name));
			if (c.action === 'disconnect') {
				await from.commandDone(c);
				await this.remove(from);
				new Notice(tx('Ambraia: {0} è stato scollegato da questo dispositivo su richiesta di “{1}”. Le note locali non sono state toccate.', from.label, c.from.name), 0);
				return;
			}
			for (const m of this.managers) m.stop('off');
			await this.idle();
			await from.commandDone(c);
			for (const m of [...this.managers]) await this.remove(m);
			await this.plugin.wipeLocalData();
			resetDeviceId(this.app);
			new Notice(tx('Ambraia: su richiesta di “{0}” questo dispositivo è stato scollegato e i dati del vault sono stati eliminati.', c.from.name), 0);
		} finally {
			this.executing = false;
		}
	}

	/** Service of a link code that this device knows but has not connected yet. */
	findUnlinked(provider: ProviderId, folder?: string) {
		const f = cleanPath(folder ?? '');
		return this.managers.find((m) => !m.connected && m.t.provider === provider && (!f || m.folder === f)) ?? null;
	}

	// ------------------------------------------------------------ status

	get status(): SyncStatus {
		let best: SyncStatus = 'off';
		for (const m of this.managers) if (PRIORITY.indexOf(m.status) < PRIORITY.indexOf(best)) best = m.status;
		return best;
	}

	get log(): LogEntry[] {
		const many = this.managers.length > 1;
		return this.managers.flatMap((m) => (many ? m.log.map((l) => ({ ...l, msg: `[${m.label}] ${l.msg}` })) : m.log)).sort((a, b) => a.time - b.time);
	}

	statusText(): { icon: string; text: string; tip: string } {
		const list = this.managers.filter((m) => m.connected || m.t.enabled);
		if (!list.length) return { icon: 'cloud-off', text: '', tip: tx('Sincronizzazione disattivata – clic per configurare') };
		const st = this.status;
		const main = list.find((m) => m.status === st) ?? list[0];
		const own = main.statusText();
		if (list.length === 1) return own;
		const pending = list.reduce((n, m) => Math.max(n, m.pendingCount), 0);
		const tip = list.map((m) => `${m.label}: ${m.statusText().tip}`).join('\n');
		return { icon: own.icon, text: pending ? String(pending) : '', tip };
	}

	renderStatus() {
		const el = this.statusEl;
		if (!el) return;
		// one indicator per sync that is really in use:
		// - Ambraia configured, Obsidian Sync not linked → only Ambraia's icon (Obsidian's idle icon is hidden)
		// - Ambraia not configured → only Obsidian's icon
		// - both really in use → both icons
		const ours = this.settings.syncTargets.length > 0;
		const native = obsidianSyncActive(this.app);
		el.toggleClass('ambraia-hidden', !this.settings.syncStatusBar || !ours);
		document.body.toggleClass('ambraia-hide-native-sync', ours && !native);
		const { icon, text, tip } = this.statusText();
		el.empty();
		const ic = el.createSpan({ cls: 'ambraia-sync-icon' });
		setIcon(ic, icon);
		if (this.status === 'syncing') ic.addClass('ambraia-spin');
		if (text) el.createSpan({ text, cls: 'ambraia-sync-count' });
		el.setAttr('aria-label', tip);
		el.setAttr('data-tooltip-position', 'top');
		el.dataset.status = this.status;
	}

	openMenu(e: MouseEvent) {
		const m = new Menu();
		for (const x of this.managers) {
			const { tip } = x.statusText();
			m.addItem((i) => i.setTitle(this.managers.length > 1 ? `${x.label}: ${tip}` : tip).setIcon('info').setDisabled(true));
		}
		if (!this.managers.length) m.addItem((i) => i.setTitle(this.statusText().tip).setIcon('info').setDisabled(true));
		// service problems that the status line alone does not explain (full cloud, files refused…)
		for (const x of this.managers) {
			const p = x.problem;
			if (p && p.msg !== x.statusText().tip && p.msg !== x.statusDetail) m.addItem((i) => i.setTitle(p.msg).setIcon(p.kind === 'quota' ? 'hard-drive' : 'alert-triangle').setDisabled(true));
		}
		m.addSeparator();
		for (const x of this.managers)
			if (x.status === 'locked') m.addItem((i) => i.setTitle(this.managers.length > 1 ? tx('Sblocca {0}', x.label) : tx('Sblocca con la chiave principale')).setIcon('lock-open').onClick(() => this.openUnlock(x)));
		if (this.connected) {
			m.addItem((i) => i.setTitle(tx('Sincronizza ora')).setIcon('refresh-cw').onClick(() => this.syncNow()));
			if (this.managers.some((x) => x.started)) m.addItem((i) => i.setTitle(tx('Metti in pausa')).setIcon('pause').onClick(() => this.pauseAll()));
			else m.addItem((i) => i.setTitle(tx('Riprendi')).setIcon('play').onClick(() => this.resumeAll()));
		}
		m.addItem((i) => i.setTitle(tx('Registro attività')).setIcon('scroll-text').onClick(() => new LogModal(this.app, this).open()));
		m.addItem((i) => i.setTitle(this.connected ? tx('Impostazioni di sincronizzazione') : tx('Configura la sincronizzazione')).setIcon('settings').onClick(() => this.plugin.openSettings()));
		m.showAtMouseEvent(e);
	}

	/** Settings, themes or plugins arrived from another device: they apply after a reload. */
	offerReload() {
		if (this.reloadNotice) return;
		const n = (this.reloadNotice = new Notice('', 0));
		const box = n.messageEl;
		box.empty();
		box.createDiv({ text: tx('Ambraia: impostazioni o plugin aggiornati da un altro dispositivo. Ricarica Obsidian per applicarli.') });
		const row = box.createDiv({ cls: 'ambraia-auth-actions' });
		row.createEl('button', { cls: 'mod-cta', text: tx('Ricarica ora') }).onclick = (e) => {
			e.stopPropagation();
			const cmds = (this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands;
			if (!cmds?.executeCommandById('app:reload')) window.location.reload();
		};
		row.createEl('button', { text: tx('Più tardi') }).onclick = (e) => {
			e.stopPropagation();
			n.hide();
			this.reloadNotice = null;
		};
	}
}

/** True when Obsidian's own Sync core plugin is enabled and linked to a remote vault. */
export function obsidianSyncActive(app: App): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ip = (app as any).internalPlugins;
		const p = ip?.getEnabledPluginById?.('sync') ?? (ip?.plugins?.sync?.enabled ? ip.plugins.sync.instance : null);
		if (!p) return false;
		// only a plugin linked to a remote vault counts: when that cannot be told, it is treated as not in use
		return typeof p.vaultId === 'string' ? !!p.vaultId : false;
	} catch {
		return false;
	}
}
