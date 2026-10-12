import { App, normalizePath, TFile } from 'obsidian';
import { moment } from '../ui/util';
import type { AmbraiaSettings } from '../settings';

type Moment = import('../ui/util').Moment;

export interface PeriodicConfig {
	folder: string;
	format: string;
	template: string;
}

export function isoDay(d: Date | Moment): string {
	return moment(d).format('YYYY-MM-DD');
}

/** Daily notes configuration: Ambraia's own, or the core "Daily notes" plugin if enabled and requested. */
export function dailyConfig(app: App, s: AmbraiaSettings): PeriodicConfig {
	if (s.calendarUseCoreDaily) {
		const core = (app as unknown as { internalPlugins?: { getPluginById?(id: string): { enabled?: boolean; instance?: { options?: Partial<PeriodicConfig> } } | null } })
			.internalPlugins?.getPluginById?.('daily-notes');
		const o = core?.enabled ? core.instance?.options : null;
		if (o) return { folder: (o.folder ?? '').trim(), format: (o.format || 'YYYY-MM-DD').trim(), template: (o.template ?? '').trim() };
	}
	return { folder: s.dailyFolder.trim(), format: s.dailyFormat.trim() || 'YYYY-MM-DD', template: s.dailyTemplate.trim() };
}

export function weeklyConfig(s: AmbraiaSettings): PeriodicConfig {
	return { folder: s.weeklyFolder.trim(), format: s.weeklyFormat.trim() || 'gggg-[W]ww', template: s.weeklyTemplate.trim() };
}

export function periodicPath(cfg: PeriodicConfig, d: Moment): string {
	const name = d.format(cfg.format);
	const folder = cfg.folder.replace(/^\/+|\/+$/g, '');
	return normalizePath(`${folder ? folder + '/' : ''}${name}.md`);
}

/** Parses the date of a periodic note from its path (supports formats with folders, e.g. YYYY/MM/YYYY-MM-DD). */
export function dateFromPath(cfg: PeriodicConfig, path: string): Moment | null {
	const folder = cfg.folder.replace(/^\/+|\/+$/g, '');
	let rel = path.replace(/\.md$/i, '');
	if (folder) {
		if (!rel.startsWith(folder + '/')) return null;
		rel = rel.slice(folder.length + 1);
	}
	const depth = cfg.format.split('/').length;
	const parts = rel.split('/');
	if (parts.length < depth) return null;
	const tail = parts.slice(-depth).join('/');
	const m = moment(tail, cfg.format, true);
	return m.isValid() ? m : null;
}

export function findPeriodic(app: App, cfg: PeriodicConfig, d: Moment): TFile | null {
	const f = app.vault.getAbstractFileByPath(periodicPath(cfg, d));
	return f instanceof TFile ? f : null;
}

/** Applies core-style template variables: date, time, title, date:FORMAT, yesterday, tomorrow. */
export function applyTemplate(tpl: string, d: Moment, title: string, fallbackFormat: string): string {
	return tpl.replace(/\{\{\s*(date|time|title|yesterday|tomorrow)\s*(?::\s*([^}]+?))?\s*\}\}/gi, (_m, key: string, fmt?: string) => {
		const k = key.toLowerCase();
		if (k === 'title') return title;
		if (k === 'time') return moment().format(fmt || 'HH:mm');
		if (k === 'yesterday') return d.clone().subtract(1, 'day').format(fmt || fallbackFormat);
		if (k === 'tomorrow') return d.clone().add(1, 'day').format(fmt || fallbackFormat);
		return d.format(fmt || fallbackFormat);
	});
}

async function ensureFolder(app: App, path: string) {
	const dir = path.split('/').slice(0, -1).join('/');
	if (!dir || app.vault.getAbstractFileByPath(dir)) return;
	let cur = '';
	for (const part of dir.split('/')) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
	}
}

export async function createPeriodic(app: App, cfg: PeriodicConfig, d: Moment): Promise<TFile> {
	const existing = findPeriodic(app, cfg, d);
	if (existing) return existing;
	const path = periodicPath(cfg, d);
	let content = '';
	if (cfg.template) {
		const tp = normalizePath(cfg.template.replace(/\.md$/i, '') + '.md');
		const tf = app.vault.getAbstractFileByPath(tp);
		if (tf instanceof TFile) content = applyTemplate(await app.vault.read(tf), d, path.split('/').pop()!.replace(/\.md$/, ''), cfg.format);
	}
	await ensureFolder(app, path);
	return app.vault.create(path, content);
}

/** 6×7 grid of days for the month containing `month`, starting on `weekStart` (0 = Sunday, 1 = Monday). */
export function monthGrid(month: Moment, weekStart: number): Moment[][] {
	const first = month.clone().startOf('month');
	const offset = (first.day() - weekStart + 7) % 7;
	const start = first.clone().subtract(offset, 'days');
	const weeks: Moment[][] = [];
	for (let w = 0; w < 6; w++) {
		const row: Moment[] = [];
		for (let i = 0; i < 7; i++) row.push(start.clone().add(w * 7 + i, 'days'));
		weeks.push(row);
	}
	// drop a trailing week that is entirely in the next month
	while (weeks.length > 4 && weeks[weeks.length - 1][0].month() !== month.month()) weeks.pop();
	return weeks;
}

export function resolveWeekStart(s: AmbraiaSettings): number {
	if (s.calendarWeekStart === 'sunday') return 0;
	if (s.calendarWeekStart === 'monday') return 1;
	return moment.localeData().firstDayOfWeek();
}

// ---------------------------------------------------------------- tasks & dated pages

export interface DatedTask {
	file: TFile;
	line: number;
	text: string;
	done: boolean;
	date: string;
}

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\]\s+)(.*)$/;
const DUE_RE = /(?:📅|🗓️?|⏳|due::|scadenza::|\[due::\s*)\s*(\d{4}-\d{2}-\d{2})/u;

/** Extracts tasks with a due/scheduled date (Tasks plugin 📅 / ⏳, Dataview due:: syntax). */
export function parseTasks(content: string): { line: number; text: string; done: boolean; date: string }[] {
	const out: { line: number; text: string; done: boolean; date: string }[] = [];
	const lines = content.split(/\r?\n/);
	let fence = false;
	lines.forEach((l, i) => {
		if (/^\s*(```|~~~)/.test(l)) fence = !fence;
		if (fence) return;
		const m = TASK_RE.exec(l);
		if (!m) return;
		const d = DUE_RE.exec(m[4]);
		if (!d) return;
		const text = m[4]
			.replace(/\s*(?:📅|🗓️?|⏳|🛫|➕|✅|❌)\s*\d{4}-\d{2}-\d{2}/gu, '')
			.replace(/\[?(?:due|scadenza)::\s*\d{4}-\d{2}-\d{2}\]?/g, '')
			.trim();
		out.push({ line: i, text, done: m[2] !== ' ', date: d[1] });
	});
	return out;
}

/** Toggles the checkbox of a task line, keeping everything else. Returns null if the line is not a task. */
export function toggleTaskLine(line: string): string | null {
	const m = TASK_RE.exec(line);
	if (!m) return null;
	const done = m[2] !== ' ';
	let rest = m[4];
	if (done) rest = rest.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/u, '');
	else if (/📅|⏳/u.test(rest)) rest = rest + ' ✅ ' + isoDay(new Date());
	return m[1] + (done ? ' ' : 'x') + m[3] + rest;
}

export function toDay(v: unknown): string | null {
	if (v == null || v === '') return null;
	if (v instanceof Date) return isNaN(v.getTime()) ? null : isoDay(v);
	if (typeof v !== 'string' && typeof v !== 'number') return null;
	const s = String(v).trim();
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
	if (m) return m[1];
	const d = moment(s, ['DD/MM/YYYY', 'D/M/YYYY', 'YYYY/MM/DD'], true);
	return d.isValid() ? d.format('YYYY-MM-DD') : null;
}

export interface DayInfo {
	daily: TFile | null;
	pages: TFile[];
	tasks: DatedTask[];
}

/**
 * Index of what happens on each day: daily notes, pages with a date property and dated tasks.
 * Task scanning reads only files whose metadata reports tasks, and is cached by mtime.
 */
export class CalendarIndex {
	private taskCache = new Map<string, { mtime: number; tasks: { line: number; text: string; done: boolean; date: string }[] }>();
	/** Daily-note date of every path ("" = not a daily note): parsing dates is the costly part of a scan. */
	private dayCache = new Map<string, string>();
	private daySig = '';
	constructor(
		private app: App,
		private settings: () => AmbraiaSettings,
	) {}

	invalidate(path?: string) {
		if (path) {
			this.taskCache.delete(path);
			this.dayCache.delete(path);
		} else {
			this.taskCache.clear();
			this.dayCache.clear();
		}
	}

	private dailyKey(cfg: PeriodicConfig, path: string): string {
		const sig = cfg.folder + '\0' + cfg.format;
		if (sig !== this.daySig) {
			this.dayCache.clear();
			this.daySig = sig;
		}
		let k = this.dayCache.get(path);
		if (k === undefined) {
			k = dateFromPath(cfg, path)?.format('YYYY-MM-DD') ?? '';
			this.dayCache.set(path, k);
		}
		return k;
	}

	dateFields(): string[] {
		return this.settings()
			.calendarDateFields.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	/** `tasks` forces (or disables) task scanning regardless of the calendar setting. */
	async build(from: Moment, to: Moment, opts: { tasks?: boolean } = {}): Promise<Map<string, DayInfo>> {
		const s = this.settings();
		const cfg = dailyConfig(this.app, s);
		const map = new Map<string, DayInfo>();
		const lo = isoDay(from);
		const hi = isoDay(to);
		const get = (k: string) => {
			let d = map.get(k);
			if (!d) map.set(k, (d = { daily: null, pages: [], tasks: [] }));
			return d;
		};
		const fields = this.dateFields().map((f) => f.toLowerCase());
		for (const f of this.app.vault.getMarkdownFiles()) {
			const k = this.dailyKey(cfg, f.path);
			if (k) {
				if (k >= lo && k <= hi) get(k).daily = f;
				continue;
			}
			const cache = this.app.metadataCache.getFileCache(f);
			const fm = cache?.frontmatter;
			if (fm && fields.length) {
				const seen = new Set<string>();
				for (const [key, val] of Object.entries(fm)) {
					if (!fields.includes(key.toLowerCase())) continue;
					const k = toDay(Array.isArray(val) ? val[0] : val);
					if (k && k >= lo && k <= hi && !seen.has(k)) {
						seen.add(k);
						get(k).pages.push(f);
					}
				}
			}
		}
		if (opts.tasks ?? s.calendarShowTasks) {
			for (const f of this.app.vault.getMarkdownFiles()) {
				const cache = this.app.metadataCache.getFileCache(f);
				const li = (cache as { listItems?: { task?: string }[] } | null)?.listItems;
				// metadata says the note has no task list items: skip reading it
				if (cache && !li?.some((i) => i.task !== undefined)) continue;
				let c = this.taskCache.get(f.path);
				if (!c || c.mtime !== f.stat.mtime) {
					const content = await this.app.vault.cachedRead(f);
					c = { mtime: f.stat.mtime, tasks: parseTasks(content) };
					this.taskCache.set(f.path, c);
				}
				for (const t of c.tasks) if (t.date >= lo && t.date <= hi) get(t.date).tasks.push({ ...t, file: f });
			}
		}
		return map;
	}
}

/** Moves a dated task to another day (keeps its syntax: 📅, ⏳ or due::). Returns null if the line is not a dated task. */
export function rescheduleTaskLine(line: string, day: string): string | null {
	const m = TASK_RE.exec(line);
	if (!m || !DUE_RE.test(m[4])) return null;
	return m[1] + m[2] + m[3] + m[4].replace(/((?:📅|🗓️?|⏳|due::|scadenza::|\[due::\s*)\s*)\d{4}-\d{2}-\d{2}/u, `$1${day}`);
}

/** A new task line due on a day (Tasks plugin syntax, read by the calendar). */
export function newTaskLine(text: string, day: string): string {
	return `- [ ] ${text.trim().replace(/\s*\n\s*/g, ' ')} 📅 ${day}`;
}

/** Appends a line at the end of a note, keeping one line break between blocks. */
export function appendLine(content: string, line: string): string {
	if (!content.trim()) return line + '\n';
	const body = content.replace(/\s*$/, '');
	const lastLine = body.slice(body.lastIndexOf('\n') + 1);
	const sameList = /^\s*[-*+]\s+\[.\]\s/.test(lastLine);
	return body + (sameList ? '\n' : '\n\n') + line + '\n';
}
