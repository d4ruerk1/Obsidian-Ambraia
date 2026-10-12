import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, SuggestModal, TFile } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { dailyConfig, findPeriodic, periodicPath } from '../calendar/dates';
import { getIconFor, moment, renderIcon, type Moment } from '../ui/util';
import { inCode, normalize } from './slash';
import { tx } from '../i18n';

/** Returns the "@query" typed right before the cursor (not inside words, e-mails or links). */
export function matchMention(before: string): { start: number; query: string } | null {
	const idx = before.lastIndexOf('@');
	if (idx < 0) return null;
	const prev = idx === 0 ? '' : before[idx - 1];
	if (prev && !/[\s([{>"'«]/.test(prev)) return null;
	const q = before.slice(idx + 1);
	if (q.length > 40 || /^\s/.test(q) || /\s{2}/.test(q) || /[[\]|#^@]/.test(q)) return null;
	return { start: idx, query: q };
}

export interface PageHit {
	file: TFile;
	score: number;
	/** the alias that matched, if not the title */
	alias?: string;
}

function aliasesOf(plugin: AmbraiaPlugin, f: TFile): string[] {
	const a: unknown = plugin.app.metadataCache.getFileCache(f)?.frontmatter?.aliases;
	if (Array.isArray(a)) return a.filter((x): x is string => typeof x === 'string');
	return typeof a === 'string' ? [a] : [];
}

/** Accent-insensitive score: exact > prefix > word start > substring > in order (0 = no match). */
export function scoreText(text: string, q: string): number {
	const t = normalize(text);
	if (!q) return 1;
	if (t === q) return 100;
	if (t.startsWith(q)) return 80 - Math.min(20, t.length - q.length) / 2;
	const at = t.indexOf(q);
	if (at > 0 && /[\s\-_./([]/.test(t[at - 1])) return 60;
	if (at > 0) return 40;
	// letters in order (e.g. "rpm" → "Riunione progetto marketing")
	let i = 0;
	for (const c of t) if (c === q[i]) i++;
	if (i < q.length) return 0;
	return 10 + (q.length / t.length) * 10;
}

/** Pages (notes and canvases) ranked for a query; recent pages first when the query is empty. */
export function searchPages(plugin: AmbraiaPlugin, query: string, limit = 30): PageHit[] {
	const app = plugin.app;
	const q = normalize(query.trim());
	const recent: string[] = (app.workspace as unknown as { getLastOpenFiles?(): string[] }).getLastOpenFiles?.() ?? [];
	const rank = new Map(recent.map((p, i) => [p, recent.length - i]));
	const hits: PageHit[] = [];
	for (const f of app.vault.getFiles()) {
		if (f.extension !== 'md' && f.extension !== 'canvas') continue;
		let best = scoreText(f.basename, q);
		let alias: string | undefined;
		if (q) {
			for (const a of aliasesOf(plugin, f)) {
				const s = scoreText(a, q) - 1;
				if (s > best) {
					best = s;
					alias = a;
				}
			}
			// the folder also counts, a little ("progetti/alpha")
			if (!best && q.includes('/')) best = scoreText(f.path, q) / 2;
		}
		if (best <= 0) continue;
		const bonus = (rank.get(f.path) ?? 0) / 4 + (q ? 0 : f.stat.mtime / 1e13);
		hits.push({ file: f, score: best + bonus, alias });
	}
	hits.sort((a, b) => b.score - a.score || a.file.basename.length - b.file.basename.length);
	return hits.slice(0, limit);
}

type Item =
	| { kind: 'page'; hit: PageHit }
	| { kind: 'date'; label: string; date: Moment }
	| { kind: 'create'; name: string };

/** A link to a daily note (existing or not yet created: Obsidian creates it on click). */
export function dailyLink(plugin: AmbraiaPlugin, d: Moment, sourcePath: string): string {
	const cfg = dailyConfig(plugin.app, plugin.settings);
	const f = findPeriodic(plugin.app, cfg, d);
	if (f) return plugin.linkTo(f, sourcePath);
	const path = periodicPath(cfg, d).replace(/\.md$/, '');
	const name = path.split('/').pop()!;
	const unique = !plugin.app.metadataCache.getFirstLinkpathDest(name, sourcePath);
	return unique ? `[[${name}]]` : `[[${path}|${name}]]`;
}

function dateItems(q: string): Item[] {
	const days: [string, number, string][] = [
		[tx('Oggi'), 0, 'today oggi'],
		[tx('Domani'), 1, 'tomorrow domani'],
		[tx('Ieri'), -1, 'yesterday ieri'],
	];
	return days
		.filter(([label, , keys]) => !q || normalize(label).startsWith(q) || keys.split(' ').some((k) => k.startsWith(q)))
		.map(([label, off]) => ({ kind: 'date' as const, label, date: moment().startOf('day').add(off, 'day') }));
}

function renderPage(plugin: AmbraiaPlugin, hit: PageHit, el: HTMLElement) {
	el.addClass('ambraia-mention');
	const ic = el.createSpan({ cls: 'ambraia-mention-icon' });
	const icon = getIconFor(plugin, hit.file);
	if (icon) renderIcon(plugin.app, ic, icon, hit.file.path);
	else renderIcon(plugin.app, ic, hit.file.extension === 'canvas' ? 'lucide-layout-dashboard' : 'lucide-file-text');
	const body = el.createDiv({ cls: 'ambraia-mention-body' });
	body.createDiv({ cls: 'ambraia-mention-title', text: hit.file.basename });
	const parent = hit.file.parent && !hit.file.parent.isRoot() ? hit.file.parent.path : '';
	const sub = [hit.alias ? `↪ ${hit.alias}` : '', parent].filter(Boolean).join(' · ');
	if (sub) body.createDiv({ cls: 'ambraia-mention-path', text: sub });
}

function renderItem(plugin: AmbraiaPlugin, it: Item, el: HTMLElement) {
	if (it.kind === 'page') return renderPage(plugin, it.hit, el);
	el.addClass('ambraia-mention');
	const ic = el.createSpan({ cls: 'ambraia-mention-icon' });
	renderIcon(plugin.app, ic, it.kind === 'date' ? 'lucide-calendar-days' : 'lucide-plus');
	const body = el.createDiv({ cls: 'ambraia-mention-body' });
	if (it.kind === 'date') {
		body.createDiv({ cls: 'ambraia-mention-title', text: it.label });
		body.createDiv({ cls: 'ambraia-mention-path', text: it.date.format('dddd D MMMM YYYY') });
	} else {
		body.createDiv({ cls: 'ambraia-mention-title', text: tx('Crea «{0}»', it.name) });
		body.createDiv({ cls: 'ambraia-mention-path', text: tx('Nuova pagina') });
	}
}

function itemsFor(plugin: AmbraiaPlugin, query: string): Item[] {
	const q = normalize(query.trim());
	const pages = searchPages(plugin, query, 20).map((hit) => ({ kind: 'page' as const, hit }));
	const out: Item[] = [...(q ? pages : []), ...dateItems(q), ...(q ? [] : pages)];
	const exact = pages.some((p) => normalize(p.hit.file.basename) === q);
	if (query.trim() && !exact) out.push({ kind: 'create', name: query.trim() });
	return out;
}

/** "@" in the editor: link a page, a date (today, tomorrow, yesterday) or create a new page. */
export class MentionSuggest extends EditorSuggest<Item> {
	constructor(private plugin: AmbraiaPlugin) {
		super(plugin.app);
		this.limit = 24;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!this.plugin.settings.mentions || !file) return null;
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const m = matchMention(before);
		if (!m || inCode(editor, cursor.line, cursor.ch)) return null;
		return { start: { line: cursor.line, ch: m.start }, end: cursor, query: m.query };
	}

	getSuggestions(ctx: EditorSuggestContext): Item[] {
		return itemsFor(this.plugin, ctx.query);
	}

	renderSuggestion(it: Item, el: HTMLElement): void {
		renderItem(this.plugin, it, el);
	}

	selectSuggestion(it: Item): void {
		void this.insert(it);
	}

	/** Inserts the chosen link (awaitable, used by selectSuggestion). */
	async insert(it: Item): Promise<void> {
		const ctx = this.context;
		if (!ctx) return;
		const { editor, start, end, file } = ctx;
		const src = file?.path ?? '';
		this.close();
		let text = '';
		if (it.kind === 'date') text = dailyLink(this.plugin, it.date, src);
		else {
			const f = it.kind === 'page' ? it.hit.file : await this.plugin.createPageNamed(it.name, file);
			if (!f) return;
			text = this.plugin.linkTo(f, src);
		}
		editor.replaceRange(text + ' ', start, end);
		editor.setCursor({ line: start.line, ch: start.ch + text.length + 1 });
	}
}

/**
 * Page picker used by the "Link" button and command: type to find a page, or create a new one,
 * or paste a web address. `onChoose(file, typed, url)` — file is null when a new page must be created.
 */
export class PagePicker extends SuggestModal<Item | { kind: 'url'; url: string }> {
	constructor(
		private plugin: AmbraiaPlugin,
		private initial: string,
		private onChoose: (target: TFile | null, typed: string, url?: string) => void | Promise<void>,
	) {
		super(plugin.app);
		this.setPlaceholder(tx('Cerca una pagina o incolla un link…'));
		this.limit = 30;
	}

	onOpen(): void {
		(super.onOpen as (() => void) | undefined)?.call(this);
		const input = (this as unknown as { inputEl?: HTMLInputElement }).inputEl;
		if (input && this.initial) {
			input.value = this.initial;
			input.dispatchEvent(new Event('input'));
		}
	}

	getSuggestions(query: string): (Item | { kind: 'url'; url: string })[] {
		const q = query.trim();
		if (/^(https?:\/\/|www\.)\S+$/i.test(q)) return [{ kind: 'url', url: /^www\./i.test(q) ? 'https://' + q : q }];
		return itemsFor(this.plugin, query).filter((i) => i.kind !== 'date');
	}

	renderSuggestion(it: Item | { kind: 'url'; url: string }, el: HTMLElement): void {
		if (it.kind !== 'url') return renderItem(this.plugin, it, el);
		el.addClass('ambraia-mention');
		renderIcon(this.plugin.app, el.createSpan({ cls: 'ambraia-mention-icon' }), 'lucide-globe');
		const body = el.createDiv({ cls: 'ambraia-mention-body' });
		body.createDiv({ cls: 'ambraia-mention-title', text: tx('Collega a un sito web') });
		body.createDiv({ cls: 'ambraia-mention-path', text: it.url });
	}

	onChooseSuggestion(it: Item | { kind: 'url'; url: string }): void {
		if (it.kind === 'url') void this.onChoose(null, '', it.url);
		else if (it.kind === 'page') void this.onChoose(it.hit.file, it.hit.file.basename);
		else if (it.kind === 'create') void this.onChoose(null, it.name);
	}
}
