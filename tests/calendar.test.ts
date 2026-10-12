// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { moment } from 'obsidian';
import { FakeApp, installDomShim } from './app-fake';
import { applyTemplate, CalendarIndex, createPeriodic, dateFromPath, monthGrid, parseTasks, periodicPath, toDay, toggleTaskLine } from '../src/calendar/dates';
import { DEFAULT_SETTINGS } from '../src/settings';

installDomShim();

const m = (s: string) => (moment as any)(s, 'YYYY-MM-DD');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
});

describe('calendar dates', () => {
	it('builds month grids starting on Monday or Sunday', () => {
		const mon = monthGrid(m('2026-10-15'), 1);
		expect(mon[0][0].format('YYYY-MM-DD')).toBe('2026-09-28'); // 1 Oct 2026 is a Thursday
		expect(mon.every((w) => w.length === 7)).toBe(true);
		expect(mon[mon.length - 1].some((d) => d.month() === 9)).toBe(true);
		const sun = monthGrid(m('2026-10-15'), 0);
		expect(sun[0][0].format('YYYY-MM-DD')).toBe('2026-09-27');
		// February 2026 starts on Sunday: with Sunday start it fits in exactly 4 weeks
		expect(monthGrid(m('2026-02-10'), 0)).toHaveLength(4);
	});

	it('maps dates to paths and back, also with nested formats', () => {
		const cfg = { folder: 'Diario/', format: 'YYYY/MM/YYYY-MM-DD', template: '' };
		expect(periodicPath(cfg, m('2026-10-02'))).toBe('Diario/2026/10/2026-10-02.md');
		expect(dateFromPath(cfg, 'Diario/2026/10/2026-10-02.md')?.format('YYYY-MM-DD')).toBe('2026-10-02');
		expect(dateFromPath(cfg, 'Altro/2026/10/2026-10-02.md')).toBeNull();
		const flat = { folder: '', format: 'YYYY-MM-DD', template: '' };
		expect(dateFromPath(flat, '2026-10-02.md')).not.toBeNull();
		expect(dateFromPath(flat, '2026-10-02 copia.md')).toBeNull();
		expect(dateFromPath(flat, 'Progetti/Sito.md')).toBeNull();
		const week = { folder: 'Settimane', format: 'gggg-[W]ww', template: '' };
		const p = periodicPath(week, m('2026-10-02'));
		expect(p).toMatch(/^Settimane\/2026-W\d\d\.md$/);
		expect(dateFromPath(week, p)).not.toBeNull();
	});

	it('applies core-style template variables', () => {
		const out = applyTemplate('# {{title}}\n{{date}} | {{date:DD/MM}} | {{yesterday}} | {{tomorrow:D}} | {{time}}', m('2026-10-02'), 'Titolo', 'YYYY-MM-DD');
		expect(out).toMatch(/^# Titolo\n2026-10-02 \| 02\/10 \| 2026-10-01 \| 3 \| \d\d:\d\d$/);
	});

	it('creates periodic notes with folders and template', async () => {
		const app = new FakeApp();
		await app.vault.create('Modelli/Giorno.md', '# {{date:dddd}}\n- [ ] ');
		const cfg = { folder: 'Diario', format: 'YYYY/MM/YYYY-MM-DD', template: 'Modelli/Giorno' };
		const f = await createPeriodic(app as any, cfg, m('2026-10-02'));
		expect(f.path).toBe('Diario/2026/10/2026-10-02.md');
		expect(app.vault.data.get(f.path)).toMatch(/^# \S+\n- \[ \] $/);
		expect(await createPeriodic(app as any, cfg, m('2026-10-02'))).toBe(f); // idempotent
	});

	it('parses dated tasks (Tasks emoji and Dataview fields), ignoring code blocks', () => {
		const t = parseTasks(
			[
				'- [ ] Pagare bolletta 📅 2026-10-05 #casa',
				'- [x] Fatto ⏳ 2026-10-01 ✅ 2026-10-01',
				'* [ ] Dataview [due:: 2026-10-07]',
				'1. [ ] Numerata scadenza:: 2026-10-08',
				'- [ ] senza data',
				'```',
				'- [ ] nel codice 📅 2026-10-09',
				'```',
				'testo 📅 2026-10-10',
			].join('\n'),
		);
		expect(t.map((x) => [x.line, x.date, x.done, x.text])).toEqual([
			[0, '2026-10-05', false, 'Pagare bolletta #casa'],
			[1, '2026-10-01', true, 'Fatto'],
			[2, '2026-10-07', false, 'Dataview'],
			[3, '2026-10-08', false, 'Numerata'],
		]);
	});

	it('toggles task lines and the completion date', () => {
		const on = toggleTaskLine('  - [ ] Bolletta 📅 2026-10-05')!;
		expect(on).toMatch(/^ {2}- \[x\] Bolletta 📅 2026-10-05 ✅ \d{4}-\d{2}-\d{2}$/);
		expect(toggleTaskLine(on)).toBe('  - [ ] Bolletta 📅 2026-10-05');
		expect(toggleTaskLine('- [ ] semplice')).toBe('- [x] semplice');
		expect(toggleTaskLine('non è un task')).toBeNull();
	});

	it('normalizes frontmatter dates', () => {
		expect(toDay('2026-10-02T10:00')).toBe('2026-10-02');
		expect(toDay('02/10/2026')).toBe('2026-10-02');
		expect(toDay(new Date(2026, 9, 2))).toBe('2026-10-02');
		expect(toDay('domani')).toBeNull();
		expect(toDay(null)).toBeNull();
	});

	it('indexes daily notes, dated pages and tasks in a range, caching by mtime', async () => {
		const app = new FakeApp();
		const s = { ...DEFAULT_SETTINGS, dailyFolder: 'Diario', dailyFormat: 'YYYY-MM-DD', calendarUseCoreDaily: false, calendarShowTasks: true };
		await app.vault.create('Diario/2026-10-02.md', '- [ ] dentro la daily 📅 2026-10-03');
		await app.vault.create('Progetti/Sito.md', '---\nscadenza: 2026-10-05\n---\n');
		await app.vault.create('Progetti/Fuori.md', '---\ndata: 2027-01-01\n---\n');
		const list = await app.vault.create('Lista.md', '- [ ] chiama 📅 2026-10-05\n- [ ] dopo 📅 2026-12-01');
		await app.vault.create('Prosa.md', 'nessuna lista 📅 2026-10-05');
		const idx = new CalendarIndex(app as any, () => s as any);
		let reads = 0;
		const orig = app.vault.cachedRead.bind(app.vault);
		app.vault.cachedRead = async (f: any) => (reads++, orig(f));
		const map = await idx.build(m('2026-09-28'), m('2026-11-08'));
		expect(map.get('2026-10-02')?.daily?.path).toBe('Diario/2026-10-02.md');
		expect(map.get('2026-10-05')?.pages.map((f) => f.path)).toEqual(['Progetti/Sito.md']);
		expect(map.get('2026-10-05')?.tasks.map((t) => t.text)).toEqual(['chiama']);
		expect(map.get('2026-10-03')?.tasks).toHaveLength(1);
		expect(map.has('2026-12-01')).toBe(false);
		expect(reads).toBe(2); // only notes with task list items are read
		await idx.build(m('2026-09-28'), m('2026-11-08'));
		expect(reads).toBe(2); // cached
		await app.vault.modify(list, '- [x] chiama 📅 2026-10-05');
		const again = await idx.build(m('2026-09-28'), m('2026-11-08'));
		expect(again.get('2026-10-05')?.tasks[0].done).toBe(true);
		s.calendarShowTasks = false;
		expect((await idx.build(m('2026-10-05'), m('2026-10-05'))).get('2026-10-05')?.tasks ?? []).toHaveLength(0);
		expect((await idx.build(m('2026-10-05'), m('2026-10-05'), { tasks: true })).get('2026-10-05')?.tasks).toHaveLength(1);
	});
});

async function setup() {
	document.body.innerHTML = '';
	const app = new FakeApp();
	const plugin = new AmbraiaPlugin(app, manifest);
	await plugin.onload();
	await app.workspace.fireLayoutReady();
	plugin.settings.calendarUseCoreDaily = false;
	plugin.settings.dailyFolder = 'Diario';
	plugin.settings.dailyFormat = 'YYYY-MM-DD';
	return { app, plugin };
}

describe('calendar in the plugin', () => {
	it('registers the calendar commands and view', async () => {
		const { plugin } = await setup();
		const ids = plugin.commands.map((c: any) => c.id);
		for (const id of ['calendar-open', 'daily-today', 'daily-prev', 'daily-next', 'weekly-this']) expect(ids).toContain(id);
		expect(plugin.views.has('ambraia-calendar')).toBe(true);
	});

	it('today command creates and opens the daily note once', async () => {
		const { app, plugin } = await setup();
		const cmd = plugin.commands.find((c: any) => c.id === 'daily-today');
		await (cmd.callback ?? cmd.checkCallback)?.();
		const today = (moment as any)().format('YYYY-MM-DD');
		expect(app.workspace.getActiveFile()?.path).toBe(`Diario/${today}.md`);
		await cmd.callback?.();
		expect(app.vault.getMarkdownFiles().filter((f) => f.path.startsWith('Diario/'))).toHaveLength(1);
	});

	it('previous/next daily note skip missing days', async () => {
		const { app, plugin } = await setup();
		await app.vault.create('Diario/2026-09-20.md', '');
		const mid = await app.vault.create('Diario/2026-09-25.md', '');
		await app.vault.create('Diario/2026-09-29.md', '');
		app.workspace.active = mid;
		await plugin.commands.find((c: any) => c.id === 'daily-next').callback();
		expect(app.workspace.getActiveFile()?.path).toBe('Diario/2026-09-29.md');
		app.workspace.active = mid;
		await plugin.commands.find((c: any) => c.id === 'daily-prev').callback();
		expect(app.workspace.getActiveFile()?.path).toBe('Diario/2026-09-20.md');
	});

	it('renders the month, marks days and toggles a task from the agenda', async () => {
		const { app, plugin } = await setup();
		const today = (moment as any)().format('YYYY-MM-DD');
		await app.vault.create(`Diario/${today}.md`, 'oggi');
		const list = await app.vault.create('Lista.md', `- [ ] chiamare Luca 📅 ${today}`);
		await app.vault.create('Evento.md', `---\ndata: ${today}\n---\n`);
		await plugin.activateCalendar();
		const view = app.workspace.getLeavesOfType('ambraia-calendar')[0].view;
		await view.render();
		const el: HTMLElement = view.contentEl;
		const cell = el.querySelector(`.ambraia-calv-day[data-date="${today}"]`)!;
		expect(cell.classList.contains('is-today')).toBe(true);
		// one task + one dated page: two blue dots (the daily note itself is not counted)
		expect(cell.querySelectorAll('.ambraia-calv-dot.is-busy').length).toBe(2);
		expect(cell.querySelector('.ambraia-calv-dot.is-full')).toBeNull();
		const cells = el.querySelectorAll('.ambraia-calv-day');
		expect(cells.length % 7).toBe(0);
		expect(el.querySelector('.ambraia-calv-agenda')!.textContent).toContain('chiamare Luca');
		const cb = el.querySelector<HTMLInputElement>('.ambraia-calv-task input')!;
		cb.click();
		await sleep(10);
		expect(app.vault.data.get(list.path)).toMatch(/^- \[x\] chiamare Luca/);
		await sleep(80);
		await view.render();
		expect(el.querySelector('.ambraia-calv-task.is-done')).not.toBeNull();
	});

	it('navigates months and clicking a day with a daily note opens it', async () => {
		const { app, plugin } = await setup();
		await plugin.activateCalendar();
		const view = app.workspace.getLeavesOfType('ambraia-calendar')[0].view;
		const title = () => view.contentEl.querySelector('.ambraia-calv-title')!.textContent;
		const before = title();
		view.shift(1);
		await sleep(5);
		expect(title()).not.toBe(before);
		view.goToday();
		await sleep(5);
		expect(title()).toBe(before);
		const day = (moment as any)().startOf('month').add(2, 'day').format('YYYY-MM-DD');
		await app.vault.create(`Diario/${day}.md`, '');
		await view.render();
		(view.contentEl.querySelector(`[data-date="${day}"]`) as HTMLElement).click();
		await sleep(5);
		expect(app.workspace.getActiveFile()?.path).toBe(`Diario/${day}.md`);
	});

	it('get_daily_note tool reports tasks even when the calendar hides them', async () => {
		const { app, plugin } = await setup();
		plugin.settings.calendarShowTasks = false;
		await app.vault.create('Lista.md', '- [ ] consegna 📅 2026-10-05');
		const tool = plugin.ai.getTools().find((t: any) => t.def.name === 'get_daily_note');
		const out = await tool.run({ date: '2026-10-05' }, { plugin, touched: new Set(), confirm: async () => false });
		expect(out).toContain('consegna');
	});
});
