import { App, Modal, Notice, Setting, setIcon, TAbstractFile, TFile, TFolder, normalizePath, moment as obsidianMoment } from 'obsidian';
import type MomentStatic from 'moment';
import type AmbraiaPlugin from '../main';
import { tx } from '../i18n';

/**
 * Obsidian re-exports moment as a namespace import, which is not callable with
 * modern TypeScript interop. Re-type it once here so every module can call it.
 */
/** Red "destructive" button style, on every supported Obsidian version (setWarning is deprecated). */
export function destructive<T extends { buttonEl: HTMLElement }>(b: T): T {
	b.buttonEl.addClass('mod-warning');
	return b;
}

export const moment = obsidianMoment as unknown as typeof MomentStatic;
export type Moment = ReturnType<typeof MomentStatic>;

export const GRADIENTS: string[] = [
	'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
	'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)',
	'linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)',
	'linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)',
	'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',
	'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)',
	'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
	'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
	'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
	'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
	'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
	'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
	'linear-gradient(160deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
	'linear-gradient(135deg, #e6dada 0%, #274046 100%)',
	'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
	'linear-gradient(135deg, #c79081 0%, #dfa579 100%)',
	// added in 1.0.0: keep the order (covers are saved as gradient:<index>)
	'linear-gradient(135deg, #fdfbfb 0%, #ebedee 100%)',
	'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
	'linear-gradient(120deg, #fccb90 0%, #f6d365 100%)',
	'linear-gradient(120deg, #89f7fe 0%, #66a6ff 100%)',
	'linear-gradient(120deg, #a8edea 0%, #fed6e3 100%)',
	'linear-gradient(120deg, #d299c2 0%, #fef9d7 100%)',
	'linear-gradient(120deg, #f093fb 0%, #f5576c 100%)',
	'linear-gradient(120deg, #4facfe 0%, #00f2fe 100%)',
	'linear-gradient(120deg, #0ba360 0%, #3cba92 100%)',
	'linear-gradient(120deg, #ff0844 0%, #ffb199 100%)',
	'linear-gradient(120deg, #b721ff 0%, #21d4fd 100%)',
	'linear-gradient(120deg, #13547a 0%, #80d0c7 100%)',
	'linear-gradient(120deg, #ff758c 0%, #ff7eb3 100%)',
	'linear-gradient(120deg, #868f96 0%, #596164 100%)',
	'linear-gradient(120deg, #c471f5 0%, #fa71cd 100%)',
	'linear-gradient(120deg, #48c6ef 0%, #6f86d6 100%)',
	'linear-gradient(120deg, #feada6 0%, #f5efef 100%)',
	'linear-gradient(120deg, #e6e9f0 0%, #eef1f5 100%)',
	'linear-gradient(120deg, #accbee 0%, #e7f0fd 100%)',
	'linear-gradient(120deg, #e9defa 0%, #fbfcdb 100%)',
	'linear-gradient(120deg, #c1dfc4 0%, #deecdd 100%)',
	'linear-gradient(120deg, #f3e7e9 0%, #e3eeff 100%)',
	'linear-gradient(120deg, #fff1eb 0%, #ace0f9 100%)',
	'linear-gradient(120deg, #ebbba7 0%, #cfc7f8 100%)',
	'linear-gradient(120deg, #2af598 0%, #009efd 100%)',
	'linear-gradient(120deg, #cd9cf2 0%, #f6f3ff 100%)',
	'linear-gradient(120deg, #6a11cb 0%, #2575fc 100%)',
	'linear-gradient(120deg, #37ecba 0%, #72afd3 100%)',
	'linear-gradient(120deg, #ebc0fd 0%, #d9ded8 100%)',
	'linear-gradient(120deg, #f83600 0%, #f9d423 100%)',
	'linear-gradient(120deg, #b8cbb8 0%, #b465da 50%, #ee609c 100%)',
	'linear-gradient(120deg, #c2e59c 0%, #64b3f4 100%)',
	'linear-gradient(120deg, #fddb92 0%, #d1fdff 100%)',
	'linear-gradient(120deg, #9890e3 0%, #b1f4cf 100%)',
	'linear-gradient(120deg, #ebedee 0%, #fdfbfb 40%, #dfe9f3 100%)',
	'linear-gradient(160deg, #232526 0%, #414345 100%)',
	'linear-gradient(160deg, #141e30 0%, #243b55 100%)',
	'linear-gradient(160deg, #3a1c71 0%, #d76d77 50%, #ffaf7b 100%)',
	'linear-gradient(160deg, #000428 0%, #004e92 100%)',
	'linear-gradient(160deg, #42275a 0%, #734b6d 100%)',
	'linear-gradient(160deg, #1d4350 0%, #a43931 100%)',
	'linear-gradient(160deg, #093028 0%, #237a57 100%)',
	'radial-gradient(circle at 20% 30%, #ffd3a5 0%, #fd6585 100%)',
	'radial-gradient(circle at 70% 20%, #a1ffce 0%, #faffd1 100%)',
	'radial-gradient(circle at 30% 70%, #c9d6ff 0%, #e2e2e2 100%)',
	'radial-gradient(circle at 50% 0%, #fbd3e9 0%, #bb377d 100%)',
	'conic-gradient(from 200deg at 30% 50%, #fbc2eb, #a6c1ee, #c2e9fb, #fbc2eb)',
	'conic-gradient(from 90deg at 70% 40%, #f6d365, #fda085, #f093fb, #f6d365)',
];

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);

export function isImageFile(f: TAbstractFile | null): f is TFile {
	return f instanceof TFile && IMAGE_EXT.has(f.extension.toLowerCase());
}

/** Strip [[ ]], ![[ ]], quotes and an alias from a link-ish value. */
export function unwrapLink(v: string): string {
	let s = v.trim().replace(/^["']|["']$/g, '');
	const m = /^!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(s);
	if (m) s = m[1];
	const md = /^!?\[[^\]]*\]\(([^)]+)\)$/.exec(s);
	if (md) s = decodeURI(md[1]);
	return s.trim();
}

export type CssBackground = { kind: 'css'; value: string } | { kind: 'img'; src: string };

/** Resolve a banner/cover frontmatter value into something we can render. */
export function resolveBanner(app: App, raw: unknown, sourcePath: string): CssBackground | null {
	if (raw === null || raw === undefined) return null;
	const first: unknown = Array.isArray(raw) ? raw[0] : raw;
	const v = typeof first === 'string' ? first : typeof first === 'number' ? String(first) : '';
	if (!v.trim()) return null;
	const g = /^gradient[:-]?(\d+)$/i.exec(v.trim());
	if (g) return { kind: 'css', value: GRADIENTS[Number(g[1]) % GRADIENTS.length] };
	if (/^(linear|radial|conic)-gradient\(/.test(v.trim()) || /^#[0-9a-f]{3,8}$/i.test(v.trim())) return { kind: 'css', value: v.trim() };
	const s = unwrapLink(v);
	if (/^(https?:|data:image\/|app:|file:)/i.test(s)) return { kind: 'img', src: s };
	const f = resolveFile(app, s, sourcePath);
	if (f) return { kind: 'img', src: app.vault.getResourcePath(f) };
	return null;
}

export function resolveFile(app: App, link: string, sourcePath: string): TFile | null {
	const dest = app.metadataCache.getFirstLinkpathDest(link, sourcePath);
	if (dest) return dest;
	const f = app.vault.getAbstractFileByPath(normalizePath(link));
	return f instanceof TFile ? f : null;
}

/** Render a page icon value: emoji, `lucide-xxx`, or image. */
export function renderIcon(app: App, el: HTMLElement, value: string, sourcePath = ''): void {
	el.empty();
	const v = value.trim();
	if (!v) return;
	const lucide = /^(?:lucide[:-])?([a-z0-9-]+)$/.exec(v);
	if (v.startsWith('lucide') && lucide) {
		el.addClass('ob-icon-lucide');
		setIcon(el, v.startsWith('lucide:') ? v.slice(7) : v.startsWith('lucide-') ? v : 'lucide-' + v);
		return;
	}
	el.removeClass('ob-icon-lucide');
	const link = unwrapLink(v);
	if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(link) || /^https?:/.test(link)) {
		const f = /^https?:/.test(link) ? null : resolveFile(app, link, sourcePath);
		const src = f ? app.vault.getResourcePath(f) : /^https?:/.test(link) ? link : '';
		if (src) {
			el.createEl('img', { attr: { src, alt: '' } });
			return;
		}
	}
	el.setText(v);
}

export function folderNoteFor(app: App, folder: TFolder): TFile | null {
	if (folder.isRoot()) return null;
	const inside = app.vault.getAbstractFileByPath(`${folder.path}/${folder.name}.md`);
	if (inside instanceof TFile) return inside;
	return null;
}

export function isFolderNote(app: App, file: TAbstractFile): boolean {
	return file instanceof TFile && file.extension === 'md' && !!file.parent && !file.parent.isRoot() && file.parent.name === file.basename;
}

/** The note that stands for an item as a page: the note itself, or the folder note of a folder. */
export function pageNoteFor(plugin: AmbraiaPlugin, file: TAbstractFile): TFile | null {
	if (file instanceof TFile) return file.extension === 'md' ? file : null;
	if (file instanceof TFolder && plugin.settings.folderNotes) return folderNoteFor(plugin.app, file);
	return null;
}

const ICON_KEYS = (key: string) => [key, 'icon', 'sticker'];

function frontmatterIcon(plugin: AmbraiaPlugin, note: TFile): string {
	const fm = plugin.app.metadataCache.getFileCache(note)?.frontmatter;
	if (!fm) return '';
	for (const k of ICON_KEYS(plugin.settings.iconKey)) {
		const v: unknown = fm[k];
		if (typeof v === 'string' && v.trim()) return v.trim();
	}
	return '';
}

/**
 * Automatic icons (only when "an icon for every note" is on, and never written to the file):
 * chosen from the meaning of the name (Italian, English, Spanish, French, German keywords),
 * with a neutral page or folder icon when nothing matches. Same name → same icon on every device.
 */
/** icon → word beginnings ("ricett" matches "Ricette"); a trailing "$" asks for the whole word. */
const ICON_WORDS: [string, string][] = [
	['📔', 'diario journal daily giornal tagebuch'],
	['📅', 'calendar calendrier kalender scadenz deadline agenda'],
	['🗣️', 'riunion meeting incontr reunion besprechung standup call$ 1:1$'],
	['🚀', 'progett project projet proyect projekt roadmap lancio launch'],
	['💼', 'lavoro work$ job$ ufficio office travail trabajo arbeit azienda company business client kunde carriera career'],
	['✅', 'todo to-do attivit task compiti checklist faccende chores'],
	['🎯', 'obiettiv goal okr traguard objecti ziel'],
	['💡', 'idea idee brainstorm spunti inspir ispiraz'],
	['🎓', 'studi study universit scuola school corso course esam exam lezion lesson cours clase vorlesung tesi thesis'],
	['📚', 'libr book lettur reading livre buch biblio'],
	['🍝', 'ricett recipe cucina cooking cibo food recette receta rezept pasti meal'],
	['🛒', 'spesa shopping acquist grocer compra einkauf'],
	['✈️', 'viagg travel trip$ vacanz holiday voyage viaje reise ferie'],
	['💶', 'soldi money budget financ finanz spese expense banca bank tasse tax$ fattur invoice stipend salary risparm saving conti'],
	['🩺', 'salute health medic dottor doctor gesundheit terapi farmac visite'],
	['🏋️', 'sport palestra gym$ allenam workout fitness corsa running calcio yoga'],
	['🌱', 'abitudin habit routine gewohnheit habito'],
	['🏠', 'casa$ home$ house maison hogar haus$ trasloc affitto rent$'],
	['👨‍👩‍👧', 'famigli family famille familia familie figli kids bambin'],
	['👥', 'persone people contatt contact amici friends crm$ team$ squadra clienti'],
	['🎵', 'musica music musique canzon song playlist album'],
	['🎬', 'film$ movie cinema serie$ series tv$ netflix'],
	['🎮', 'gioc game gaming jeu$ juego spiel'],
	['📷', 'foto photo immagin image picture galler'],
	['🎨', 'arte$ art$ disegn drawing design grafica illustr'],
	['✍️', 'scrittur writing articol article blog post$ bozz draft romanzo novel poesi poem racconti'],
	['💻', 'codice code$ coding programm dev$ software script api$ github python javascript'],
	['🐞', 'bug$ bugs$ errori issue'],
	['🗄️', 'server database dati$ data$ sql$'],
	['🔐', 'sicurezz security password privacy sicher segurid'],
	['🔬', 'ricerca research recherche investig forschung analisi analysis report rapporto'],
	['🧪', 'scienz science chimic chemistry fisica physics biolog matemat math'],
	['🪴', 'natura nature giardin garden piante plants fiori flower jardin garten'],
	['🐾', 'animal cane$ cani$ dog$ dogs$ gatt cat$ cats$ pet$ pets$ chien perro hund'],
	['🚗', 'auto$ macchina moto$ veicol vehicle voiture coche wagen'],
	['📑', 'document contratt contract legal legge law$ burocra modul'],
	['🗃️', 'archivi archive backup'],
	['📥', 'inbox posta mail$ email newsletter'],
	['🧩', 'template modell modele plantilla vorlage'],
	['🔗', 'risorse resources link$ links$ bookmark segnalib strumenti tools toolbox'],
	['⚙️', 'impostaz settings config setup preferenz'],
	['🎁', 'regal gift natale christmas compleann birthday'],
	['🎉', 'festa party evento event matrimonio wedding conferenz conference'],
	['💭', 'pensier thought riflession reflection emozion mood'],
	['🌐', 'lingu language inglese english vocabol vocabulary traduz translation'],
	['🏛️', 'storia$ history histoire geschichte'],
	['🗺️', 'mappa map$ maps$ luoghi places citta city mondo world'],
	['❓', 'domand question faq$ dubbi'],
	['⭐', 'importante important urgent priorit preferit favorit'],
	['📖', 'wiki knowledge conoscenz guida guide manuale manual howto how-to tutorial'],
	['🧭', 'homepage dashboard indice index panoramica overview hub$ start$ inizio'],
];

const ICON_RULES: [RegExp, string][] = [
	[/^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/, '📅'],
	[/^\d{4}-w\d{1,2}$|^(settimana|week|semaine|woche|semana) ?\d/, '🗓️'],
	...ICON_WORDS.map(([icon, words]): [RegExp, string] => {
		const alts = words.split(' ').map((w) => (w.endsWith('$') ? w.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])' : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		return [new RegExp(`(?:^|[^a-z0-9])(?:${alts.join('|')})`), icon];
	}),
];

const PAGE_ICONS = ['📄', '📝', '🗒️', '📃'];
const FOLDER_ICONS = ['📁', '📂', '🗂️'];

const plain = (s: string) =>
	s
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[_]+/g, ' ')
		.trim();

/** An icon that fits the name ("Ricette" → 🍝, "2026-10-10" → 📅), or a neutral page/folder icon. */
export function autoIconFor(seed: string, folder = false): string {
	const name = plain(seed);
	for (const [re, icon] of ICON_RULES) if (re.test(name)) return icon;
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	const set = folder ? FOLDER_ICONS : PAGE_ICONS;
	return set[(h >>> 0) % set.length];
}

/**
 * The one icon of a page, shared by the file explorer, the page header, links, calendar and databases.
 * Notes keep it in their frontmatter; a folder with a folder note uses the note's icon;
 * other files and plain folders keep it in the plugin settings. With "an icon for every note" on,
 * pages without one show an automatic icon (nothing is written to the file) unless `fallback` is false.
 * A folder and its folder note always show the same icon, in the explorer and inside the note.
 */
export function getIconFor(plugin: AmbraiaPlugin, file: TAbstractFile, fallback = true): string {
	const own = ownIconFor(plugin, file);
	if (own || !fallback || !plugin.settings.autoIcons) return own;
	const note = pageNoteFor(plugin, file);
	if (!note) return '';
	const folderNote = plugin.settings.folderNotes && isFolderNote(plugin.app, note);
	return autoIconFor(note.basename, folderNote);
}

/** Only an icon chosen by the user (or given at creation), never the automatic one. */
export function ownIconFor(plugin: AmbraiaPlugin, file: TAbstractFile): string {
	const s = plugin.settings;
	const note = pageNoteFor(plugin, file);
	if (note) {
		const v = frontmatterIcon(plugin, note);
		if (v) return v;
		// icons saved by older versions in the settings (for the note or for its folder)
		if (s.icons[note.path]) return s.icons[note.path];
		if (s.folderNotes && note.parent && isFolderNote(plugin.app, note) && s.icons[note.parent.path]) return s.icons[note.parent.path];
		return '';
	}
	return s.icons[file.path] ?? '';
}

/** Removes a frontmatter block left empty (keeps notes as small as possible). */
export async function dropEmptyFrontmatter(app: App, file: TFile): Promise<void> {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (fm && Object.keys(fm).some((k) => k !== 'position')) return;
	await app.vault.process(file, (c) => c.replace(/^---\r?\n(?:\s*\r?\n)*---\r?\n?/, ''));
}

/** Sets (or removes, with null) the single icon of a page. */
export async function setIconFor(plugin: AmbraiaPlugin, file: TAbstractFile, icon: string | null): Promise<void> {
	const s = plugin.settings;
	const note = pageNoteFor(plugin, file);
	let changed = false;
	if (note) {
		let empty = false;
		await plugin.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
			for (const k of ICON_KEYS(s.iconKey)) delete fm[k];
			if (icon) fm[s.iconKey] = icon;
			empty = Object.keys(fm).length === 0;
		});
		if (empty) await dropEmptyFrontmatter(plugin.app, note);
		// one icon only: forget copies kept in the settings by older versions
		for (const k of [note.path, note.parent && isFolderNote(plugin.app, note) ? note.parent.path : '']) {
			if (k && k in s.icons) {
				delete s.icons[k];
				changed = true;
			}
		}
	} else {
		if (icon) s.icons[file.path] = icon;
		else delete s.icons[file.path];
		changed = true;
	}
	if (changed) await plugin.saveSettings();
	plugin.refreshDecorations();
}

export function displayName(plugin: AmbraiaPlugin, f: TAbstractFile): string {
	if (f instanceof TFile) return f.extension === 'md' ? f.basename : f.name;
	return f.name || plugin.app.vault.getName();
}

export class PromptModal extends Modal {
	private value: string;
	private done = false;
	constructor(
		app: App,
		private titleText: string,
		initial: string,
		private resolve: (v: string | null) => void,
		private placeholder = '',
		private cta = 'OK',
		private multiline = false,
	) {
		super(app);
		this.value = initial;
	}
	onOpen() {
		this.titleEl.setText(this.titleText);
		this.modalEl.addClass('ambraia-prompt');
		const input = this.multiline
			? this.contentEl.createEl('textarea', { cls: 'ambraia-prompt-input' })
			: this.contentEl.createEl('input', { type: 'text', cls: 'ambraia-prompt-input' });
		input.value = this.value;
		input.placeholder = this.placeholder;
		input.addEventListener('input', () => (this.value = input.value));
		(input as HTMLInputElement).addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (!this.multiline || e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submit();
			}
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(tx('Annulla')).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.cta).setCta().onClick(() => this.submit()));
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 10);
	}
	private submit() {
		this.done = true;
		this.resolve(this.value);
		this.close();
	}
	onClose() {
		if (!this.done) this.resolve(null);
		this.contentEl.empty();
	}
}

export function prompt(app: App, title: string, initial = '', placeholder = '', cta = 'OK', multiline = false): Promise<string | null> {
	return new Promise((res) => new PromptModal(app, title, initial, res, placeholder, cta, multiline).open());
}

export class ConfirmModal extends Modal {
	private done = false;
	constructor(app: App, private titleText: string, private body: string, private cta: string, private resolve: (v: boolean) => void, private danger = false) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(this.titleText);
		this.contentEl.createEl('p', { text: this.body });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(tx('Annulla')).onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.cta).onClick(() => {
					this.done = true;
					this.resolve(true);
					this.close();
				});
				if (this.danger) destructive(b);
				else b.setCta();
			});
	}
	onClose() {
		if (!this.done) this.resolve(false);
	}
}

export function confirm(app: App, title: string, body: string, cta = tx('Conferma'), danger = false): Promise<boolean> {
	return new Promise((res) => new ConfirmModal(app, title, body, cta, res, danger).open());
}

/** Pick a non-existing path like "Folder/Senza titolo 2.md". */
export function availablePath(app: App, folder: string, base: string, ext: string): string {
	const dir = folder && folder !== '/' ? folder.replace(/\/+$/, '') + '/' : '';
	let i = 0;
	for (;;) {
		const name = i === 0 ? base : `${base} ${i + 1}`;
		const p = normalizePath(`${dir}${name}${ext ? '.' + ext : ''}`);
		if (!app.vault.getAbstractFileByPath(p)) return p;
		i++;
	}
}

export function sanitizeFileName(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || tx('Senza titolo');
}

export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLElement {
	const b = parent.createDiv({ cls: `clickable-icon ambraia-icon-btn ${cls}`.trim(), attr: { 'aria-label': label } });
	setIcon(b, icon);
	b.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		onClick(e);
	});
	return b;
}

/**
 * Opens a web address in the browser only for safe schemes (https, http, mailto).
 * Links found inside notes could otherwise start local programs or files (file:, javascript:, custom schemes).
 */
export function openExternal(url: string): boolean {
	const u = url.trim();
	if (!/^(https?:\/\/|mailto:)/i.test(u)) {
		new Notice(tx('Link non aperto: sono ammessi solo indirizzi web (https://).'));
		return false;
	}
	window.open(u, '_blank', 'noopener');
	return true;
}
