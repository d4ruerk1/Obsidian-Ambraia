// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeApp, fakeMarkdownLeaf, installDomShim } from './app-fake';

installDomShim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };

let AmbraiaPlugin: any;
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
});

async function setup(seed = true) {
	document.body.innerHTML = '';
	document.body.className = '';
	const app = new FakeApp();
	if (seed) {
		await app.vault.create('Progetti/Progetti.md', '```ambraia\nsource: this\nview: table\n```\n');
		await app.vault.create('Progetti/Sito.md', '---\nstato: In corso\npriorità: 2\nscadenza: 2026-10-05\nicon: 🚀\n---\nTesto');
		await app.vault.create('Progetti/App.md', '---\nstato: Fatto\npriorità: 1\ntags: [lavoro]\n---\n# Titolo');
		await app.vault.create('Diario.md', '---\nbanner: "gradient:3"\nicon: 📔\n---\nciao');
	}
	const plugin = new AmbraiaPlugin(app, manifest);
	await plugin.onload();
	await app.workspace.fireLayoutReady();
	return { app, plugin };
}

function ctxFor(app: FakeApp, path: string, children: any[]) {
	return {
		sourcePath: path,
		getSectionInfo: () => {
			const text = String(app.vault.data.get(path));
			const lines = text.split('\n');
			const start = lines.findIndex((l) => l.startsWith('```ambraia'));
			const end = lines.findIndex((l, i) => i > start && l.startsWith('```'));
			return { text, lineStart: start, lineEnd: end };
		},
		addChild: (c: any) => {
			children.push(c);
			c.load();
		},
	};
}

function renderBlock(app: FakeApp, plugin: any, src: string, path = 'Progetti/Progetti.md') {
	const el = document.body.createDiv();
	const kids: any[] = [];
	plugin.codeBlocks.get('ambraia')(src, el, ctxFor(app, path, kids));
	return { el, child: kids[0] };
}

describe('plugin lifecycle', () => {
	it('shares a note with a link from the note menu and opens it again', async () => {
		const { app, plugin } = await setup(true);
		const { Menu } = (await import('obsidian')) as any;
		const f = app.vault.getAbstractFileByPath('Progetti/Sito.md');
		const menu = new Menu();
		app.workspace.trigger('file-menu', menu, f, 'file-explorer');
		const items = (menu.items ?? []).map((x: any) => x.title ?? x.titleEl?.textContent);
		expect(items.join('|')).toContain('Condividi con un link');
		const { ShareModal, OpenShareModal } = await import('../src/share/ui');
		const { FakeNtfy } = await import('./ntfy-fake');
		const { Relay } = await import('../src/share/relay');
		const relay = new FakeNtfy();
		plugin.settings.shareRelayUrl = relay.base;
		plugin.shares.http = relay.http;
		plugin.shares.socket = relay.Socket;
		relay.onPublish = (msg) => void plugin.shares.server.onMessage(new Relay(relay.base, relay.http), msg);
		const m = new ShareModal(plugin.shares, f);
		m.open();
		const btn = [...m.contentEl.querySelectorAll('button')].find((b: any) => b.textContent === 'Crea link') as HTMLButtonElement;
		btn.click();
		for (let i = 0; i < 100 && !m.contentEl.querySelector('.ambraia-share-result input'); i++) await sleep(20);
		const url = (m.contentEl.querySelector('.ambraia-share-result input') as HTMLInputElement).value;
		expect(url).toMatch(/^https:\/\/.+\/share\/#c2/);
		expect(url).not.toContain('Testo');
		expect(plugin.shares.store.forPath('Progetti/Sito.md').length).toBe(1);
		m.close();
		const o = new OpenShareModal(app, plugin.shares, url);
		o.open();
		for (let i = 0; i < 100 && !o.contentEl.querySelector('.ambraia-share-rendered h2'); i++) await sleep(20);
		expect(o.contentEl.querySelector('.ambraia-share-rendered')!.textContent).toContain('Testo');
		expect(o.contentEl.querySelector('.ambraia-share-rendered')!.textContent).not.toContain('In corso'); // properties stay private
		o.close();
	});

	it('loads, registers everything and applies the Notion look', async () => {
		const { app, plugin } = await setup();
		const ids = plugin.commands.map((c: any) => c.id);
		for (const id of ['new-page', 'insert-database', 'sync-now', 'change-icon', 'sync-setup', 'show-shortcuts', 'link-page', 'canvas-new-page', 'canvas-grid'])
			expect(ids).toContain(id);
		expect(ids).not.toContain('open-navigator');
		for (const id of ['optimize-vault', 'toggle-theme', 'daily-yesterday', 'daily-tomorrow']) expect(ids).not.toContain(id);
		expect(ids).not.toContain('toggle-properties');
		// no default hotkeys: the user chooses them
		expect(plugin.commands.some((c: any) => c.hotkeys?.length)).toBe(false);
		expect(document.body.classList.contains('ambraia-theme')).toBe(true);
		expect(plugin.codeBlocks.has('ambraia')).toBe(true);
		expect(plugin.editorExtensions.length).toBe(1);
		expect(plugin.suggests.length).toBe(2);
		expect(app.workspace.getLeavesOfType('ambraia-navigator').length).toBe(0);
		expect(document.body.classList.contains('ambraia-hide-props')).toBe(true);
		expect(document.body.classList.contains('ambraia-link-icons')).toBe(true);
		expect(plugin.sync.status).toBe('off');
		await plugin.onunload();
		plugin.unload();
		expect(document.body.classList.contains('ambraia-theme')).toBe(false);
	});

	it('settings persist and toggle body classes', async () => {
		const { plugin } = await setup(false);
		plugin.settings.contentWidth = 'wide';
		plugin.settings.notionTheme = false;
		await plugin.saveSettings();
		expect(document.body.classList.contains('ambraia-width-wide')).toBe(true);
		expect(document.body.classList.contains('ambraia-theme')).toBe(false);
		expect(plugin.data.contentWidth).toBe('wide');
	});

	it('settings tab renders (disconnected) without errors', async () => {
		const { plugin } = await setup(false);
		const tab = plugin.settingTabs[0];
		const { showSettingsPage, showSettingsRoot } = (await import('obsidian')) as any;
		const root: HTMLElement = showSettingsRoot(tab);
		const names = (el: HTMLElement) => [...el.querySelectorAll('.setting-item')].map((e: any) => e.firstChild.textContent);
		// the sections are tabs of a floating bar at the top, and the first one is already open
		const tabs = [...root.querySelectorAll('.ambraia-set-tabs .ambraia-set-tab')] as HTMLElement[];
		expect(tabs.map((t) => t.textContent)).toEqual(['Generale', 'Editor', 'Sincronizzazione', 'Condivisione', 'AI', 'Calendario']);
		expect(root.firstElementChild!.classList.contains('ambraia-set-tabs-wrap')).toBe(true);
		expect(tabs[0].classList.contains('is-active')).toBe(true);
		expect(tabs[0].getAttribute('aria-selected')).toBe('true');
		expect(tabs.slice(1).every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
		expect(names(root.querySelector('.ambraia-set-panel')!)).toContain('Tema Ambraia');
		expect(root.textContent).toContain('d4ruerk1');
		expect(tabs[2].querySelector('.ambraia-set-tab-dot')!.getAttribute('aria-label')).toBe('Non collegato');
		// clicking a tab swaps the content below and keeps the bar
		tabs[1].click();
		expect(tabs[1].classList.contains('is-active') && !tabs[0].classList.contains('is-active')).toBe(true);
		expect(names(root.querySelector('.ambraia-set-panel')!)).toContain('Menu “/”');
		expect(root.querySelectorAll('.ambraia-set-tabs').length).toBe(1);
		// arrow keys move between tabs
		tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
		expect(tab.currentSection).toBe('sync');
		// reopening the settings starts again from the first tab
		tab.hide();
		tab.display();
		expect(tab.currentSection).toBe('general');
		expect(root.querySelector('.ambraia-set-tab.is-active')!.textContent).toBe('Generale');
		const general = showSettingsPage(tab, 'general');
		expect(names(general)).toContain('Tema Ambraia');
		expect(names(general)).toContain('Lingua');
		const sync = showSettingsPage(tab, 'sync');
		expect(names(sync)).toContain('Collega un servizio cloud');
		expect(sync.querySelector('.ambraia-settings-status')!.textContent).toContain('Non collegato');
		// few settings per page: the rest is under "Avanzate"
		for (const id of ['general', 'editor', 'sync', 'ai', 'calendar']) {
			const visible = [...showSettingsPage(tab, id).querySelectorAll('.setting-item')].filter((e: any) => !e.closest('details')).length;
			expect(visible, id).toBeLessThanOrEqual(14);
		}
	});
});

/** A file explorer like Obsidian's (only the parts the decorator touches). */
function fakeExplorer(app: FakeApp) {
	const containerEl = document.createElement('div');
	containerEl.innerHTML = '<div class="nav-header"><div class="nav-buttons-container"></div></div><div class="nav-files-container"></div>';
	const list = containerEl.querySelector('.nav-files-container')!;
	const fileItems: Record<string, any> = {};
	for (const f of app.vault.getAllLoadedFiles() as any[]) {
		if (!f.path || f.path === '/') continue;
		const wrap = document.createElement('div');
		const selfEl = document.createElement('div');
		selfEl.className = f.children ? 'nav-folder-title' : 'nav-file-title';
		const innerEl = document.createElement('div');
		innerEl.textContent = f.children ? f.name : f.basename;
		selfEl.append(innerEl);
		wrap.append(selfEl);
		list.append(wrap);
		fileItems[f.path] = { file: f, selfEl, innerEl };
	}
	const view = { containerEl, fileItems, getViewType: () => 'file-explorer', revealInFolder() {} };
	const leaf: any = { view };
	app.workspace.leaves.push(leaf);
	return view;
}

describe('file explorer (no separate navigator)', () => {
	it('shows page icons, hides folder notes, adds "+" on folders and a today button', async () => {
		const { app, plugin } = await setup();
		const view = fakeExplorer(app);
		plugin.explorer.decorate();
		const icon = (p: string) => view.fileItems[p].selfEl.querySelector('.ambraia-explorer-icon')?.textContent;
		expect(icon('Progetti/Sito.md')).toBe('🚀');
		expect(icon('Diario.md')).toBe('📔');
		expect(view.fileItems['Progetti/Progetti.md'].selfEl.parentElement.classList.contains('ambraia-folder-note-hidden')).toBe(true);
		expect(view.fileItems['Progetti'].selfEl.querySelector('.ambraia-ex-add')).not.toBeNull();
		expect(view.containerEl.querySelector('.ambraia-nav-custom[data-ambraia-custom="today"]')).not.toBeNull();
		// the "+" creates a page inside the folder
		(view.fileItems['Progetti'].selfEl.querySelector('.ambraia-ex-add') as HTMLElement).click();
		await sleep(20);
		expect(app.vault.getAbstractFileByPath('Progetti/Senza titolo.md')).not.toBeNull();
	});

	it('explorer toolbar: native buttons can be hidden or replaced, "New note" opens a menu', async () => {
		const { app, plugin } = await setup();
		const view = fakeExplorer(app);
		const bar = view.containerEl.querySelector('.nav-buttons-container')!;
		bar.innerHTML = '<div class="clickable-icon nav-action-button"><svg class="svg-icon lucide-edit"></svg></div><div class="clickable-icon nav-action-button"><svg class="svg-icon lucide-folder-plus"></svg></div>';
		let created = 0;
		bar.firstElementChild!.addEventListener('click', () => created++);
		plugin.settings.navHidden = ['new-folder'];
		plugin.explorer.decorate();
		const [newNote, newFolder] = [...bar.querySelectorAll('[data-ambraia-id]')] as HTMLElement[];
		expect(newNote.dataset.ambraiaId).toBe('new-note');
		expect(newFolder.classList.contains('ambraia-hidden')).toBe(true);
		// the menu replaces the direct action
		newNote.click();
		expect(created).toBe(0);
		plugin.settings.newNoteMenu = false;
		newNote.click();
		expect(created).toBe(1);
		// a command in place of a native button
		plugin.settings.navCustom.push({ id: 'x', icon: 'search', command: 'app:open-search', label: 'Cerca', replaces: 'new-note' });
		plugin.explorer.refreshNav();
		expect(newNote.classList.contains('ambraia-hidden')).toBe(true);
		expect(newNote.nextElementSibling?.getAttribute('data-ambraia-custom')).toBe('x');
		plugin.explorer.unload();
		expect(bar.querySelector('.ambraia-hidden, .ambraia-nav-custom')).toBeNull();
	});

	it('favourites and spaces appear above the tree', async () => {
		const { app, plugin } = await setup();
		plugin.settings.pinned = ['Diario.md'];
		plugin.settings.spaces = [{ id: 's1', name: 'Lavoro', icon: '💼', items: ['Progetti/Sito.md'] }];
		const view = fakeExplorer(app);
		plugin.explorer.decorate();
		const box = view.containerEl.querySelector('.ambraia-ex-pins')!;
		expect(box.nextElementSibling?.classList.contains('nav-files-container')).toBe(true);
		const names = [...box.querySelectorAll('.ambraia-ex-group-name')].map((e) => e.textContent);
		expect(names).toEqual(['Preferiti', 'Lavoro']);
		const items = [...box.querySelectorAll('.ambraia-ex-item-name')].map((e) => e.textContent);
		expect(items).toEqual(['Diario', 'Sito']);
	});
});

describe('databases', () => {
	it('table view lists folder notes except the host', async () => {
		const { app, plugin } = await setup();
		const { el } = renderBlock(app, plugin, 'source: this\nview: table\ncolumns: [nome, stato, priorità]');
		expect(el.querySelector('.ambraia-db-error')).toBeNull();
		const rows = el.querySelectorAll('tbody tr:not(.ambraia-db-add-row)');
		expect(rows.length).toBe(2);
		expect(el.textContent).toContain('In corso');
		expect(el.textContent).not.toContain('Progetti.md');
	});

	for (const view of ['board', 'gallery', 'list', 'calendar']) {
		it(`${view} view renders without errors`, async () => {
			const { app, plugin } = await setup();
			const { el } = renderBlock(app, plugin, `source: this\nview: ${view}\ngroupBy: stato\ndateField: scadenza\ncolumns: [nome, stato]`);
			expect(el.querySelector('.ambraia-db-error')).toBeNull();
			expect(el.querySelector(`.ambraia-db-body.is-${view}`)).not.toBeNull();
			expect(el.textContent).toContain('Sito');
		});
	}

	it('board groups by property', async () => {
		const { app, plugin } = await setup();
		const { el } = renderBlock(app, plugin, 'source: this\nview: board\ngroupBy: stato');
		const heads = [...el.querySelectorAll('.ambraia-board-head .ambraia-pill')].map((e) => e.textContent);
		expect(heads).toEqual(expect.arrayContaining(['In corso', 'Fatto']));
	});

	it('tag source and formulas', async () => {
		const { app, plugin } = await setup();
		const { el } = renderBlock(app, plugin, 'source: "#lavoro"\nview: table\ncolumns: [nome, doppio]\nformulas:\n  doppio: prop("priorità") * 2', 'Diario.md');
		expect(el.querySelector('.ambraia-db-error')).toBeNull();
		const rows = el.querySelectorAll('tbody tr:not(.ambraia-db-add-row)');
		expect(rows.length).toBe(1);
		expect(rows[0].textContent).toContain('App');
		expect(rows[0].textContent).toContain('2');
	});

	it('invalid YAML shows a friendly error', async () => {
		const { app, plugin } = await setup();
		const { el } = renderBlock(app, plugin, 'source: [unclosed');
		expect(el.querySelector('.ambraia-db-error')?.textContent).toContain('non valida');
	});

	it('saving the view rewrites only the code block', async () => {
		const { app, plugin } = await setup();
		const f = app.vault.getAbstractFileByPath('Progetti/Progetti.md') as any;
		await app.vault.modify(f, '# Intro\n\n```ambraia\nsource: this\nview: table\n```\n\nFine\n');
		const { child } = renderBlock(app, plugin, 'source: this\nview: table');
		const host = child.renderer.host;
		await host.saveConfig({ ...child.renderer.cfg, view: 'board', groupBy: 'stato' });
		const text = String(app.vault.data.get('Progetti/Progetti.md'));
		expect(text.startsWith('# Intro\n\n```ambraia\n')).toBe(true);
		expect(text).toContain('view: board');
		expect(text).toContain('groupBy: stato');
		expect(text.endsWith('```\n\nFine\n')).toBe(true);
	});

	it('re-renders when a note changes', async () => {
		const { app, plugin } = await setup();
		const { el } = renderBlock(app, plugin, 'source: this\nview: table\ncolumns: [nome, stato]');
		await app.vault.create('Progetti/Nuovo.md', '---\nstato: Idea\n---\n');
		await sleep(400);
		expect(el.textContent).toContain('Nuovo');
		expect(el.textContent).toContain('Idea');
	});

	it('folder opened as database', async () => {
		const { app, plugin } = await setup();
		await plugin.openFolderDatabase('Progetti');
		const leaf = app.workspace.getLeavesOfType('ambraia-database')[0];
		expect(leaf).toBeTruthy();
		expect(leaf.view.contentEl.querySelectorAll('tbody tr:not(.ambraia-db-add-row)').length).toBe(2);
		await leaf.view.renderer.host.saveConfig({ ...leaf.view.renderer.cfg, view: 'list' });
		expect(plugin.settings.folderViews['Progetti'].view).toBe('list');
	});
});

describe('page header', () => {
	it('renders icon and banner from frontmatter', async () => {
		const { app, plugin } = await setup();
		const f = app.vault.getAbstractFileByPath('Diario.md') as any;
		const leaf = fakeMarkdownLeaf(app, f);
		plugin.headers.apply(leaf);
		const h = leaf.view.contentEl.querySelector('.cm-sizer > .ambraia-header');
		expect(h).not.toBeNull();
		expect(h.querySelector('.ambraia-page-icon').textContent).toContain('📔');
		expect(h.querySelector('.ambraia-banner')).not.toBeNull();
		expect(h.nextElementSibling.className).toBe('inline-title');
		// idempotent
		plugin.headers.apply(leaf);
		expect(leaf.view.contentEl.querySelectorAll('.cm-sizer > .ambraia-header').length).toBe(1);
	});
	it('add-cover action writes a gradient to frontmatter', async () => {
		const { app, plugin } = await setup();
		const f = app.vault.getAbstractFileByPath('Progetti/App.md') as any;
		const leaf = fakeMarkdownLeaf(app, f);
		plugin.headers.apply(leaf);
		const actions = [...leaf.view.contentEl.querySelectorAll('.cm-sizer .ambraia-header-action')] as HTMLElement[];
		actions.find((a) => a.textContent!.includes('copertina'))!.click();
		await sleep(10);
		const text = String(app.vault.data.get('Progetti/App.md'));
		expect(text).toMatch(/banner: gradient:\d+/);
		expect(text).toContain('stato: Fatto');
		expect(text).toContain('# Titolo');
	});
});

describe('folders', () => {
	it('renaming a folder renames its folder note and keeps icons/pins', async () => {
		const { app, plugin } = await setup();
		plugin.settings.icons['Progetti'] = '📁';
		plugin.settings.pinned = ['Progetti/Sito.md'];
		const folder = app.vault.getAbstractFileByPath('Progetti')!;
		await app.vault.rename(folder, 'Lavori');
		await sleep(10);
		expect(app.vault.getAbstractFileByPath('Lavori/Lavori.md')).not.toBeNull();
		expect(app.vault.getAbstractFileByPath('Lavori/Progetti.md')).toBeNull();
		expect(plugin.settings.icons['Lavori']).toBe('📁');
		expect(plugin.settings.pinned).toEqual(['Lavori/Sito.md']);
	});
	it('create folder note from the file menu', async () => {
		const { app, plugin } = await setup();
		await app.vault.createFolder('Idee');
		await plugin.createFolderNote(app.vault.getAbstractFileByPath('Idee'));
		expect(String(app.vault.data.get('Idee/Idee.md'))).toContain('```ambraia');
		expect(app.workspace.active?.path).toBe('Idee/Idee.md');
	});
	it('clicking a folder in the explorer opens its note', async () => {
		const { app } = await setup();
		const leafEl = document.body.createDiv({ cls: 'workspace-leaf-content', attr: { 'data-type': 'file-explorer' } });
		const title = leafEl.createDiv({ cls: 'nav-folder-title', attr: { 'data-path': 'Progetti' } });
		const inner = title.createDiv('nav-folder-title-content');
		inner.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
		await sleep(5);
		expect(app.workspace.active?.path).toBe('Progetti/Progetti.md');
	});
});

describe('commands', () => {
	it('new page creates unique untitled notes', async () => {
		const { app, plugin } = await setup(false);
		const cmd = plugin.commands.find((c: any) => c.id === 'new-page');
		await cmd.callback();
		await cmd.callback();
		const names = app.vault.getMarkdownFiles().map((f) => f.path).sort();
		expect(names.length).toBe(2);
		expect(new Set(names).size).toBe(2);
	});
	it('insert database command', async () => {
		const { plugin } = await setup(false);
		let out = '';
		plugin.commands.find((c: any) => c.id === 'insert-board').editorCallback({ replaceSelection: (s: string) => (out = s) });
		expect(out).toContain('view: board');
	});
});
