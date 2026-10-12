import { describe, expect, it } from 'vitest';
import { toggleInline, setColor, transformLines, toggleTodos, sortLines, dedupeLines, joinLines, changeCase, stripFormatting, selectionKind, parseEmbed, formatEmbed, findEmbeds, embedMatchesName, isWrapped } from '../src/editor/textOps';
import { matchSlash, setLinePrefix } from '../src/editor/slash';

const apply = (doc: string, c: { from: number; to: number; insert: string; selFrom: number; selTo: number }) => {
	const out = doc.slice(0, c.from) + c.insert + doc.slice(c.to);
	return { out, sel: out.slice(c.selFrom, c.selTo) };
};

describe('toggleInline', () => {
	it('wraps and unwraps', () => {
		const d = 'ciao mondo bello';
		const a = apply(d, toggleInline(d, 5, 10, '**'));
		expect(a.out).toBe('ciao **mondo** bello');
		expect(a.sel).toBe('mondo');
		const c = toggleInline(a.out, 7, 12, '**');
		const b = apply(a.out, c);
		expect(b.out).toBe(d);
		expect(b.sel).toBe('mondo');
		// selection including markers
		expect(apply(a.out, toggleInline(a.out, 5, 14, '**')).out).toBe(d);
	});
	it('keeps whitespace outside', () => {
		const d = 'a bc d';
		expect(apply(d, toggleInline(d, 1, 5, '==')).out).toBe('a ==bc== d');
	});
	it('italic is not confused with bold', () => {
		const d = '**ab**';
		expect(isWrapped(d, 2, 4, '*')).toBe(false);
		expect(apply(d, toggleInline(d, 2, 4, '*')).out).toBe('***ab***');
		expect(isWrapped(d, 2, 4, '**')).toBe(true);
	});
	it('empty selection inserts markers', () => {
		const c = toggleInline('xy', 1, 1, '`');
		expect(apply('xy', c).out).toBe('x``y');
		expect(c.selFrom).toBe(2);
	});
	it('html tags', () => {
		const d = 'x ab y';
		const r = apply(d, toggleInline(d, 2, 4, '<u>', '</u>'));
		expect(r.out).toBe('x <u>ab</u> y');
		expect(apply(r.out, toggleInline(r.out, 5, 7, '<u>', '</u>')).out).toBe(d);
	});
});

describe('setColor', () => {
	it('applies, changes, removes', () => {
		const d = 'x ab y';
		const r = apply(d, setColor(d, 2, 4, 'ob-c-red'));
		expect(r.out).toBe('x <span class="ob-c-red">ab</span> y');
		expect(r.sel).toBe('ab');
		const inner = r.out.indexOf('ab');
		const r2 = apply(r.out, setColor(r.out, inner, inner + 2, 'ob-c-blue'));
		expect(r2.out).toBe('x <span class="ob-c-blue">ab</span> y');
		const r3 = apply(r2.out, setColor(r2.out, 2, r2.out.length - 2, null));
		expect(r3.out).toBe(d);
		const bg = apply(d, setColor(d, 2, 4, 'ob-bg-yellow', true));
		expect(bg.out).toBe('x <mark class="ob-bg-yellow">ab</mark> y');
	});
});

describe('lines', () => {
	it('transforms', () => {
		expect(transformLines('a\n- b\n\n# c', 'ul')).toBe('- a\n- b\n\n- c');
		expect(transformLines('a\nb', 'ol')).toBe('1. a\n2. b');
		expect(transformLines('- [x] a\nb', 'todo')).toBe('- [ ] a\n- [ ] b');
		expect(transformLines('- a\n  - b', 'plain')).toBe('a\n  b');
		expect(transformLines('a\nb', 'quote')).toBe('> a\n> b');
		expect(transformLines('Titolo\nb', 'callout', 'tip')).toBe('> [!tip] Titolo\n> b');
		expect(transformLines('x', 'callout')).toBe('> [!note]\n> x');
		expect(transformLines('a\nb', 'code')).toBe('```\na\nb\n```');
		expect(transformLines('## a', 'h1')).toBe('# a');
	});
	it('todos, sort, dedupe, join', () => {
		expect(toggleTodos('- [ ] a\n- [x] b')).toBe('- [x] a\n- [x] b');
		expect(toggleTodos('- [x] a\n- [x] b')).toBe('- [ ] a\n- [ ] b');
		expect(sortLines('- b\n- a\n- C')).toBe('- a\n- b\n- C');
		expect(sortLines('a2\na10\na1')).toBe('a1\na2\na10');
		expect(dedupeLines('a\nb\na\n\n\nb')).toBe('a\nb\n\n');
		expect(joinLines('- a\n- b\n\nc')).toBe('a b c');
	});
	it('case & strip', () => {
		expect(changeCase('ciao MONDO', 'title')).toBe('Ciao Mondo');
		expect(changeCase('ciao. come va?', 'sentence')).toBe('Ciao. Come va?');
		expect(changeCase('perché', 'upper')).toBe('PERCHÉ');
		expect(stripFormatting('**a** *b* _c_ ~~d~~ ==e== `f` [[g|G]] [[h]] [i](u) <span class="ob-c-red">j</span>')).toBe('a b c d e f G h i j');
		expect(stripFormatting('snake_case_name')).toBe('snake_case_name');
	});
});

describe('selection kinds', () => {
	it('detects', () => {
		expect(selectionKind('![[foto.png]]')).toBe('image');
		expect(selectionKind('![[foto.PNG|300]]')).toBe('image');
		expect(selectionKind('![x](https://a.b/c.jpg)')).toBe('image');
		expect(selectionKind('![[Nota]]')).toBe('text');
		expect(selectionKind('[[Nota|alias]]')).toBe('link');
		expect(selectionKind('[t](https://x.y)')).toBe('link');
		expect(selectionKind('https://example.com/a?b=1')).toBe('url');
		expect(selectionKind('a\nb')).toBe('multiline');
		expect(selectionKind('- [ ] a\n- [ ] b')).toBe('todo');
		expect(selectionKind('parola')).toBe('text');
	});
});

describe('embeds', () => {
	it('parse / format round trip', () => {
		const e = parseEmbed('![[img/foto.png|center bella|300]]')!;
		expect(e).toEqual({ kind: 'wiki', target: 'img/foto.png', alt: 'bella', width: 300, height: null, align: 'center' });
		expect(formatEmbed(e)).toBe('![[img/foto.png|center bella|300]]');
		expect(formatEmbed({ ...e, align: null, alt: '' })).toBe('![[img/foto.png|300]]');
		expect(formatEmbed({ ...e, align: null, alt: '', width: null })).toBe('![[img/foto.png]]');
		const m = parseEmbed('![alt|200x100](https://x.y/a.png)')!;
		expect(m).toMatchObject({ kind: 'md', alt: 'alt', width: 200, height: 100 });
		expect(formatEmbed({ ...m, align: 'right' })).toBe('![right alt|200x100](https://x.y/a.png)');
		expect(parseEmbed('![[a.png|100]]')!.width).toBe(100);
		expect(parseEmbed('nope')).toBe(null);
	});
	it('finds embeds', () => {
		const d = 'a ![[x.png]] b ![](y%20z.jpg) ![[sub/x.png|50]]';
		const f = findEmbeds(d);
		expect(f.length).toBe(3);
		expect(d.slice(f[1].from, f[1].to)).toBe('![](y%20z.jpg)');
		expect(f.filter((x) => embedMatchesName(x.embed, 'x.png')).length).toBe(2);
		expect(embedMatchesName(f[1].embed, 'y z.jpg')).toBe(true);
	});
});

describe('slash trigger', () => {
	it('matches only at word start', () => {
		expect(matchSlash('/', '/')).toEqual({ start: 0, query: '' });
		expect(matchSlash('ciao /tit', '/')).toEqual({ start: 5, query: 'tit' });
		expect(matchSlash('http://x', '/')).toBe(null);
		expect(matchSlash('1/2', '/')).toBe(null);
		expect(matchSlash('a / b', '/')).toBe(null);
		expect(matchSlash('/elenco puntato', '/')).toEqual({ start: 0, query: 'elenco puntato' });
		expect(matchSlash('/a  b', '/')).toBe(null);
		expect(matchSlash('/città', '/')).toEqual({ start: 0, query: 'città' });
		expect(matchSlash('/[x', '/')).toBe(null);
	});
	it('replaces block prefixes', () => {
		expect(setLinePrefix('## ciao', '- ')).toBe('- ciao');
		expect(setLinePrefix('  - [ ] x', '# ')).toBe('  # x');
		expect(setLinePrefix('testo', '> ')).toBe('> testo');
		expect(setLinePrefix('1. a', '')).toBe('a');
	});
});
