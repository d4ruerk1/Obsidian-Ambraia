import { syntaxTree } from '@codemirror/language';
import { Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { editorInfoField, editorLivePreviewField, MarkdownPostProcessor, Menu, TFile } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { pickIcon } from '../ui/pickers';
import { getIconFor, ownIconFor, renderIcon, setIconFor } from '../ui/util';
import { tx } from '../i18n';

export interface FoundLink {
	from: number;
	to: number;
	/** link path without heading/block part */
	path: string;
	alias: string | null;
	/** markdown-style link [text](path) */
	md: boolean;
}

const WIKI = /(!?)\[\[([^[\]|#^\n]*)((?:[#^][^[\]|\n]*)?)(?:\|([^[\]\n]*))?\]\]/g;
const MDL = /(!?)\[([^[\]\n]+)\]\((<[^>\n]+>|[^()\s]+)\)/g;

/** Internal links in a text (embeds excluded). */
export function findLinks(text: string, offset = 0): FoundLink[] {
	const out: FoundLink[] = [];
	for (const m of text.matchAll(WIKI)) {
		if (m[1] || !m[2].trim()) continue;
		out.push({ from: offset + m.index, to: offset + m.index + m[0].length, path: m[2].trim(), alias: m[4] ?? null, md: false });
	}
	for (const m of text.matchAll(MDL)) {
		if (m[1]) continue;
		let dest = m[3].replace(/^<|>$/g, '');
		if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) continue; // web, mailto, obsidian://
		try {
			dest = decodeURIComponent(dest);
		} catch {
			/* keep as is */
		}
		dest = dest.replace(/[#^].*$/, '');
		if (!dest) continue;
		out.push({ from: offset + m.index, to: offset + m.index + m[0].length, path: dest, alias: m[2], md: true });
	}
	return out.sort((a, b) => a.from - b.from);
}

const base = (p: string) => p.split('/').pop()!.replace(/\.md$/i, '');

/**
 * Which links show the page icon: page "mentions" — links that show the page title
 * (`[[Page]]`, `[Page](Page.md)`). `[[Page|Page]]` is the plain form chosen by the user to hide it;
 * links with their own text (`[[Page|some text]]`) are text links, without icon.
 */
export function showsIcon(l: FoundLink): boolean {
	if (l.md) return l.alias!.trim() === base(l.path);
	return l.alias === null;
}

/** The plain version of a link (same target and text, no icon). */
export function plainForm(l: FoundLink, src: string): string {
	const raw = src.slice(l.from, l.to);
	if (l.md) return `[[${l.path.replace(/\.md$/i, '')}|${l.alias}]]`;
	const inner = raw.slice(2, -2);
	return `[[${inner}|${l.path}]]`;
}

function iconMenu(plugin: AmbraiaPlugin, file: TFile, e: MouseEvent, removeHere: (() => void) | null) {
	const menu = new Menu();
	if (removeHere) menu.addItem((i) => i.setTitle(tx('Togli l’icona da questo link')).setIcon('eraser').onClick(removeHere));
	menu.addItem((i) =>
		i
			.setTitle(tx('Cambia icona della pagina'))
			.setIcon('smile')
			.onClick(async () => {
				const v = await pickIcon(plugin.app, !!ownIconFor(plugin, file));
				if (v !== undefined) await setIconFor(plugin, file, v);
			}),
	);
	menu.addItem((i) => i.setTitle(tx('Apri la pagina')).setIcon('file-text').onClick(() => void plugin.app.workspace.getLeaf(false).openFile(file)));
	menu.showAtMouseEvent(e);
}

function fillIcon(plugin: AmbraiaPlugin, el: HTMLElement, file: TFile) {
	const icon = getIconFor(plugin, file, false);
	el.toggleClass('is-default', !icon);
	renderIcon(plugin.app, el, icon || (file.extension === 'canvas' ? 'lucide-layout-dashboard' : 'lucide-file-text'), file.path);
}

class IconWidget extends WidgetType {
	constructor(
		private plugin: AmbraiaPlugin,
		private file: TFile,
		private icon: string,
		private from: number,
		private to: number,
	) {
		super();
	}
	eq(o: IconWidget): boolean {
		return o.file === this.file && o.icon === this.icon && o.from === this.from;
	}
	toDOM(view: EditorView): HTMLElement {
		const el = createSpan();
		el.className = 'ambraia-link-icon';
		el.setAttr?.('aria-label', tx('Icona della pagina'));
		fillIcon(this.plugin, el, this.file);
		el.addEventListener('mousedown', (e) => e.preventDefault());
		el.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			iconMenu(this.plugin, this.file, e, () => {
				const doc = view.state.doc.toString();
				const l = findLinks(doc.slice(this.from, this.to), this.from)[0];
				if (!l || l.from !== this.from) return;
				view.dispatch({ changes: { from: l.from, to: l.to, insert: plainForm(l, doc) } });
			});
		});
		return el;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

const SKIP_NODE = /code|math|comment|frontmatter|hashtag-begin/i;

function inSkippedNode(view: EditorView, pos: number): boolean {
	try {
		type N = { name: string; parent: N | null };
		for (let n: N | null = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) if (SKIP_NODE.test(n.name)) return true;
	} catch {
		/* no syntax tree */
	}
	return false;
}

function build(plugin: AmbraiaPlugin, view: EditorView): DecorationSet {
	const b = new RangeSetBuilder<Decoration>();
	if (!plugin.settings.linkIcons) return b.finish();
	let live = true;
	try {
		live = view.state.field<boolean>(editorLivePreviewField as never);
	} catch {
		/* not an Obsidian editor */
	}
	if (!live) return b.finish();
	let source = '';
	try {
		source = view.state.field<{ file?: TFile | null }>(editorInfoField as never)?.file?.path ?? '';
	} catch {
		/* ignore */
	}
	const sel = view.state.selection.ranges;
	const mc = plugin.app.metadataCache;
	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		for (const l of findLinks(text, from)) {
			if (!showsIcon(l)) continue;
			if (sel.some((r) => r.from <= l.to && r.to >= l.from)) continue; // being edited: raw text is shown
			const file = mc.getFirstLinkpathDest(l.path, source);
			if (!file || (file.extension !== 'md' && file.extension !== 'canvas')) continue;
			if (inSkippedNode(view, l.from + 2)) continue;
			const icon = getIconFor(plugin, file, false);
			b.add(l.from, l.from, Decoration.widget({ widget: new IconWidget(plugin, file, icon, l.from, l.to), side: 1 }));
		}
	}
	return b.finish();
}

/** Page icons in front of internal links (live preview). */
export function linkIconExtension(plugin: AmbraiaPlugin): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(plugin, view);
			}
			update(u: ViewUpdate) {
				this.decorations = build(plugin, u.view);
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

/** Page icons in front of internal links (reading view). */
export function linkIconPostProcessor(plugin: AmbraiaPlugin): MarkdownPostProcessor {
	return (el, ctx) => {
		if (!plugin.settings.linkIcons) return;
		const anchors = Array.from(el.querySelectorAll<HTMLAnchorElement>('a.internal-link')).filter((a) => !a.closest('.internal-embed, .ambraia-db, code'));
		if (!anchors.length) return;
		const info = ctx.getSectionInfo(el);
		const links = info ? findLinks(info.text.split('\n').slice(info.lineStart, info.lineEnd + 1).join('\n')) : null;
		const used = new Set<FoundLink>();
		for (const a of anchors) {
			const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
			const path = href.replace(/[#^].*$/, '');
			const file = plugin.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
			if (!file || (file.extension !== 'md' && file.extension !== 'canvas')) continue;
			const text = (a.textContent ?? '').trim();
			// match the anchor with its source link to know its form
			const src = links?.find((l) => !used.has(l) && (l.path === path || l.path.replace(/\.md$/i, '') === path) && (l.alias ?? l.path).trim() === text) ??
				links?.find((l) => !used.has(l) && (l.path === path || l.path.replace(/\.md$/i, '') === path));
			if (src) used.add(src);
			if (src ? !showsIcon(src) : text !== href && text !== file.basename) continue;
			if (a.previousElementSibling?.classList.contains('ambraia-link-icon')) continue;
			const ic = createSpan({ cls: 'ambraia-link-icon' });
			fillIcon(plugin, ic, file);
			ic.addEventListener('click', (e) => {
				e.preventDefault();
				iconMenu(plugin, file, e, null);
			});
			a.before(ic);
			a.addClass('ambraia-page-link');
		}
	};
}
