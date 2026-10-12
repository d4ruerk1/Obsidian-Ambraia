import { compare, FormulaError, run, toStr, Value } from './formula';
import { tx } from '../i18n';

export type ViewType = 'table' | 'board' | 'list' | 'gallery' | 'calendar';
export type PropType = 'text' | 'number' | 'checkbox' | 'date' | 'select' | 'tags' | 'link' | 'url' | 'formula';

export const VIEW_TYPES: { id: ViewType; label: string; icon: string }[] = [
	{ id: 'table', label: tx('Tabella'), icon: 'table' },
	{ id: 'board', label: tx('Bacheca'), icon: 'kanban-square' },
	{ id: 'list', label: tx('Elenco'), icon: 'list' },
	{ id: 'gallery', label: tx('Galleria'), icon: 'layout-grid' },
	{ id: 'calendar', label: tx('Calendario'), icon: 'calendar' },
];

export const PROP_TYPES: { id: PropType; label: string; icon: string }[] = [
	{ id: 'text', label: tx('Testo'), icon: 'text' },
	{ id: 'number', label: tx('Numero'), icon: 'hash' },
	{ id: 'select', label: tx('Selezione'), icon: 'circle-chevron-down' },
	{ id: 'tags', label: tx('Selezione multipla'), icon: 'tags' },
	{ id: 'checkbox', label: tx('Casella di controllo'), icon: 'check-square' },
	{ id: 'date', label: tx('Data'), icon: 'calendar' },
	{ id: 'link', label: tx('Relazione (link a pagine)'), icon: 'link' },
	{ id: 'url', label: 'URL', icon: 'globe' },
	{ id: 'formula', label: tx('Formula'), icon: 'sigma' },
];

export interface DbConfig {
	title?: string;
	source: string; // folder path, "#tag", or "this" (folder of the note)
	view: ViewType;
	columns: string[];
	types: Record<string, PropType>;
	formulas: Record<string, string>;
	groupBy?: string;
	dateField?: string;
	sort?: string; // "field asc" | "field desc"
	filter?: string;
	subfolders?: boolean;
	widths?: Record<string, number>;
}

export interface Row {
	path: string;
	name: string;
	folder: string;
	fm: Record<string, unknown>;
	tags: string[];
	ctime: number;
	mtime: number;
	icon?: string;
	cover?: string;
}

export const NAME_COL = 'nome';

const SPECIAL: Record<string, (r: Row) => Value> = {
	nome: (r) => r.name,
	name: (r) => r.name,
	'file.name': (r) => r.name,
	'file.path': (r) => r.path,
	cartella: (r) => r.folder,
	folder: (r) => r.folder,
	creato: (r) => new Date(r.ctime),
	created: (r) => new Date(r.ctime),
	'file.ctime': (r) => new Date(r.ctime),
	modificato: (r) => new Date(r.mtime),
	modified: (r) => new Date(r.mtime),
	'file.mtime': (r) => new Date(r.mtime),
};

export function isSpecial(col: string): boolean {
	return Object.prototype.hasOwnProperty.call(SPECIAL, col.toLowerCase());
}

export function normalizeConfig(raw: unknown, fallbackSource = 'this'): DbConfig {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const view = VIEW_TYPES.some((v) => v.id === r.view) ? (r.view as ViewType) : 'table';
	const columns = Array.isArray(r.columns)
		? r.columns.map((c) => String(c)).filter((c) => c.trim() !== '')
		: typeof r.columns === 'string'
			? r.columns.split(',').map((c) => c.trim()).filter(Boolean)
			: [];
	if (!columns.some((c) => c.toLowerCase() === NAME_COL || c.toLowerCase() === 'name')) columns.unshift(NAME_COL);
	const types: Record<string, PropType> = {};
	if (r.types && typeof r.types === 'object') {
		for (const [k, v] of Object.entries(r.types as Record<string, unknown>)) {
			if (PROP_TYPES.some((p) => p.id === v)) types[k] = v as PropType;
		}
	}
	const formulas: Record<string, string> = {};
	if (r.formulas && typeof r.formulas === 'object') {
		for (const [k, v] of Object.entries(r.formulas as Record<string, unknown>)) {
			if (typeof v === 'string') {
				formulas[k] = v;
				types[k] = 'formula';
			}
		}
	}
	const widths: Record<string, number> = {};
	if (r.widths && typeof r.widths === 'object') {
		for (const [k, v] of Object.entries(r.widths as Record<string, unknown>)) if (typeof v === 'number') widths[k] = v;
	}
	const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
	return {
		title: str(r.title),
		source: str(r.source) ?? fallbackSource,
		view,
		columns,
		types,
		formulas,
		groupBy: str(r.groupBy),
		dateField: str(r.dateField),
		sort: str(r.sort),
		filter: str(r.filter),
		subfolders: r.subfolders === true,
		widths: Object.keys(widths).length ? widths : undefined,
	};
}

/** Serialize to a plain object, omitting defaults so the YAML stays tidy. */
export function serializeConfig(c: DbConfig): Record<string, unknown> {
	const o: Record<string, unknown> = {};
	if (c.title) o.title = c.title;
	o.source = c.source;
	o.view = c.view;
	o.columns = c.columns;
	const types = Object.fromEntries(Object.entries(c.types).filter(([k, v]) => v !== 'formula' && v !== 'text' && c.columns.includes(k)));
	if (Object.keys(types).length) o.types = types;
	if (Object.keys(c.formulas).length) o.formulas = c.formulas;
	if (c.groupBy) o.groupBy = c.groupBy;
	if (c.dateField) o.dateField = c.dateField;
	if (c.sort) o.sort = c.sort;
	if (c.filter) o.filter = c.filter;
	if (c.subfolders) o.subfolders = true;
	if (c.widths && Object.keys(c.widths).length) o.widths = c.widths;
	return o;
}

function fmGet(fm: Record<string, unknown>, key: string): unknown {
	if (Object.prototype.hasOwnProperty.call(fm, key)) return fm[key];
	const low = key.toLowerCase();
	for (const k of Object.keys(fm)) if (k.toLowerCase() === low) return fm[k];
	return undefined;
}

export function toValue(v: unknown): Value {
	if (v === undefined || v === null) return null;
	if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
	if (v instanceof Date) return v;
	if (Array.isArray(v)) return v.map(toValue);
	return JSON.stringify(v);
}

/** Raw (stored) value of a property for a row, without formulas. */
export function rawValue(r: Row, col: string): Value {
	const low = col.toLowerCase();
	if (low === 'tags' || low === 'tag') {
		const t = fmGet(r.fm, col);
		if (t !== undefined) return normTags(t);
		return r.tags;
	}
	const fmv = fmGet(r.fm, col);
	if (fmv !== undefined) return toValue(fmv);
	const sp = Object.prototype.hasOwnProperty.call(SPECIAL, low) ? SPECIAL[low] : undefined;
	return sp ? sp(r) : null;
}

export function normTags(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x).replace(/^#/, '')).filter(Boolean);
	if (typeof v === 'string') return v.split(/[,\s]+/).map((x) => x.replace(/^#/, '')).filter(Boolean);
	return [];
}

export class FormulaCtx {
	errors = new Map<string, string>();
	constructor(private cfg: DbConfig) {}

	value(r: Row, col: string, depth = 0): Value {
		const f = Object.prototype.hasOwnProperty.call(this.cfg.formulas, col) ? this.cfg.formulas[col] : undefined;
		if (typeof f === 'string') {
			if (depth > 8) return null;
			try {
				return run(f, (name) => this.value(r, name, depth + 1));
			} catch (e) {
				this.errors.set(col, e instanceof FormulaError ? e.message : String(e));
				return null;
			}
		}
		return rawValue(r, col);
	}
}

export interface QueryResult {
	rows: Row[];
	error?: string;
}

export function applyQuery(rows: Row[], cfg: DbConfig, search = ''): QueryResult {
	const ctx = new FormulaCtx(cfg);
	let out = rows;
	let error: string | undefined;
	if (cfg.filter) {
		try {
			run(cfg.filter, () => null); // syntax check once
			out = out.filter((r) => {
				try {
					return !!truthyResult(run(cfg.filter!, (n) => ctx.value(r, n)));
				} catch {
					return false;
				}
			});
		} catch (e) {
			error = tx('Filtro non valido: {0}', e instanceof Error ? e.message : e);
		}
	}
	const q = search.trim().toLowerCase();
	if (q) {
		out = out.filter((r) => {
			if (r.name.toLowerCase().includes(q)) return true;
			return cfg.columns.some((c) => toStr(ctx.value(r, c)).toLowerCase().includes(q));
		});
	}
	const sort = parseSort(cfg.sort);
	if (sort) {
		const dir = sort.desc ? -1 : 1;
		const keyed = out.map((r) => ({ r, v: ctx.value(r, sort.field) }));
		keyed.sort((a, b) => {
			const ea = a.v === null || a.v === '';
			const eb = b.v === null || b.v === '';
			if (ea !== eb) return ea ? 1 : -1; // empty always last
			return compare(a.v, b.v) * dir || a.r.name.localeCompare(b.r.name);
		});
		out = keyed.map((k) => k.r);
	} else {
		out = [...out].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	}
	for (const [col, msg] of ctx.errors) error = error ?? tx('Formula "{0}": {1}', col, msg);
	return { rows: out, error };
}

function truthyResult(v: Value): boolean {
	if (Array.isArray(v)) return v.length > 0;
	if (typeof v === 'string') return v !== '';
	return !!v;
}

export function parseSort(s?: string): { field: string; desc: boolean } | null {
	if (!s) return null;
	const m = /^(.*?)(?:\s+(asc|desc|crescente|decrescente))?$/i.exec(s.trim());
	if (!m || !m[1]) return null;
	const d = (m[2] ?? '').toLowerCase();
	return { field: m[1].trim(), desc: d === 'desc' || d === 'decrescente' };
}

export const EMPTY_GROUP = '\u0000';

export function groupRows(rows: Row[], cfg: DbConfig, field: string): Map<string, Row[]> {
	const ctx = new FormulaCtx(cfg);
	const groups = new Map<string, Row[]>();
	const type = cfg.types[field];
	for (const r of rows) {
		const v = ctx.value(r, field);
		let keys: string[];
		if (Array.isArray(v)) keys = v.length ? v.map(toStr) : [EMPTY_GROUP];
		else if (type === 'checkbox' || typeof v === 'boolean') keys = [v === true || v === 'true' ? 'true' : 'false'];
		else keys = [v === null || v === '' ? EMPTY_GROUP : toStr(v)];
		for (const k of keys) {
			if (!groups.has(k)) groups.set(k, []);
			groups.get(k)!.push(r);
		}
	}
	return groups;
}

/** Distinct option values for a property across rows (for select menus). */
export function distinctValues(rows: Row[], col: string): string[] {
	const s = new Set<string>();
	for (const r of rows) {
		const v = rawValue(r, col);
		if (Array.isArray(v)) v.forEach((x) => s.add(toStr(x)));
		else if (v !== null && v !== '') s.add(toStr(v));
	}
	return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Guess a property type from existing values. */
export function guessType(rows: Row[], col: string): PropType {
	const low = col.toLowerCase();
	if (low === 'tags' || low === 'tag') return 'tags';
	if (['creato', 'created', 'modificato', 'modified', 'file.ctime', 'file.mtime'].includes(low)) return 'date';
	const vals = rows.map((r) => rawValue(r, col)).filter((v) => v !== null && v !== '');
	if (!vals.length) return 'text';
	if (vals.every((v) => typeof v === 'boolean')) return 'checkbox';
	if (vals.every((v) => typeof v === 'number')) return 'number';
	if (vals.every((v) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)))) return 'date';
	if (vals.every((v) => typeof v === 'string' && /^https?:\/\//.test(v))) return 'url';
	if (vals.every((v) => (typeof v === 'string' && /^\[\[.*\]\]$/.test(v)) || (Array.isArray(v) && v.every((x) => typeof x === 'string' && /^\[\[.*\]\]$/.test(x)))))
		return 'link';
	if (vals.some((v) => Array.isArray(v))) return 'tags';
	const distinct = new Set(vals.map(toStr));
	if (vals.length >= 3 && distinct.size <= Math.max(2, vals.length / 2) && [...distinct].every((d) => d.length < 30)) return 'select';
	return 'text';
}

/** Convert an edited string to the value stored in frontmatter. */
export function coerceInput(type: PropType, input: string): unknown {
	const s = input.trim();
	if (s === '') return null;
	switch (type) {
		case 'number': {
			const n = Number(s.replace(',', '.'));
			return Number.isNaN(n) ? s : n;
		}
		case 'checkbox':
			return ['true', 'si', 'sì', 'yes', '1', 'x'].includes(s.toLowerCase());
		case 'tags':
			return normTags(s);
		case 'link':
			return s
				.split(',')
				.map((x) => x.trim())
				.filter(Boolean)
				.map((x) => (/^\[\[.*\]\]$/.test(x) ? x : `[[${x}]]`));
		default:
			return s;
	}
}

/** Folder membership test used to build rows. */
export function inSource(path: string, folder: string, subfolders: boolean): boolean {
	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	const f = folder.replace(/^\/+|\/+$/g, '');
	if (subfolders) return f === '' ? true : parent === f || parent.startsWith(f + '/');
	return parent === f;
}
