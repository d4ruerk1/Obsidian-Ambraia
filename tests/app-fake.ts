// In-memory Obsidian App + Obsidian's DOM helpers, for jsdom smoke tests.
import YAML from 'yaml';
import { Events, MarkdownView, TAbstractFile, TFile, TFolder } from 'obsidian';
import { LocalEntry, LocalFS, RemoteAPI, RemoteChange, RemoteFile, HttpError, md5 } from '../src/sync/types';
import { QuotaError } from '../src/sync/engine';

// ---------------------------------------------------------------- DOM helpers
export function installDomShim() {
	const P = (globalThis as any).Node.prototype;
	if (P.createDiv) return;
	const apply = (el: HTMLElement, o: any) => {
		if (o == null) return;
		if (typeof o === 'string') o = { cls: o };
		if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls;
		if (o.text != null) el.textContent = typeof o.text === 'string' ? o.text : String(o.text.textContent ?? '');
		if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v != null && v !== false) el.setAttribute(k, String(v));
		if (o.title) el.title = o.title;
		for (const k of ['type', 'href', 'value', 'placeholder']) if (o[k] != null) (el as any)[k] = o[k];
		if (o.parent) o.parent.appendChild(el);
	};
	P.createEl = function (tag: string, o?: any, cb?: (el: HTMLElement) => void) {
		const el = (this.ownerDocument ?? document).createElement(tag);
		apply(el, o);
		if (o?.prepend) this.prepend(el);
		else this.appendChild(el);
		cb?.(el);
		return el;
	};
	P.createDiv = function (o?: any, cb?: any) {
		return this.createEl('div', o, cb);
	};
	P.createSpan = function (o?: any, cb?: any) {
		return this.createEl('span', o, cb);
	};
	P.empty = function () {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	P.detach = function () {
		this.parentNode?.removeChild(this);
	};
	P.appendText = function (t: string) {
		this.appendChild(document.createTextNode(t));
	};
	P.instanceOf = function (c: any) {
		return this instanceof c;
	};
	P.doc = document;
	P.win = window;
	const E = (globalThis as any).Element.prototype;
	E.addClass = function (...c: string[]) {
		this.classList.add(...c.flatMap((x) => x.split(' ')).filter(Boolean));
	};
	E.addClasses = function (c: string[]) {
		this.addClass(...c);
	};
	E.removeClass = function (...c: string[]) {
		this.classList.remove(...c.flatMap((x) => x.split(' ')).filter(Boolean));
	};
	E.removeClasses = function (c: string[]) {
		this.removeClass(...c);
	};
	E.toggleClass = function (c: string, v: boolean) {
		this.classList.toggle(c, v);
	};
	E.hasClass = function (c: string) {
		return this.classList.contains(c);
	};
	E.setText = function (t: string) {
		this.textContent = t;
	};
	E.getText = function () {
		return this.textContent;
	};
	E.setAttr = function (k: string, v: any) {
		if (v == null) this.removeAttribute(k);
		else this.setAttribute(k, String(v));
	};
	E.setAttrs = function (o: any) {
		for (const [k, v] of Object.entries(o)) this.setAttr(k, v);
	};
	E.getAttr = function (k: string) {
		return this.getAttribute(k);
	};
	E.find = function (s: string) {
		return this.querySelector(s);
	};
	E.findAll = function (s: string) {
		return Array.from(this.querySelectorAll(s));
	};
	E.show = function () {
		this.style.display = '';
	};
	E.hide = function () {
		this.style.display = 'none';
	};
	E.toggle = function (show: boolean) {
		this.style.display = show ? '' : 'none';
	};
	E.isShown = function () {
		return this.style.display !== 'none';
	};
	E.setCssStyles = function (o: any) {
		Object.assign(this.style, o);
	};
	E.setCssProps = function (o: any) {
		for (const [k, v] of Object.entries(o)) this.style.setProperty(k, String(v));
	};
	E.onClickEvent = function (cb: any) {
		this.addEventListener('click', cb);
	};
	const g = globalThis as any;
	g.createDiv = (o?: any, cb?: any) => {
		const el = document.createElement('div');
		apply(el, o);
		cb?.(el);
		return el;
	};
	g.createSpan = (o?: any) => {
		const el = document.createElement('span');
		apply(el, o);
		return el;
	};
	g.createEl = (tag: string, o?: any) => {
		const el = document.createElement(tag);
		apply(el, o);
		return el;
	};
	g.createFragment = (cb?: any) => {
		const f = document.createDocumentFragment();
		cb?.(f);
		return f;
	};
	g.activeDocument = document;
	g.activeWindow = window;
	if (!g.requestAnimationFrame) g.requestAnimationFrame = (f: any) => setTimeout(f, 0);
	if (!(Element.prototype as any).scrollIntoView) (Element.prototype as any).scrollIntoView = () => {};
}

// ---------------------------------------------------------------- frontmatter
export function splitFrontmatter(text: string): { fm: Record<string, unknown> | null; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) return { fm: null, body: text };
	let fm: any = null;
	try {
		fm = YAML.parse(m[1]) ?? {};
	} catch {
		fm = null;
	}
	return { fm, body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------- vault
export class FakeVault extends Events {
	configDir = '.obsidian';
	root: TFolder;
	private map = new Map<string, TAbstractFile>();
	data = new Map<string, string | ArrayBuffer>();
	cache!: FakeMetadataCache;
	clock = 1_700_000_000_000;
	adapter: any;
	constructor() {
		super();
		this.root = new TFolder();
		this.root.path = '/';
		this.root.name = '';
		this.map.set('/', this.root);
		const raw = new Map<string, any>();
		this.adapter = {
			exists: async (p: string) => raw.has(p) || this.map.has(p) || [...raw.keys()].some((k) => k.startsWith(p + '/')),
			read: async (p: string) => { const v = raw.get(p); return v != null && typeof v !== 'string' ? new TextDecoder().decode(v as ArrayBuffer) : (v ?? (this.data.get(p) as string) ?? ''); },
			write: async (p: string, d: string) => void raw.set(p, d),
			remove: async (p: string) => void raw.delete(p),
			rename: async (a: string, b: string) => {
				raw.set(b, raw.get(a) ?? '');
				raw.delete(a);
			},
			list: async (dir: string) => ({ files: [...raw.keys()].filter((k) => k.startsWith(dir + '/') && !k.slice(dir.length + 1).includes('/')), folders: [] }),
			stat: async (p: string) => (raw.has(p) ? { type: 'file', mtime: 1, ctime: 1, size: raw.get(p)!.length ?? raw.get(p)!.byteLength } : null),
			mkdir: async () => {},
			rmdir: async (p: string) => {
				for (const k of [...raw.keys()]) if (k.startsWith(p + '/')) raw.delete(k);
			},
			readBinary: async (p: string) => { const v = raw.get(p); return v instanceof ArrayBuffer ? v : typeof v === 'string' ? new TextEncoder().encode(v).buffer : new ArrayBuffer(0); },
			writeBinary: async (p: string, d: ArrayBuffer) => void raw.set(p, d),
		};
	}
	getName() {
		return 'Test';
	}
	getRoot() {
		return this.root;
	}
	getAbstractFileByPath(p: string) {
		return this.map.get(p === '' ? '/' : p) ?? null;
	}
	getFileByPath(p: string) {
		const f = this.map.get(p);
		return f instanceof TFile ? f : null;
	}
	getFolderByPath(p: string) {
		const f = this.map.get(p);
		return f instanceof TFolder ? f : null;
	}
	getAllLoadedFiles() {
		return [...this.map.values()];
	}
	getFiles() {
		return [...this.map.values()].filter((f): f is TFile => f instanceof TFile);
	}
	getMarkdownFiles() {
		return this.getFiles().filter((f) => f.extension === 'md');
	}
	getResourcePath(f: TFile) {
		return 'app://local/' + f.path;
	}
	private parentOf(path: string): TFolder {
		const i = path.lastIndexOf('/');
		if (i < 0) return this.root;
		const pp = path.slice(0, i);
		const ex = this.map.get(pp);
		if (ex instanceof TFolder) return ex;
		return this.mkFolder(pp);
	}
	private mkFolder(path: string): TFolder {
		const parent = this.parentOf(path);
		const f = new TFolder();
		f.path = path;
		f.name = path.split('/').pop()!;
		f.parent = parent;
		parent.children.push(f);
		this.map.set(path, f);
		this.trigger('create', f);
		return f;
	}
	async createFolder(path: string) {
		if (this.map.has(path)) throw new Error('Folder already exists.');
		return this.mkFolder(path);
	}
	private mkFile(path: string, data: string | ArrayBuffer): TFile {
		if (this.map.has(path)) throw new Error('File already exists.');
		const parent = this.parentOf(path);
		const f = new TFile();
		f.path = path;
		f.name = path.split('/').pop()!;
		const dot = f.name.lastIndexOf('.');
		f.basename = dot > 0 ? f.name.slice(0, dot) : f.name;
		f.extension = dot > 0 ? f.name.slice(dot + 1) : '';
		f.parent = parent;
		f.stat = { ctime: ++this.clock, mtime: this.clock, size: typeof data === 'string' ? data.length : data.byteLength };
		parent.children.push(f);
		this.map.set(path, f);
		this.data.set(path, data);
		this.cache?.index(f);
		this.trigger('create', f);
		return f;
	}
	async create(path: string, data: string) {
		return this.mkFile(path, data);
	}
	async createBinary(path: string, data: ArrayBuffer) {
		return this.mkFile(path, data);
	}
	async read(f: TFile) {
		return String(this.data.get(f.path) ?? '');
	}
	async cachedRead(f: TFile) {
		return this.read(f);
	}
	async readBinary(f: TFile) {
		const d = this.data.get(f.path);
		return d != null && typeof d !== 'string' ? (d as ArrayBuffer) : new TextEncoder().encode(String(d ?? '')).buffer;
	}
	async modify(f: TFile, data: string) {
		this.data.set(f.path, data);
		f.stat = { ...f.stat, mtime: ++this.clock, size: data.length };
		this.cache?.index(f);
		this.trigger('modify', f);
	}
	async modifyBinary(f: TFile, data: ArrayBuffer) {
		this.data.set(f.path, data);
		this.trigger('modify', f);
	}
	async process(f: TFile, fn: (s: string) => string) {
		const next = fn(await this.read(f));
		await this.modify(f, next);
		return next;
	}
	async copy(f: TFile, path: string) {
		return this.mkFile(path, this.data.get(f.path) ?? '');
	}
	async delete(f: TAbstractFile) {
		if (f instanceof TFolder) for (const c of [...f.children]) await this.delete(c);
		this.map.delete(f.path);
		this.data.delete(f.path);
		if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
		this.trigger('delete', f);
	}
	async trash(f: TAbstractFile) {
		return this.delete(f);
	}
	async rename(f: TAbstractFile, newPath: string) {
		if (this.map.has(newPath)) throw new Error('Destination file already exists!');
		const old = f.path;
		const moveOne = (x: TAbstractFile, np: string) => {
			this.map.delete(x.path);
			const d = this.data.get(x.path);
			this.data.delete(x.path);
			x.path = np;
			x.name = np.split('/').pop()!;
			if (x instanceof TFile) {
				const dot = x.name.lastIndexOf('.');
				x.basename = dot > 0 ? x.name.slice(0, dot) : x.name;
				x.extension = dot > 0 ? x.name.slice(dot + 1) : '';
				this.data.set(np, d ?? '');
			}
			this.map.set(np, x);
			if (x instanceof TFolder) for (const c of x.children) moveOne(c, np + '/' + c.name);
		};
		const newParent = this.parentOf(newPath);
		if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
		moveOne(f, newPath);
		f.parent = newParent;
		newParent.children.push(f);
		if (f instanceof TFile) this.cache?.index(f);
		this.trigger('rename', f, old);
	}
}

export class FakeMetadataCache extends Events {
	private c = new Map<string, any>();
	resolvedLinks: Record<string, Record<string, number>> = {};
	constructor(private vault: FakeVault) {
		super();
		vault.cache = this;
	}
	index(f: TFile) {
		if (f.extension !== 'md') return;
		const text = String(this.vault.data.get(f.path) ?? '');
		const { fm } = splitFrontmatter(text);
		const headings = [...text.matchAll(/^(#{1,6}) (.+)$/gm)].map((m) => ({ level: m[1].length, heading: m[2] }));
		const tags = [...text.matchAll(/(^|\s)(#[\w/-]+)/g)].map((m) => ({ tag: m[2] }));
		const listItems = text
			.split('\n')
			.map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(?:\[(.)\])?/.exec(l))
			.filter((m): m is RegExpExecArray => !!m)
			.map((m) => (m[1] !== undefined ? { task: m[1] } : {}));
		const cache = { frontmatter: fm ?? undefined, headings, tags, listItems: listItems.length ? listItems : undefined };
		this.c.set(f.path, cache);
		this.trigger('changed', f, text, cache);
	}
	getFileCache(f: TFile) {
		return this.c.get(f.path) ?? null;
	}
	getCache(p: string) {
		return this.c.get(p) ?? null;
	}
	getFirstLinkpathDest(link: string, _src: string) {
		const clean = link.split('#')[0].split('|')[0];
		const exact = this.vault.getAbstractFileByPath(clean) ?? this.vault.getAbstractFileByPath(clean + '.md');
		if (exact instanceof TFile) return exact;
		return this.vault.getFiles().find((f) => f.basename === clean || f.name === clean) ?? null;
	}
	fileToLinktext(f: TFile) {
		return f.extension === 'md' ? f.basename : f.name;
	}
}

export class FakeLeaf {
	view: any = null;
	opened: TFile | null = null;
	constructor(public app: FakeApp) {}
	async setViewState(st: { type: string; state?: any; active?: boolean }) {
		const f = this.app.workspace._views.get(st.type);
		if (!f) throw new Error('unknown view ' + st.type);
		this.view = f(this);
		this.view.app = this.app;
		this.view.load?.();
		await this.view.onOpen?.();
		if (st.state) await this.view.setState(st.state, {});
		if (!this.app.workspace.leaves.includes(this)) this.app.workspace.leaves.push(this);
	}
	getViewState() {
		return { type: this.view?.getViewType?.() ?? 'empty', state: this.view?.getState?.() ?? {} };
	}
	async openFile(f: TFile) {
		this.opened = f;
		this.app.workspace.active = f;
		if (!this.app.workspace.leaves.includes(this)) this.app.workspace.leaves.push(this);
		this.app.workspace.trigger('file-open', f);
	}
	detach() {
		this.view?.unload?.();
		this.view?.onClose?.();
		this.app.workspace.leaves = this.app.workspace.leaves.filter((l) => l !== this);
	}
	getDisplayText() {
		return this.view?.getDisplayText?.() ?? '';
	}
}

export class FakeWorkspace extends Events {
	_views = new Map<string, (leaf: any) => any>();
	leaves: FakeLeaf[] = [];
	active: TFile | null = null;
	private readyCbs: (() => any)[] = [];
	layoutReady = false;
	containerEl = document.createElement('div');
	constructor(private app: FakeApp) {
		super();
	}
	onLayoutReady(cb: () => any) {
		if (this.layoutReady) void cb();
		else this.readyCbs.push(cb);
	}
	async fireLayoutReady() {
		this.layoutReady = true;
		for (const cb of this.readyCbs.splice(0)) await cb();
	}
	getLeaf() {
		const l = new FakeLeaf(this.app);
		return l;
	}
	getLeftLeaf() {
		return new FakeLeaf(this.app);
	}
	getRightLeaf() {
		return new FakeLeaf(this.app);
	}
	getLeavesOfType(t: string) {
		return this.leaves.filter((l) => l.view?.getViewType?.() === t);
	}
	detachLeavesOfType(t: string) {
		for (const l of this.getLeavesOfType(t)) l.detach();
	}
	async revealLeaf() {}
	iterateAllLeaves(cb: (l: FakeLeaf) => void) {
		for (const l of this.leaves) cb(l);
	}
	getActiveFile() {
		return this.active;
	}
	getActiveViewOfType(c: any) {
		const l = this.leaves.find((x) => x.view instanceof c && x.view === this.activeView);
		return l?.view ?? null;
	}
	activeView: any = null;
	async openLinkText(link: string, src: string) {
		const f = this.app.metadataCache.getFirstLinkpathDest(link, src);
		if (f) this.active = f;
	}
	get activeLeaf() {
		return this.leaves[0] ?? null;
	}
	setActiveLeaf() {}
	updateOptions() {}
}

export class FakeFileManager {
	constructor(private app: FakeApp) {}
	async processFrontMatter(f: TFile, fn: (fm: any) => void) {
		const text = await this.app.vault.read(f);
		const { fm, body } = splitFrontmatter(text);
		const obj = fm ?? {};
		fn(obj);
		const y = Object.keys(obj).length ? `---\n${YAML.stringify(obj)}---\n` : '';
		await this.app.vault.modify(f, y + body);
	}
	async renameFile(f: TAbstractFile, p: string) {
		return this.app.vault.rename(f, p);
	}
	async trashFile(f: TAbstractFile) {
		return this.app.vault.delete(f);
	}
	getNewFileParent() {
		return this.app.vault.getRoot();
	}
	generateMarkdownLink(f: TFile) {
		return `[[${f.basename}]]`;
	}
	async getAvailablePathForAttachment(name: string) {
		return name;
	}
}

export class FakeApp {
	vault = new FakeVault();
	metadataCache = new FakeMetadataCache(this.vault);
	workspace = new FakeWorkspace(this);
	fileManager = new FakeFileManager(this);
	secrets = new Map<string, string>();
	secretStorage = { getSecret: (k: string) => this.secrets.get(k) ?? null, setSecret: (k: string, v: string) => void this.secrets.set(k, v), listSecrets: () => [...this.secrets.keys()] };
	local = new Map<string, unknown>();
	loadLocalStorage(k: string) {
		return this.local.get(k) ?? null;
	}
	saveLocalStorage(k: string, v: unknown) {
		if (v === null) this.local.delete(k);
		else this.local.set(k, v);
	}
	setting = { open() {}, openTabById() {} };
	commands = { executeCommandById() {} };
	internalPlugins = { getPluginById: () => null };
}

/** A markdown view whose DOM looks like Obsidian's live-preview editor. */
export function fakeMarkdownLeaf(app: FakeApp, file: TFile): FakeLeaf {
	const leaf = new FakeLeaf(app);
	const v: any = new MarkdownView(leaf);
	v.app = app;
	v.file = file;
	v.getViewType = () => 'markdown';
	const src = v.contentEl.createDiv('markdown-source-view mod-cm6');
	const sizer = src.createDiv('cm-sizer');
	sizer.createDiv('inline-title');
	sizer.createDiv('cm-contentContainer');
	const rv = v.contentEl.createDiv('markdown-reading-view');
	const ps = rv.createDiv('markdown-preview-view').createDiv('markdown-preview-sizer');
	ps.createDiv('mod-header');
	leaf.view = v;
	app.workspace.leaves.push(leaf);
	document.body.appendChild(v.containerEl);
	return leaf;
}

// ---------------------------------------------------------------- sync fakes (LocalFS / Drive)

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
export const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

let clock = 1_000_000;
export const tick = () => ++clock;
/** local file times on the same scale as the fake cloud's modifiedTime */
const ltime = () => 1700000000000 + tick() * 1000;

export class FakeLocal implements LocalFS {
	files = new Map<string, { data: ArrayBuffer; mtime: number }>();
	folders = new Set<string>();
	trash: string[] = [];
	ignore: (p: string) => boolean = (p) => p.startsWith('.trash');

	private ensureParents(p: string) {
		const parts = p.split('/');
		for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
	}
	put(p: string, text: string) {
		this.ensureParents(p);
		this.files.set(p, { data: enc(text), mtime: ltime() });
	}
	get(p: string) {
		const f = this.files.get(p);
		return f ? dec(f.data) : undefined;
	}
	async list(): Promise<LocalEntry[]> {
		const out: LocalEntry[] = [];
		for (const f of this.folders) if (!this.ignore(f)) out.push({ path: f, isFolder: true, mtime: 0, size: 0 });
		for (const [p, f] of this.files) if (!this.ignore(p)) out.push({ path: p, isFolder: false, mtime: f.mtime, size: f.data.byteLength });
		return out;
	}
	async stat(p: string) {
		if (this.folders.has(p)) return { path: p, isFolder: true, mtime: 0, size: 0 };
		const f = this.files.get(p);
		return f ? { path: p, isFolder: false, mtime: f.mtime, size: f.data.byteLength } : null;
	}
	async read(p: string) {
		const f = this.files.get(p);
		if (!f) throw new Error('ENOENT ' + p);
		return f.data.slice(0);
	}
	async write(p: string, data: ArrayBuffer) {
		this.ensureParents(p);
		this.files.set(p, { data: data.slice(0), mtime: ltime() });
	}
	async mkdir(p: string) {
		this.ensureParents(p + '/x');
	}
	async remove(p: string) {
		this.trash.push(p);
		this.files.delete(p);
		for (const k of [...this.files.keys()]) if (k.startsWith(p + '/')) this.files.delete(k);
		this.folders.delete(p);
		for (const k of [...this.folders]) if (k.startsWith(p + '/')) this.folders.delete(k);
	}
	async rename(from: string, to: string) {
		if (this.files.has(from)) {
			this.ensureParents(to);
			const f = this.files.get(from)!;
			this.files.delete(from);
			this.files.set(to, f);
			return;
		}
		if (!this.folders.has(from)) throw new Error('ENOENT ' + from);
		this.ensureParents(to + '/x');
		for (const k of [...this.folders]) if (k === from || k.startsWith(from + '/')) {
			this.folders.delete(k);
			this.folders.add(to + k.slice(from.length));
		}
		for (const [k, v] of [...this.files]) if (k.startsWith(from + '/')) {
			this.files.delete(k);
			this.files.set(to + k.slice(from.length), v);
		}
	}
	async children(p: string) {
		const out: string[] = [];
		for (const k of [...this.files.keys(), ...this.folders]) {
			if (k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) out.push(k);
		}
		return out;
	}
	isIgnored(p: string) {
		return this.ignore(p);
	}
}

interface DF extends RemoteFile {
	trashed: boolean;
	data?: ArrayBuffer;
	root?: string;
	version?: number;
}

export type DriveMode = 'feed' | 'probe' | 'snapshot';

/** Lets test helpers read/write an encrypted fake drive in plain text. */
export interface Codec {
	encName(n: string): Promise<string>;
	decName(n: string): Promise<string | null>;
	encrypt(d: ArrayBuffer): Promise<ArrayBuffer>;
	decrypt(d: ArrayBuffer): Promise<ArrayBuffer>;
}

/** In-memory cloud with the semantics of the real providers (ids, revisions, trash, change feed). */
export class FakeDrive {
	files = new Map<string, DF>();
	log: { id: string; seq: number }[] = [];
	seq = 0;
	nextId = 1;
	calls: string[] = [];
	failNext = 0;
	/** Account size in bytes (null = unlimited). Trashed files count, like on real services. */
	capacity: number | null = null;
	/** Exposes space() (some services/scopes don't). */
	spaceApi = true;
	/** Fault injection: return an error to throw it from the named call (or any call). */
	fault: ((call: string) => Error | null) | null = null;
	codec: Codec | null = null;
	/** plain names of encrypted names, filled by the test codec */
	plainNames = new Map<string, string>();
	constructor(public mode: DriveMode = 'feed') {}
	touch(id: string) {
		this.log.push({ id, seq: ++this.seq });
	}
	private time() {
		return new Date(1700000000000 + tick() * 1000).toISOString();
	}
	new(f: Partial<DF>): DF {
		const id = 'id' + this.nextId++;
		const file: DF = { id, name: '', parentId: null, isFolder: false, trashed: false, createdTime: this.time(), modifiedTime: this.time(), version: 1, ...f } as DF;
		this.files.set(id, file);
		this.touch(id);
		return file;
	}
	public pub(f: DF): RemoteFile {
		const out: RemoteFile = { id: f.id, name: f.name, parentId: f.parentId, isFolder: f.isFolder, createdTime: f.createdTime, modifiedTime: f.modifiedTime };
		if (!f.isFolder) {
			out.rev = `${f.id}.${f.version}`;
			if (f.data) {
				out.hash = md5(f.data);
				out.size = f.data.byteLength;
			}
		}
		return out;
	}
	isTrashed(id: string): boolean {
		const f = this.files.get(id);
		if (!f) return true;
		if (f.trashed) return true;
		return f.parentId ? (this.files.has(f.parentId) ? this.isTrashed(f.parentId) : false) : false;
	}
	/** id of the vault root containing the item (null = outside any vault) */
	rootOf(id: string): string | null {
		let f = this.files.get(id);
		for (let i = 0; f && i < 100; i++) {
			if (f.root) return f.id;
			f = f.parentId ? this.files.get(f.parentId) : undefined;
		}
		return null;
	}
	inVault(f: DF) {
		return !f.root && this.rootOf(f.id) !== null;
	}
	private plain(name: string) {
		return this.plainNames.get(name) ?? name;
	}
	/** Helpers used by tests to simulate edits made from another client */
	pathOf(id: string): string {
		const f = this.files.get(id)!;
		if (f.root) return '';
		const pp = f.parentId ? this.pathOf(f.parentId) : '';
		const n = this.plain(f.name);
		return pp ? pp + '/' + n : n;
	}
	find(path: string): DF | undefined {
		for (const f of this.files.values()) if (!this.isTrashed(f.id) && !f.root && this.pathOf(f.id) === path) return f;
	}
	async contentOf(f: DF): Promise<string> {
		return dec(this.codec ? await this.codec.decrypt(f.data!) : f.data!);
	}
	async text(path: string) {
		const f = this.find(path);
		return f?.data ? this.contentOf(f) : undefined;
	}
	/** path -> text of every live file of every vault */
	async snapshot(): Promise<Record<string, string>> {
		const o: Record<string, string> = {};
		for (const f of this.files.values()) {
			if (f.isFolder || this.isTrashed(f.id) || !this.inVault(f)) continue;
			const p = this.pathOf(f.id);
			if (p === '.ambraia-crypt.json') continue;
			o[p] = await this.contentOf(f);
		}
		return o;
	}

	get used() {
		let n = 0;
		for (const f of this.files.values()) n += f.data?.byteLength ?? 0;
		return n;
	}
	private fits(extra: number) {
		if (this.capacity !== null && this.used + extra > this.capacity) throw new QuotaError('Fake: storageQuotaExceeded');
	}

	api(key = 'Vault'): RemoteAPI {
		const d = this;
		const guard = (name: string) => {
			d.calls.push(name);
			if (d.failNext > 0) {
				d.failNext--;
				throw new HttpError(500, 'boom');
			}
			const e = d.fault?.(name);
			if (e) throw e;
		};
		const myRoot = () => [...d.files.values()].find((f) => f.root === key && !f.trashed);
		const under = (f: DF, rootId: string) => d.rootOf(f.id) === rootId && f.id !== rootId;
		const api: RemoteAPI = {
			async findRoot() {
				guard('findRoot');
				const r = myRoot();
				return r ? d.pub(r) : null;
			},
			async vaultFolders() {
				return [...new Set([...d.files.values()].filter((f) => typeof f.root === 'string' && !f.trashed).map((f) => f.root as string))];
			},
			async createRoot() {
				guard('createRoot');
				return d.pub(d.new({ name: key, isFolder: true, root: key, parentId: 'mydrive' }));
			},
			async listAll(rootId) {
				guard('listAll');
				const r = d.files.get(rootId);
				if (!r || r.trashed) throw new HttpError(404, 'root not found');
				return [...d.files.values()].filter((f) => under(f, rootId) && !d.isTrashed(f.id)).map((f) => d.pub(f));
			},
			async findChild(parentId, name) {
				guard('findChild');
				for (const f of d.files.values()) if (f.parentId === parentId && f.name === name && !f.trashed) return d.pub(f);
				return null;
			},
			async createFolder(name, parentId) {
				guard('createFolder');
				return d.pub(d.new({ name, parentId, isFolder: true }));
			},
			async upload(name, parentId, data) {
				guard('upload');
				d.fits(data.byteLength);
				return d.pub(d.new({ name, parentId, data: data.slice(0) }));
			},
			async update(id, data, prev) {
				guard('update');
				const f = d.files.get(id);
				if (!f || f.trashed) throw new HttpError(404, 'nf');
				if (prev?.rev && prev.rev !== `${f.id}.${f.version}`) throw new HttpError(412, 'precondition failed');
				d.fits(data.byteLength - (f.data?.byteLength ?? 0));
				f.data = data.slice(0);
				f.version = (f.version ?? 1) + 1;
				f.modifiedTime = d.time();
				d.touch(id);
				return d.pub(f);
			},
			async move(id, name, newParent) {
				guard('move');
				const f = d.files.get(id);
				if (!f) throw new HttpError(404, 'nf');
				f.name = name;
				f.parentId = newParent;
				d.touch(id);
				return d.pub(f);
			},
			async trash(id) {
				guard('trash');
				const f = d.files.get(id);
				if (!f) throw new HttpError(404, 'nf');
				f.trashed = true;
				d.touch(id);
			},
			async download(id) {
				guard('download');
				const f = d.files.get(id);
				if (!f || !f.data) throw new HttpError(404, 'nf');
				return f.data.slice(0);
			},
		};
		if (this.spaceApi)
			api.space = async () => {
				guard('space');
				return d.capacity === null ? null : { used: d.used, total: d.capacity };
			};
		if (this.mode === 'feed') {
			(api as { changes: unknown }).changes = {
				start: async () => {
					guard('changesStart');
					return String(d.seq);
				},
				list: async (token: string) => {
					guard('listChanges');
					const since = Number(token);
					const r = myRoot();
					const ids = [...new Set(d.log.filter((l) => l.seq > since).map((l) => l.id))];
					const changes: RemoteChange[] = [];
					for (const id of ids) {
						const f = d.files.get(id);
						if (!f) changes.push({ fileId: id, removed: true });
						else if (f.root === key || (r && d.rootOf(id) === r.id) || f.trashed) changes.push(d.isTrashed(id) ? { fileId: id, removed: true } : { fileId: id, removed: false, file: d.pub(f) });
					}
					return { changes, newToken: String(d.seq) };
				},
			};
		} else if (this.mode === 'probe') {
			(api as { probe: unknown }).probe = {
				start: async () => {
					guard('probeStart');
					return String(d.seq);
				},
				changed: async (token: string) => {
					guard('probe');
					return { changed: d.seq > Number(token), token: String(d.seq) };
				},
			};
		}
		return api;
	}

	// remote-side manipulations (simulating another client acting directly on the cloud)
	async remoteEdit(path: string, text: string) {
		const f = this.find(path)!;
		f.data = this.codec ? await this.codec.encrypt(enc(text)) : enc(text);
		f.version = (f.version ?? 1) + 1;
		this.touch(f.id);
	}
	remoteTrash(path: string) {
		const f = this.find(path)!;
		f.trashed = true;
		this.touch(f.id);
	}
	async remoteRename(path: string, newName: string) {
		const f = this.find(path)!;
		f.name = this.codec ? await this.codec.encName(newName) : newName;
		this.touch(f.id);
	}
}
