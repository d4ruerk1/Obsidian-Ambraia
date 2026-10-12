import { Component, FuzzySuggestModal, ItemView, Keymap, MarkdownRenderer, MarkdownView, Menu, Notice, normalizePath, setIcon, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { moment } from '../ui/util';
import type AmbraiaPlugin from '../main';
import type { ChatMsg } from './client';
import { splitThinking, stripThinking } from './client';
import { ChatMode, MODE_LABELS } from './manager';
import { expandTemplate } from './prompts';
import { modelLabel } from './providers';
import { allActions } from './inline';
import { availablePath, sanitizeFileName } from '../ui/util';
import { clip, fetchWeb, fileText, isReadable, listProjects, parseProject, Project, URL_RE } from './local';
import { tx } from '../i18n';
import { markAiContent } from './marking';

export const AI_CHAT_VIEW = 'ambraia-ai-chat';

export interface ChatEntry {
	role: 'user' | 'assistant';
	/** What is sent to the model (user turns include the attached context). */
	content: string;
	/** What is shown (user turns: the typed text). */
	display?: string;
	images?: string[];
	sources?: string[];
	context?: string[];
	error?: boolean;
	/** Tool calls and notices of an agent turn (kept after the answer is complete). */
	steps?: { label: string; ok?: boolean; note?: boolean }[];
	/** Google Search Suggestions of the searches made for this answer (not saved in the note). */
	searches?: { html?: string; queries: string[] }[];
}

/** Plain headings: the saved chat reads well for people and for AI tools alike. */
const USER_H = '### Tu';
const AI_H = '### Ambraia AI';

/** Serializes a chat as a readable Markdown note. */
export function chatToMarkdown(entries: ChatEntry[], meta: { mode: ChatMode; model: string; created: string; project?: string }): string {
	const q = (v: string) => `"${v.replace(/["\\\n]/g, ' ')}"`;
	const fm = ['---', 'ambraia-chat: true', 'type: ai-chat', 'ai-generated: true', `created: ${meta.created}`, `modalita: ${meta.mode}`, `modello: ${q(meta.model)}`, ...(meta.project ? [`progetto: ${q(meta.project)}`] : []), 'tags:', '  - ai-chat', '---', ''];
	const body = entries
		.filter((e) => !e.error)
		.map((e) => {
			if (e.role === 'user') {
				const ctx = e.context?.length ? tx('\n\n> Contesto: {0}', e.context.map((p) => (/^https?:/.test(p) ? `<${p}>` : `[[${p.replace(/\.md$/, '')}]]`)).join(', ')) : '';
				return `${USER_H}\n\n${(e.display ?? e.content).trim()}${ctx}\n`;
			}
			const src = e.sources?.length ? tx('\n\n> Fonti: {0}', e.sources.map((p) => `[[${p.replace(/\.md$/, '')}]]`).join(', ')) : '';
			return `${AI_H}\n\n${stripThinking(e.content)}${src}\n`;
		});
	return fm.join('\n') + body.join('\n');
}

/** Parses a chat note written by chatToMarkdown. */
export function markdownToChat(md: string): { entries: ChatEntry[]; mode: ChatMode | null; created: string | null; project: string | null } {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
	const mode = (/modalita:\s*(chat|vault|agent)/.exec(fm?.[1] ?? '')?.[1] as ChatMode | undefined) ?? null;
	const body = fm ? md.slice(fm[0].length) : md;
	const entries: ChatEntry[] = [];
	const re = /^### ((?:🧑 )?Tu|(?:✨ )?Ambraia AI)[ \t]*$/gmu;
	const marks: { role: 'user' | 'assistant'; start: number; end: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) marks.push({ role: m[1].includes('Ambraia AI') ? 'assistant' : 'user', start: m.index, end: m.index + m[0].length });
	marks.forEach((mk, i) => {
		let text = body.slice(mk.end, marks[i + 1]?.start ?? body.length).trim();
		const meta = /\n*> (Contesto|Fonti): (.*)$/.exec(text);
		const paths = meta ? [...meta[2].matchAll(/\[\[([^\]]+)\]\]|<(https?:[^>]+)>/g)].map((x) => x[2] ?? (/\.[a-z0-9]{2,5}$/i.test(x[1]) && !/\.md$/i.test(x[1]) ? x[1] : x[1] + '.md')) : [];
		if (meta) text = text.slice(0, meta.index).trim();
		if (mk.role === 'user') entries.push({ role: 'user', content: text, display: text, context: paths.length ? paths : undefined });
		else entries.push({ role: 'assistant', content: text, sources: paths.length ? paths : undefined });
	});
	const created = /(?:created|creata):\s*(.+)/.exec(fm?.[1] ?? '')?.[1].trim().replace(/^["']|["']$/g, '') ?? null;
	const project = /progetto:\s*(.+)/.exec(fm?.[1] ?? '')?.[1].trim().replace(/^["']|["']$/g, '') || null;
	return { entries, mode, created, project };
}

class ChatHistoryPicker extends FuzzySuggestModal<TFile> {
	constructor(
		private plugin: AmbraiaPlugin,
		private files: TFile[],
		private onPick: (f: TFile) => void,
	) {
		super(plugin.app);
		this.setPlaceholder(tx('Apri una chat precedente…'));
	}
	getItems() {
		return this.files;
	}
	getItemText(f: TFile) {
		return `${f.basename}  ·  ${moment(f.stat.mtime).format('D MMM YYYY HH:mm')}`;
	}
	onChooseItem(f: TFile) {
		this.onPick(f);
	}
}

/** Notes and documents (PDF, Office, EPUB, canvas…) that can be attached to the chat. */
class DocPicker extends FuzzySuggestModal<TFile> {
	constructor(
		plugin: AmbraiaPlugin,
		private onPick: (f: TFile) => void,
	) {
		super(plugin.app);
		this.setPlaceholder(tx('Aggiungi una nota o un documento al contesto…'));
	}
	getItems() {
		return this.app.vault
			.getFiles()
			.filter(isReadable)
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}
	getItemText(f: TFile) {
		return f.extension === 'md' ? f.path.replace(/\.md$/, '') : f.path;
	}
	onChooseItem(f: TFile) {
		this.onPick(f);
	}
}

class ProjectPicker extends FuzzySuggestModal<Project | null> {
	constructor(
		plugin: AmbraiaPlugin,
		private items: (Project | null)[],
		private onPick: (p: Project | null) => void,
	) {
		super(plugin.app);
		this.setPlaceholder(tx('Scegli un progetto…'));
	}
	getItems() {
		return this.items;
	}
	getItemText(p: Project | null) {
		return p ? p.name : tx('— Nessun progetto (tutto il vault)');
	}
	onChooseItem(p: Project | null) {
		this.onPick(p);
	}
}

export class AiChatView extends ItemView {
	entries: ChatEntry[] = [];
	mode: ChatMode;
	modelId = '';
	includeActive: boolean;
	extraNotes: string[] = [];
	selections: { text: string; source: string }[] = [];
	images: string[] = [];
	chatFile: TFile | null = null;
	project: Project | null = null;
	private projectBtn!: HTMLElement;
	private created = moment().format('YYYY-MM-DD HH:mm');
	private abort: AbortController | null = null;
	private listEl!: HTMLElement;
	private chipsEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLElement;
	private modelSel!: HTMLSelectElement;
	private modeSel!: HTMLSelectElement;
	private relatedEl!: HTMLElement;
	private relatedTimer: number | null = null;
	private renderers = new Map<HTMLElement, Component>();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: AmbraiaPlugin,
	) {
		super(leaf);
		this.mode = plugin.settings.aiDefaultMode;
		this.includeActive = plugin.settings.aiIncludeActiveNote;
	}

	getViewType() {
		return AI_CHAT_VIEW;
	}
	getDisplayText() {
		return tx('Ambraia AI');
	}
	getIcon() {
		return 'sparkles';
	}

	get busy() {
		return !!this.abort;
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass('ambraia-ai-chat');

		const head = root.createDiv('ambraia-ai-head');
		head.createDiv({ cls: 'ambraia-ai-title', text: tx('Ambraia AI') });
		const tools = head.createDiv('ambraia-ai-head-tools');
		const hb = (icon: string, label: string, fn: (e: MouseEvent) => void) => {
			const b = tools.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.onclick = fn;
			return b;
		};
		hb('plus', tx('Nuova chat'), () => this.newChat());
		hb('history', tx('Chat precedenti'), () => this.openHistory());
		hb('save', tx('Salva la chat come nota'), () => void this.saveChat(true));
		hb('settings', tx('Impostazioni AI'), () => this.plugin.openSettings());

		this.listEl = root.createDiv('ambraia-ai-list');
		this.listEl.addEventListener('click', (e) => {
			const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.internal-link');
			if (!a) return;
			e.preventDefault();
			const href = a.dataset.href ?? a.getAttr('href') ?? '';
			if (href) void this.app.workspace.openLinkText(href, '', Keymap.isModEvent(e) ? 'tab' : false);
		});

		this.relatedEl = root.createEl('details', { cls: 'ambraia-ai-related' });

		const composer = root.createDiv('ambraia-ai-composer');
		this.chipsEl = composer.createDiv('ambraia-ai-chips');
		this.inputEl = composer.createEl('textarea', { cls: 'ambraia-ai-input', attr: { rows: '2' } });
		this.inputEl.addEventListener('keydown', (e) => this.onKey(e));
		this.inputEl.addEventListener('input', () => this.onInput());
		this.inputEl.addEventListener('paste', (e) => this.onPaste(e));
		composer.addEventListener('dragover', (e) => e.preventDefault());
		composer.addEventListener('drop', (e) => this.onDrop(e));

		// two groups: choices on the left (shrink and ellipsize), actions on the right (never cut)
		const bar = composer.createDiv('ambraia-ai-composer-bar');
		const left = bar.createDiv('ambraia-ai-bar-left');
		const right = bar.createDiv('ambraia-ai-bar-right');
		this.modeSel = left.createEl('select', { cls: 'dropdown ambraia-ai-mode', attr: { 'aria-label': tx('Modalità') } });
		for (const [k, v] of Object.entries(MODE_LABELS)) this.modeSel.createEl('option', { value: k, text: v });
		this.modeSel.onchange = () => {
			this.mode = this.modeSel.value as ChatMode;
			this.updatePlaceholder();
		};
		this.modelSel = left.createEl('select', { cls: 'dropdown ambraia-ai-model-sel', attr: { 'aria-label': tx('Modello') } });
		this.modelSel.onchange = () => {
			if (this.modelSel.value === '__add') {
				this.fillModels();
				this.plugin.openAiSetup();
				return;
			}
			this.modelId = this.modelSel.value;
		};
		this.projectBtn = left.createDiv({ cls: 'clickable-icon ambraia-ai-project', attr: { 'aria-label': tx('Progetto') } });
		this.projectBtn.onclick = () => void this.pickProject();
		const attach = right.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': tx('Aggiungi una nota al contesto') } });
		setIcon(attach, 'paperclip');
		attach.onclick = () => this.pickNote();
		const quick = right.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': tx('Azioni rapide sulla nota attiva') } });
		setIcon(quick, 'zap');
		quick.onclick = (e) => void this.quickMenu(e);
		this.sendBtn = right.createDiv({ cls: 'ambraia-ai-send', attr: { 'aria-label': tx('Invia (Invio)') } });
		this.sendBtn.onclick = () => (this.busy ? this.stop() : void this.send());

		this.registerEvent(this.app.workspace.on('file-open', () => {
			this.renderChips();
			this.scheduleRelated();
		}));
		this.refresh();
		this.scheduleRelated(50);
	}

	async onClose() {
		this.abort?.abort();
		if (this.relatedTimer) window.clearTimeout(this.relatedTimer);
		for (const c of this.renderers.values()) c.unload();
		this.renderers.clear();
	}

	/** Re-reads settings (models, mode) and redraws everything. */
	refresh() {
		if (!this.listEl) return;
		this.modeSel.value = this.mode;
		this.fillModels();
		this.renderProject();
		this.updatePlaceholder();
		this.renderChips();
		this.renderList();
		this.updateSend();
	}

	private fillModels() {
		const sel = this.modelSel;
		sel.empty();
		const ms = this.plugin.ai.models();
		for (const m of ms) sel.createEl('option', { value: m.id, text: modelLabel(m) });
		sel.createEl('option', { value: '__add', text: tx('＋ Aggiungi modello…') });
		const cur = this.plugin.ai.model(this.modelId);
		this.modelId = cur?.id ?? '';
		sel.value = cur ? cur.id : '__add';
	}

	private updatePlaceholder() {
		const ph: Record<ChatMode, string> = {
			chat: tx('Scrivi un messaggio…  [[ per allegare una nota · Invio per inviare'),
			vault: tx('Fai una domanda sulle tue note…'),
			agent: tx('Chiedi di cercare, creare o modificare note…'),
		};
		this.inputEl.placeholder = ph[this.mode];
	}

	private updateSend() {
		this.sendBtn.empty();
		setIcon(this.sendBtn, this.busy ? 'square' : 'arrow-up');
		this.sendBtn.toggleClass('is-busy', this.busy);
		this.sendBtn.setAttr('aria-label', this.busy ? tx('Interrompi (Esc)') : tx('Invia (Invio)'));
	}

	focusInput() {
		this.inputEl?.focus();
	}

	// ---------------------------------------------------------------- context

	activeFile(): TFile | null {
		const f = this.app.workspace.getActiveFile() ?? this.plugin.lastMarkdownView?.file ?? null;
		return f && f.extension === 'md' ? f : null;
	}

	addSelection(text: string, source: string) {
		if (!text.trim()) return;
		this.selections.push({ text, source });
		this.renderChips();
		this.focusInput();
	}

	addNote(path: string) {
		if (!this.extraNotes.includes(path)) this.extraNotes.push(path);
		this.renderChips();
	}

	private renderChips() {
		const c = this.chipsEl;
		if (!c) return;
		c.empty();
		const chip = (icon: string, text: string, opts: { off?: boolean; title?: string; onClick?: () => void; onRemove?: () => void }) => {
			const el = c.createDiv({ cls: 'ambraia-ai-chip' + (opts.off ? ' is-off' : ''), attr: { 'aria-label': opts.title ?? text } });
			setIcon(el.createSpan('ambraia-ai-chip-icon'), icon);
			el.createSpan({ cls: 'ambraia-ai-chip-text', text });
			if (opts.onClick) el.onclick = opts.onClick;
			if (opts.onRemove) {
				const x = el.createSpan('ambraia-ai-chip-x');
				setIcon(x, 'x');
				x.onclick = (e) => {
					e.stopPropagation();
					opts.onRemove!();
					this.renderChips();
				};
			}
		};
		const act = this.activeFile();
		if (act && !this.extraNotes.includes(act.path))
			chip(this.includeActive ? 'file-check' : 'file-x', act.basename, {
				off: !this.includeActive,
				title: this.includeActive ? tx('Nota attiva inclusa nel contesto (clic per escluderla)') : tx('Nota attiva esclusa (clic per includerla)'),
				onClick: () => {
					this.includeActive = !this.includeActive;
					this.renderChips();
				},
			});
		this.extraNotes.forEach((p, i) => chip('file-text', p.split('/').pop()!.replace(/\.md$/, ''), { title: p, onRemove: () => this.extraNotes.splice(i, 1) }));
		this.selections.forEach((s, i) => chip('text-select', `“${s.text.slice(0, 28).replace(/\s+/g, ' ')}${s.text.length > 28 ? '…' : ''}”`, { title: tx('Selezione da {0}', s.source), onRemove: () => this.selections.splice(i, 1) }));
		this.images.forEach((_s, i) => chip('image', tx('Immagine {0}', i + 1), { onRemove: () => this.images.splice(i, 1) }));
	}

	private pickNote() {
		new DocPicker(this.plugin, (f) => {
			this.addNote(f.path);
			this.focusInput();
		}).open();
	}

	/** Builds the context block sent with the user's message; returns it with the list of note paths used. */
	async buildContext(text: string): Promise<{ block: string; paths: string[] }> {
		const budget = this.plugin.settings.aiContextChars;
		const paths: string[] = [];
		const act = this.activeFile();
		if (act && this.includeActive) paths.push(act.path);
		for (const p of this.extraNotes) if (!paths.includes(p)) paths.push(p);
		// [[links]] typed in the message are attached too
		for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
			const f = this.app.metadataCache.getFirstLinkpathDest(m[1].trim(), act?.path ?? '');
			if (f && isReadable(f) && !paths.includes(f.path)) paths.push(f.path);
		}
		const urls = this.plugin.settings.aiWebAccess ? [...new Set(text.match(URL_RE) ?? [])].slice(0, 4) : [];
		const parts: string[] = [];
		const per = Math.max(1500, Math.floor(budget / Math.max(1, paths.length + urls.length + this.selections.length)));
		for (const p of paths) {
			const f = this.app.vault.getAbstractFileByPath(p);
			if (!(f instanceof TFile)) continue;
			let body: string;
			try {
				body = clip(await fileText(this.app, f), per);
			} catch (e) {
				body = tx('(impossibile leggere il file: {0})', e instanceof Error ? e.message : String(e));
			}
			parts.push(tx('<nota percorso="{0}"{1}>\n{2}\n</nota>', p, f === act ? tx(' attiva="sì"') : '', body));
		}
		for (const u of urls) {
			try {
				const d = await fetchWeb(u, this.plugin.ai.webCtx());
				parts.push(tx('<pagina-web url="{0}" titolo="{1}" tipo="{2}">\n{3}\n</pagina-web>', d.url, d.title.replace(/"/g, "'"), d.kind, clip(d.text, per)));
				paths.push(u);
			} catch (e) {
				new Notice(tx('Non riesco a leggere {0}: {1}', u, e instanceof Error ? e.message : String(e)));
			}
		}
		for (const s of this.selections) parts.push(tx('<selezione da="{0}">\n{1}\n</selezione>', s.source, s.text.slice(0, per)));
		return { block: parts.join('\n\n'), paths };
	}

	// ---------------------------------------------------------------- input

	private onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			if (!this.busy) void this.send();
		} else if (e.key === 'Escape' && this.busy) {
			e.preventDefault();
			this.stop();
		}
	}

	private onInput() {
		const el = this.inputEl;
		el.setCssProps({ height: 'auto' });
		el.setCssProps({ height: `${Math.min(220, el.scrollHeight)}px` });
		const pos = el.selectionStart ?? el.value.length;
		if (el.value.slice(pos - 2, pos) === '[[') {
			new DocPicker(this.plugin, (f) => {
				const v = el.value;
				const ins = `${f.extension === 'md' ? f.basename : f.name}]]`;
				el.value = v.slice(0, pos) + ins + v.slice(pos);
				el.selectionStart = el.selectionEnd = pos + ins.length;
				el.focus();
			}).open();
		}
	}

	private readImage(file: File) {
		if (!file.type.startsWith('image/')) return false;
		if (file.size > 8 * 1024 * 1024) {
			new Notice(tx('Immagine troppo grande (max 8 MB).'));
			return true;
		}
		const r = new FileReader();
		r.onload = () => {
			if (typeof r.result === 'string') this.images.push(r.result);
			this.renderChips();
		};
		r.readAsDataURL(file);
		return true;
	}

	private onPaste(e: ClipboardEvent) {
		const files = [...(e.clipboardData?.files ?? [])];
		if (files.some((f) => this.readImage(f))) e.preventDefault();
	}

	private onDrop(e: DragEvent) {
		const files = [...(e.dataTransfer?.files ?? [])];
		if (files.length) {
			e.preventDefault();
			files.forEach((f) => this.readImage(f));
			return;
		}
		// a note dragged from the file explorer
		const text = e.dataTransfer?.getData('text/plain') ?? '';
		const m = /\[\[([^\]]+)\]\]/.exec(text) ?? /obsidian:\/\/open\?.*file=([^&]+)/.exec(text);
		if (m) {
			e.preventDefault();
			const f = this.app.metadataCache.getFirstLinkpathDest(decodeURIComponent(m[1]), '');
			if (f) this.addNote(f.path);
		}
	}

	private async quickMenu(e: MouseEvent) {
		const menu = new Menu();
		const act = this.activeFile();
		const fixed: [string, string, string][] = [
			[tx('Riassumi la nota attiva'), 'list-collapse', tx('Riassumi la nota attiva in punti chiave.')],
			[tx('Estrai le attività'), 'list-checks', tx('Estrai dalla nota attiva tutte le attività da fare come elenco di caselle Markdown (- [ ]).')],
			[tx('Suggerisci titoli e tag'), 'tags', tx('Suggerisci 5 titoli e 5 tag adatti alla nota attiva.')],
			[tx('Domande di ripasso'), 'graduation-cap', tx('Crea 8 domande di ripasso con risposta sulla nota attiva.')],
		];
		for (const [title, icon, text] of fixed)
			menu.addItem((i) =>
				i
					.setTitle(title)
					.setIcon(icon)
					.setDisabled(!act)
					.onClick(() => {
						this.includeActive = true;
						void this.send(text);
					}),
			);
		const custom = (await allActions(this.plugin)).filter((a) => a.group === 'personalizzato');
		if (custom.length) {
			menu.addSeparator();
			for (const a of custom)
				menu.addItem((i) =>
					i
						.setTitle(a.title)
						.setIcon(a.icon)
						.onClick(async () => {
							const sel = this.selections.map((s) => s.text).join('\n\n');
							const expanded = await expandTemplate(this.app, a.prompt, sel, act);
							this.selections = [];
							void this.send(a.title, { content: expanded, noContext: true });
						}),
				);
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(tx('Nuovo prompt personalizzato…')).setIcon('file-plus-2').onClick(() => void this.plugin.createSamplePrompt()));
		menu.showAtMouseEvent(e);
	}

	// ---------------------------------------------------------------- conversation

	// ---------------------------------------------------------------- projects

	private renderProject() {
		const b = this.projectBtn;
		if (!b) return;
		b.empty();
		setIcon(b.createSpan(), 'folder-kanban');
		if (this.project) b.createSpan({ cls: 'ambraia-ai-project-name', text: this.project.name });
		b.toggleClass('is-active', !!this.project);
		b.setAttr('aria-label', this.project ? tx('Progetto: {0} (clic per cambiare)', this.project.name) : tx('Scegli un progetto'));
	}

	async pickProject() {
		const list = await listProjects(this.app, this.plugin.settings.aiProjectsFolder);
		if (!list.length) {
			new Notice(tx('Nessun progetto ancora: ne creo uno di esempio da completare.'));
			await this.plugin.createProject();
			return;
		}
		new ProjectPicker(this.plugin, [null, ...list], (p) => void this.setProject(p)).open();
	}

	/** Activates a project (or none); applies its preferred model and mode. */
	async setProject(p: Project | string | null) {
		if (typeof p === 'string') {
			const f = this.app.vault.getAbstractFileByPath(p);
			p = f instanceof TFile ? parseProject(f.path, await this.app.vault.cachedRead(f)) : null;
		}
		this.project = p;
		if (p?.model) {
			const want = p.model.toLowerCase();
			const m = this.plugin.ai.models().find((x) => x.id === p.model || x.model.toLowerCase() === want || modelLabel(x).toLowerCase() === want);
			if (m) this.modelId = m.id;
			else new Notice(tx('Il modello “{0}” del progetto non è configurato: uso quello attuale.', p.model));
		}
		if (p?.mode && p.mode in MODE_LABELS) this.mode = p.mode as ChatMode;
		this.refresh();
	}

	/** Re-reads the active project note (instructions may have changed). */
	private async freshProject(): Promise<Project | null> {
		if (!this.project) return null;
		const f = this.app.vault.getAbstractFileByPath(this.project.path);
		if (!(f instanceof TFile)) return (this.project = null);
		return (this.project = parseProject(f.path, await this.app.vault.cachedRead(f)));
	}

	newChat() {
		this.stop();
		this.entries = [];
		this.chatFile = null;
		this.selections = [];
		this.images = [];
		this.extraNotes = [];
		this.created = moment().format('YYYY-MM-DD HH:mm');
		this.mode = this.plugin.settings.aiDefaultMode;
		this.includeActive = this.plugin.settings.aiIncludeActiveNote;
		this.refresh();
		this.focusInput();
	}

	stop() {
		this.abort?.abort();
	}

	private chatFiles(): TFile[] {
		const root = this.app.vault.getAbstractFileByPath(normalizePath(this.plugin.settings.aiChatsFolder || 'Ambraia/Chat'));
		if (!(root instanceof TFolder)) return [];
		const out: TFile[] = [];
		const walk = (f: TFolder) => f.children.forEach((c) => (c instanceof TFolder ? walk(c) : c instanceof TFile && c.extension === 'md' && out.push(c)));
		walk(root);
		return out.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	openHistory() {
		const files = this.chatFiles();
		if (!files.length) return new Notice(tx('Nessuna chat salvata finora.'));
		new ChatHistoryPicker(this.plugin, files, (f) => void this.loadChat(f)).open();
	}

	async loadChat(f: TFile) {
		this.stop();
		const { entries, mode, created, project } = markdownToChat(await this.app.vault.read(f));
		this.entries = entries;
		if (mode) this.mode = mode;
		if (project) {
			const pf = this.app.vault.getAbstractFileByPath(project);
			this.project = pf instanceof TFile ? parseProject(pf.path, await this.app.vault.cachedRead(pf)) : null;
		}
		if (created) this.created = created;
		this.chatFile = f;
		this.refresh();
	}

	private chatTitle(): string {
		const first = this.entries.find((e) => e.role === 'user');
		const t = sanitizeFileName((first?.display ?? first?.content ?? tx('Chat')).replace(/\s+/g, ' ').trim()).slice(0, 50).trim();
		return `${moment().format('YYYY-MM-DD HHmm')} ${t || 'Chat'}`;
	}

	async saveChat(explicit = false): Promise<TFile | null> {
		if (!this.entries.some((e) => e.role === 'assistant' && !e.error)) {
			if (explicit) new Notice(tx('Non c’è ancora niente da salvare.'));
			return null;
		}
		const m = this.plugin.ai.model(this.modelId);
		const md = chatToMarkdown(this.entries, { mode: this.mode, model: m ? modelLabel(m) : '', created: this.created, project: this.project?.path });
		const vault = this.app.vault;
		if (this.chatFile && vault.getAbstractFileByPath(this.chatFile.path)) {
			await vault.modify(this.chatFile, md);
		} else {
			const folder = normalizePath(this.plugin.settings.aiChatsFolder || 'Ambraia/Chat');
			if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined);
			this.chatFile = await vault.create(availablePath(this.app, folder, this.chatTitle(), 'md'), md);
		}
		if (explicit) {
			new Notice(tx('Chat salvata in “{0}”.', this.chatFile.path));
			await this.app.workspace.getLeaf('tab').openFile(this.chatFile);
		}
		return this.chatFile;
	}

	/** Sends a message. `override.content` replaces the API content (custom prompts). */
	async send(text?: string, override: { content?: string; noContext?: boolean } = {}) {
		if (this.busy) return;
		const typed = text ?? this.inputEl.value.trim();
		if (!typed && !this.images.length) return;
		if (!this.plugin.ai.ready) {
			this.plugin.openAiSetup();
			return;
		}
		if (text === undefined) {
			this.inputEl.value = '';
			this.onInput();
		}
		const ctx = override.noContext ? { block: '', paths: [] as string[] } : await this.buildContext(typed);
		const body = override.content ?? typed;
		const content = ctx.block ? tx('Contesto allegato dall’utente:\n\n{0}\n\n---\n\n{1}', ctx.block, body) : body;
		this.entries.push({ role: 'user', content, display: typed || '(immagine)', images: this.images.length ? [...this.images] : undefined, context: ctx.paths.length ? ctx.paths : undefined });
		this.selections = [];
		this.images = [];
		this.renderChips();
		await this.generate();
	}

	/** History sent to the model: last N turns; context of older user turns trimmed to keep requests small. */
	history(): ChatMsg[] {
		const turns = Math.max(1, this.plugin.settings.aiHistoryTurns) * 2;
		const list = this.entries.filter((e) => !e.error).slice(-turns);
		return list.map((e, i) => {
			const last = i === list.length - 1;
			const content = e.role === 'assistant' ? stripThinking(e.content) : last ? e.content : e.content.length > 6000 ? (e.display ?? e.content.slice(-6000)) : e.content;
			return { role: e.role, content, images: last ? e.images : undefined };
		});
	}

	async regenerate() {
		if (this.busy) return;
		while (this.entries.length && this.entries[this.entries.length - 1].role === 'assistant') this.entries.pop();
		if (!this.entries.length) return;
		await this.generate();
	}

	private async generate() {
		const history = this.history();
		const entry: ChatEntry = { role: 'assistant', content: '' };
		this.entries.push(entry);
		this.abort = new AbortController();
		this.renderList();
		const el = this.listEl.lastElementChild as HTMLElement;
		const bodyEl = el.querySelector<HTMLElement>('.ambraia-ai-body')!;
		const toolsEl = el.querySelector<HTMLElement>('.ambraia-ai-tools')!;
		const signal = this.abort.signal;
		this.updateSend();
		let last = 0;
		let pending: number | null = null;
		const paint = () => {
			pending = null;
			last = Date.now();
			this.renderBody(bodyEl, entry.content, true);
			this.scrollDown();
		};
		const toolRows = new Map<string, HTMLElement>();
		const stepIdx = new Map<string, number>();
		try {
			const r = await this.plugin.ai.run(
				history,
				this.mode,
				{
					signal,
					onToken: (t) => {
						entry.content += t;
						if (pending) return;
						const wait = Math.max(0, 120 - (Date.now() - last));
						pending = window.setTimeout(paint, wait);
					},
					onToolStart: (id, label) => {
						(entry.steps ??= []).push({ label });
						stepIdx.set(id, entry.steps.length - 1);
						const row = toolsEl.createDiv({ cls: 'ambraia-ai-tool is-running' });
						setIcon(row.createSpan('ambraia-ai-tool-icon'), 'loader');
						row.createSpan({ text: label });
						toolRows.set(id, row);
						this.scrollDown();
					},
					onToolEnd: (id, ok) => {
						const si = stepIdx.get(id);
						if (si !== undefined && entry.steps) entry.steps[si].ok = ok;
						const row = toolRows.get(id);
						if (!row) return;
						row.removeClass('is-running');
						row.addClass(ok ? 'is-ok' : 'is-failed');
						const ic = row.querySelector<HTMLElement>('.ambraia-ai-tool-icon');
						if (ic) {
							ic.empty();
							setIcon(ic, ok ? 'check' : 'x');
						}
					},
					onNotice: (t) => {
						(entry.steps ??= []).push({ label: t, note: true });
						toolsEl.createDiv({ cls: 'ambraia-ai-tool is-note', text: t });
					},
					onSearch: (x) => (entry.searches ??= []).push(x),
					confirm: (title, preview) => this.confirmCard(toolsEl, title, preview),
					project: await this.freshProject(),
				},
				this.modelId,
			);
			if (pending) window.clearTimeout(pending);
			entry.content = r.text || entry.content;
			entry.sources = r.sources.length ? r.sources : undefined;
			if (r.aborted) entry.content += (entry.content ? '\n\n' : '') + '_(interrotto)_';
		} catch (e) {
			if (pending) window.clearTimeout(pending);
			entry.error = true;
			entry.content = e instanceof Error ? e.message : String(e);
		} finally {
			this.abort = null;
			this.updateSend();
		}
		this.renderList();
		if (!entry.error && this.plugin.settings.aiAutosave) {
			try {
				await this.saveChat(false);
			} catch (e) {
				console.warn(tx('Ambraia AI: salvataggio chat non riuscito'), e);
			}
		}
	}

	private confirmCard(parent: HTMLElement, title: string, preview: string): Promise<boolean> {
		return new Promise((resolve) => {
			const card = parent.createDiv('ambraia-ai-confirm');
			card.createDiv({ cls: 'ambraia-ai-confirm-title', text: title });
			if (preview) card.createEl('pre', { cls: 'ambraia-ai-confirm-preview', text: preview.length > 1500 ? preview.slice(0, 1500) + '\n…' : preview });
			const bar = card.createDiv('ambraia-ai-confirm-bar');
			const finish = (ok: boolean) => {
				bar.empty();
				bar.createSpan({ cls: ok ? 'ambraia-ai-ok' : 'ambraia-ai-muted', text: ok ? tx('Consentito') : tx('Rifiutato') });
				this.abort?.signal.removeEventListener('abort', onAbort);
				resolve(ok);
			};
			const onAbort = () => finish(false);
			this.abort?.signal.addEventListener('abort', onAbort);
			const yes = bar.createEl('button', { cls: 'mod-cta', text: tx('Consenti') });
			yes.onclick = () => finish(true);
			const no = bar.createEl('button', { text: tx('Rifiuta') });
			no.onclick = () => finish(false);
			this.scrollDown();
		});
	}

	// ---------------------------------------------------------------- rendering

	private scrollDown() {
		const l = this.listEl;
		if (l) l.scrollTop = l.scrollHeight;
	}

	private renderBody(el: HTMLElement, text: string, streaming: boolean) {
		const prev = this.renderers.get(el);
		prev?.unload();
		this.renderers.delete(el);
		el.empty();
		const { thinking, answer, open } = splitThinking(text);
		if (thinking) {
			const d = el.createEl('details', { cls: 'ambraia-ai-think' });
			if (open && streaming) d.open = true;
			d.createEl('summary', { text: open && streaming ? tx('Sto ragionando…') : tx('Ragionamento') });
			d.createDiv({ cls: 'ambraia-ai-think-text', text: thinking });
		}
		const md = el.createDiv('ambraia-ai-md markdown-rendered');
		if (!answer && streaming) {
			if (!thinking) md.createDiv({ cls: 'ambraia-ai-typing', text: '…' });
			return;
		}
		const comp = new Component();
		comp.load();
		this.renderers.set(el, comp);
		const src = this.activeFile()?.path ?? '';
		void MarkdownRenderer.render(this.app, answer, md, src, comp);
	}

	renderList() {
		const l = this.listEl;
		if (!l) return;
		for (const c of this.renderers.values()) c.unload();
		this.renderers.clear();
		l.empty();
		if (!this.entries.length) return this.renderEmpty();
		this.entries.forEach((e, idx) => {
			const msg = l.createDiv(`ambraia-ai-msg is-${e.role}` + (e.error ? ' is-error' : ''));
			if (e.role === 'user') {
				const b = msg.createDiv({ cls: 'ambraia-ai-bubble', text: e.display ?? e.content });
				if (e.images?.length) {
					const row = b.createDiv('ambraia-ai-imgs');
					for (const u of e.images) row.createEl('img', { attr: { src: u } });
				}
				if (e.context?.length) msg.createDiv({ cls: 'ambraia-ai-ctx', text: tx('Contesto: ') + e.context.map((p) => (/^https?:/.test(p) ? p.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40) : p.split('/').pop()!.replace(/\.md$/, ''))).join(', ') });
				return;
			}
			const tl = msg.createDiv('ambraia-ai-tools');
			for (const st of e.steps ?? []) {
				if (st.note) {
					tl.createDiv({ cls: 'ambraia-ai-tool is-note', text: st.label });
					continue;
				}
				const row = tl.createDiv({ cls: 'ambraia-ai-tool ' + (st.ok === undefined ? 'is-running' : st.ok ? 'is-ok' : 'is-failed') });
				setIcon(row.createSpan('ambraia-ai-tool-icon'), st.ok === undefined ? 'loader' : st.ok ? 'check' : 'x');
				row.createSpan({ text: st.label });
			}
			const body = msg.createDiv('ambraia-ai-body');
			if (e.error) {
				body.createDiv({ cls: 'ambraia-ai-error', text: e.content });
				const bar = msg.createDiv('ambraia-ai-actions');
				const retry = bar.createEl('button', { text: tx('Riprova') });
				retry.onclick = () => void this.regenerate();
				const cfg = bar.createEl('button', { text: tx('Configura l’AI') });
				cfg.onclick = () => this.plugin.openAiSetup();
				return;
			}
			const streaming = this.busy && idx === this.entries.length - 1;
			this.renderBody(body, e.content, streaming);
			if (streaming) return;
			if (e.sources?.length) {
				const s = msg.createDiv('ambraia-ai-sources');
				s.createSpan({ text: tx('Fonti: ') });
				for (const p of e.sources) {
					const a = s.createEl('a', { cls: 'ambraia-ai-source', text: p.split('/').pop()!.replace(/\.md$/, '') });
					a.onclick = (ev) => {
						const f = this.app.vault.getAbstractFileByPath(p);
						if (f instanceof TFile) void this.plugin.openFile(f, Keymap.isModEvent(ev) ? 'tab' : false);
					};
				}
			}
			for (const g of e.searches ?? []) renderSearchSuggestions(msg, g);
			this.renderActions(msg, e, idx === this.entries.length - 1);
		});
		this.scrollDown();
	}

	private renderActions(msg: HTMLElement, e: ChatEntry, isLast: boolean) {
		const bar = msg.createDiv('ambraia-ai-actions');
		const text = () => stripThinking(e.content).replace(/\n*_\(interrotto\)_$/, '');
		const act = (icon: string, label: string, fn: () => void) => {
			const b = bar.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.onclick = fn;
		};
		act('copy', tx('Copia'), () => {
			void navigator.clipboard?.writeText(text());
			new Notice(tx('Copiato.'));
		});
		act('text-cursor-input', tx('Inserisci nella nota al cursore'), () => this.insert(text(), false));
		act('replace', tx('Sostituisci la selezione nella nota'), () => this.insert(text(), true));
		act('file-plus-2', tx('Crea una nuova nota con la risposta'), () => void this.toNote(text()));
		if (isLast) act('rotate-ccw', tx('Rigenera'), () => void this.regenerate());
	}

	private editorView(): MarkdownView | null {
		const v = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.plugin.lastMarkdownView;
		return v && v.file && this.app.workspace.getLeavesOfType('markdown').some((l) => l.view === v) ? v : null;
	}

	insert(text: string, replace: boolean) {
		const v = this.editorView();
		if (!v) return new Notice(tx('Apri una nota in modalità modifica per inserire la risposta.'));
		if (v.getMode() !== 'source') return new Notice(tx('Passa la nota in modalità modifica per inserire la risposta.'));
		const ed = v.editor;
		if (replace && !ed.somethingSelected()) return new Notice(tx('Nessun testo selezionato nella nota.'));
		ed.replaceSelection(text);
		void markAiContent(this.app, v.file, this.plugin.settings.aiMarkOutput);
		new Notice(replace ? tx('Selezione sostituita.') : tx('Inserito in “{0}”.', v.file?.basename));
	}

	async toNote(text: string) {
		const firstLine = text.split('\n').find((l) => l.trim()) ?? tx('Risposta AI');
		const title = sanitizeFileName(firstLine.replace(/^#+\s*|[*_`>]/g, '').trim()).slice(0, 60) || tx('Risposta AI');
		const parent = this.app.fileManager.getNewFileParent(this.activeFile()?.path ?? '');
		const f = await this.app.vault.create(availablePath(this.app, parent.isRoot() ? '' : parent.path, title, 'md'), text + '\n');
		await markAiContent(this.app, f, this.plugin.settings.aiMarkOutput, true);
		await this.app.workspace.getLeaf('tab').openFile(f);
	}

	private renderEmpty() {
		const box = this.listEl.createDiv('ambraia-ai-empty');
		setIcon(box.createDiv({ cls: 'ambraia-ai-empty-icon' }), 'sparkles');
		if (!this.plugin.ai.ready) {
			box.createDiv({ cls: 'ambraia-ai-empty-title', text: tx('Collega un’AI per iniziare') });
			box.createDiv({ cls: 'ambraia-ai-empty-text', text: tx('Funziona con AI locali (LM Studio, Ollama) e cloud (OpenAI, Claude, Gemini, OpenRouter, Groq, Mistral…).') });
			const b = box.createEl('button', { cls: 'mod-cta', text: tx('Configura l’AI') });
			b.onclick = () => this.plugin.openAiSetup();
			return;
		}
		box.createDiv({ cls: 'ambraia-ai-empty-title', text: tx('Come posso aiutarti?') });
		const sug: [ChatMode, string][] = [
			['chat', tx('Riassumi la nota attiva in 5 punti')],
			['vault', tx('Cosa ho scritto di recente su questo argomento?')],
			['agent', tx('Aggiungi alla nota di oggi un elenco delle cose da fare')],
			['agent', tx('Crea una nota con un piano settimanale')],
		];
		const list = box.createDiv('ambraia-ai-suggestions');
		for (const [mode, text] of sug) {
			const s = list.createDiv({ cls: 'ambraia-ai-suggestion' });
			s.createSpan({ cls: 'ambraia-ai-suggestion-mode', text: MODE_LABELS[mode] });
			s.createSpan({ text });
			s.onclick = () => {
				this.mode = mode;
				this.modeSel.value = mode;
				this.updatePlaceholder();
				this.inputEl.value = text;
				this.focusInput();
			};
		}
	}

	// ---------------------------------------------------------------- related notes

	private scheduleRelated(delay = 600) {
		if (this.relatedTimer) window.clearTimeout(this.relatedTimer);
		this.relatedTimer = window.setTimeout(() => {
			this.relatedTimer = null;
			void this.renderRelated();
		}, delay);
	}

	async renderRelated() {
		const d = this.relatedEl as HTMLDetailsElement;
		if (!d) return;
		const f = this.activeFile();
		if (!this.plugin.settings.aiRelevantNotes || !f) {
			d.hide();
			return;
		}
		d.show();
		const wasOpen = d.open;
		d.empty();
		d.open = wasOpen;
		d.createEl('summary', { text: tx('Note correlate a “{0}”', f.basename) });
		const list = d.createDiv('ambraia-ai-related-list');
		try {
			const rel = await this.plugin.ai.relevantNotes(f, 8);
			if (this.activeFile() !== f) return;
			if (!rel.length) list.createDiv({ cls: 'ambraia-ai-muted', text: tx('Nessuna nota correlata trovata.') });
			for (const r of rel) {
				const row = list.createDiv('ambraia-ai-related-row');
				const a = row.createEl('a', { text: r.file.basename });
				a.onclick = (e) => void this.plugin.openFile(r.file, Keymap.isModEvent(e) ? 'tab' : false);
				row.createSpan({ cls: 'ambraia-ai-muted', text: r.reason });
				const add = row.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': tx('Aggiungi al contesto della chat') } });
				setIcon(add, 'plus');
				add.onclick = () => this.addNote(r.file.path);
			}
		} catch {
			list.createDiv({ cls: 'ambraia-ai-muted', text: tx('Impossibile calcolare le note correlate.') });
		}
	}
}

/**
 * Google Search Suggestions, shown as required by the Gemini API terms for "Grounding with Google
 * Search": Google's own snippet in a sandboxed frame (no scripts, links open in the browser), or
 * plain links to the searches when the snippet is missing.
 */
export function renderSearchSuggestions(parent: HTMLElement, g: { html?: string; queries: string[] }) {
	const box = parent.createDiv('ambraia-ai-google');
	if (g.html) {
		const f = box.createEl('iframe', { cls: 'ambraia-ai-google-frame', attr: { sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer', title: tx('Suggerimenti di ricerca Google') } });
		f.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:0}</style>${g.html}`;
		return;
	}
	box.createSpan({ text: tx('Ricerche Google: ') });
	for (const q of g.queries) box.createEl('a', { cls: 'ambraia-chip', text: q, href: 'https://www.google.com/search?q=' + encodeURIComponent(q) });
}
