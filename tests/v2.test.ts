// @vitest-environment jsdom
// Features added in 2.0: mentions, link icons, shortcuts, canvas tools, calendar quick actions, one icon per page.
import { beforeAll, describe, expect, it } from 'vitest';
import { moment } from 'obsidian';
import { FakeApp, installDomShim } from './app-fake';
import { matchMention, scoreText, searchPages, dailyLink, MentionSuggest } from '../src/editor/mentions';
import { findLinks, showsIcon, plainForm, linkIconPostProcessor } from '../src/editor/linkIcons';
import { toggleBlock, keyLabel, BLOCK_KEYS } from '../src/editor/shortcuts';
import { arrange } from '../src/canvas';
import { appendLine, newTaskLine, parseTasks, rescheduleTaskLine } from '../src/calendar/dates';
import { wrapLines } from '../src/editor/selectionToolbar';
import { getIconFor, setIconFor } from '../src/ui/util';

installDomShim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
});

async function setup() {
	document.body.innerHTML = '';
	document.body.className = '';
	const app = new FakeApp();
	await app.vault.create('Progetti/Riunione progetto marketing.md', 'x');
	await app.vault.create('Città.md', '---\naliases: [Roma capitale]\n---\n');
	await app.vault.create('Lavagna.canvas', '{"nodes":[],"edges":[]}');
	await app.vault.create('Foto.png', '');
	const plugin = new AmbraiaPlugin(app, manifest);
	await plugin.onload();
	await app.workspace.fireLayoutReady();
	plugin.settings.calendarUseCoreDaily = false;
	plugin.settings.dailyFolder = 'Diario';
	plugin.settings.dailyFormat = 'YYYY-MM-DD';
	return { app, plugin };
}

function fakeEditor(text: string) {
	let doc = text;
	const off = (p: { line: number; ch: number }) => doc.split('\n').slice(0, p.line).reduce((s, l) => s + l.length + 1, 0) + p.ch;
	let cursor = { line: 0, ch: 0 };
	return {
		get doc() {
			return doc;
		},
		getLine: (l: number) => doc.split('\n')[l] ?? '',
		replaceRange: (t: string, a: any, b?: any) => {
			const s = off(a);
			doc = doc.slice(0, s) + t + doc.slice(b ? off(b) : s);
		},
		setCursor: (p: any) => (cursor = p),
		getCursor: () => cursor,
	};
}

describe('@ mentions', () => {
	it('triggers only at word starts, not in e-mails', () => {
		expect(matchMention('vedi @riu')).toEqual({ start: 5, query: 'riu' });
		expect(matchMention('@')).toEqual({ start: 0, query: '' });
		expect(matchMention('(@doc')).toEqual({ start: 1, query: 'doc' });
		expect(matchMention('mario@example')).toBeNull();
		expect(matchMention('@ spazio')).toBeNull();
		expect(matchMention('@[[x')).toBeNull();
	});

	it('scores exact, prefix, word and in-order matches, ignoring accents', () => {
		const s = (t: string, q: string) => scoreText(t, q);
		expect(s('Città', 'citta')).toBe(100);
		expect(s('Città vecchia', 'cit')).toBeGreaterThan(s('Riunione città', 'cit'));
		expect(s('Riunione progetto marketing', 'rpm')).toBeGreaterThan(0);
		expect(s('Riunione', 'xyz')).toBe(0);
	});

	it('searches notes and canvases by title and alias', async () => {
		const { plugin } = await setup();
		const names = (q: string) => searchPages(plugin, q).map((h) => h.file.path);
		expect(names('riun')[0]).toBe('Progetti/Riunione progetto marketing.md');
		expect(names('roma')[0]).toBe('Città.md');
		expect(searchPages(plugin, 'roma')[0].alias).toBe('Roma capitale');
		expect(names('lava')).toContain('Lavagna.canvas');
		expect(names('foto')).toEqual([]);
		expect(names('').length).toBe(3);
	});

	it('inserts a page link, a date link or a new page', async () => {
		const { app, plugin } = await setup();
		const s = new MentionSuggest(plugin);
		const src = app.vault.getFileByPath('Città.md');
		const ed = fakeEditor('ciao @riu');
		const trig = s.onTrigger({ line: 0, ch: 9 }, ed as any, src);
		expect(trig?.query).toBe('riu');
		s.context = { editor: ed, start: trig!.start, end: trig!.end, file: src, query: 'riu' };
		const items = s.getSuggestions(s.context);
		await s.insert(items[0]);
		expect(ed.doc).toBe('ciao [[Riunione progetto marketing]] ');
		// dates
		const today = (moment as any)().startOf('day');
		expect(dailyLink(plugin, today, 'Città.md')).toBe(`[[${today.format('YYYY-MM-DD')}]]`);
		const ed2 = fakeEditor('@nuova idea');
		s.context = { editor: ed2, start: { line: 0, ch: 0 }, end: { line: 0, ch: 11 }, file: src, query: 'nuova idea' };
		const create = s.getSuggestions(s.context).find((i: any) => i.kind === 'create');
		await s.insert(create!);
		expect(ed2.doc).toBe('[[nuova idea]] ');
		expect(app.vault.getFileByPath('nuova idea.md')).not.toBeNull();
		// off in settings, or inside code
		expect(s.onTrigger({ line: 0, ch: 4 }, fakeEditor('`@ab') as any, src)).toBeNull();
		plugin.settings.mentions = false;
		expect(s.onTrigger({ line: 0, ch: 9 }, fakeEditor('ciao @riu') as any, src)).toBeNull();
	});
});

describe('page icons in links', () => {
	it('finds wiki and markdown links, skipping embeds and web links', () => {
		const t = 'a [[Pagina]] b [[Altra|testo]] ![[Img.png]] [Doc](Doc.md) [web](https://x.it) [[P#Sez]]';
		const l = findLinks(t);
		expect(l.map((x) => x.path)).toEqual(['Pagina', 'Altra', 'Doc.md', 'P']);
		expect(l.map(showsIcon)).toEqual([true, false, true, true]);
		expect(t.slice(l[0].from, l[0].to)).toBe('[[Pagina]]');
	});

	it('the plain form keeps target and text but hides the icon', () => {
		const t = '[[Pagina]] [[P#Sez]] [Doc](Doc.md)';
		const out = findLinks(t).map((l) => plainForm(l, t));
		expect(out).toEqual(['[[Pagina|Pagina]]', '[[P#Sez|P]]', '[[Doc|Doc]]']);
		for (const o of out) expect(findLinks(o).map(showsIcon)).toEqual([false]);
	});

	it('reading view: icon before page links, not before plain or text links', async () => {
		const { app, plugin } = await setup();
		await setIconFor(plugin, app.vault.getFileByPath('Città.md')!, '🏛️');
		const pp = linkIconPostProcessor(plugin);
		const text = '[[Città]] e [[Città|Città]] e [[Città|la capitale]]';
		const el = document.createElement('p');
		el.innerHTML = '<a class="internal-link" data-href="Città">Città</a> e <a class="internal-link" data-href="Città">Città</a> e <a class="internal-link" data-href="Città">la capitale</a>';
		pp(el, { sourcePath: 'x.md', getSectionInfo: () => ({ text, lineStart: 0, lineEnd: 0 }) } as any);
		const icons = el.querySelectorAll('.ambraia-link-icon');
		expect(icons.length).toBe(1);
		expect(icons[0].nextElementSibling?.textContent).toBe('Città');
		expect(icons[0].textContent).toContain('🏛️');
		plugin.settings.linkIcons = false;
		const el2 = document.createElement('p');
		el2.innerHTML = '<a class="internal-link" data-href="Città">Città</a>';
		pp(el2, { sourcePath: 'x.md', getSectionInfo: () => ({ text: '[[Città]]', lineStart: 0, lineEnd: 0 }) } as any);
		expect(el2.querySelector('.ambraia-link-icon')).toBeNull();
	});
});

describe('one icon per page', () => {
	it('notes keep it in the frontmatter, other files in the settings; old copies are dropped', async () => {
		const { app, plugin } = await setup();
		const f = app.vault.getFileByPath('Progetti/Riunione progetto marketing.md')!;
		plugin.settings.icons[f.path] = '📁'; // saved by an older version
		expect(getIconFor(plugin, f)).toBe('📁');
		await setIconFor(plugin, f, '🎯');
		expect(String(app.vault.data.get(f.path))).toMatch(/^---\nicon: 🎯\n---/);
		expect(plugin.settings.icons[f.path]).toBeUndefined();
		expect(getIconFor(plugin, f)).toBe('🎯');
		await setIconFor(plugin, f, null);
		expect(String(app.vault.data.get(f.path))).toBe('x'); // no empty frontmatter left behind
		const img = app.vault.getFileByPath('Foto.png')!;
		await setIconFor(plugin, img, '🖼️');
		expect(plugin.settings.icons['Foto.png']).toBe('🖼️');
		expect(getIconFor(plugin, img)).toBe('🖼️');
	});
});

describe('keyboard shortcuts', () => {
	it('turns lines into blocks and back', () => {
		expect(toggleBlock('ciao', 'h1')).toBe('# ciao');
		expect(toggleBlock('# ciao', 'h1')).toBe('ciao');
		expect(toggleBlock('# ciao', 'h2')).toBe('## ciao');
		expect(toggleBlock('a\nb', 'todo')).toBe('- [ ] a\n- [ ] b');
		expect(toggleBlock('- [ ] a\n- [ ] b', 'todo')).toBe('a\nb');
		expect(toggleBlock('- a', 'plain')).toBe('a');
		const code = toggleBlock('x = 1', 'code');
		expect(code).toMatch(/^```[^\n]*\nx = 1\n```$/);
		expect(toggleBlock(code, 'code')).toBe('x = 1');
		expect(BLOCK_KEYS.map(([n]) => n).join('')).toBe('012345678');
	});

	it('shows readable key names', () => {
		expect(keyLabel('Mod-Shift-1')).toBe('Ctrl + Shift + 1');
		expect(keyLabel('Mod-u')).toBe('Ctrl + U');
		expect(keyLabel('Alt-ArrowUp')).toBe('Alt + ↑');
	});
});

describe('selection toolbar helpers', () => {
	it('wraps every line after its list marker, and unwraps', () => {
		expect(wrapLines('- uno\n- due', '**')).toBe('- **uno**\n- **due**');
		expect(wrapLines('- **uno**\n- **due**', '**')).toBe('- uno\n- due');
		expect(wrapLines('# Titolo\n\ntesto', '==')).toBe('# ==Titolo==\n\n==testo==');
	});
});

describe('canvas tools', () => {
	const boxes = [
		{ x: 10, y: 0, width: 100, height: 50 },
		{ x: 300, y: 40, width: 100, height: 80 },
		{ x: 140, y: 100, width: 100, height: 50 },
	];
	it('aligns, distributes and arranges in a grid', () => {
		expect(arrange(boxes, 'left').map((p) => p.x)).toEqual([10, 10, 10]);
		expect(arrange(boxes, 'top').map((p) => p.y)).toEqual([0, 0, 0]);
		const h = arrange(boxes, 'h');
		expect(h[0].x).toBe(10);
		expect(h[2].x - (h[0].x + 100)).toBe(h[1].x - (h[2].x + 100)); // equal gaps
		const g = arrange(boxes, 'grid');
		expect(g[0]).toEqual({ x: 10, y: 0 });
		expect(new Set(g.map((p) => `${p.x},${p.y}`)).size).toBe(3);
		expect(arrange([boxes[0]], 'grid')).toEqual([{ x: 10, y: 0 }]);
	});
});

describe('calendar quick actions', () => {
	it('reschedules dated tasks keeping their syntax', () => {
		expect(rescheduleTaskLine('- [ ] pagare 📅 2026-10-05', '2026-10-07')).toBe('- [ ] pagare 📅 2026-10-07');
		expect(rescheduleTaskLine('  * [ ] x [due:: 2026-10-05]', '2026-11-01')).toBe('  * [ ] x [due:: 2026-11-01]');
		expect(rescheduleTaskLine('- [ ] senza data', '2026-10-07')).toBeNull();
		expect(rescheduleTaskLine('testo 📅 2026-10-05', '2026-10-07')).toBeNull();
	});

	it('appends new tasks to a note', () => {
		const line = newTaskLine(' chiamare\nLuca ', '2026-10-05');
		expect(line).toBe('- [ ] chiamare Luca 📅 2026-10-05');
		expect(parseTasks(line)[0].date).toBe('2026-10-05');
		expect(appendLine('', line)).toBe(line + '\n');
		expect(appendLine('# Oggi\n\n', line)).toBe('# Oggi\n\n' + line + '\n');
		expect(appendLine('- [ ] a 📅 2026-10-05\n', line)).toBe('- [ ] a 📅 2026-10-05\n' + line + '\n');
	});

	it('adds a task to the daily note, moves it; month view only', async () => {
		const { app, plugin } = await setup();
		await plugin.activateCalendar();
		const view = app.workspace.getLeavesOfType('ambraia-calendar')[0].view;
		const day = (moment as any)().format('YYYY-MM-DD');
		const next = (moment as any)().add(1, 'day').format('YYYY-MM-DD');
		await view.addTask(day, 'consegna');
		const path = `Diario/${day}.md`;
		expect(String(app.vault.data.get(path))).toContain(`- [ ] consegna 📅 ${day}`);
		await sleep(60);
		await view.render();
		const t = { file: app.vault.getFileByPath(path), line: String(app.vault.data.get(path)).split('\n').findIndex((l: string) => l.includes('consegna')), text: 'consegna', done: false, date: day };
		await view.moveTo({ kind: 'task', task: t }, next);
		expect(String(app.vault.data.get(path))).toContain(`- [ ] consegna 📅 ${next}`);
		const page = await app.vault.create('Evento.md', `---\ndata: ${day}\n---\n`);
		await view.moveTo({ kind: 'page', file: page, from: day }, next);
		expect(String(app.vault.data.get('Evento.md'))).toContain(`data: ${next}`);
		// month view only: no week switch any more
		expect(Array.from(view.contentEl.querySelectorAll('button')).some((b: any) => /^(settimana|week)$/i.test(b.textContent.trim()))).toBe(false);
	});
});

describe('settings', () => {
	it('every tab renders without errors and the footer credits the developer', async () => {
		const { plugin } = await setup();
		const { AmbraiaSettingTab } = await import('../src/settingsTab');
		const tab = new AmbraiaSettingTab(plugin.app, plugin);
		expect(tab.getSettingDefinitions()).toEqual([]); // → Obsidian calls display()
		tab.display();
		const tabs = [...tab.containerEl.querySelectorAll('.ambraia-set-tab')] as HTMLElement[];
		expect(tabs.length).toBe(6);
		for (const t of tabs) {
			t.click();
			const panel = tab.containerEl.querySelector('.ambraia-set-panel')!;
			expect(panel.querySelectorAll('.setting-item').length, t.textContent!).toBeGreaterThan(0);
		}
		expect(tab.containerEl.querySelector('.ambraia-set-footer')!.textContent).toContain('d4ruerk1');
		expect(tab.containerEl.textContent).toContain('GitHub');
	});
});
