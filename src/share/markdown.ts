/**
 * Small, safe Markdown renderer for shared notes (viewer page and in-app preview).
 * Content comes from someone else: no HTML is ever interpreted (everything goes through
 * textContent), links are limited to http(s) and mailto, and no remote resource is loaded
 * (images become links), so opening a note cannot run code or reveal the reader to third parties.
 */

type Doc = Pick<Document, 'createElement' | 'createTextNode'>;

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

function el<K extends keyof HTMLElementTagNameMap>(doc: Doc, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
	const e = doc.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

function link(doc: Doc, href: string, label: string): HTMLElement {
	const url = href.trim();
	if (!SAFE_URL.test(url)) return el(doc, 'span', '', label);
	const a = el(doc, 'a', '', label);
	a.setAttribute('href', url);
	a.setAttribute('rel', 'noopener noreferrer nofollow');
	a.setAttribute('target', '_blank');
	return a;
}

/** Inline formatting: code, links, images (as links), bold, italic, strike, highlight, autolinks. */
export function renderInline(doc: Doc, parent: HTMLElement, text: string, depth = 0) {
	if (depth > 6) {
		parent.appendChild(doc.createTextNode(text));
		return;
	}
	const re = /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|==([\s\S]+?)==|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\\([\\`*_{}[\]()#+\-.!~=|>])/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		if (m.index > last) parent.appendChild(doc.createTextNode(text.slice(last, m.index)));
		last = re.lastIndex;
		if (m[1]) parent.appendChild(el(doc, 'code', '', m[2]));
		else if (m[4] !== undefined) parent.appendChild(link(doc, m[4], `🖼 ${m[3] || m[4]}`));
		else if (m[6] !== undefined) {
			const a = link(doc, m[6], '');
			a.textContent = '';
			renderInline(doc, a, m[5], depth + 1);
			parent.appendChild(a);
		} else if (m[7] !== undefined || m[8] !== undefined) renderInline(doc, parent.appendChild(el(doc, 'strong')), m[7] ?? m[8], depth + 1);
		else if (m[9] !== undefined) renderInline(doc, parent.appendChild(el(doc, 'del')), m[9], depth + 1);
		else if (m[10] !== undefined) renderInline(doc, parent.appendChild(el(doc, 'mark')), m[10], depth + 1);
		else if (m[11] !== undefined || m[12] !== undefined) renderInline(doc, parent.appendChild(el(doc, 'em')), m[11] ?? m[12], depth + 1);
		else if (m[13] !== undefined) parent.appendChild(link(doc, m[13], m[13]));
		else if (m[14] !== undefined) parent.appendChild(doc.createTextNode(m[14]));
	}
	if (last < text.length) parent.appendChild(doc.createTextNode(text.slice(last)));
}

function inlineLines(doc: Doc, parent: HTMLElement, lines: string[]) {
	lines.forEach((l, i) => {
		if (i) parent.appendChild(el(doc, 'br'));
		renderInline(doc, parent, l.replace(/\s+$/, ''));
	});
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)/;

/** Renders Markdown into `root` (cleared first). */
export function renderMarkdown(doc: Doc, root: HTMLElement, md: string) {
	root.textContent = '';
	renderBlocks(doc, root, md.replace(/\r\n?/g, '\n').split('\n'), 0);
}

function renderBlocks(doc: Doc, root: HTMLElement, lines: string[], depth: number) {
	if (depth > 8) {
		root.appendChild(el(doc, 'p', '', lines.join('\n')));
		return;
	}
	let i = 0;
	let para: string[] = [];
	const flush = () => {
		if (!para.length) return;
		const p = el(doc, 'p');
		inlineLines(doc, p, para);
		root.appendChild(p);
		para = [];
	};
	while (i < lines.length) {
		const line = lines[i];
		const fence = FENCE.exec(line);
		if (fence) {
			flush();
			const close = fence[1][0].repeat(fence[1].length);
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
			i++;
			const pre = el(doc, 'pre');
			const code = el(doc, 'code', fence[2] ? `language-${fence[2].replace(/[^\w-]/g, '')}` : '', body.join('\n'));
			pre.appendChild(code);
			root.appendChild(pre);
			continue;
		}
		if (!line.trim()) {
			flush();
			i++;
			continue;
		}
		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) {
			flush();
			const tag = `h${h[1].length}` as 'h1';
			const he = el(doc, tag);
			renderInline(doc, he, h[2]);
			root.appendChild(he);
			i++;
			continue;
		}
		if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			root.appendChild(el(doc, 'hr'));
			i++;
			continue;
		}
		if (/^\s{0,3}>/.test(line)) {
			flush();
			const body: string[] = [];
			while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
			const call = /^\[!([\w-]+)\][+-]?\s*(.*)$/.exec(body[0] ?? '');
			const q = el(doc, 'blockquote', call ? `callout callout-${call[1].toLowerCase().replace(/[^a-z-]/g, '')}` : '');
			if (call) {
				const t = el(doc, 'div', 'callout-title');
				renderInline(doc, t, call[2] || call[1][0].toUpperCase() + call[1].slice(1).toLowerCase());
				q.appendChild(t);
				body.shift();
			}
			renderBlocks(doc, q, body, depth + 1);
			root.appendChild(q);
			continue;
		}
		if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
			flush();
			const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
			const wrap = el(doc, 'div', 'table-wrap');
			const table = el(doc, 'table');
			const tr = el(doc, 'tr');
			for (const c of cells(line)) renderInline(doc, tr.appendChild(el(doc, 'th')), c);
			table.appendChild(el(doc, 'thead')).appendChild(tr);
			const tb = table.appendChild(el(doc, 'tbody'));
			i += 2;
			while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
				const r = el(doc, 'tr');
				for (const c of cells(lines[i++])) renderInline(doc, r.appendChild(el(doc, 'td')), c);
				tb.appendChild(r);
			}
			wrap.appendChild(table);
			root.appendChild(wrap);
			continue;
		}
		const li = LIST.exec(line);
		if (li) {
			flush();
			i = renderList(doc, root, lines, i, depth);
			continue;
		}
		para.push(line);
		i++;
	}
	flush();
}

function renderList(doc: Doc, root: HTMLElement, lines: string[], start: number, depth: number): number {
	const first = LIST.exec(lines[start])!;
	const indent = first[1].replace(/\t/g, '    ').length;
	const ordered = /\d/.test(first[2]);
	const list = el(doc, ordered ? 'ol' : 'ul');
	if (ordered) {
		const n = parseInt(first[2], 10);
		if (n !== 1) list.setAttribute('start', String(n));
	}
	let i = start;
	while (i < lines.length) {
		const m = LIST.exec(lines[i]);
		if (!m) break;
		const ind = m[1].replace(/\t/g, '    ').length;
		if (ind < indent) break;
		if (ind > indent) {
			const lastLi = list.lastElementChild as HTMLElement | null;
			i = renderList(doc, lastLi ?? list, lines, i, depth + 1);
			continue;
		}
		if (/\d/.test(m[2]) !== ordered) break;
		const item = el(doc, 'li');
		const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
		if (task) {
			item.className = 'task';
			const box = el(doc, 'input');
			box.setAttribute('type', 'checkbox');
			box.setAttribute('disabled', '');
			if (task[1] !== ' ') box.setAttribute('checked', '');
			item.appendChild(box);
			renderInline(doc, item, ' ' + task[2]);
		} else renderInline(doc, item, m[3]);
		list.appendChild(item);
		i++;
		// continuation lines of the same item
		while (i < lines.length && lines[i].trim() && !LIST.exec(lines[i]) && /^\s{2,}/.test(lines[i])) {
			item.appendChild(el(doc, 'br'));
			renderInline(doc, item, lines[i++].trim());
		}
	}
	root.appendChild(list);
	return i;
}
