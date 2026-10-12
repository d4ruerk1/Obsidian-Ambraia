import { Menu, Notice, setIcon, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import type AmbraiaPlugin from '../main';
import type { Space } from '../settings';
import { availablePath, displayName, folderNoteFor, getIconFor, ownIconFor, isFolderNote, prompt, renderIcon, sanitizeFileName, setIconFor } from './util';
import { pickIcon } from './pickers';
import { tx } from '../i18n';

interface FileItem {
	file: TAbstractFile;
	selfEl: HTMLElement;
	innerEl: HTMLElement;
}

interface ExplorerView {
	containerEl: HTMLElement;
	fileItems?: Record<string, FileItem>;
	revealInFolder?(f: TAbstractFile): void;
}

/** A group shown above the file tree: favourites or a user space. */
interface Group {
	id: string;
	name: string;
	icon: string;
	lucide: boolean;
	items: string[];
	space?: Space;
}

/**
 * Additions inside Obsidian's own file explorer (no separate sidebar):
 * page icons, hidden folder notes, favourites and spaces above the tree,
 * "+" on folders to add a page, and a "today" button in the explorer toolbar.
 */
export class ExplorerDecorator {
	private timer: number | null = null;
	private collapsed = new Set<string>();
	constructor(private plugin: AmbraiaPlugin) {}

	get app() {
		return this.plugin.app;
	}

	load() {
		const p = this.plugin;
		const q = () => this.schedule();
		p.registerEvent(p.app.metadataCache.on('changed', q));
		p.registerEvent(p.app.metadataCache.on('resolved', q));
		p.registerEvent(p.app.vault.on('rename', q));
		p.registerEvent(p.app.vault.on('create', q));
		p.registerEvent(p.app.vault.on('delete', q));
		p.registerEvent(p.app.workspace.on('layout-change', q));
		p.registerEvent(p.app.workspace.on('file-open', () => this.markActive()));
		p.app.workspace.onLayoutReady(q);
	}

	schedule() {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.decorate();
		}, 120);
	}

	unload() {
		if (this.timer) window.clearTimeout(this.timer);
		const sel = ['.ambraia-explorer-icon', '.ambraia-ex-add', '.ambraia-ex-pins', '.ambraia-ex-today'];
		for (const s of sel) document.querySelectorAll(s).forEach((e) => e.remove());
		this.plugin.navButtons.unload();
		document.querySelectorAll('.ambraia-folder-note-hidden').forEach((e) => e.removeClass('ambraia-folder-note-hidden'));
		document.querySelectorAll('.ambraia-has-folder-note').forEach((e) => e.removeClass('ambraia-has-folder-note'));
	}

	private explorers(): { leaf: WorkspaceLeaf; view: ExplorerView }[] {
		return this.app.workspace.getLeavesOfType('file-explorer').map((leaf) => ({ leaf, view: leaf.view }));
	}

	decorate() {
		const s = this.plugin.settings;
		for (const { view } of this.explorers()) {
			const items = view.fileItems;
			if (items) {
				for (const item of Object.values(items)) {
					if (!item?.selfEl || !item.file) continue;
					const f = item.file;
					let el = item.selfEl.querySelector<HTMLElement>(':scope > .ambraia-explorer-icon');
					const icon = s.explorerIcons ? getIconFor(this.plugin, f) : '';
					if (!icon) el?.remove();
					else if (!el || el.dataset.icon !== icon) {
						el?.remove();
						el = createDiv('ambraia-explorer-icon');
						el.dataset.icon = icon;
						renderIcon(this.app, el, icon, f.path);
						item.selfEl.insertBefore(el, item.innerEl ?? item.selfEl.firstChild);
					}
					const hide = s.folderNotes && isFolderNote(this.app, f);
					item.selfEl.parentElement?.toggleClass('ambraia-folder-note-hidden', hide);
					if (f instanceof TFolder) {
						item.selfEl.toggleClass('ambraia-has-folder-note', s.folderNotes && !!folderNoteFor(this.app, f));
						this.addButton(item.selfEl, f);
					}
				}
			}
			this.plugin.navButtons.apply(view.containerEl);
			this.renderPins(view);
		}
	}

	/** "+" shown on hover: new page inside the folder */
	private addButton(selfEl: HTMLElement, folder: TFolder) {
		if (selfEl.querySelector(':scope > .ambraia-ex-add')) return;
		const b = selfEl.createDiv({ cls: 'ambraia-ex-add clickable-icon', attr: { 'aria-label': tx('Nuova pagina qui') } });
		setIcon(b, 'plus');
		b.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			void this.newPage(folder);
		});
	}

	/** Re-applies the toolbar customisation right away (after a settings change). */
	refreshNav() {
		for (const { view } of this.explorers()) this.plugin.navButtons.apply(view.containerEl);
	}

	async newPage(folder: TFolder, name = tx('Senza titolo')) {
		const path = availablePath(this.app, folder.isRoot() ? '' : folder.path, sanitizeFileName(name), 'md');
		const f = await this.app.vault.create(path, '');
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(f, { state: { mode: 'source' }, eState: { rename: 'all' } });
		for (const { view } of this.explorers()) view.revealInFolder?.(f);
		return f;
	}

	// ------------------------------------------------------------ favourites and spaces

	private groups(): Group[] {
		const s = this.plugin.settings;
		const out: Group[] = [];
		if (s.pinned.length) out.push({ id: 'fav', name: tx('Preferiti'), icon: 'star', lucide: true, items: s.pinned });
		for (const sp of s.spaces) out.push({ id: 'space:' + sp.id, name: sp.name, icon: sp.icon || '📁', lucide: false, items: sp.items, space: sp });
		return out;
	}

	private renderPins(view: ExplorerView) {
		const files = view.containerEl.querySelector<HTMLElement>('.nav-files-container');
		if (!files?.parentElement) return;
		let box = view.containerEl.querySelector<HTMLElement>(':scope .ambraia-ex-pins');
		const groups = this.groups();
		const sig = JSON.stringify([groups.map((g) => [g.id, g.name, g.icon, g.items, g.space?.collapsed]), [...this.collapsed], groups.flatMap((g) => g.items.map((p) => this.iconSig(p)))]);
		if (!groups.length) {
			box?.remove();
			return;
		}
		if (box && box.dataset.sig === sig && box.nextElementSibling === files) return;
		box?.remove();
		box = createDiv('ambraia-ex-pins');
		box.dataset.sig = sig;
		files.parentElement.insertBefore(box, files);
		for (const g of groups) this.renderGroup(box, g);
		this.markActive();
	}

	private iconSig(path: string) {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f ? getIconFor(this.plugin, f) + '|' + f.name : '';
	}

	private renderGroup(box: HTMLElement, g: Group) {
		const sec = box.createDiv('ambraia-ex-group');
		const head = sec.createDiv('ambraia-ex-group-head');
		const collapsed = g.space ? !!g.space.collapsed : this.collapsed.has(g.id);
		head.toggleClass('is-collapsed', collapsed);
		const chev = head.createDiv('ambraia-ex-chevron');
		setIcon(chev, 'chevron-right');
		const ic = head.createDiv('ambraia-ex-group-icon');
		if (g.lucide) setIcon(ic, g.icon);
		else renderIcon(this.app, ic, g.icon);
		head.createDiv({ cls: 'ambraia-ex-group-name', text: g.name });
		head.onclick = async () => {
			if (g.space) {
				g.space.collapsed = !g.space.collapsed;
				await this.plugin.saveSettings();
			} else if (this.collapsed.has(g.id)) this.collapsed.delete(g.id);
			else this.collapsed.add(g.id);
			this.schedule();
		};
		head.oncontextmenu = (e) => {
			e.preventDefault();
			this.groupMenu(g, e);
		};
		this.dropTarget(head, (paths) => this.addTo(g, paths));
		if (collapsed) return;
		const list = sec.createDiv('ambraia-ex-group-items');
		const files = g.items.map((p) => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TAbstractFile => !!f);
		if (!files.length) list.createDiv({ cls: 'ambraia-ex-empty', text: tx('Trascina qui pagine o cartelle') });
		for (const f of files) this.renderItem(list, g, f);
		this.dropTarget(list, (paths) => this.addTo(g, paths));
	}

	private renderItem(list: HTMLElement, g: Group, f: TAbstractFile) {
		const note = f instanceof TFolder ? folderNoteFor(this.app, f) : null;
		const target = f instanceof TFile ? f : note;
		const it = list.createDiv({ cls: 'ambraia-ex-item tree-item-self is-clickable' });
		it.dataset.path = target?.path ?? f.path;
		const ic = it.createDiv('ambraia-ex-item-icon');
		const icon = getIconFor(this.plugin, f);
		if (icon) renderIcon(this.app, ic, icon, f.path);
		else setIcon(ic, f instanceof TFolder ? 'folder' : f instanceof TFile && f.extension === 'canvas' ? 'layout-dashboard' : 'file-text');
		it.createDiv({ cls: 'ambraia-ex-item-name', text: displayName(this.plugin, f) });
		it.onclick = (e) => {
			const mod = e.ctrlKey || e.metaKey;
			if (target) void this.app.workspace.getLeaf(mod ? 'tab' : false).openFile(target);
			else for (const { leaf, view } of this.explorers()) {
				view.revealInFolder?.(f);
				void this.app.workspace.revealLeaf(leaf);
			}
		};
		it.addEventListener('auxclick', (e) => {
			if (e.button === 1 && target) void this.app.workspace.getLeaf('tab').openFile(target);
		});
		it.oncontextmenu = (e) => {
			e.preventDefault();
			const m = new Menu();
			if (target) m.addItem((i) => i.setTitle(tx('Apri in una nuova scheda')).setIcon('file-plus-2').onClick(() => this.app.workspace.getLeaf('tab').openFile(target)));
			m.addItem((i) =>
				i.setTitle(tx('Cambia icona')).setIcon('smile').onClick(async () => {
					const v = await pickIcon(this.app, !!ownIconFor(this.plugin, f));
					if (v !== undefined) await setIconFor(this.plugin, f, v);
				}),
			);
			m.addItem((i) =>
				i.setTitle(tx('Mostra nell’esplora file')).setIcon('folder-search').onClick(() => {
					for (const { view } of this.explorers()) view.revealInFolder?.(f);
				}),
			);
			m.addItem((i) =>
				i
					.setTitle(g.space ? tx('Rimuovi da “{0}”', g.name) : tx('Rimuovi dai preferiti'))
					.setIcon('x')
					.onClick(() => this.removeFrom(g, f.path)),
			);
			m.showAtMouseEvent(e);
		};
	}

	markActive() {
		const active = this.app.workspace.getActiveFile()?.path;
		document.querySelectorAll<HTMLElement>('.ambraia-ex-item').forEach((el) => el.toggleClass('is-active', !!active && el.dataset.path === active));
	}

	/** Accepts files dragged from the explorer (Obsidian drag manager) or from a group. */
	private dropTarget(el: HTMLElement, onDrop: (paths: string[]) => void | Promise<void>) {
		const dragged = (): string[] => {
			const d = (this.app as unknown as { dragManager?: { draggable?: { type?: string; file?: TAbstractFile; files?: TAbstractFile[] } } }).dragManager?.draggable;
			if (!d) return [];
			if (d.file) return [d.file.path];
			if (d.files) return d.files.map((f) => f.path);
			return [];
		};
		el.addEventListener('dragover', (e) => {
			if (!dragged().length) return;
			e.preventDefault();
			el.addClass('is-drop-target');
		});
		el.addEventListener('dragleave', () => el.removeClass('is-drop-target'));
		el.addEventListener('drop', (e) => {
			el.removeClass('is-drop-target');
			const paths = dragged();
			if (!paths.length) return;
			e.preventDefault();
			e.stopPropagation();
			void onDrop(paths);
		});
	}

	private async addTo(g: Group, paths: string[]) {
		const s = this.plugin.settings;
		const list = g.space ? g.space.items : s.pinned;
		for (const p of paths) if (!list.includes(p)) list.push(p);
		await this.plugin.saveSettings();
		this.schedule();
	}

	async removeFrom(g: Group, path: string) {
		const s = this.plugin.settings;
		if (g.space) g.space.items = g.space.items.filter((p) => p !== path);
		else s.pinned = s.pinned.filter((p) => p !== path);
		await this.plugin.saveSettings();
		this.schedule();
	}

	private groupMenu(g: Group, e: MouseEvent) {
		const s = this.plugin.settings;
		const m = new Menu();
		const active = this.app.workspace.getActiveFile();
		if (active && !g.items.includes(active.path)) m.addItem((i) => i.setTitle(tx('Aggiungi la pagina corrente')).setIcon('plus').onClick(() => this.addTo(g, [active.path])));
		if (g.space) {
			const sp = g.space;
			m.addItem((i) =>
				i.setTitle(tx('Rinomina spazio')).setIcon('pencil').onClick(async () => {
					const n = await prompt(this.app, tx('Rinomina spazio'), sp.name);
					if (!n?.trim()) return;
					sp.name = n.trim();
					await this.plugin.saveSettings();
					this.schedule();
				}),
			);
			m.addItem((i) =>
				i.setTitle(tx('Cambia icona')).setIcon('smile').onClick(async () => {
					const v = await pickIcon(this.app, true);
					if (v === undefined) return;
					sp.icon = v ?? '';
					await this.plugin.saveSettings();
					this.schedule();
				}),
			);
			m.addItem((i) =>
				i.setTitle(tx('Elimina spazio (i file restano)')).setIcon('trash').setWarning(true).onClick(async () => {
					s.spaces = s.spaces.filter((x) => x !== sp);
					await this.plugin.saveSettings();
					this.schedule();
				}),
			);
		}
		m.addSeparator();
		m.addItem((i) => i.setTitle(tx('Nuovo spazio')).setIcon('layers').onClick(() => void this.newSpace()));
		m.showAtMouseEvent(e);
	}

	async newSpace(first?: string) {
		const name = await prompt(this.app, tx('Nuovo spazio'), '', tx('Es. Lavoro, Personale, Università…'), tx('Crea'));
		if (!name?.trim()) return;
		this.plugin.settings.spaces.push({ id: Date.now().toString(36), name: name.trim(), icon: '📁', items: first ? [first] : [] });
		await this.plugin.saveSettings();
		this.schedule();
		new Notice(tx('Spazio creato: trascina dentro pagine e cartelle dall’esplora file.'));
	}
}
