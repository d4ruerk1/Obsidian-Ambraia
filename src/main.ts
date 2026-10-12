import {
	ItemView,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownView,
	Menu,
	Notice,
	normalizePath,
	parseYaml,
	Plugin,
	stringifyYaml,
	TAbstractFile,
	TFile,
	TFolder,
	ViewStateResult,
	WorkspaceLeaf,
} from 'obsidian';
import { AI_CHAT_VIEW, AiChatView } from './ai/chatView';
import type { ChatMsg } from './ai/client';
import { editorTarget, pickAction, runAiAction } from './ai/inline';
import { AiManager } from './ai/manager';
import { SAMPLE_PROMPT } from './ai/prompts';
import { AiSetupModal } from './ai/setupModal';
import { CalendarIndex, createPeriodic, dailyConfig, DatedTask, findPeriodic, weeklyConfig } from './calendar/dates';
import { CALENDAR_VIEW, CalendarView } from './calendar/view';
import { moment, Moment } from './ui/util';
import { DbHost, DbRenderer } from './db/view';
import { DbConfig, normalizeConfig, serializeConfig } from './db/model';
import { ImageClickTools } from './editor/imageTools';
import { ReadingSelectionBar, selectionToolbar } from './editor/selectionToolbar';
import { SlashSuggest } from './editor/slash';
import { DEFAULT_SETTINGS, AmbraiaSettings, SyncTarget } from './settings';
import { AmbraiaSettingTab } from './settingsTab';
import { LogModal } from './sync/manager';
import { makeTarget, SyncHub } from './sync/hub';
import { SetupModal } from './sync/setupModal';
import { ExplorerDecorator } from './ui/explorer';
import { NavButtons } from './ui/navButtons';
import { createFromTemplate, insertTemplate, TemplatePicker } from './templates';
import { PageHeaders } from './ui/header';
import { availablePath, folderNoteFor, ownIconFor, sanitizeFileName } from './ui/util';
import { MentionSuggest } from './editor/mentions';
import { linkIconExtension, linkIconPostProcessor } from './editor/linkIcons';
import { ShortcutsModal, shortcutsExtension } from './editor/shortcuts';
import { CanvasTools } from './canvas';
import { dropBackup, legacyDir, migrateState, readBackup, sparse, stateDir } from './storage';
import { ensureFolderFor, PROJECT_SAMPLE } from './ai/local';
import { Maintenance } from './maintenance';
import { compactNoteMenu, orderEditorMenu } from './ui/noteMenu';
import { isRtl, setLanguage, tx } from './i18n';
import { RibbonTools } from './ui/ribbon';
import { watchRemoval } from './lifecycle';
import { PROVIDER_IDS, ProviderId } from './sync/providers';
import { Alg, ALGS } from './sync/crypto';
import { SharingFeature } from './share/feature';

export const DATABASE_VIEW = 'ambraia-database';
export const DB_LANG = 'ambraia';

/** Live database inside a note (```ambraia code block). */
class DbBlock extends MarkdownRenderChild {
	renderer: DbRenderer;
	constructor(
		private plugin: AmbraiaPlugin,
		el: HTMLElement,
		cfg: DbConfig,
		host: DbHost,
	) {
		super(el);
		this.renderer = new DbRenderer(plugin, el, cfg, host);
	}
	onload() {
		this.renderer.render();
		const q = () => this.renderer.schedule();
		const { vault, metadataCache } = this.plugin.app;
		this.registerEvent(vault.on('create', q));
		this.registerEvent(vault.on('delete', q));
		this.registerEvent(vault.on('rename', q));
		this.registerEvent(metadataCache.on('changed', q));
	}
	onunload() {
		this.renderer.destroy();
	}
}

/** A folder opened as a full-page database. */
export class FolderDatabaseView extends ItemView {
	folder = '';
	private renderer: DbRenderer | null = null;
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: AmbraiaPlugin,
	) {
		super(leaf);
	}
	getViewType() {
		return DATABASE_VIEW;
	}
	getDisplayText() {
		return this.folder ? this.folder.split('/').pop()! : this.app.vault.getName();
	}
	getIcon() {
		return 'table';
	}
	getState(): Record<string, unknown> {
		return { folder: this.folder };
	}
	async setState(state: unknown, result: ViewStateResult) {
		const s = (state ?? {}) as { folder?: string };
		this.folder = typeof s.folder === 'string' ? s.folder : '';
		this.draw();
		await super.setState(state, result);
	}
	async onOpen() {
		const q = () => {
			if (this.renderer) this.renderer.schedule();
		};
		this.registerEvent(this.app.vault.on('create', q));
		this.registerEvent(this.app.vault.on('delete', q));
		this.registerEvent(
			this.app.vault.on('rename', (f, old) => {
				if (f instanceof TFolder && old === this.folder) {
					this.folder = f.path;
					this.draw();
				} else q();
			}),
		);
		this.registerEvent(this.app.metadataCache.on('changed', q));
		this.draw();
	}
	async onClose() {
		this.renderer?.destroy();
	}
	draw() {
		this.renderer?.destroy();
		const c = this.contentEl;
		c.empty();
		c.addClass('ambraia-db-page');
		const folder = this.folder;
		const af = folder ? this.app.vault.getAbstractFileByPath(folder) : this.app.vault.getRoot();
		if (!(af instanceof TFolder)) {
			c.createDiv({ cls: 'ambraia-empty', text: tx('La cartella "{0}" non esiste più.', folder) });
			return;
		}
		const saved = this.plugin.settings.folderViews[folder];
		const cfg = normalizeConfig(saved ?? { title: af.isRoot() ? this.app.vault.getName() : af.name }, folder);
		cfg.source = folder || '/';
		const note = folderNoteFor(this.app, af);
		this.renderer = new DbRenderer(this.plugin, c.createDiv('ambraia-db-page-inner'), cfg, {
			contextPath: note?.path ?? '',
			contextFolder: folder,
			stateKey: 'folder:' + folder,
			saveConfig: async (next) => {
				this.plugin.settings.folderViews[folder] = serializeConfig(next);
				await this.plugin.saveSettings();
			},
		});
		this.renderer.render();
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}
}

export default class AmbraiaPlugin extends Plugin {
	settings!: AmbraiaSettings;
	sync!: SyncHub;
	headers!: PageHeaders;
	explorer!: ExplorerDecorator;
	navButtons!: NavButtons;
	private readingBar!: ReadingSelectionBar;
	private imageTools!: ImageClickTools;
	canvas!: CanvasTools;
	ai!: AiManager;
	calendarIndex!: CalendarIndex;
	/** Last focused Markdown editor (the chat inserts answers there). */
	lastMarkdownView: MarkdownView | null = null;
	maintenance!: Maintenance;
	private aiRibbon: HTMLElement | null = null;
	ribbon!: RibbonTools;
	shares!: SharingFeature;

	async onload() {
		await migrateState(this.app, this.manifest.dir);
		await this.loadSettings();
		setLanguage(this.settings.language);
		this.applyBodyClasses();

		// ----- page look
		this.headers = new PageHeaders(this);
		this.headers.load();
		this.navButtons = new NavButtons(this);
		this.explorer = new ExplorerDecorator(this);
		this.explorer.load();

		// ----- Folders opened as databases
		this.registerView(DATABASE_VIEW, (leaf) => new FolderDatabaseView(leaf, this));

		// ----- AI assistant and calendar
		this.ai = new AiManager(this);
		this.ai.load();
		this.calendarIndex = new CalendarIndex(this.app, () => this.settings);
		this.registerView(AI_CHAT_VIEW, (leaf) => new AiChatView(leaf, this));
		this.registerView(CALENDAR_VIEW, (leaf) => new CalendarView(leaf, this));
		// calendar first, the AI right after it (only shown while the AI is on), then the user's shortcuts
		this.addRibbonIcon('calendar-days', tx('Ambraia: calendario'), () => this.activateCalendar());
		this.aiRibbon = this.addRibbonIcon('sparkles', tx('Ambraia AI'), () => this.activateAiChat());
		this.aiRibbon.toggleClass('ambraia-hidden', !this.settings.aiEnabled);
		this.ribbon = new RibbonTools(this);
		this.ribbon.load();
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view instanceof MarkdownView) this.lastMarkdownView = leaf.view;
			}),
		);
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, info) => {
				orderEditorMenu(menu);
				if (!this.settings.aiEnabled || !this.ai.ready) return;
				menu.addItem((i) =>
					i
						.setTitle(editor.somethingSelected() ? tx('Ambraia AI: azioni sulla selezione') : tx('Ambraia AI: azioni sulla nota'))
						.setIcon('sparkles')
						.setSection('ambraia')
						.onClick(() => void this.aiOnEditor(editor, info.file ?? null)),
				);
				if (editor.somethingSelected())
					menu.addItem((i) =>
						i
							.setTitle(tx('Ambraia AI: aggiungi la selezione alla chat'))
							.setIcon('message-square-plus')
							.setSection('ambraia')
							.onClick(() => void this.addSelectionToChat(editor.getSelection(), info.file?.basename ?? 'nota')),
					);
			}),
		);

		// ----- Editor tools
		this.registerEditorSuggest(new SlashSuggest(this));
		this.registerEditorSuggest(new MentionSuggest(this));
		this.registerEditorExtension([selectionToolbar(this), linkIconExtension(this), shortcutsExtension(this)]);
		this.registerMarkdownPostProcessor(linkIconPostProcessor(this));
		this.readingBar = new ReadingSelectionBar(this);
		this.readingBar.load();
		this.imageTools = new ImageClickTools(this);
		this.imageTools.load();
		this.canvas = new CanvasTools(this);
		this.canvas.load();

		// ----- Databases
		this.registerMarkdownCodeBlockProcessor(DB_LANG, (src, el, ctx) => this.renderDbBlock(src, el, ctx));

		// ----- Folder notes: clicking a folder opens its note
		this.registerDomEvent(document, 'click', (e) => this.onExplorerClick(e), { capture: true });
		this.registerEvent(this.app.vault.on('rename', (f, old) => this.onRename(f, old)));
		this.registerEvent(this.app.workspace.on('file-menu', (menu, f, source) => this.fileMenu(menu, f, source)));

		// ----- cloud sync
		this.sync = new SyncHub(this.app, this);
		const statusEl = this.addStatusBarItem();

		this.shares = new SharingFeature(this);
		this.addSettingTab(new AmbraiaSettingTab(this.app, this));
		this.registerCommands();
		this.shares.registerCommands();
		this.maintenance = new Maintenance(this);

		this.app.workspace.onLayoutReady(async () => {
			// started after layout-ready so the initial vault indexing is not mistaken for edits
			await this.sync.init(statusEl);
			await this.shares.load();
			this.maintenance.schedule();
			watchRemoval(this);
			// the separate navigator of 1.x is now part of the file explorer: close its old panel
			this.app.workspace.detachLeavesOfType('ambraia-navigator');
			// a chat panel restored from the saved layout while the AI is off would leave its icon in the sidebar
			if (!this.settings.aiEnabled) this.app.workspace.detachLeavesOfType(AI_CHAT_VIEW);
			if (this.settings.calendarOnStart && !this.app.workspace.getLeavesOfType(CALENDAR_VIEW).length) await this.activateCalendar(false);
			const md = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (md) this.lastMarkdownView = md;
		});
	}

	/**
	 * Restores what Ambraia changed in Obsidian before it is removed. `wipe` also deletes the
	 * device data (state folder, AI index, settings copy, keychain entries). Notes are never touched.
	 * Returns problems worth telling the user (empty when everything went fine).
	 */
	async beforeUninstall(wipe: boolean): Promise<string[]> {
		const problems: string[] = [];
		try {
			if (this.sync?.connected) await this.sync.syncNow();
		} catch {
			problems.push(tx('Ultime modifiche non inviate (offline): le note su questo dispositivo sono comunque complete.'));
		}
		// this device disappears from the list shown on the other devices
		for (const m of this.sync?.managers ?? []) await m.leaveRegistry().catch(() => undefined);
		// explorer toolbar and theme classes are restored right away
		this.navButtons?.unload();
		document.body.removeClasses(this.bodyClasses());
		if (wipe) {
			try {
				const a = this.app.vault.adapter;
				if (await a.exists(this.stateDir)) await a.rmdir(this.stateDir, true);
				if (await a.exists(legacyDir(this.app))) await a.rmdir(legacyDir(this.app), true);
			} catch {
				problems.push(tx('Alcuni file tecnici in {0} non sono stati eliminati: puoi cancellarli a mano.', this.stateDir));
			}
			try {
				const ss = this.app.secretStorage;
				for (const id of ss.listSecrets()) if (id.startsWith('ambraia-')) ss.setSecret(id, '');
			} catch {
				/* keychain not available */
			}
			try {
				for (const k of ['ambraia-device-id', 'ambraia-device-name', 'ambraia-calendar-tips', 'ambraia-maintenance-at', 'ambraia-recent-templates']) this.app.saveLocalStorage(k, null);
			} catch {
				/* ignore */
			}
		}
		return problems;
	}

	onunload() {
		this.shares?.unload();
		this.headers?.unload();
		this.explorer?.unload();
		this.canvas?.unload();
		this.readingBar?.unload();
		this.imageTools?.unload();
		this.ribbon?.unload();
		this.ai?.unload();
		document.body.removeClasses(this.bodyClasses());
		void this.sync?.unload();
	}

	// ------------------------------------------------------------------ settings

	/** Folder with the device state that survives updates (see storage.ts). */
	get stateDir() {
		return stateDir(this.app);
	}

	async loadSettings(persist = true) {
		let stored = (await this.loadData()) as Partial<AmbraiaSettings> | null;
		let restored = false;
		if (!stored || typeof stored !== 'object') {
			// plugin folder replaced by an update: settings come back from the backup
			stored = (await readBackup(this.app));
			restored = !!stored;
		}
		const data = (stored ?? {});
		this.settings = { ...DEFAULT_SETTINGS, ...data };
		for (const k of Object.keys(this.settings)) if (!(k in DEFAULT_SETTINGS) && k !== 'aiKeysFallback' && k !== 'credentialsFallback' && !k.startsWith('sync')) delete (this.settings as unknown as Record<string, unknown>)[k];
		// defensive copies of nested defaults
		this.settings.pinned = Array.isArray(data.pinned) ? data.pinned : [];
		this.settings.spaces = Array.isArray(data.spaces) ? data.spaces : [];
		this.settings.expanded = Array.isArray(data.expanded) ? data.expanded : [];
		this.settings.ribbonCustom = Array.isArray(data.ribbonCustom) ? data.ribbonCustom.filter((c) => c && typeof c.command === 'string' && typeof c.id === 'string').map((c) => ({ ...c, icon: c.icon || 'terminal-square', label: c.label || c.command })) : [];
		this.settings.icons = data.icons && typeof data.icons === 'object' ? data.icons : {};
		this.settings.folderViews = data.folderViews && typeof data.folderViews === 'object' ? data.folderViews : {};
		const obj = <T,>(v: T | undefined): T => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : ({} as T));
		// shared links: only https addresses (the viewer and the relay must not be downgraded)
		const https = (v: unknown, d: string) => (typeof v === 'string' && /^https:\/\/[^\s#]+$/i.test(v.trim()) ? v.trim() : d);
		this.settings.shareViewerUrl = https(data.shareViewerUrl, DEFAULT_SETTINGS.shareViewerUrl);
		this.settings.shareRelayUrl = https(data.shareRelayUrl, DEFAULT_SETTINGS.shareRelayUrl).replace(/\/+$/, '');
		this.settings.aiModels = Array.isArray(data.aiModels) ? data.aiModels.filter((m) => m && typeof m.model === 'string').map((m) => ({ ...m })) : [];
		this.settings.aiProviderUrls = obj(data.aiProviderUrls);
		// security: legacy plaintext secrets are moved to the OS secret storage
		const legacyKeys = obj(data.aiKeysFallback);
		const legacyCreds = (data as { credentialsFallback?: string }).credentialsFallback;
		let migrated = false;
		try {
			for (const [k, v] of Object.entries(legacyKeys)) if (v && !this.app.secretStorage.getSecret('ambraia-ai-' + k)) this.app.secretStorage.setSecret('ambraia-ai-' + k, v);
			if (legacyCreds && !this.app.secretStorage.getSecret('ambraia-google-drive')) this.app.secretStorage.setSecret('ambraia-google-drive', legacyCreds);
			migrated = Object.keys(legacyKeys).length > 0 || !!legacyCreds;
		} catch {
			/* secret storage unavailable: drop them anyway */
		}
		delete this.settings.aiKeysFallback;
		delete (this.settings as { credentialsFallback?: string }).credentialsFallback;
		if (this.settings.syncKdf !== 'pbkdf2') this.settings.syncKdf = 'argon2id';
		// a font option of 1.x/2.x is now "Standard" (system fonts only)
		if (!['standard', 'obsidian', 'serif', 'mono'].includes(this.settings.font)) this.settings.font = 'standard';
		delete (this.settings as unknown as Record<string, unknown>).showProperties;
		if (this.migrateSyncTargets(data)) migrated = true;
		if (persist && (restored || migrated || (data as Record<string, unknown>).aiKeysFallback || legacyCreds)) await this.saveSettings();
		if (persist) await dropBackup(this.app);
		this.settings.aiEmbedding = data.aiEmbedding && typeof data.aiEmbedding.model === 'string' ? { ...data.aiEmbedding } : null;
		if (!['chat', 'vault', 'agent'].includes(this.settings.aiDefaultMode)) this.settings.aiDefaultMode = 'chat';
		if (!['ask', 'auto', 'never'].includes(this.settings.aiWrites)) this.settings.aiWrites = 'ask';
	}

	/** Up to 1.4 a vault had a single cloud service in flat settings: it becomes the service "main". */
	private migrateSyncTargets(data: Record<string, unknown>): boolean {
		const legacy = ['syncEnabled', 'vaultKey', 'syncProvider', 'syncFolder', 'syncEncrypt', 'syncAlg', 'syncEncryptNames', 'syncRememberKey'];
		const s = this.settings as unknown as Record<string, unknown>;
		const ok = (t: Partial<SyncTarget> | null): t is SyncTarget => !!t && typeof t.id === 'string' && PROVIDER_IDS.includes(t.provider as ProviderId);
		let changed = false;
		if (Array.isArray(data.syncTargets)) {
			this.settings.syncTargets = (data.syncTargets as SyncTarget[]).filter(ok).map((t) => ({ ...makeTarget(t.provider, '', t.id), ...t, alg: ALGS.includes(t.alg) ? t.alg : 'aes-gcm' }));
		} else {
			this.settings.syncTargets = [];
			let hasCreds = false;
			try {
				hasCreds = !!(this.app.secretStorage.getSecret('ambraia-sync') || this.app.secretStorage.getSecret('ambraia-google-drive'));
			} catch {
				/* no secret storage */
			}
			if (hasCreds || data.syncEnabled || data.syncFolder || data.vaultKey) {
				const provider = PROVIDER_IDS.includes(data.syncProvider as ProviderId) ? (data.syncProvider as ProviderId) : 'gdrive';
				// before 1.3 the Drive folder was the vault key (or the vault name)
				const folder = typeof data.syncFolder === 'string' ? data.syncFolder : data.syncEnabled || data.vaultKey ? (typeof data.vaultKey === 'string' && data.vaultKey ? data.vaultKey : this.app.vault.getName()).trim() : '';
				const t = makeTarget(provider, folder, 'main');
				t.enabled = !!data.syncEnabled;
				t.encrypt = !!data.syncEncrypt;
				t.alg = ALGS.includes(data.syncAlg as Alg) ? (data.syncAlg as Alg) : 'aes-gcm';
				t.names = data.syncEncryptNames !== false;
				t.remember = data.syncRememberKey !== false;
				this.settings.syncTargets.push(t);
				changed = true;
			}
		}
		for (const k of legacy) {
			if (k in s) changed = true;
			delete s[k];
		}
		return changed;
	}

	/** data.json changed on another device (synced): apply it, but keep this device's sync switches. */
	async onExternalSettingsChange() {
		const cur = this.settings;
		const keep = Object.fromEntries(Object.entries(cur).filter(([k]) => k.startsWith('sync')));
		const lang = cur.language;
		await this.loadSettings(false);
		const fresh = this.settings;
		this.settings = Object.assign(cur, fresh, keep);
		if (this.settings.language !== lang) setLanguage(this.settings.language);
		this.applyBodyClasses();
		this.refreshDecorations();
		this.sync.settingsChanged();
	}

	/** What is written to disk: only the values that differ from the defaults. */
	stored(): Partial<AmbraiaSettings> {
		return sparse(this.settings, DEFAULT_SETTINGS);
	}

	async saveSettings() {
		const data = this.stored();
		await this.saveData(data);
		this.applyBodyClasses();
	}

	/** Back to the defaults, keeping cloud services, favourites, spaces, icons and saved views. */
	async resetSettings() {
		const s = this.settings;
		const keep: Partial<AmbraiaSettings> = {
			syncTargets: s.syncTargets,
			pinned: s.pinned,
			spaces: s.spaces,
			icons: s.icons,
			folderViews: s.folderViews,
			aiModels: s.aiModels,
			aiChatModel: s.aiChatModel,
			aiEmbedding: s.aiEmbedding,
			aiProviderUrls: s.aiProviderUrls,
			maintenanceVersion: s.maintenanceVersion,
		};
		this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...keep };
		setLanguage(this.settings.language);
		await this.saveSettings();
		this.refreshDecorations();
		this.sync.settingsChanged();
	}

	/** Vault opened on a new device (e.g. a copied folder): sign in here, then link with a one-time code. */
	async offerLink() {
		const n = new Notice('', 0);
		const box = n.messageEl;
		box.empty();
		box.createDiv({ text: tx('Ambraia: la sincronizzazione non è ancora collegata su questo dispositivo.') });
		const b = box.createEl('button', { cls: 'mod-cta', text: tx('Collega') });
		b.onclick = (e) => {
			e.stopPropagation();
			n.hide();
			const unlinked = this.sync.managers.find((x) => !x.connected && x.t.enabled);
			new SetupModal(this.app, this, unlinked ?? undefined, unlinked ? 'pair' : 'new').open();
		};
	}

	/**
	 * Remote "disconnect and erase" (see SyncHub.runCommand): every service is already stopped and
	 * forgotten. Deletes the notes of this vault on this device, the device state, Ambraia's secrets
	 * and settings. Obsidian's own configuration folder is kept so the app still opens.
	 */
	async wipeLocalData() {
		const vault = this.app.vault;
		const a = vault.adapter;
		const cfg = vault.configDir;
		// files are removed through the adapter: a remote erase must not leave copies in the trash
		try {
			const { files, folders } = await a.list('/');
			for (const d of folders) {
				const name = d.replace(/^\/+/, '');
				if (name && name !== cfg) await a.rmdir(name, true).catch(() => undefined);
			}
			for (const f of files) await a.remove(f.replace(/^\/+/, '')).catch(() => undefined);
		} catch {
			/* listing not available */
		}
		try {
			if (await a.exists(this.stateDir)) await a.rmdir(this.stateDir, true);
		} catch {
			/* ignore */
		}
		try {
			const ss = this.app.secretStorage;
			for (const id of ss.listSecrets()) if (id.startsWith('ambraia-')) ss.setSecret(id, '');
		} catch {
			/* ignore */
		}
		this.settings = { ...structuredClone(DEFAULT_SETTINGS) };
		await this.saveSettings();
		this.refreshDecorations();
	}

	openSettings() {
		const s = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		s?.open();
		s?.openTabById(this.manifest.id);
	}

	private bodyClasses(): string[] {
		return [
			'ambraia-theme',
			'ambraia-font-standard',
			'ambraia-font-serif',
			'ambraia-font-mono',
			'ambraia-width-wide',
			'ambraia-width-full',
			'ambraia-minimal',
			'ambraia-folder-notes',
			'ambraia-hide-props',
			'ambraia-link-icons',
			'ambraia-rtl',
		];
	}

	applyBodyClasses() {
		const s = this.settings;
		const b = document.body;
		b.removeClasses(this.bodyClasses());
		if (s.notionTheme) b.addClass('ambraia-theme');
		if (s.font !== 'obsidian') b.addClass(`ambraia-font-${s.font}`);
		if (s.contentWidth !== 'normal') b.addClass(`ambraia-width-${s.contentWidth}`);
		if (s.minimalUI) b.addClass('ambraia-minimal');
		if (s.folderNotes) b.addClass('ambraia-folder-notes');
		// properties are hidden inside notes with CSS only (Obsidian's own settings are not changed)
		if (s.hideProperties) b.addClass('ambraia-hide-props');
		this.aiRibbon?.toggleClass('ambraia-hidden', !s.aiEnabled);
		if (s.linkIcons) b.addClass('ambraia-link-icons');
		this.sync?.renderStatus();
		if (isRtl()) b.addClass('ambraia-rtl');
		b.style.setProperty('--ambraia-banner-height', `${s.bannerHeight}px`);
	}

	/** Re-render icons/headers everywhere (after an icon or setting changes). */
	refreshDecorations() {
		this.headers?.refreshAll();
		this.explorer?.schedule();
		this.app.workspace.updateOptions();
		this.refreshCalendars();
	}

	// ------------------------------------------------------------------ views

	async openFolderDatabase(folder: string) {
		const path = folder === '/' ? '' : folder;
		const existing = this.app.workspace.getLeavesOfType(DATABASE_VIEW).find((l) => (l.view as FolderDatabaseView).folder === path);
		const leaf = existing ?? this.app.workspace.getLeaf('tab');
		if (!existing) await leaf.setViewState({ type: DATABASE_VIEW, active: true, state: { folder: path } });
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Opens a file; `line` (0-based) scrolls to and selects that line. */
	async openFile(file: TFile, mode: false | 'tab' = false, line?: number) {
		const leaf = this.app.workspace.getLeaf(mode);
		await leaf.openFile(file, line !== undefined ? { eState: { line } } : undefined);
		if (line !== undefined && leaf.view instanceof MarkdownView) {
			const ed = leaf.view.editor;
			const pos = { line, ch: 0 };
			ed.setCursor(pos);
			ed.scrollIntoView({ from: pos, to: pos }, true);
		}
	}

	/** Opens (and if needed creates) the daily or weekly note of a date. Returns the file or null. */
	async openPeriodic(kind: 'day' | 'week', m: Moment, mode: false | 'tab' = false, create = true): Promise<TFile | null> {
		const cfg = kind === 'day' ? dailyConfig(this.app, this.settings) : weeklyConfig(this.settings);
		let f = findPeriodic(this.app, cfg, m);
		if (!f && !create) {
			new Notice(tx('Non esiste una nota per {0}.', m.format(kind === 'day' ? tx('D MMMM YYYY') : tx('[settimana] w, gggg'))));
			return null;
		}
		if (!f) {
			try {
				f = await createPeriodic(this.app, cfg, m);
			} catch (e) {
				new Notice(tx('Impossibile creare la nota: ') + (e instanceof Error ? e.message : String(e)));
				return null;
			}
		}
		await this.openFile(f, mode);
		return f;
	}

	/** Daily note before/after the active one (skips missing days, like the core command). */
	private async stepDaily(dir: 1 | -1) {
		const cfg = dailyConfig(this.app, this.settings);
		const act = this.app.workspace.getActiveFile();
		const { dateFromPath } = await import('./calendar/dates');
		const cur = act ? dateFromPath(cfg, act.path) : null;
		const base = cur ?? moment();
		const dated = this.app.vault
			.getMarkdownFiles()
			.map((f) => ({ f, d: dateFromPath(cfg, f.path) }))
			.filter((x): x is { f: TFile; d: Moment } => !!x.d && (dir > 0 ? x.d.isAfter(base, 'day') : x.d.isBefore(base, 'day')))
			.sort((a, b) => (dir > 0 ? a.d.valueOf() - b.d.valueOf() : b.d.valueOf() - a.d.valueOf()));
		if (!dated.length) return new Notice(dir > 0 ? tx('Nessuna nota del giorno successiva.') : tx('Nessuna nota del giorno precedente.'));
		await this.openFile(dated[0].f);
	}

	async tasksOn(day: string): Promise<DatedTask[]> {
		const d = moment(day, 'YYYY-MM-DD');
		const map = await this.calendarIndex.build(d.clone(), d.clone(), { tasks: true });
		return map.get(day)?.tasks ?? [];
	}

	async activateCalendar(reveal = true) {
		const ws = this.app.workspace;
		let leaf = ws.getLeavesOfType(CALENDAR_VIEW)[0];
		if (!leaf) {
			const l = ws.getRightLeaf(false);
			if (!l) return;
			leaf = l;
			await leaf.setViewState({ type: CALENDAR_VIEW, active: reveal });
		}
		if (reveal) await ws.revealLeaf(leaf);
	}

	async activateAiChat(): Promise<AiChatView | null> {
		const ws = this.app.workspace;
		if (!this.settings.aiEnabled) {
			this.openAiSetup();
			return null;
		}
		let leaf = ws.getLeavesOfType(AI_CHAT_VIEW)[0];
		if (!leaf) {
			const l = ws.getRightLeaf(false);
			if (!l) return null;
			leaf = l;
			await leaf.setViewState({ type: AI_CHAT_VIEW, active: true });
		}
		await ws.revealLeaf(leaf);
		const v = leaf.view instanceof AiChatView ? leaf.view : null;
		v?.focusInput();
		return v;
	}

	openAiSetup(providerId?: string) {
		new AiSetupModal(this, undefined, providerId).open();
	}

	refreshCalendars() {
		this.calendarIndex.invalidate();
		for (const l of this.app.workspace.getLeavesOfType(CALENDAR_VIEW)) if (l.view instanceof CalendarView) l.view.schedule(0);
	}

	/** Redraws chat views after models/settings change. */
	refreshAiViews() {
		// AI off: no chat panel (and no sidebar tab icon) left behind
		if (!this.settings.aiEnabled) {
			this.app.workspace.detachLeavesOfType(AI_CHAT_VIEW);
			this.aiRibbon?.toggleClass('ambraia-hidden', true);
			return;
		}
		this.aiRibbon?.toggleClass('ambraia-hidden', false);
		for (const l of this.app.workspace.getLeavesOfType(AI_CHAT_VIEW)) if (l.view instanceof AiChatView) l.view.refresh();
	}

	async addSelectionToChat(text: string, source: string) {
		const v = await this.activateAiChat();
		v?.addSelection(text, source);
	}

	/** Continues an inline action as a chat conversation. */
	async continueInChat(history: ChatMsg[], answer: string) {
		const v = await this.activateAiChat();
		if (!v) return;
		v.newChat();
		for (const m of history) if (m.role === 'user' || m.role === 'assistant') v.entries.push({ role: m.role, content: m.content, display: m.content.length > 400 ? m.content.slice(0, 400) + '…' : m.content });
		v.entries.push({ role: 'assistant', content: answer });
		v.renderList();
	}

	async askAiAboutDay(day: string) {
		const v = await this.activateAiChat();
		if (!v) return;
		const d = moment(day, 'YYYY-MM-DD');
		// Collect the day's material directly, so this works with every model (also without tool support).
		const info = (await this.calendarIndex.build(d.clone(), d.clone(), { tasks: true })).get(day);
		const parts: string[] = [];
		if (info?.daily) parts.push(tx('<nota titolo="{0}" tipo="nota del giorno">\n{1}\n</nota>', info.daily.basename, (await this.app.vault.cachedRead(info.daily)).slice(0, 8000)));
		if (info?.tasks.length) parts.push(tx('Attività con data ') + day + ':\n' + info.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text} (in [[${t.file.basename}]])`).join('\n'));
		if (info?.pages.length) parts.push(tx('Pagine con questa data: ') + info.pages.map((p) => `[[${p.basename}]]`).join(', '));
		const ask = tx('Fammi un riepilogo di {0}: nota del giorno, attività in scadenza e pagine collegate a quella data. Suggerisci cosa fare.', d.format(tx('dddd D MMMM YYYY')));
		const ctx = parts.length ? parts.join('\n\n') : tx('Per questo giorno non ci sono note, attività né pagine con data.');
		await v.send(ask, { content: tx('Materiale del giorno {0}:\n\n{1}\n\n---\n\n{2}', day, ctx, ask) });
	}

	/** AI quick actions on the editor selection (or the whole note when nothing is selected). */
	async aiOnEditor(editor: import('obsidian').Editor, file: TFile | null) {
		if (!this.ai.ready) return this.openAiSetup();
		const target = editorTarget(editor);
		const a = await pickAction(this);
		if (a) await runAiAction(this, a, target, file);
	}

	async createSamplePrompt() {
		const folder = this.settings.aiPromptsFolder || 'Ambraia/Prompt';
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => undefined);
		const f = await this.app.vault.create(availablePath(this.app, folder, tx('Nuovo prompt'), 'md'), SAMPLE_PROMPT);
		await this.openFile(f, 'tab');
	}

	/** Creates a project note for the AI chat and opens it. */
	async createProject(): Promise<TFile> {
		const folder = normalizePath(this.settings.aiProjectsFolder || 'Ambraia/Progetti');
		await ensureFolderFor(this.app, folder + '/x.md');
		const f = await this.app.vault.create(availablePath(this.app, folder, tx('Nuovo progetto'), 'md'), PROJECT_SAMPLE);
		await this.openFile(f, 'tab');
		return f;
	}

	async openMemory() {
		const p = normalizePath(this.settings.aiMemoryFile || 'Ambraia/Memoria.md');
		let f = this.app.vault.getAbstractFileByPath(p);
		if (!(f instanceof TFile)) {
			await ensureFolderFor(this.app, p);
			f = await this.app.vault.create(p, '# Memoria di Ambraia AI\n\nCose da ricordare tra una chat e l’altra. Puoi modificare o cancellare liberamente.\n\n');
		}
		if (f instanceof TFile) await this.openFile(f, 'tab');
	}

	// ------------------------------------------------------------------ databases in notes

	private renderDbBlock(src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		let raw: unknown;
		try {
			raw = src.trim() ? parseYaml(src) : {};
		} catch (e) {
			el.createDiv({ cls: 'ambraia-db-error', text: tx('Configurazione del database non valida: {0}', (e as Error).message) });
			return;
		}
		const cfg = normalizeConfig(raw);
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		const parent = file?.parent;
		const contextFolder = !parent || parent.isRoot() ? '' : parent.path;
		const info = ctx.getSectionInfo(el);
		const host: DbHost = {
			contextPath: ctx.sourcePath,
			contextFolder,
			stateKey: `${ctx.sourcePath}#${info?.lineStart ?? 0}`,
			saveConfig: (next) => this.writeDbBlock(ctx, el, next),
		};
		ctx.addChild(new DbBlock(this, el, cfg, host));
	}

	private async writeDbBlock(ctx: MarkdownPostProcessorContext, el: HTMLElement, cfg: DbConfig) {
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		const info = ctx.getSectionInfo(el);
		if (!(file instanceof TFile) || !info) {
			new Notice(tx('Impossibile salvare la vista: apri la nota che contiene il database.'));
			return;
		}
		const yaml = stringifyYaml(serializeConfig(cfg)).trimEnd();
		let ok = false;
		await this.app.vault.process(file, (data) => {
			const nl = data.includes('\r\n') ? '\r\n' : '\n';
			const lines = data.split(/\r?\n/);
			const open = lines[info.lineStart] ?? '';
			const close = lines[info.lineEnd] ?? '';
			if (!/^\s*(```+|~~~+)\s*ambraia\b/.test(open) || !/^\s*(```+|~~~+)\s*$/.test(close)) return data;
			ok = true;
			lines.splice(info.lineStart + 1, info.lineEnd - info.lineStart - 1, ...yaml.split('\n'));
			return lines.join(nl);
		});
		if (!ok) new Notice(tx('Il blocco del database è cambiato nel frattempo: modifica non salvata.'));
	}

	async insertDatabase(editor: { replaceSelection(s: string): void }, view = 'table') {
		editor.replaceSelection('```ambraia\nsource: this\nview: ' + view + '\n```\n');
	}

	// ------------------------------------------------------------------ folder notes

	private onExplorerClick(e: MouseEvent) {
		if (!this.settings.folderNotes || e.button !== 0) return;
		const t = e.target as HTMLElement;
		if (t.closest('.collapse-icon, .ambraia-ex-add')) return; // the arrow just toggles
		const title = t.closest<HTMLElement>('.workspace-leaf-content[data-type="file-explorer"] .nav-folder-title');
		const path = title?.dataset.path;
		if (!path) return;
		const folder = this.app.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) return;
		const note = folderNoteFor(this.app, folder);
		if (!note) return;
		void this.app.workspace.getLeaf(e.ctrlKey || e.metaKey ? 'tab' : false).openFile(note);
	}

	async createFolderNote(folder: TFolder) {
		const existing = folderNoteFor(this.app, folder);
		if (existing) return this.app.workspace.getLeaf(false).openFile(existing);
		const path = `${folder.path}/${folder.name}.md`;
		const f = await this.app.vault.create(path, '```ambraia\nsource: this\nview: table\n```\n');
		await this.app.workspace.getLeaf(false).openFile(f);
		this.refreshDecorations();
	}

	private async onRename(f: TAbstractFile, old: string) {
		const s = this.settings;
		let changed = false;
		const move = (p: string) => (p === old ? f.path : p.startsWith(old + '/') ? f.path + p.slice(old.length) : p);
		// keep icons, pins, spaces and folder views attached to renamed items
		for (const k of Object.keys(s.icons)) {
			const n = move(k);
			if (n !== k) {
				s.icons[n] = s.icons[k];
				delete s.icons[k];
				changed = true;
			}
		}
		for (const k of Object.keys(s.folderViews)) {
			const n = move(k);
			if (n !== k) {
				s.folderViews[n] = s.folderViews[k];
				delete s.folderViews[k];
				changed = true;
			}
		}
		const mapList = (l: string[]) => {
			const n = l.map(move);
			if (n.some((v, i) => v !== l[i])) changed = true;
			return n;
		};
		s.pinned = mapList(s.pinned);
		s.expanded = mapList(s.expanded);
		for (const sp of s.spaces) sp.items = mapList(sp.items);

		// folder renamed -> rename its folder note too (Folder/Folder.md)
		if (s.folderNotes && f instanceof TFolder) {
			const oldName = old.split('/').pop()!;
			const stale = this.app.vault.getAbstractFileByPath(`${f.path}/${oldName}.md`);
			if (stale instanceof TFile && oldName !== f.name && !this.app.vault.getAbstractFileByPath(`${f.path}/${f.name}.md`)) {
				await this.app.fileManager.renameFile(stale, `${f.path}/${f.name}.md`);
			}
		}
		if (changed) await this.saveSettings();
	}

	private fileMenu(menu: Menu, f: TAbstractFile, source = '') {
		// note menu (⋯ top right): only the essential actions
		const noteMenu = source === 'more-options';
		if (noteMenu && this.settings.compactNoteMenu) compactNoteMenu(menu);
		if (f instanceof TFolder) {
			menu.addItem((i) => i.setTitle(tx('Apri come database')).setIcon('table').setSection('ambraia').onClick(() => this.openFolderDatabase(f.path)));
			if (this.settings.folderNotes) {
				const has = !!folderNoteFor(this.app, f);
				menu.addItem((i) =>
					i
						.setTitle(has ? tx('Apri nota della cartella') : tx('Crea nota della cartella'))
						.setIcon('file-text')
						.setSection('ambraia')
						.onClick(() => this.createFolderNote(f)),
				);
			}
		}
		this.shares?.fileMenu(menu, f);
		menu.addItem((i) =>
			i
				.setTitle(tx('Cambia icona'))
				.setIcon('smile')
				.setSection('ambraia')
				.onClick(async () => {
					const { pickIcon } = await import('./ui/pickers');
					const { setIconFor } = await import('./ui/util');
					const v = await pickIcon(this.app, !!ownIconFor(this, f));
					if (v !== undefined) await setIconFor(this, f, v);
				}),
		);
		menu.addItem((i) => {
			const pinned = this.settings.pinned.includes(f.path);
			i.setTitle(pinned ? tx('Rimuovi dai preferiti') : tx('Aggiungi ai preferiti'))
				.setIcon(pinned ? 'star-off' : 'star')
				.setSection('ambraia')
				.onClick(async () => {
					this.settings.pinned = pinned ? this.settings.pinned.filter((p) => p !== f.path) : [...this.settings.pinned, f.path];
					await this.saveSettings();
					this.refreshDecorations();
				});
		});
		// spaces: one "Spaces" entry with a sub-menu (flat list only where sub-menus are unavailable)
		if (noteMenu && !this.settings.spaces.length) return;
		const toggleIn = async (sp: (typeof this.settings.spaces)[number], inside: boolean) => {
			sp.items = inside ? sp.items.filter((p) => p !== f.path) : [...sp.items, f.path];
			await this.saveSettings();
			this.refreshDecorations();
		};
		if (!this.settings.spaces.length) {
			menu.addItem((i) => i.setTitle(tx('Nuovo spazio con questo elemento')).setIcon('layers').setSection('ambraia').onClick(() => void this.explorer.newSpace(f.path)));
			return;
		}
		let sub: Menu | null = null;
		const flat = (i: import('obsidian').MenuItem, sp: (typeof this.settings.spaces)[number]) => {
			const inside = sp.items.includes(f.path);
			i.setTitle(inside ? tx('Rimuovi da “{0}”', sp.name) : tx('Aggiungi a “{0}”', sp.name))
				.setIcon('layers')
				.setSection('ambraia')
				.onClick(() => void toggleIn(sp, inside));
		};
		const [first, ...rest] = this.settings.spaces;
		menu.addItem((i) => {
			const make = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu;
			if (typeof make !== 'function') return flat(i, first);
			i.setTitle(tx('Spazi')).setIcon('layers').setSection('ambraia');
			sub = make.call(i);
		});
		if (!sub) {
			for (const sp of rest) menu.addItem((i) => flat(i, sp));
			return;
		}
		for (const sp of this.settings.spaces) {
			const inside = sp.items.includes(f.path);
			(sub as Menu).addItem((i) => i.setTitle(sp.name).setIcon('layers').setChecked(inside).onClick(() => void toggleIn(sp, inside)));
		}
		(sub as Menu).addItem((i) => i.setTitle(tx('Nuovo spazio con questo elemento')).setIcon('plus').onClick(() => void this.explorer.newSpace(f.path)));
	}

	// ------------------------------------------------------------------ commands

	private registerCommands() {
		this.addCommand({
			id: 'new-page',
			name: tx('Nuova pagina'),
			icon: 'square-pen',
			callback: async () => {
				const parent = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '');
				const path = availablePath(this.app, parent.isRoot() ? '' : parent.path, tx('Senza titolo'), 'md');
				const f = await this.app.vault.create(path, '');
				await this.app.workspace.getLeaf(false).openFile(f, { state: { mode: 'source' }, eState: { rename: 'all' } });
			},
		});
		this.addCommand({
			id: 'new-from-template',
			name: tx('Nuova pagina dalla galleria modelli'),
			icon: 'layout-template',
			callback: () => new TemplatePicker(this, (t) => void createFromTemplate(this, t)).open(),
		});
		this.addCommand({
			id: 'insert-template',
			name: tx('Inserisci un modello nella nota'),
			icon: 'layout-template',
			editorCallback: () => new TemplatePicker(this, (t) => void insertTemplate(this, t), true).open(),
		});
		this.addCommand({ id: 'show-shortcuts', name: tx('Mostra le scorciatoie da tastiera'), icon: 'keyboard', callback: () => new ShortcutsModal(this).open() });
		this.addCommand({
			id: 'link-page',
			name: tx('Collega una pagina'),
			icon: 'file-symlink',
			editorCallback: (editor, ctx) => void this.linkPage(editor, ctx.file ?? null),
		});
		this.addCommand({
			id: 'insert-database',
			name: tx('Inserisci database (tabella)'),
			icon: 'table',
			editorCallback: (editor) => this.insertDatabase(editor),
		});
		this.addCommand({
			id: 'insert-board',
			name: tx('Inserisci database (bacheca)'),
			icon: 'kanban',
			editorCallback: (editor) => this.insertDatabase(editor, 'board'),
		});
		this.addCommand({
			id: 'open-folder-database',
			name: tx('Apri la cartella corrente come database'),
			icon: 'table',
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f) return false;
				if (!checking) void this.openFolderDatabase(f.parent?.path ?? '');
				return true;
			},
		});
		const withFile = (fn: (f: TFile) => unknown) => (checking: boolean) => {
			const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
			if (!f) return false;
			if (!checking) void fn(f);
			return true;
		};
		this.addCommand({ id: 'change-icon', name: tx('Cambia icona della pagina'), icon: 'smile', checkCallback: withFile((f) => this.headers.chooseIcon(f, !!ownIconFor(this, f))) });
		this.addCommand({
			id: 'change-banner',
			name: tx('Cambia copertina della pagina'),
			icon: 'image',
			checkCallback: withFile((f) => {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
				void this.headers.chooseBanner(f, !!(fm[this.settings.bannerKey] ?? fm.banner ?? fm.cover));
			}),
		});
		this.addCommand({ id: 'sync-now', name: tx('Sync: sincronizza ora'), icon: 'refresh-cw', callback: () => this.syncCommand() });
		this.addCommand({
			id: 'sync-pause',
			name: tx('Sync: metti in pausa / riprendi'),
			icon: 'pause',
			checkCallback: (check) => {
				if (!this.sync.connected) return false;
				if (!check) void this.togglePause();
				return true;
			},
		});
		this.addCommand({ id: 'sync-setup', name: tx('Sync: collega un servizio cloud'), icon: 'cloud', callback: () => new SetupModal(this.app, this).open() });
		this.addCommand({ id: 'sync-unlock', name: tx('Sync: sblocca la cifratura'), icon: 'lock-open', checkCallback: (check) => {
			if (this.sync.status !== 'locked') return false;
			if (!check) this.sync.openUnlock();
			return true;
		} });
		this.registerAiCommands();
	}

	private async togglePause() {
		if (this.sync.anyEnabled) {
			await this.sync.pauseAll();
			new Notice(tx('Sincronizzazione in pausa'));
		} else {
			await this.sync.resumeAll();
			new Notice(tx('Sincronizzazione ripresa'));
		}
	}

	private registerAiCommands() {
		// ----- AI (the commands appear only when AI is turned on)
		const on = () => this.settings.aiEnabled;
		const aiCmd = (id: string, name: string, icon: string, run: () => unknown) =>
			this.addCommand({
				id,
				name,
				icon,
				checkCallback: (checking) => {
					if (!on()) return false;
					if (!checking) void run();
					return true;
				},
			});
		const aiEditorCmd = (id: string, name: string, icon: string, run: (editor: import('obsidian').Editor, file: TFile | null) => unknown, needsSelection = false) =>
			this.addCommand({
				id,
				name,
				icon,
				editorCheckCallback: (checking, editor, ctx) => {
					if (!on() || (needsSelection && !editor.somethingSelected())) return false;
					if (!checking) void run(editor, ctx.file ?? null);
					return true;
				},
			});
		aiCmd('ai-open-chat', tx('AI: apri la chat'), 'sparkles', () => this.activateAiChat());
		aiCmd('ai-new-chat', tx('AI: nuova chat'), 'message-square-plus', async () => (await this.activateAiChat())?.newChat());
		aiCmd('ai-setup', tx('AI: configura modello (locale o cloud)'), 'settings-2', () => this.openAiSetup());
		aiEditorCmd('ai-actions', tx('AI: azioni sulla selezione…'), 'wand-2', (editor, file) => this.aiOnEditor(editor, file));
		aiEditorCmd('ai-custom-prompt', tx('AI: esegui un prompt personalizzato…'), 'sparkle', async (editor, file) => {
			if (!this.ai.ready) return this.openAiSetup();
			const a = await pickAction(this, true);
			if (a) await runAiAction(this, a, editorTarget(editor), file);
		});
		aiEditorCmd('ai-add-selection', tx('AI: aggiungi la selezione alla chat'), 'message-square-plus', (editor, file) => this.addSelectionToChat(editor.getSelection(), file?.basename ?? 'nota'), true);
		aiCmd('ai-rebuild-index', tx('AI: ricostruisci l’indice del vault'), 'database-zap', async () => {
			const n = new Notice(tx('Ambraia AI: indicizzazione…'), 0);
			try {
				const msg = await this.ai.rebuildIndex((d, t) => n.setMessage(tx('Ambraia AI: indicizzazione {0}/{1}…', d, t)));
				new Notice(msg);
			} catch (e) {
				new Notice(tx('Indicizzazione non riuscita: ') + (e instanceof Error ? e.message : String(e)));
			} finally {
				n.hide();
			}
		});
		aiCmd('ai-new-project', tx('AI: nuovo progetto'), 'folder-kanban', () => this.createProject());
		aiCmd('ai-open-memory', tx('AI: apri la memoria'), 'brain', () => this.openMemory());

		// ----- Calendar
		this.addCommand({ id: 'calendar-open', name: tx('Calendario: apri'), icon: 'calendar-days', callback: () => this.activateCalendar() });
		this.addCommand({ id: 'daily-today', name: tx('Calendario: nota di oggi'), icon: 'calendar-check', callback: () => this.openPeriodic('day', moment()) });
		this.addCommand({ id: 'daily-prev', name: tx('Calendario: nota del giorno precedente'), icon: 'chevron-left', callback: () => this.stepDaily(-1) });
		this.addCommand({ id: 'daily-next', name: tx('Calendario: nota del giorno successivo'), icon: 'chevron-right', callback: () => this.stepDaily(1) });
		this.addCommand({ id: 'weekly-this', name: tx('Calendario: nota di questa settimana'), icon: 'calendar-range', callback: () => this.openPeriodic('week', moment()) });

		this.addCommand({ id: 'sync-log', name: tx('Sync: registro attività'), icon: 'scroll-text', checkCallback: (check) => {
			if (!this.sync.connected) return false;
			if (!check) new LogModal(this.app, this.sync).open();
			return true;
		} });
		this.canvas.registerCommands();
	}

	/** Page picker that inserts a link (or creates the page): used by the toolbar, "@" and the command. */
	async linkPage(editor: import('obsidian').Editor, file: TFile | null) {
		const { PagePicker } = await import('./editor/mentions');
		const sel = editor.getSelection();
		new PagePicker(this, /^(https?:\/\/|www\.)/i.test(sel.trim()) ? '' : sel.trim(), async (target, typed, url) => {
			if (url) return editor.replaceSelection(`[${sel.trim().replace(/[[\]]/g, '') || url}](${url})`);
			const f = target ?? (await this.createPageNamed(typed, file));
			if (!f) return;
			editor.replaceSelection(this.linkTo(f, file?.path ?? '', sel.trim()));
		}).open();
	}

	/** Creates a page next to the current note (or reuses an existing one with that name). */
	async createPageNamed(name: string, from: TFile | null): Promise<TFile | null> {
		const clean = sanitizeFileName(name);
		if (!clean) return null;
		const existing = this.app.metadataCache.getFirstLinkpathDest(clean, from?.path ?? '');
		if (existing) return existing;
		const folder = this.app.fileManager.getNewFileParent(from?.path ?? '');
		return this.app.vault.create(availablePath(this.app, folder.isRoot() ? '' : folder.path, clean, 'md'), '');
	}

	/** A link in the user's preferred format; `label` keeps the selected text as the link text. */
	linkTo(f: TFile, sourcePath: string, label = ''): string {
		const link = this.app.fileManager.generateMarkdownLink(f, sourcePath);
		if (!label || label === f.basename) return link;
		const wl = /^\[\[([^\]|]+)\]\]$/.exec(link);
		if (wl) return `[[${wl[1]}|${label.replace(/[[\]|]/g, '')}]]`;
		const md = /^\[[^\]]*\](\(.+\))$/.exec(link);
		return md ? `[${label.replace(/[[\]]/g, '')}]${md[1]}` : link;
	}

	private async syncCommand() {
		if (!this.sync.connected) return new SetupModal(this.app, this).open();
		await this.sync.syncNow();
	}
}
