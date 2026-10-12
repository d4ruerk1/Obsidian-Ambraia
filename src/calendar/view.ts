import { ItemView, Keymap, Menu, normalizePath, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import { moment } from '../ui/util';
import type AmbraiaPlugin from '../main';
import { availablePath, displayName, getIconFor, prompt, renderIcon, sanitizeFileName } from '../ui/util';
import {
	appendLine,
	CalendarIndex,
	createPeriodic,
	dailyConfig,
	DatedTask,
	DayInfo,
	findPeriodic,
	isoDay,
	monthGrid,
	newTaskLine,
	rescheduleTaskLine,
	resolveWeekStart,
	toggleTaskLine,
	weeklyConfig,
} from './dates';
import { tx } from '../i18n';

export const CALENDAR_VIEW = 'ambraia-calendar';
type Moment = import('../ui/util').Moment;

/** What is being dragged onto a day. */
type Drag = { kind: 'task'; task: DatedTask } | { kind: 'page'; file: TFile; from: string };

const TIPS_KEY = 'ambraia-calendar-tips';

/** Folder of the notes with the tasks added from the calendar ("Calendario", "Calendar"… by language). */
export function calendarFolder(): string {
	return sanitizeFileName(tx('Calendario')) || 'Calendar';
}
const OVERDUE_DAYS = 60;

/** Calendar: one month, with daily notes, dated pages and tasks; agenda of the selected day. */
export class CalendarView extends ItemView {
	private cursor: Moment = moment().startOf('day');
	private selected: string = isoDay(new Date());
	private timer: number | null = null;
	private days = new Map<string, DayInfo>();
	private overdue: DatedTask[] = [];
	private gridEl!: HTMLElement;
	private agendaEl!: HTMLElement;
	private titleBox!: HTMLElement;
	private headEl!: HTMLElement;
	/** A change arrived while the panel was hidden: redraw when it is shown again. */
	private pending = false;
	private renderSeq = 0;
	private drag: Drag | null = null;
	index: CalendarIndex;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: AmbraiaPlugin,
	) {
		super(leaf);
		// shared with the plugin (agenda, AI tools): one task cache for the whole vault
		this.index = plugin.calendarIndex ?? new CalendarIndex(this.app, () => this.plugin.settings);
	}

	getViewType() {
		return CALENDAR_VIEW;
	}
	getDisplayText() {
		return tx('Calendario');
	}
	getIcon() {
		return 'calendar-days';
	}

	async onOpen() {
		const c = this.contentEl;
		c.empty();
		c.addClass('ambraia-calendar');
		// the header uses the same columns as the days: ‹ over the first day, month and year in the
		// middle, › over the last day (and an empty cell over the week numbers, when shown)
		const head = (this.headEl = c.createDiv('ambraia-calv-head'));
		head.createDiv('ambraia-calv-head-wk');
		const btn = (icon: string, label: string, fn: () => void, cls: string) => {
			const b = head.createEl('button', { cls: `ambraia-calv-btn clickable-icon ${cls}`, attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.onclick = fn;
			return b;
		};
		btn('chevron-left', tx('Mese precedente'), () => this.shift(-1), 'ambraia-calv-prev');
		this.titleBox = head.createDiv('ambraia-calv-title');
		btn('chevron-right', tx('Mese successivo'), () => this.shift(1), 'ambraia-calv-next');

		this.tipsEl = c.createDiv('ambraia-calv-tips');
		this.toggleTips(false);

		this.gridEl = c.createDiv({ cls: 'ambraia-calv-grid', attr: { tabindex: '0', role: 'grid', 'aria-label': tx('Calendario') } });
		this.gridEl.addEventListener('keydown', (e) => this.onKey(e));
		this.agendaEl = c.createDiv('ambraia-calv-agenda');

		const q = (f?: unknown) => {
			if (f instanceof TFile) this.index.invalidate(f.path);
			this.schedule();
		};
		this.registerEvent(this.app.vault.on('create', q));
		this.registerEvent(this.app.vault.on('delete', q));
		this.registerEvent(this.app.vault.on('rename', q));
		this.registerEvent(this.app.metadataCache.on('changed', q));
		this.registerEvent(this.app.workspace.on('file-open', () => this.markActive()));
		// changes made while the panel was hidden are drawn as soon as it is visible again
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				if (this.pending && this.visible()) this.schedule(0);
			}),
		);
		// roll over at midnight
		this.registerInterval(
			window.setInterval(() => {
				const today = this.contentEl.querySelector<HTMLElement>('.ambraia-calv-day.is-today');
				if (today && today.dataset.date !== isoDay(new Date())) this.schedule();
			}, 60_000),
		);
		await this.render();
	}

	async onClose() {
		if (this.timer) window.clearTimeout(this.timer);
	}

	private visible(): boolean {
		const el = this.contentEl as HTMLElement & { isShown?: () => boolean };
		return typeof el.isShown === 'function' ? el.isShown() : true;
	}

	schedule(ms = 150) {
		if (this.timer) window.clearTimeout(this.timer);
		// a hidden panel does no work: typing in a note never rebuilds an invisible calendar
		if (!this.visible()) {
			this.pending = true;
			return;
		}
		this.pending = false;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.render();
		}, ms);
	}

	shift(n: number) {
		this.cursor = this.cursor.clone().add(n, 'month');
		void this.render();
	}

	goToday() {
		this.cursor = moment().startOf('day');
		this.selected = isoDay(new Date());
		void this.render();
	}

	select(day: string, rerender = false) {
		this.selected = day;
		const m = moment(day, 'YYYY-MM-DD');
		const outside = !m.isSame(this.cursor, 'month');
		if (outside || rerender) {
			this.cursor = m.clone();
			void this.render();
			return;
		}
		this.gridEl.querySelectorAll('.is-selected').forEach((el) => el.removeClass('is-selected'));
		this.gridEl.querySelector(`[data-date="${day}"]`)?.addClass('is-selected');
		this.renderAgenda();
	}

	private tipsEl!: HTMLElement;

	/** Short guide shown on first use (and with the ? button): what clicks, drags and colours do. */
	private toggleTips(manual: boolean) {
		const ls = this.app as unknown as { loadLocalStorage?(k: string): unknown; saveLocalStorage?(k: string, v: unknown): void };
		const el = this.tipsEl;
		if (manual) {
			const open = !el.hasClass('is-open');
			el.toggleClass('is-open', open);
			if (!open) ls.saveLocalStorage?.(TIPS_KEY, 'seen');
		} else el.toggleClass('is-open', ls.loadLocalStorage?.(TIPS_KEY) !== 'seen');
		el.empty();
		if (!el.hasClass('is-open')) return;
		const head = el.createDiv('ambraia-calv-tips-head');
		setIcon(head.createSpan('ambraia-calv-tips-icon'), 'lightbulb');
		head.createSpan({ text: tx('Come si usa') });
		const close = head.createEl('button', { cls: 'clickable-icon ambraia-calv-tips-close', attr: { 'aria-label': tx('Chiudi') } });
		setIcon(close, 'x');
		close.onclick = () => {
			el.removeClass('is-open');
			el.empty();
			ls.saveLocalStorage?.(TIPS_KEY, 'seen');
		};
		// what the coloured dots on the days mean
		const legend = el.createDiv('ambraia-calv-legend');
		const item = (cls: string, text: string) => {
			const i = legend.createDiv('ambraia-calv-legend-item');
			i.createSpan(`ambraia-calv-dot ${cls}`);
			i.createSpan({ text });
		};
		item('is-busy', tx('Un punto per ogni attività o pagina (fino a 3)'));
		item('is-full', tx('Tre punti rossi: più di 3'));
		const ul = el.createEl('ul');
		for (const t of [
			tx('Clic su un giorno per l’agenda, doppio clic per la nota del giorno.'),
			tx('Trascina attività e pagine su un altro giorno per spostarle.'),
			tx('Tasto destro per altre azioni · frecce per muoverti · T per oggi.'),
		])
			ul.createEl('li', { text: t });
	}

	async render() {
		const seq = ++this.renderSeq;
		const s = this.plugin.settings;
		const weekStart = resolveWeekStart(s);
		const weeks = monthGrid(this.cursor.clone().startOf('month'), weekStart);
		const from = weeks[0][0];
		const to = weeks[weeks.length - 1][6];
		const today = moment().startOf('day');
		const [days, past] = await Promise.all([
			this.index.build(from, to),
			s.calendarShowTasks ? this.index.build(today.clone().subtract(OVERDUE_DAYS, 'day'), today.clone().subtract(1, 'day'), { tasks: true }) : Promise.resolve(new Map<string, DayInfo>()),
		]);
		if (seq !== this.renderSeq) return; // a newer render started meanwhile
		this.days = days;
		this.overdue = Array.from(past.values())
			.flatMap((d) => d.tasks)
			.filter((t) => !t.done)
			.sort((a, b) => a.date.localeCompare(b.date));

		this.renderTitle();
		const g = this.gridEl;
		g.empty();
		g.toggleClass('has-weeks', s.weeklyNotes);
		this.headEl?.toggleClass('has-weeks', s.weeklyNotes);
		this.renderMonth(weeks, weekStart);
		this.renderAgenda();
	}

	/** "November 2026" as one button: it opens the month / year picker. */
	private renderTitle() {
		const t = this.titleBox;
		t.empty();
		const b = t.createEl('button', { cls: 'ambraia-calv-month', attr: { 'aria-label': tx('Scegli mese e anno') } });
		b.createSpan({ cls: 'ambraia-calv-month-name', text: this.cursor.format('MMMM') });
		b.createSpan({ cls: 'ambraia-calv-year', text: this.cursor.format('YYYY') });
		setIcon(b.createSpan('ambraia-calv-month-caret'), 'chevron-down');
		b.onclick = () => this.pickMonth(b);
	}

	private renderMonth(weeks: Moment[][], weekStart: number) {
		const s = this.plugin.settings;
		const g = this.gridEl;
		// weekly notes need the week numbers: they are where the note opens
		const showWeeks = s.weeklyNotes;
		if (showWeeks) g.createDiv({ cls: 'ambraia-calv-dow ambraia-calv-wk-head', text: '#' });
		for (let i = 0; i < 7; i++) g.createDiv({ cls: 'ambraia-calv-dow', text: moment().day((weekStart + i) % 7).format('dd') });
		for (const week of weeks) {
			if (showWeeks) this.weekNumber(g, week, weekStart);
			for (const d of week) this.dayCell(g, d, !d.isSame(this.cursor, 'month'));
		}
	}

	private weekNumber(g: HTMLElement, week: Moment[], weekStart: number) {
		const s = this.plugin.settings;
		const wk = g.createDiv({ cls: 'ambraia-calv-wk', text: String(week[weekStart === 1 ? 0 : 1].week()) });
		if (!s.weeklyNotes) return;
		const wf = findPeriodic(this.app, weeklyConfig(s), week[0]);
		if (wf) wk.addClass('has-note');
		wk.addClass('is-clickable');
		wk.setAttr('aria-label', wf ? tx('Apri la nota della settimana') : tx('Crea la nota della settimana'));
		wk.onclick = (e) => this.plugin.openPeriodic('week', week[0], Keymap.isModEvent(e) ? 'tab' : false);
	}

	private dayCell(g: HTMLElement, d: Moment, other: boolean) {
		const key = isoDay(d);
		const today = isoDay(new Date());
		const info = this.days.get(key);
		const active = this.app.workspace.getActiveFile()?.path;
		const cell = g.createDiv({ cls: 'ambraia-calv-day', attr: { 'data-date': key, role: 'gridcell' } });
		cell.toggleClass('is-other', other);
		cell.toggleClass('is-today', key === today);
		cell.toggleClass('is-past', key < today);
		cell.toggleClass('is-selected', key === this.selected);
		cell.toggleClass('is-weekend', d.day() === 0 || d.day() === 6);
		cell.toggleClass('is-active', !!info?.daily && info.daily.path === active);
		cell.toggleClass('has-daily', !!info?.daily);
		const num = cell.createDiv('ambraia-calv-num');
		num.setText(d.format('D'));
		const open = info?.tasks.filter((x) => !x.done) ?? [];
		// dots (narrow) and chips (wide sidebar): CSS shows one or the other
		// one dot per open task or dated page, up to three; more than three: three red dots
		const dots = cell.createDiv('ambraia-calv-dots');
		const count = open.length + (info?.pages.length ?? 0);
		for (let i = 0; i < Math.min(count, 3); i++) dots.createSpan(`ambraia-calv-dot ${count > 3 ? 'is-full' : 'is-busy'}`);
		const chips = cell.createDiv('ambraia-calv-chips');
		const items: [string, string, () => void, Drag | null][] = [
			...(info?.pages ?? []).map((f) => [getIconFor(this.plugin, f) || 'lucide-file-text', displayName(this.plugin, f), () => void this.plugin.openFile(f), { kind: 'page', file: f, from: key }] as [string, string, () => void, Drag]),
			...open.map((t) => ['lucide-circle', t.text || tx('(senza testo)'), () => void this.plugin.openFile(t.file, false, t.line), { kind: 'task', task: t }] as [string, string, () => void, Drag]),
		];
		const max = 2;
		for (const [icon, text, go, drag] of items.slice(0, max)) {
			const chip = chips.createDiv({ cls: 'ambraia-calv-chip', attr: { draggable: 'true', 'aria-label': text } });
			if (drag?.kind === 'task') chip.addClass('is-task');
			renderIcon(this.app, chip.createSpan('ambraia-calv-chip-icon'), icon);
			chip.createSpan({ cls: 'ambraia-calv-chip-text', text });
			chip.onclick = (e) => {
				e.stopPropagation();
				go();
			};
			if (drag) this.draggable(chip, drag);
		}
		if (items.length > max) chips.createDiv({ cls: 'ambraia-calv-more', text: tx('+{0} altri', items.length - max) });
		const parts: string[] = [];
		if (info?.daily) parts.push(tx('nota del giorno'));
		if (info?.pages.length) parts.push(tx('{0} pagine', info.pages.length));
		if (open.length) parts.push(tx('{0} attività', open.length));
		cell.setAttr('aria-label', d.format(tx('dddd D MMMM')) + (parts.length ? ' · ' + parts.join(', ') : ''));
		cell.onclick = (e) => this.onDayClick(key, e);
		cell.ondblclick = () => this.plugin.openPeriodic('day', moment(key, 'YYYY-MM-DD'), false, true);
		cell.oncontextmenu = (e) => this.dayMenu(key, e);
		this.dropTarget(cell, key);
	}

	// ------------------------------------------------------------ drag & drop (reschedule)

	private draggable(el: HTMLElement, d: Drag) {
		el.addEventListener('dragstart', (e) => {
			this.drag = d;
			e.dataTransfer?.setData('text/plain', d.kind === 'task' ? d.task.text : d.file.basename);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
			this.contentEl.addClass('is-dragging');
		});
		el.addEventListener('dragend', () => {
			this.drag = null;
			this.contentEl.removeClass('is-dragging');
			this.gridEl.querySelectorAll('.is-drop').forEach((x) => x.removeClass('is-drop'));
		});
	}

	private dropTarget(cell: HTMLElement, key: string) {
		cell.addEventListener('dragover', (e) => {
			if (!this.drag) return;
			e.preventDefault();
			cell.addClass('is-drop');
		});
		cell.addEventListener('dragleave', () => cell.removeClass('is-drop'));
		cell.addEventListener('drop', (e) => {
			cell.removeClass('is-drop');
			const d = this.drag;
			if (!d) return;
			e.preventDefault();
			this.drag = null;
			void this.moveTo(d, key);
		});
	}

	async moveTo(d: Drag, key: string) {
		if (d.kind === 'task') {
			if (d.task.date === key) return;
			let ok = false;
			await this.app.vault.process(d.task.file, (data) => {
				const nl = data.includes('\r\n') ? '\r\n' : '\n';
				const lines = data.split(/\r?\n/);
				const cur = lines[d.task.line];
				const next = cur !== undefined && cur.includes(d.task.text.slice(0, 20)) ? rescheduleTaskLine(cur, key) : null;
				if (next === null) return data;
				ok = true;
				lines[d.task.line] = next;
				return lines.join(nl);
			});
			if (!ok) new Notice(tx('L’attività è cambiata nel frattempo: aprila per modificarla.'));
			this.index.invalidate(d.task.file.path);
		} else {
			if (d.from === key) return;
			const fields = this.index.dateFields().map((f) => f.toLowerCase());
			await this.app.fileManager.processFrontMatter(d.file, (fm: Record<string, unknown>) => {
				for (const k of Object.keys(fm)) if (fields.includes(k.toLowerCase()) && String(fm[k]).startsWith(d.from)) fm[k] = key + String(fm[k]).slice(10);
			});
		}
		new Notice(tx('Spostato a {0}', moment(key, 'YYYY-MM-DD').format(tx('dddd D MMMM'))));
		this.selected = key;
		this.schedule(50);
	}

	// ------------------------------------------------------------ keyboard

	private onKey(e: KeyboardEvent) {
		const m = moment(this.selected, 'YYYY-MM-DD');
		const step: Record<string, [number, 'day' | 'week' | 'month']> = {
			ArrowLeft: [-1, 'day'],
			ArrowRight: [1, 'day'],
			ArrowUp: [-1, 'week'],
			ArrowDown: [1, 'week'],
			PageUp: [-1, 'month'],
			PageDown: [1, 'month'],
		};
		const s = step[e.key];
		if (s) {
			e.preventDefault();
			this.select(isoDay(m.add(s[0], s[1])));
			this.gridEl.focus();
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			void this.plugin.openPeriodic('day', m, Keymap.isModEvent(e) ? 'tab' : false, true);
		} else if (e.key === 't' || e.key === 'T') {
			e.preventDefault();
			this.goToday();
		}
	}

	private onDayClick(key: string, e: MouseEvent) {
		const info = this.days.get(key);
		this.select(key);
		const mod = Keymap.isModEvent(e);
		const m = moment(key, 'YYYY-MM-DD');
		if (info?.daily) void this.plugin.openFile(info.daily, mod ? 'tab' : false);
		else if (mod || this.plugin.settings.calendarClickCreates) void this.plugin.openPeriodic('day', m, mod ? 'tab' : false, true);
	}

	private dayMenu(key: string, e: MouseEvent) {
		const m = moment(key, 'YYYY-MM-DD');
		const info = this.days.get(key);
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle(info?.daily ? tx('Apri la nota del giorno') : tx('Crea la nota del giorno'))
				.setIcon('calendar-plus')
				.onClick(() => this.plugin.openPeriodic('day', m, false, true)),
		);
		if (info?.daily) menu.addItem((i) => i.setTitle(tx('Apri in una nuova scheda')).setIcon('file-plus-2').onClick(() => this.plugin.openFile(info.daily!, 'tab')));
		menu.addItem((i) => i.setTitle(tx('Nuova pagina in questa data')).setIcon('file-plus').onClick(() => this.newDatedPage(key)));
		if (this.plugin.settings.aiEnabled && this.plugin.ai.ready)
			menu.addItem((i) => i.setTitle(tx('Chiedi all’AI di questo giorno')).setIcon('sparkles').onClick(() => this.plugin.askAiAboutDay(key)));
		if (info?.daily) {
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle(tx('Elimina la nota del giorno'))
					.setIcon('trash')
					.onClick(() => this.app.fileManager.trashFile(info.daily!)),
			);
		}
		menu.showAtMouseEvent(e);
	}

	/** Month / year picker: a grid of months; the year in its header opens a grid of years. */
	private pickMonth(anchor: HTMLElement) {
		const old = this.contentEl.querySelector('.ambraia-calv-pop');
		old?.remove();
		if (old) return; // second click on the title closes the picker
		const pop = (this.titleBox ?? this.contentEl).createDiv('ambraia-calv-pop');
		let year = this.cursor.year();
		let years = false;
		const close = () => {
			pop.remove();
			activeDocument.removeEventListener('mousedown', outside, true);
			activeDocument.removeEventListener('keydown', esc, true);
		};
		const outside = (e: MouseEvent) => {
			if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
		};
		const esc = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.stopPropagation();
			if (years) {
				years = false;
				draw();
			} else close();
		};
		const draw = () => {
			pop.empty();
			pop.toggleClass('is-years', years);
			const first = years ? year - (((year % 12) + 12) % 12) : year; // 12 years per page
			const h = pop.createDiv('ambraia-calv-pop-head');
			const arrow = (icon: string, label: string, step: number) => {
				const b = h.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
				setIcon(b, icon);
				b.onclick = () => {
					year += years ? step * 12 : step;
					draw();
				};
			};
			arrow('chevron-left', years ? tx('Anni precedenti') : tx('Anno precedente'), -1);
			const label = h.createEl('button', {
				cls: 'ambraia-calv-pop-year',
				text: years ? `${first} – ${first + 11}` : String(year),
				attr: { 'aria-label': years ? tx('Torna ai mesi') : tx('Scegli l’anno') },
			});
			label.onclick = () => {
				years = !years;
				draw();
			};
			arrow('chevron-right', years ? tx('Anni successivi') : tx('Anno successivo'), 1);
			const grid = pop.createDiv('ambraia-calv-pop-grid');
			// compact footer: back to today, and the short guide
			const foot = pop.createDiv('ambraia-calv-pop-foot');
			const today = foot.createEl('button', { cls: 'ambraia-calv-pop-today', text: tx('Oggi'), attr: { 'aria-label': tx('Vai a oggi (T)') } });
			today.onclick = () => {
				close();
				this.goToday();
			};
			const help = foot.createEl('button', { cls: 'clickable-icon ambraia-calv-pop-help', attr: { 'aria-label': tx('Come si usa il calendario') } });
			setIcon(help, 'help-circle');
			help.onclick = () => {
				close();
				this.toggleTips(true);
			};
			if (years) {
				for (let y = first; y < first + 12; y++) {
					const b = grid.createEl('button', { text: String(y) });
					if (y === this.cursor.year()) b.addClass('is-active');
					if (y === moment().year()) b.addClass('is-now');
					b.onclick = () => {
						year = y;
						years = false;
						draw();
					};
				}
				return;
			}
			for (let i = 0; i < 12; i++) {
				const m = moment().year(year).month(i).startOf('month');
				const b = grid.createEl('button', { text: m.format('MMM') });
				if (year === this.cursor.year() && i === this.cursor.month()) b.addClass('is-active');
				if (m.isSame(moment(), 'month')) b.addClass('is-now');
				b.onclick = () => {
					this.cursor = m.clone();
					close();
					void this.render();
				};
			}
		};
		draw();
		activeDocument.addEventListener('mousedown', outside, true);
		activeDocument.addEventListener('keydown', esc, true);
	}

	private markActive() {
		const active = this.app.workspace.getActiveFile()?.path;
		this.gridEl?.querySelectorAll('.ambraia-calv-day').forEach((el) => {
			const info = this.days.get((el as HTMLElement).dataset.date ?? '');
			el.toggleClass('is-active', !!info?.daily && info.daily.path === active);
		});
	}

	async newDatedPage(key: string) {
		const name = await prompt(this.app, tx('Nuova pagina'), '', tx('Titolo della pagina'), tx('Crea'));
		if (!name) return;
		const folder = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '').path;
		const field = this.index.dateFields()[0] || 'data';
		const f = await this.app.vault.create(availablePath(this.app, folder === '/' ? '' : folder, sanitizeFileName(name), 'md'), `---\n${field}: ${key}\n---\n`);
		await this.plugin.openFile(f, false);
	}

	/**
	 * Adds a task due on the day. It goes to the day's note inside the "Calendar" folder (name in the
	 * language of Obsidian), created together with the folder when missing.
	 */
	async addTask(key: string, text: string) {
		if (!text.trim()) return;
		const f = await this.taskNote(key);
		await this.app.vault.process(f, (c) => appendLine(c, newTaskLine(text, key)));
		this.index.invalidate(f.path);
		this.schedule(30);
	}

	/** "Calendar/2026-11-05.md": the note that collects the tasks added from the calendar on that day. */
	private async taskNote(key: string): Promise<TFile> {
		const folder = calendarFolder();
		const path = normalizePath(`${folder}/${key}.md`);
		const found = this.app.vault.getAbstractFileByPath(path);
		if (found instanceof TFile) return found;
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => undefined);
		return this.app.vault.create(path, '');
	}

	private taskRow(parent: HTMLElement, t: DatedTask, showDate = false) {
		const row = parent.createDiv({ cls: 'ambraia-calv-row ambraia-calv-task', attr: { draggable: 'true' } });
		row.toggleClass('is-done', t.done);
		const cb = row.createEl('input', { type: 'checkbox', cls: 'task-list-item-checkbox' });
		cb.checked = t.done;
		cb.onclick = async (e) => {
			e.stopPropagation();
			await this.toggleTask(t.file, t.line, t.text);
		};
		row.createDiv({ cls: 'ambraia-calv-row-label', text: t.text || tx('(senza testo)') });
		row.createDiv({ cls: 'ambraia-calv-row-src', text: showDate ? moment(t.date, 'YYYY-MM-DD').format('D MMM') : t.file.basename });
		row.onclick = () => this.plugin.openFile(t.file, false, t.line);
		row.oncontextmenu = (e) => {
			const menu = new Menu();
			const move = (label: string, d: Moment) => menu.addItem((i) => i.setTitle(label).setIcon('calendar-arrow-up').onClick(() => this.moveTo({ kind: 'task', task: t }, isoDay(d))));
			move(tx('Sposta a oggi'), moment());
			move(tx('Sposta a domani'), moment().add(1, 'day'));
			move(tx('Sposta alla prossima settimana'), moment().add(1, 'week').startOf('isoWeek'));
			menu.showAtMouseEvent(e);
		};
		this.draggable(row, { kind: 'task', task: t });
	}

	renderAgenda() {
		const a = this.agendaEl;
		a.empty();
		const key = this.selected;
		const m = moment(key, 'YYYY-MM-DD');
		const info = this.days.get(key) ?? { daily: null, pages: [], tasks: [] };
		const today = isoDay(new Date());
		const s = this.plugin.settings;

		const head = a.createDiv('ambraia-calv-agenda-head');
		head.createDiv({ cls: 'ambraia-calv-agenda-title', text: m.format(tx('dddd D MMMM')) });
		const rel = m.clone().startOf('day').diff(moment().startOf('day'), 'days');
		const relText = rel === 0 ? tx('Oggi') : rel === 1 ? tx('Domani') : rel === -1 ? tx('Ieri') : m.fromNow();
		head.createDiv({ cls: `ambraia-calv-agenda-rel${rel === 0 ? ' is-today' : ''}`, text: relText });

		// main actions of the day, always in the same place
		const actions = a.createDiv('ambraia-calv-actions');
		const action = (icon: string, text: string, fn: (e: MouseEvent) => void, cls = '') => {
			const b = actions.createEl('button', { cls: `ambraia-calv-action ${cls}`.trim(), attr: { 'aria-label': text } });
			setIcon(b.createSpan('ambraia-calv-action-icon'), icon);
			b.createSpan({ cls: 'ambraia-calv-action-text', text });
			b.onclick = fn;
			return b;
		};
		if (info.daily) action('calendar-check', tx('Apri la nota del giorno'), (e) => void this.plugin.openPeriodic('day', m, Keymap.isModEvent(e) ? 'tab' : false, true), 'ambraia-calv-daily');
		if (s.aiEnabled && this.plugin.ai.ready) action('sparkles', tx('Chiedi all’AI'), () => void this.plugin.askAiAboutDay(key));

		const section = (icon: string, title: string, count: number) => {
			const sec = a.createDiv('ambraia-calv-section');
			const h = sec.createDiv('ambraia-calv-sec');
			setIcon(h.createSpan('ambraia-calv-sec-icon'), icon);
			h.createSpan({ text: title });
			if (count) h.createSpan({ cls: 'ambraia-calv-count', text: String(count) });
			return sec;
		};

		if (key === today && this.overdue.length) {
			const det = a.createEl('details', { cls: 'ambraia-calv-overdue', attr: { open: '' } });
			det.createEl('summary', { text: tx('In ritardo ({0})', this.overdue.length) });
			for (const t of this.overdue.slice(0, 30)) this.taskRow(det, t, true);
		}
		// an empty day shows one quiet line and the quick-add field, not empty sections
		const empty = !info.tasks.length && !info.pages.length;
		if (empty) a.createDiv({ cls: 'ambraia-calv-empty', text: info.daily ? tx('Nient’altro in programma.') : tx('Niente in programma.') });
		if (info.tasks.length || s.calendarShowTasks) {
			const open = info.tasks.filter((t) => !t.done).length;
			const sec = info.tasks.length ? section('check-square', tx('Attività'), open) : a.createDiv('ambraia-calv-section');
			for (const t of info.tasks.sort((x, y) => Number(x.done) - Number(y.done))) this.taskRow(sec, t);
			if (s.calendarShowTasks) {
				const add = sec.createDiv('ambraia-calv-row ambraia-calv-quick');
				const plus = add.createEl('button', { cls: 'clickable-icon ambraia-calv-row-icon ambraia-calv-quick-add', attr: { 'aria-label': tx('Aggiungi un’attività') } });
				setIcon(plus, 'plus');
				const input = add.createEl('input', { type: 'text', attr: { placeholder: tx('Aggiungi un’attività…'), 'aria-label': tx('Aggiungi un’attività') } });
				const submit = () => {
					const v = input.value;
					if (!v.trim()) return void input.focus();
					input.value = '';
					void this.addTask(key, v);
				};
				plus.onclick = (e) => {
					e.stopPropagation();
					submit();
				};
				input.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						submit();
					}
				});
			}
		}
		const pages = info.pages.length ? section('file-text', tx('Pagine'), info.pages.length) : null;
		for (const f of info.pages) {
			if (!pages) break;
			const row = pages.createDiv({ cls: 'ambraia-calv-row', attr: { draggable: 'true', 'aria-label': tx('Clic per aprire · trascina su un altro giorno per spostare') } });
			const ic = row.createDiv('ambraia-calv-row-icon');
			const icon = getIconFor(this.plugin, f);
			if (icon) renderIcon(this.app, ic, icon, f.path);
			else setIcon(ic, 'file-text');
			row.createDiv({ cls: 'ambraia-calv-row-label', text: displayName(this.plugin, f) });
			row.onclick = (e) => this.plugin.openFile(f, Keymap.isModEvent(e) ? 'tab' : false);
			this.draggable(row, { kind: 'page', file: f, from: key });
		}

		// edited that day (collapsed by default)
		const start = m.clone().startOf('day').valueOf();
		const end = m.clone().endOf('day').valueOf();
		const touched = this.app.vault
			.getMarkdownFiles()
			.filter((f) => (f.stat.mtime >= start && f.stat.mtime <= end) || (f.stat.ctime >= start && f.stat.ctime <= end))
			.filter((f) => f !== info.daily)
			.sort((x, y) => y.stat.mtime - x.stat.mtime);
		if (touched.length) {
			const det = a.createEl('details', { cls: 'ambraia-calv-touched' });
			det.createEl('summary', { text: tx('Create o modificate quel giorno ({0})', touched.length) });
			for (const f of touched.slice(0, 50)) {
				const row = det.createDiv('ambraia-calv-row');
				setIcon(row.createDiv('ambraia-calv-row-icon'), f.stat.ctime >= start && f.stat.ctime <= end ? 'file-plus' : 'file-pen');
				row.createDiv({ cls: 'ambraia-calv-row-label', text: displayName(this.plugin, f) });
				row.onclick = (e) => this.plugin.openFile(f, Keymap.isModEvent(e) ? 'tab' : false);
			}
		}
	}

	private async toggleTask(file: TFile, line: number, text: string) {
		let ok = false;
		await this.app.vault.process(file, (data) => {
			const nl = data.includes('\r\n') ? '\r\n' : '\n';
			const lines = data.split(/\r?\n/);
			const cur = lines[line];
			if (cur === undefined || !cur.includes(text.slice(0, 20))) return data;
			const next = toggleTaskLine(cur);
			if (next === null) return data;
			ok = true;
			lines[line] = next;
			return lines.join(nl);
		});
		if (!ok) new Notice(tx('L’attività è cambiata nel frattempo: aprila per modificarla.'));
		this.index.invalidate(file.path);
		this.schedule(50);
	}
}

export { createPeriodic, dailyConfig };
