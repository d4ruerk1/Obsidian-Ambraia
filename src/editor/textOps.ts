/** Pure text transformations used by the selection toolbar, slash menu and image tools. */

export interface Change {
	from: number;
	to: number;
	insert: string;
	selFrom: number;
	selTo: number;
}

/**
 * Toggle an inline marker (e.g. "**") around doc[from, to).
 * Leading/trailing whitespace stays outside the markers (Markdown requires it).
 */
export function toggleInline(doc: string, from: number, to: number, open: string, close = open): Change {
	const sel = doc.slice(from, to);
	// 1. selection includes markers
	if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
		const inner = sel.slice(open.length, sel.length - close.length);
		if (!(open === '*' && inner.startsWith('*') && !inner.startsWith('**'))) {
			return { from, to, insert: inner, selFrom: from, selTo: from + inner.length };
		}
	}
	// 2. markers surround the selection
	const before = doc.slice(Math.max(0, from - open.length), from);
	const after = doc.slice(to, to + close.length);
	if (before === open && after === close && !isPartOfLongerMarker(doc, from - open.length, to + close.length, open, close)) {
		return { from: from - open.length, to: to + close.length, insert: sel, selFrom: from - open.length, selTo: from - open.length + sel.length };
	}
	// 3. wrap (keep outer whitespace outside)
	const lead = /^\s*/.exec(sel)![0];
	const trail = sel.length > lead.length ? /\s*$/.exec(sel)![0] : '';
	const core = sel.slice(lead.length, sel.length - trail.length);
	if (!core) {
		const ins = open + close;
		return { from, to: from, insert: ins, selFrom: from + open.length, selTo: from + open.length };
	}
	const insert = lead + open + core + close + trail;
	return { from, to, insert, selFrom: from + lead.length + open.length, selTo: from + lead.length + open.length + core.length };
}

function isPartOfLongerMarker(doc: string, start: number, end: number, open: string, close: string): boolean {
	// "*" next to "**" (bold) must not be treated as italic
	if (open === '*' || open === '_') {
		const c = open[0];
		return doc[start - 1] === c || doc[end] === c;
	}
	return false;
}

export function isWrapped(doc: string, from: number, to: number, open: string, close = open): boolean {
	const sel = doc.slice(from, to);
	if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
		if (open === '*') return !sel.startsWith('**') || sel.startsWith('***');
		return true;
	}
	const before = doc.slice(Math.max(0, from - open.length), from);
	const after = doc.slice(to, to + close.length);
	return before === open && after === close && !isPartOfLongerMarker(doc, from - open.length, to + close.length, open, close);
}

const SPAN_RE = /^<(span|mark) class="(ob-[a-z]+-[a-z]+)">([\s\S]*)<\/\1>$/;

/** Apply / change / remove a colour span. cls = null removes it. */
export function setColor(doc: string, from: number, to: number, cls: string | null, bg = false): Change {
	const sel = doc.slice(from, to);
	const tag = bg ? 'mark' : 'span';
	let inner = sel;
	let f = from;
	let t = to;
	const m = SPAN_RE.exec(sel);
	if (m) inner = m[3];
	else {
		// the selection may be the inside of an existing span
		const open = /<(span|mark) class="ob-[a-z]+-[a-z]+">$/.exec(doc.slice(Math.max(0, from - 40), from));
		if (open) {
			const closeTag = `</${open[1]}>`;
			if (doc.slice(to, to + closeTag.length) === closeTag) {
				f = from - open[0].length;
				t = to + closeTag.length;
			}
		}
	}
	if (!cls) return { from: f, to: t, insert: inner, selFrom: f, selTo: f + inner.length };
	const openTag = `<${tag} class="${cls}">`;
	const insert = `${openTag}${inner}</${tag}>`;
	return { from: f, to: t, insert, selFrom: f + openTag.length, selTo: f + openTag.length + inner.length };
}

export type LineKind = 'plain' | 'ul' | 'ol' | 'todo' | 'quote' | 'h1' | 'h2' | 'h3' | 'callout' | 'code' | 'toggle';

const LINE_PREFIX = /^(\s*)(#{1,6}\s+|[-*+]\s+\[.\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/;

export function stripPrefix(line: string): { indent: string; body: string } {
	const m = LINE_PREFIX.exec(line)!;
	return { indent: m[1], body: line.slice(m[0].length) };
}

export function transformLines(text: string, kind: LineKind, calloutType = 'note'): string {
	const lines = text.split('\n');
	if (kind === 'code') {
		const inner = text.replace(/^```.*\n|\n?```\s*$/g, '');
		return '```\n' + inner + '\n```';
	}
	if (kind === 'callout' || kind === 'toggle') {
		const first = lines[0].trim() ? stripPrefix(lines[0]).body : '';
		const rest = lines.slice(1).map((l) => '> ' + stripPrefix(l).body);
		const head = `> [!${calloutType}]${kind === 'toggle' ? '-' : ''}`;
		if (lines.length === 1) return `${head}\n> ${first}`;
		return [`${head} ${first}`.trimEnd(), ...rest].join('\n');
	}
	let n = 0;
	return lines
		.map((l) => {
			if (!l.trim()) return l;
			const { indent, body } = stripPrefix(l);
			switch (kind) {
				case 'plain':
					return indent + body;
				case 'ul':
					return `${indent}- ${body}`;
				case 'ol':
					return `${indent}${++n}. ${body}`;
				case 'todo':
					return `${indent}- [ ] ${body}`;
				case 'quote':
					return `> ${indent}${body}`;
				case 'h1':
					return `# ${body}`;
				case 'h2':
					return `## ${body}`;
				case 'h3':
					return `### ${body}`;
			}
			return l;
		})
		.join('\n');
}

/** Toggle all to-do checkboxes in the text: if any is open, check all; else uncheck all. */
export function toggleTodos(text: string): string {
	const anyOpen = /^\s*[-*+]\s+\[ \]/m.test(text);
	return text.replace(/^(\s*[-*+]\s+)\[.\]/gm, (_m, p) => `${p}[${anyOpen ? 'x' : ' '}]`);
}

export function sortLines(text: string, desc = false): string {
	const lines = text.split('\n');
	const key = (l: string) => stripPrefix(l).body.toLowerCase();
	lines.sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }) * (desc ? -1 : 1));
	return lines.join('\n');
}

export function dedupeLines(text: string): string {
	const seen = new Set<string>();
	return text
		.split('\n')
		.filter((l) => {
			if (!l.trim()) return true;
			if (seen.has(l)) return false;
			seen.add(l);
			return true;
		})
		.join('\n');
}

export function joinLines(text: string): string {
	return text
		.split('\n')
		.map((l) => stripPrefix(l).body.trim())
		.filter(Boolean)
		.join(' ');
}

export function changeCase(text: string, mode: 'upper' | 'lower' | 'title' | 'sentence'): string {
	if (mode === 'upper') return text.toUpperCase();
	if (mode === 'lower') return text.toLowerCase();
	if (mode === 'title') return text.toLowerCase().replace(/(^|[\s\-–("'“])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
	return text.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}

export function stripFormatting(text: string): string {
	return text
		.replace(/<\/?(span|mark|u|b|i|strong|em|font)(\s[^>]*)?>/gi, '')
		.replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
		.replace(/!?\[\[([^\]]+)\]\]/g, (_m, t: string) => t.replace(/#.*$/, ''))
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
		.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
		.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/%%(.+?)%%/g, '$1');
}

// ---------------------------------------------------------------- selection context

export type SelKind = 'image' | 'link' | 'url' | 'multiline' | 'text' | 'todo';

export const IMAGE_EMBED_RE = /^!\[\[[^\]]+\.(png|jpe?g|gif|webp|svg|bmp|avif)(\|[^\]]*)?\]\]$|^!\[[^\]]*\]\([^)]+\)$/i;
export const WIKILINK_RE = /^\[\[([^\]|]+)(\|([^\]]+))?\]\]$/;
export const MDLINK_RE = /^\[([^\]]+)\]\(([^)\s]+)\)$/;
export const URL_RE = /^(https?:\/\/|www\.)[^\s<>"]+$/i;

export function selectionKind(sel: string): SelKind {
	const s = sel.trim();
	if (IMAGE_EMBED_RE.test(s)) return 'image';
	if (WIKILINK_RE.test(s) || MDLINK_RE.test(s)) return 'link';
	if (URL_RE.test(s)) return 'url';
	if (s.includes('\n')) {
		if (/^\s*[-*+]\s+\[.\]/m.test(s)) return 'todo';
		return 'multiline';
	}
	return 'text';
}

// ---------------------------------------------------------------- image embeds

export type Align = 'left' | 'center' | 'right' | null;

export interface Embed {
	kind: 'wiki' | 'md';
	target: string;
	alt: string;
	width: number | null;
	height: number | null;
	align: Align;
}

const ALIGN_TOKENS = ['left', 'center', 'right'];

function splitAlt(raw: string): { alt: string; align: Align; width: number | null; height: number | null } {
	const parts = raw.split('|');
	let width: number | null = null;
	let height: number | null = null;
	const last = parts[parts.length - 1]?.trim() ?? '';
	const size = /^(\d+)(?:x(\d+))?$/.exec(last);
	if (size && parts.length >= 1 && last !== '') {
		width = Number(size[1]);
		height = size[2] ? Number(size[2]) : null;
		parts.pop();
	}
	let align: Align = null;
	const words: string[] = [];
	for (const w of parts.join('|').split(/\s+/)) {
		if (!align && ALIGN_TOKENS.includes(w)) align = w as Align;
		else if (w) words.push(w);
	}
	return { alt: words.join(' '), align, width, height };
}

export function parseEmbed(s: string): Embed | null {
	const t = s.trim();
	let m = /^!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(t);
	if (m) return { kind: 'wiki', target: m[1], ...splitAlt(m[2] ?? '') };
	m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(t);
	if (m) return { kind: 'md', target: m[2], ...splitAlt(m[1]) };
	return null;
}

export function formatEmbed(e: Embed): string {
	const altParts = [e.align, e.alt].filter(Boolean).join(' ');
	const size = e.width ? (e.height ? `${e.width}x${e.height}` : `${e.width}`) : '';
	if (e.kind === 'wiki') {
		const segs = [e.target];
		if (altParts) segs.push(altParts);
		if (size) segs.push(size);
		return `![[${segs.join('|')}]]`;
	}
	const alt = [altParts, size].filter(Boolean).join('|');
	return `![${alt}](${e.target})`;
}

/** All image embeds in a document with their offsets. */
export function findEmbeds(doc: string): { from: number; to: number; embed: Embed }[] {
	const out: { from: number; to: number; embed: Embed }[] = [];
	const re = /!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)\n]+\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(doc))) {
		const e = parseEmbed(m[0]);
		if (e) out.push({ from: m.index, to: m.index + m[0].length, embed: e });
	}
	return out;
}

export function embedMatchesName(e: Embed, fileName: string): boolean {
	const dec = (x: string) => {
		try {
			return decodeURIComponent(x);
		} catch {
			return x;
		}
	};
	let raw = e.target.split('#')[0];
	if (/^[a-z]+:\/\//i.test(raw)) raw = raw.split('?')[0];
	const t = dec(raw).replace(/^<|>$/g, '');
	const base = t.split('/').pop() ?? t;
	const fn = dec(fileName);
	return base === fn || t === fn || t.endsWith('/' + fn);
}
