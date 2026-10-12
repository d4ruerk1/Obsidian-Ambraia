import { tx } from '../i18n';
/**
 * Small, safe expression language used by Ambraia databases (filters + formulas).
 * No eval / Function: a tokenizer + Pratt parser + tree-walking interpreter.
 *
 *   price * qty            status != "fatto" and done == false
 *   if(done, "✅", "⏳")     dateDiff(due, today(), "days") < 7
 *   prop("Nome con spazi") contains(tags, "lavoro")
 */

export type Value = string | number | boolean | null | Date | Value[];

type Tok =
	| { t: 'num'; v: number }
	| { t: 'str'; v: string }
	| { t: 'id'; v: string }
	| { t: 'op'; v: string }
	| { t: 'eof' };

export class FormulaError extends Error {}

const OPS = ['==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '(', ')', ',', '?', ':', '[', ']', '='];

export function tokenize(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
			let j = i;
			while (j < src.length && /[0-9._]/.test(src[j])) j++;
			const n = Number(src.slice(i, j).replace(/_/g, ''));
			if (Number.isNaN(n)) throw new FormulaError(tx('Numero non valido: {0}', src.slice(i, j)));
			out.push({ t: 'num', v: n });
			i = j;
			continue;
		}
		if (c === '"' || c === "'") {
			let j = i + 1;
			let s = '';
			while (j < src.length && src[j] !== c) {
				if (src[j] === '\\' && j + 1 < src.length) {
					const n = src[j + 1];
					s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
					j += 2;
				} else s += src[j++];
			}
			if (j >= src.length) throw new FormulaError(tx('Stringa non chiusa'));
			out.push({ t: 'str', v: s });
			i = j + 1;
			continue;
		}
		if (c === '`') {
			// `property with spaces`
			const j = src.indexOf('`', i + 1);
			if (j < 0) throw new FormulaError(tx('Nome proprietà non chiuso'));
			out.push({ t: 'id', v: src.slice(i + 1, j) });
			i = j + 1;
			continue;
		}
		if (/[\p{L}_$]/u.test(c)) {
			let j = i;
			while (j < src.length && /[\p{L}\p{N}_$.-]/u.test(src[j])) {
				// a '-' is part of an identifier only when followed by a letter (e.g. due-date)
				if (src[j] === '-' && !/[\p{L}]/u.test(src[j + 1] ?? '')) break;
				j++;
			}
			out.push({ t: 'id', v: src.slice(i, j) });
			i = j;
			continue;
		}
		const op = OPS.find((o) => src.startsWith(o, i));
		if (!op) throw new FormulaError(tx('Carattere inatteso: {0}', c));
		out.push({ t: 'op', v: op === '=' ? '==' : op });
		i += op.length;
	}
	out.push({ t: 'eof' });
	return out;
}

export type Node =
	| { k: 'lit'; v: Value }
	| { k: 'var'; name: string }
	| { k: 'un'; op: string; a: Node }
	| { k: 'bin'; op: string; a: Node; b: Node }
	| { k: 'tern'; c: Node; a: Node; b: Node }
	| { k: 'call'; fn: string; args: Node[] }
	| { k: 'list'; items: Node[] };

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const WORD_OPS: Record<string, string> = { and: '&&', or: '||', not: '!', e: '&&', o: '||' };

const PREC: Record<string, number> = {
	'?': 1,
	'||': 2,
	'&&': 3,
	'==': 4,
	'!=': 4,
	'<': 5,
	'<=': 5,
	'>': 5,
	'>=': 5,
	'+': 6,
	'-': 6,
	'*': 7,
	'/': 7,
	'%': 7,
};

export function parse(src: string): Node {
	const toks = tokenize(src).map((t) => (t.t === 'id' && own(WORD_OPS, t.v.toLowerCase()) ? ({ t: 'op', v: WORD_OPS[t.v.toLowerCase()] }) : t));
	let p = 0;
	const peek = () => toks[p];
	const next = () => toks[p++];
	const expect = (v: string) => {
		const t = next();
		if (t.t !== 'op' || t.v !== v) throw new FormulaError(tx('Atteso "{0}"', v));
	};
	const isOp = (v: string) => {
		const t = peek();
		return t.t === 'op' && t.v === v;
	};

	function primary(): Node {
		const t = next();
		if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
		if (t.t === 'op') {
			if (t.v === '(') {
				const e = expr(0);
				expect(')');
				return e;
			}
			if (t.v === '[') {
				const items: Node[] = [];
				if (!isOp(']')) {
					do items.push(expr(0));
					while (isOp(',') && next());
				}
				expect(']');
				return { k: 'list', items };
			}
			if (t.v === '-' || t.v === '!') return { k: 'un', op: t.v, a: expr(8) };
			if (t.v === '+') return expr(8);
			throw new FormulaError(tx('Simbolo inatteso "{0}"', t.v));
		}
		if (t.t === 'id') {
			const low = t.v.toLowerCase();
			if (low === 'true' || low === 'vero') return { k: 'lit', v: true };
			if (low === 'false' || low === 'falso') return { k: 'lit', v: false };
			if (low === 'null') return { k: 'lit', v: null };
			if (isOp('(')) {
				next();
				const args: Node[] = [];
				if (!isOp(')')) {
					do args.push(expr(0));
					while (isOp(',') && next());
				}
				expect(')');
				if (low === 'prop') {
					if (args.length !== 1 || args[0].k !== 'lit' || typeof args[0].v !== 'string')
						throw new FormulaError(tx('prop() vuole il nome della proprietà tra virgolette'));
					return { k: 'var', name: args[0].v };
				}
				return { k: 'call', fn: low, args };
			}
			return { k: 'var', name: t.v };
		}
		throw new FormulaError(tx('Espressione incompleta'));
	}

	function expr(minPrec: number): Node {
		let left = primary();
		for (;;) {
			const t = peek();
			if (t.t !== 'op') break;
			const prec = own(PREC, t.v) ? PREC[t.v] : undefined;
			if (prec === undefined || prec <= minPrec) break;
			next();
			if (t.v === '?') {
				const a = expr(0);
				expect(':');
				const b = expr(0);
				left = { k: 'tern', c: left, a, b };
			} else {
				const right = expr(prec);
				left = { k: 'bin', op: t.v, a: left, b: right };
			}
		}
		return left;
	}

	const root = expr(0);
	if (peek().t !== 'eof') throw new FormulaError(tx('Testo in eccesso alla fine della formula'));
	return root;
}

// ------------------------------------------------------------------ runtime

const DAY = 86400000;

export function toDate(v: Value): Date | null {
	if (v instanceof Date) return v;
	if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
		const d = new Date(v.length === 10 ? v + 'T00:00:00' : v);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	return null;
}

export function toNum(v: Value): number {
	if (typeof v === 'number') return v;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (v instanceof Date) return v.getTime();
	if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
	if (Array.isArray(v)) return v.length;
	return 0;
}

export function truthy(v: Value): boolean {
	if (Array.isArray(v)) return v.length > 0;
	if (v instanceof Date) return true;
	if (typeof v === 'string') return v !== '' && v.toLowerCase() !== 'false';
	return !!v;
}

export function toStr(v: Value): string {
	if (v === null || v === undefined) return '';
	if (v instanceof Date) return fmtDate(v);
	if (Array.isArray(v)) return v.map(toStr).join(', ');
	if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
	return String(v);
}

function fmtDate(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	if (d.getHours() || d.getMinutes()) return `${base} ${p(d.getHours())}:${p(d.getMinutes())}`;
	return base;
}

export function equals(a: Value, b: Value): boolean {
	if (a === b) return true;
	if (a === null || b === null || a === undefined || b === undefined) {
		return (a ?? '') === '' && (b ?? '') === '' ? true : a === b;
	}
	const da = toDate(a);
	const db = toDate(b);
	if (da && db) return da.getTime() === db.getTime();
	if (Array.isArray(a) || Array.isArray(b)) {
		if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equals(x, b[i]));
		return false;
	}
	if (typeof a === 'number' || typeof b === 'number') return toNum(a) === toNum(b);
	if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
	return String(a).toLowerCase() === String(b).toLowerCase();
}

export function compare(a: Value, b: Value): number {
	const ea = a === null || a === undefined || a === '';
	const eb = b === null || b === undefined || b === '';
	if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1; // empty values last
	const da = toDate(a);
	const db = toDate(b);
	if (da && db) return da.getTime() - db.getTime();
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'boolean' || typeof b === 'boolean') return toNum(a) - toNum(b);
	const na = Number(a);
	const nb = Number(b);
	if (!Array.isArray(a) && !Array.isArray(b) && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
	return toStr(a).localeCompare(toStr(b), undefined, { numeric: true, sensitivity: 'base' });
}

function contains(hay: Value, needle: Value): boolean {
	if (Array.isArray(hay)) return hay.some((x) => equals(x, needle) || (typeof x === 'string' && typeof needle === 'string' && x.replace(/^#/, '').toLowerCase() === needle.replace(/^#/, '').toLowerCase()));
	return toStr(hay).toLowerCase().includes(toStr(needle).toLowerCase());
}

type Fn = (args: Value[]) => Value;

const FNS: Record<string, Fn> = {
	if: (a) => (truthy(a[0]) ? a[1] ?? null : a[2] ?? null),
	concat: (a) => a.map(toStr).join(''),
	join: (a) => (Array.isArray(a[0]) ? a[0].map(toStr).join(toStr(a[1] ?? ', ')) : toStr(a[0])),
	len: (a) => (Array.isArray(a[0]) ? a[0].length : toStr(a[0]).length),
	length: (a) => FNS.len(a),
	lower: (a) => toStr(a[0]).toLowerCase(),
	upper: (a) => toStr(a[0]).toUpperCase(),
	trim: (a) => toStr(a[0]).trim(),
	replace: (a) => toStr(a[0]).split(toStr(a[1])).join(toStr(a[2])),
	slice: (a) => toStr(a[0]).slice(toNum(a[1]), a[2] === undefined ? undefined : toNum(a[2])),
	contains: (a) => contains(a[0], a[1]),
	startswith: (a) => toStr(a[0]).toLowerCase().startsWith(toStr(a[1]).toLowerCase()),
	endswith: (a) => toStr(a[0]).toLowerCase().endsWith(toStr(a[1]).toLowerCase()),
	empty: (a) => !truthy(a[0]) && a[0] !== 0,
	round: (a) => {
		const f = 10 ** toNum(a[1] ?? 0);
		return Math.round(toNum(a[0]) * f) / f;
	},
	floor: (a) => Math.floor(toNum(a[0])),
	ceil: (a) => Math.ceil(toNum(a[0])),
	abs: (a) => Math.abs(toNum(a[0])),
	sqrt: (a) => Math.sqrt(toNum(a[0])),
	pow: (a) => toNum(a[0]) ** toNum(a[1]),
	min: (a) => Math.min(...a.flat().map(toNum)),
	max: (a) => Math.max(...a.flat().map(toNum)),
	sum: (a) => a.flat().reduce<number>((s, x) => s + toNum(x), 0),
	avg: (a) => {
		const f = a.flat();
		return f.length ? f.reduce<number>((s, x) => s + toNum(x), 0) / f.length : 0;
	},
	number: (a) => toNum(a[0]),
	string: (a) => toStr(a[0]),
	today: () => {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d;
	},
	now: () => new Date(),
	date: (a) => toDate(a[0]),
	year: (a) => toDate(a[0])?.getFullYear() ?? null,
	month: (a) => (toDate(a[0]) ? toDate(a[0])!.getMonth() + 1 : null),
	day: (a) => toDate(a[0])?.getDate() ?? null,
	dateadd: (a) => {
		const d = toDate(a[0]);
		if (!d) return null;
		const r = new Date(d);
		const n = toNum(a[1]);
		const unit = toStr(a[2] ?? 'days').toLowerCase();
		if (unit.startsWith('month') || unit.startsWith('mes')) r.setMonth(r.getMonth() + n);
		else if (unit.startsWith('year') || unit.startsWith('ann')) r.setFullYear(r.getFullYear() + n);
		else if (unit.startsWith('week') || unit.startsWith('settim')) r.setDate(r.getDate() + 7 * n);
		else if (unit.startsWith('hour') || unit.startsWith('or')) r.setHours(r.getHours() + n);
		else r.setDate(r.getDate() + n);
		return r;
	},
	datediff: (a) => {
		const x = toDate(a[0]);
		const y = toDate(a[1]);
		if (!x || !y) return null;
		const unit = toStr(a[2] ?? 'days').toLowerCase();
		const ms = x.getTime() - y.getTime();
		if (unit.startsWith('hour') || unit.startsWith('or')) return Math.trunc(ms / 3600000);
		if (unit.startsWith('week') || unit.startsWith('settim')) return Math.trunc(ms / (7 * DAY));
		if (unit.startsWith('month') || unit.startsWith('mes'))
			return (x.getFullYear() - y.getFullYear()) * 12 + (x.getMonth() - y.getMonth());
		if (unit.startsWith('year') || unit.startsWith('ann')) return x.getFullYear() - y.getFullYear();
		return Math.round(ms / DAY);
	},
	formatdate: (a) => {
		const d = toDate(a[0]);
		if (!d) return '';
		const p = (n: number) => String(n).padStart(2, '0');
		return toStr(a[1] ?? 'DD/MM/YYYY')
			.replace('YYYY', String(d.getFullYear()))
			.replace('MM', p(d.getMonth() + 1))
			.replace('DD', p(d.getDate()))
			.replace('HH', p(d.getHours()))
			.replace('mm', p(d.getMinutes()));
	},
};

export type Scope = (name: string) => Value;

export function evaluate(node: Node, scope: Scope): Value {
	switch (node.k) {
		case 'lit':
			return node.v;
		case 'var':
			return scope(node.name) ?? null;
		case 'list':
			return node.items.map((n) => evaluate(n, scope));
		case 'un': {
			const v = evaluate(node.a, scope);
			return node.op === '-' ? -toNum(v) : !truthy(v);
		}
		case 'tern':
			return truthy(evaluate(node.c, scope)) ? evaluate(node.a, scope) : evaluate(node.b, scope);
		case 'call': {
			const fn = own(FNS, node.fn) ? FNS[node.fn] : undefined;
			if (!fn) throw new FormulaError(tx('Funzione sconosciuta: {0}()', node.fn));
			if (node.fn === 'if') {
				return truthy(evaluate(node.args[0], scope))
					? node.args[1]
						? evaluate(node.args[1], scope)
						: null
					: node.args[2]
						? evaluate(node.args[2], scope)
						: null;
			}
			return fn(node.args.map((n) => evaluate(n, scope)));
		}
		case 'bin': {
			if (node.op === '&&') {
				const a = evaluate(node.a, scope);
				return truthy(a) ? truthy(evaluate(node.b, scope)) : false;
			}
			if (node.op === '||') {
				const a = evaluate(node.a, scope);
				return truthy(a) ? true : truthy(evaluate(node.b, scope));
			}
			const a = evaluate(node.a, scope);
			const b = evaluate(node.b, scope);
			switch (node.op) {
				case '+': {
					const da = toDate(a);
					if (da && typeof b === 'number') return new Date(da.getTime() + b * DAY);
					if (typeof a === 'number' && typeof b === 'number') return a + b;
					if ((typeof a === 'number' || a === null) && (typeof b === 'number' || b === null)) return toNum(a) + toNum(b);
					if (typeof a === 'string' || typeof b === 'string') {
						const na = Number(a);
						const nb = Number(b);
						if (typeof a === 'string' && typeof b === 'number' && a.trim() !== '' && !Number.isNaN(na)) return na + b;
						if (typeof b === 'string' && typeof a === 'number' && b.trim() !== '' && !Number.isNaN(nb)) return a + nb;
						return toStr(a) + toStr(b);
					}
					return toNum(a) + toNum(b);
				}
				case '-': {
					const da = toDate(a);
					const db = toDate(b);
					if (da && db) return Math.round((da.getTime() - db.getTime()) / DAY);
					if (da && typeof b === 'number') return new Date(da.getTime() - b * DAY);
					return toNum(a) - toNum(b);
				}
				case '*':
					return toNum(a) * toNum(b);
				case '/': {
					const d = toNum(b);
					return d === 0 ? null : toNum(a) / d;
				}
				case '%': {
					const d = toNum(b);
					return d === 0 ? null : toNum(a) % d;
				}
				case '==':
					return equals(a, b);
				case '!=':
					return !equals(a, b);
				case '<':
					return compareStrict(a, b) < 0;
				case '<=':
					return compareStrict(a, b) <= 0;
				case '>':
					return compareStrict(a, b) > 0;
				case '>=':
					return compareStrict(a, b) >= 0;
			}
			throw new FormulaError(tx('Operatore sconosciuto {0}', node.op));
		}
	}
}

/** Like compare() but empty values never satisfy an ordering comparison. */
function compareStrict(a: Value, b: Value): number {
	const ea = a === null || a === undefined || a === '';
	const eb = b === null || b === undefined || b === '';
	if (ea || eb) return NaN;
	return compare(a, b);
}

const cache = new Map<string, Node>();

export function compile(src: string): Node {
	let n = cache.get(src);
	if (!n) {
		n = parse(src);
		if (cache.size > 500) cache.clear();
		cache.set(src, n);
	}
	return n;
}

export function run(src: string, scope: Scope): Value {
	return evaluate(compile(src), scope);
}
