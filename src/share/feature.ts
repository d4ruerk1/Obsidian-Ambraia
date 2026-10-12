import { MarkdownView, Menu, Notice, Platform, TAbstractFile, TFile } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { tx } from '../i18n';
import { deviceName } from '../sync/devices';
import { obsidianHttp } from '../sync/manager';
import { openLink, OpenedLink } from './client';
import { mergeEdit, shareableMarkdown, splitFrontmatter } from './content';
import type { RelayHttp } from './relay';
import { LiveServer } from './server';
import { ProfileInput, ShareRecord, ShareStore } from './store';
import { OpenShareModal, ShareModal, SharesModal } from './ui';

/** Ties shared links to the plugin: commands, menus, the encrypted list and the live answers. */
export class SharingFeature {
	readonly store: ShareStore;
	readonly server: LiveServer;
	/** Tests replace the network here. */
	http: RelayHttp = (r) => obsidianHttp({ url: r.url, method: r.method, headers: r.headers, body: r.body }).then((x) => ({ status: x.status, text: x.text }));
	socket: typeof WebSocket | null | undefined = undefined;

	constructor(readonly plugin: AmbraiaPlugin) {
		this.store = new ShareStore({
			app: plugin.app,
			viewerUrl: () => plugin.settings.shareViewerUrl,
			relayUrl: () => plugin.settings.shareRelayUrl,
			deviceName: () => deviceName(plugin.app),
		});
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		this.server = new LiveServer(this.store, {
			read: (p, edit) => this.read(p, edit),
			applyEdit: (p, base, text) => this.applyEdit(p, base, text),
			http: (r) => this.http(r),
			get socket() {
				return self.socket;
			},
		});
		this.store.onChange(() => this.server.refresh());
	}

	get app() {
		return this.plugin.app;
	}

	private note(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile && f.extension === 'md' ? f : null;
	}

	/** Readers get the text without private parts; editors get the body as it is (no properties). */
	private async read(path: string, forEdit: boolean): Promise<string | null> {
		const f = this.note(path);
		if (!f) return null;
		const md = await this.app.vault.read(f);
		return forEdit ? splitFrontmatter(md).body : shareableMarkdown(md);
	}

	/**
	 * A change from an editing profile, made on `base`: merged line by line with what changed in
	 * the note meanwhile (on this device or synced from the others, also edits made offline).
	 */
	async applyEdit(path: string, base: string, text: string): Promise<{ text: string; merged: boolean } | 'conflict' | null> {
		const f = this.note(path);
		if (!f) return null;
		let out: { text: string; merged: boolean } | 'conflict' = 'conflict';
		await this.app.vault.process(f, (md) => {
			const r = mergeEdit(md, base, text);
			if (r === 'conflict') return md;
			out = { text: r.text, merged: r.merged };
			return r.md;
		});
		return out;
	}

	async load() {
		await this.store.load();
		this.plugin.registerEvent(this.app.vault.on('rename', (f, old) => this.store.onRename(old, f.path)));
		this.applyServe();
		// mobile apps are suspended in the background: reconnect when they come back
		this.plugin.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') this.applyServe(true);
		});
	}

	/** Starts or stops answering live links on this device. */
	applyServe(restart = false) {
		if (!this.plugin.settings.shareServe) return this.server.stop();
		if (restart) this.server.stop();
		this.server.start();
	}

	unload() {
		this.server.stop();
	}

	registerCommands() {
		const p = this.plugin;
		p.addCommand({
			id: 'share-note',
			name: tx('Condividi la nota con un link'),
			icon: 'share-2',
			checkCallback: (check) => {
				const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.app.workspace.getActiveFile();
				if (!(f instanceof TFile) || f.extension !== 'md') return false;
				if (!check) this.openShare(f);
				return true;
			},
		});
		p.addCommand({ id: 'share-manage', name: tx('Gestisci i link condivisi'), icon: 'link', callback: () => new SharesModal(this).open() });
		p.addCommand({ id: 'share-open', name: tx('Apri un link condiviso'), icon: 'external-link', callback: () => new OpenShareModal(this.app, this).open() });
	}

	fileMenu(menu: Menu, f: TAbstractFile) {
		if (!(f instanceof TFile) || f.extension !== 'md') return;
		menu.addItem((i) => i.setTitle(tx('Condividi con un link')).setIcon('share-2').setSection('ambraia').onClick(() => this.openShare(f)));
	}

	openShare(f: TFile) {
		if (!this.store.loaded) return void new Notice(tx('Un momento: carico i link condivisi…'));
		new ShareModal(this, f).open();
	}

	async create(f: TFile, o: { expires: number | null; profiles: ProfileInput[] }): Promise<ShareRecord> {
		const r = await this.store.create(f.path, f.basename, o);
		const s = this.plugin.settings;
		if (!s.shareRelayConsent) {
			s.shareRelayConsent = true;
			await this.plugin.saveSettings();
		}
		if (!s.shareServe) new Notice(tx('Questo dispositivo non risponde ai link condivisi (Impostazioni → Ambraia → Condivisione): il link si aprirà solo tramite gli altri tuoi dispositivi.'), 8000);
		else if (Platform.isMobile) new Notice(tx('Sul telefono il link risponde solo mentre Obsidian è aperto in primo piano.'), 6000);
		return r;
	}

	openLink(link: string, password: string, onStatus?: (s: 'deriving' | 'waiting') => void): Promise<OpenedLink> {
		return openLink(link, { password, http: this.http, socket: this.socket, onStatus });
	}

	/** Two-way copy with the encrypted device list of a cloud service (called after each heartbeat). */
	async syncWith(reg: Parameters<ShareStore['syncWith']>[0]) {
		try {
			await this.store.syncWith(reg);
		} catch {
			/* next heartbeat */
		}
	}
}
