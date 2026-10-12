// Stand-in for the 'obsidian' module: enough behaviour to unit-test pure modules and to smoke-test
// the UI in jsdom (see tests/app-fake.ts and tests/ui.test.ts).
import YAML from 'yaml';

type Ev = { off: () => void };

export class Events {
	private h = new Map<string, ((...a: any[]) => any)[]>();
	on(name: string, cb: (...a: any[]) => any): Ev {
		const l = this.h.get(name) ?? [];
		l.push(cb);
		this.h.set(name, l);
		return { off: () => this.h.set(name, (this.h.get(name) ?? []).filter((x) => x !== cb)) };
	}
	trigger(name: string, ...a: any[]) {
		for (const cb of [...(this.h.get(name) ?? [])]) cb(...a);
	}
}

export class Component {
	_cleanup: (() => void)[] = [];
	_children: Component[] = [];
	_loaded = false;
	load() {
		this._loaded = true;
		(this as any).onload?.();
		for (const c of this._children) c.load();
	}
	unload() {
		for (const c of this._children) c.unload();
		for (const f of this._cleanup.splice(0)) f();
		(this as any).onunload?.();
		this._loaded = false;
	}
	register(f: () => void) {
		this._cleanup.push(f);
	}
	registerEvent(e: Ev) {
		if (e && typeof e.off === 'function') this._cleanup.push(() => e.off());
	}
	registerDomEvent(el: EventTarget, type: string, cb: any, opts?: any) {
		el.addEventListener(type, cb, opts);
		this._cleanup.push(() => el.removeEventListener(type, cb, opts));
	}
	registerInterval(n: number) {
		this._cleanup.push(() => clearInterval(n));
		return n;
	}
	addChild<T extends Component>(c: T) {
		this._children.push(c);
		if (this._loaded) c.load();
		return c;
	}
}

export class Modal extends Component {
	app: any;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	scope = { register() {} };
	static opened: Modal[] = [];
	constructor(app: unknown) {
		super();
		this.app = app;
		const d = globalThis.document;
		this.containerEl = d ? d.createElement('div') : ({} as any);
		this.modalEl = d ? d.createElement('div') : ({} as any);
		this.titleEl = d ? d.createElement('div') : ({} as any);
		this.contentEl = d ? d.createElement('div') : ({} as any);
		if (d) {
			this.containerEl.appendChild(this.modalEl);
			this.modalEl.append(this.titleEl, this.contentEl);
		}
	}
	open() {
		Modal.opened.push(this);
		globalThis.document?.body.appendChild(this.containerEl);
		(this as any).onOpen?.();
	}
	close() {
		Modal.opened = Modal.opened.filter((m) => m !== this);
		this.containerEl.remove?.();
		(this as any).onClose?.();
	}
	setTitle(t: string) {
		this.titleEl.textContent = t;
		return this;
	}
}

export class FuzzySuggestModal<T> extends Modal {
	setPlaceholder() {}
	_t?: T;
}
export class SuggestModal<T> extends FuzzySuggestModal<T> {}

export class Notice {
	static all: string[] = [];
	private _el: HTMLElement | null = null;
	constructor(public msg: unknown) {
		Notice.all.push(String(msg));
	}
	get messageEl(): HTMLElement {
		return (this._el ??= globalThis.document.createElement('div'));
	}
	get noticeEl(): HTMLElement {
		return this.messageEl;
	}
	setMessage() {
		return this;
	}
	hide() {}
}

export class EditorSuggest<T> {
	app: unknown;
	context: any = null;
	limit = 0;
	constructor(app: unknown) {
		this.app = app;
	}
	setInstructions() {}
	close() {}
	_t?: T;
}

export class View extends Component {
	app: any;
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	constructor(public leaf: any) {
		super();
		this.app = leaf?.app;
		const d = globalThis.document;
		this.containerEl = d ? d.createElement('div') : ({} as any);
		this.contentEl = d ? d.createElement('div') : ({} as any);
		if (d) this.containerEl.appendChild(this.contentEl);
	}
	getState() {
		return {};
	}
	async setState(_s: unknown, _r: unknown) {}
}
export class ItemView extends View {
	addAction() {
		return globalThis.document.createElement('div');
	}
}
export class MarkdownView extends ItemView {
	file: any = null;
	editor: any = null;
	getMode() {
		return 'source';
	}
}
export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) {
		super();
	}
}

export class Menu {
	static last: Menu | null = null;
	items: { title: string; onClick?: () => any }[] = [];
	constructor() {
		Menu.last = this;
	}
	addItem(cb: (i: any) => void) {
		const it: any = { title: '' };
		const api: any = new Proxy(
			{},
			{
				get: (_t, k) => {
					if (k === 'setTitle') return (t: any) => ((it.title = String(t)), api);
					if (k === 'onClick') return (f: any) => ((it.onClick = f), api);
					if (k === 'setSubmenu') return () => new Menu();
					return () => api;
				},
			},
		);
		cb(api);
		this.items.push(it);
		return this;
	}
	addSeparator() {
		return this;
	}
	showAtMouseEvent() {}
	showAtPosition() {}
	hide() {}
	onHide() {}
}

/** Chainable stand-in: every setter returns itself; add* callbacks receive a component proxy. */
function componentProxy(el: HTMLElement): any {
	const p: any = new Proxy(
		{},
		{
			get: (_t, k) => {
				if (k === 'inputEl' || k === 'buttonEl' || k === 'selectEl' || k === 'extraSettingsEl' || k === 'sliderEl' || k === 'toggleEl') return el;
				if (k === 'then') return undefined;
				const e = el as any;
				switch (k) {
					case 'onChange':
						return (cb: (v: unknown) => unknown) => {
							e.__change = cb;
							el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => cb(e.value));
							return p;
						};
					case 'onClick':
						return (cb: (ev: unknown) => unknown) => {
							el.addEventListener('click', (ev) => cb(ev));
							return p;
						};
					case 'setValue':
						return (v: unknown) => {
							if (typeof v === 'boolean') el.dataset.value = String(v);
							else e.value = v;
							return p;
						};
					case 'getValue':
						return () => (el.dataset.value !== undefined ? el.dataset.value === 'true' : e.value);
					case 'setButtonText':
						return (t: string) => {
							el.textContent = t;
							return p;
						};
					case 'setPlaceholder':
						return (t: string) => {
							el.setAttribute('placeholder', t);
							return p;
						};
					case 'setTooltip':
						return (t: string) => {
							el.setAttribute('aria-label', t);
							return p;
						};
					case 'addOption':
						return (v: string, t: string) => {
							if (el.tagName === 'SELECT') {
								const o = el.ownerDocument.createElement('option');
								o.value = v;
								o.textContent = t;
								el.appendChild(o);
							}
							return p;
						};
					case 'addOptions':
						return (o: Record<string, string>) => {
							for (const [v, t] of Object.entries(o)) p.addOption(v, t);
							return p;
						};
				}
				return () => p;
			},
		},
	);
	return p;
}
export class Setting {
	settingEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;
	constructor(container: HTMLElement) {
		const d = globalThis.document;
		this.settingEl = d.createElement('div');
		this.settingEl.className = 'setting-item';
		this.nameEl = d.createElement('div');
		this.descEl = d.createElement('div');
		this.controlEl = d.createElement('div');
		(this.nameEl as any).__role = 'name';
		(this.descEl as any).__role = 'desc';
		(this.controlEl as any).__role = 'control';
		this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
		container.appendChild(this.settingEl);
	}
	setName(n: any) {
		this.nameEl.textContent = typeof n === 'string' ? n : '';
		return this;
	}
	setDesc(n: any) {
		this.descEl.textContent = typeof n === 'string' ? n : '';
		return this;
	}
	setHeading() {
		return this;
	}
	setClass() {
		return this;
	}
	setDisabled() {
		return this;
	}
	private add(tag: string, cb: (c: any) => void) {
		const el = globalThis.document.createElement(tag);
		this.controlEl.appendChild(el);
		cb(componentProxy(el));
		return this;
	}
	addToggle(cb: any) {
		return this.add('div', cb);
	}
	addText(cb: any) {
		return this.add('input', cb);
	}
	addTextArea(cb: any) {
		return this.add('textarea', cb);
	}
	addDropdown(cb: any) {
		return this.add('select', cb);
	}
	addSlider(cb: any) {
		return this.add('input', cb);
	}
	addButton(cb: any) {
		return this.add('button', cb);
	}
	addExtraButton(cb: any) {
		return this.add('div', cb);
	}
	addSearch(cb: any) {
		return this.add('input', cb);
	}
	addColorPicker(cb: any) {
		return this.add('input', cb);
	}
}
export class PluginSettingTab {
	containerEl: HTMLElement;
	constructor(
		public app: any,
		public plugin: any,
	) {
		this.containerEl = globalThis.document?.createElement('div');
	}
	update() {}
}
/** Test helpers: Obsidian calls display() when getSettingDefinitions() is empty; sections are tabs. */
export function showSettingsPage(tab: any, id: string): HTMLElement {
	tab.display();
	const btn = tab.containerEl.querySelector(`.ambraia-set-tab[data-section="${id}"]`) as HTMLElement;
	btn.click();
	return tab.containerEl.querySelector('.ambraia-set-panel');
}
export function showSettingsRoot(tab: any): HTMLElement {
	tab.hide?.();
	tab.display();
	return tab.containerEl;
}
export class SettingPage {
	containerEl: HTMLElement = globalThis.document?.createElement('div');
	title = '';
	hide() {}
}

export class Plugin extends Component {
	commands: any[] = [];
	views = new Map<string, (leaf: any) => any>();
	codeBlocks = new Map<string, (src: string, el: HTMLElement, ctx: any) => any>();
	settingTabs: any[] = [];
	editorExtensions: any[] = [];
	suggests: any[] = [];
	data: unknown = null;
	constructor(
		public app: any,
		public manifest: any,
	) {
		super();
	}
	async loadData() {
		return this.data ? JSON.parse(JSON.stringify(this.data)) : null;
	}
	async saveData(d: unknown) {
		this.data = JSON.parse(JSON.stringify(d));
	}
	addCommand(c: any) {
		this.commands.push(c);
		return c;
	}
	addRibbonIcon() {
		return globalThis.document.createElement('div');
	}
	addStatusBarItem() {
		return globalThis.document.createElement('div');
	}
	addSettingTab(t: any) {
		this.settingTabs.push(t);
	}
	registerView(type: string, f: (leaf: any) => any) {
		this.views.set(type, f);
		this.app?.workspace?._views?.set(type, f);
	}
	registerEditorExtension(e: any) {
		this.editorExtensions.push(e);
	}
	registerEditorSuggest(s: any) {
		this.suggests.push(s);
	}
	registerMarkdownCodeBlockProcessor(lang: string, f: any) {
		this.codeBlocks.set(lang, f);
	}
	registerMarkdownPostProcessor() {}
}

export class TAbstractFile {
	path = '';
	name = '';
	parent: TFolder | null = null;
	vault: any;
}
export class TFile extends TAbstractFile {
	basename = '';
	extension = '';
	stat = { ctime: 0, mtime: 0, size: 0 };
}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot() {
		return this.path === '/' || this.path === '';
	}
}
export class WorkspaceLeaf {}
export const Platform = { isMobile: false, isDesktop: true, isDesktopApp: true, isPhone: false, isIosApp: false, isAndroidApp: false, isMobileApp: false };
export const Keymap = { isModEvent: () => false };
export function setIcon(el: HTMLElement, id: string) {
	if (el && (el as any).setAttribute) el.setAttribute('data-icon', id);
}
export function setTooltip() {}
export function getIconIds() {
	return ['lucide-star', 'lucide-book', 'lucide-home'];
}
export function normalizePath(p: string) {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/';
}
export function parseYaml(s: string) {
	return YAML.parse(s);
}
export function stringifyYaml(o: unknown) {
	return YAML.stringify(o);
}
export function getAllTags(cache: any): string[] | null {
	const out: string[] = [];
	const t = cache?.frontmatter?.tags;
	if (Array.isArray(t)) out.push(...t.map((x: string) => '#' + x));
	else if (typeof t === 'string') out.push(...t.split(/[ ,]+/).filter(Boolean).map((x) => '#' + x));
	for (const x of cache?.tags ?? []) out.push(x.tag);
	return out;
}
/** Tests can answer requestUrl() here. */
export const net: { handler: ((req: { url: string; method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; json?: unknown; text?: string; headers?: Record<string, string>; arrayBuffer?: ArrayBuffer }>) | null } = { handler: null };
export async function requestUrl(req: { url: string; method?: string; body?: unknown }) {
	if (net.handler) {
		const r = await net.handler(req);
		return { headers: {}, text: r.text ?? JSON.stringify(r.json ?? null), arrayBuffer: new ArrayBuffer(0), ...r };
	}
	throw new Error('no network in tests');
}
export { default as moment } from 'moment';
export const MarkdownRenderer = {
	async render(_app: unknown, md: string, el: HTMLElement, _src: string, _c: unknown) {
		const p = globalThis.document.createElement('div');
		p.className = 'md-render';
		p.textContent = md;
		el.appendChild(p);
	},
};
export const editorInfoField = {};
export const editorLivePreviewField = {};
export function debounce<T extends (...a: any[]) => any>(fn: T) {
	return fn;
}
export class Scope {
	register() {}
}
/** Tests put a fake pdf.js on globalThis.__pdfjs. */
export async function loadPdfJs() {
	return (globalThis as any).__pdfjs;
}

/** Tests run with the Italian (source) interface. */
export const getLanguage = () => (globalThis as { __obsidianLang?: string }).__obsidianLang ?? 'it';
