import { describe, expect, it } from 'vitest';
import { run, parse, FormulaError, toStr } from '../src/db/formula';
import { applyQuery, coerceInput, groupRows, guessType, inSource, normalizeConfig, parseSort, Row, serializeConfig, EMPTY_GROUP } from '../src/db/model';

const vars: Record<string, any> = { price: 10, qty: 3, name: 'Mela', done: false, due: '2026-10-05', tags: ['lavoro', 'casa'], empty: null, 'due-date': '2026-01-01', 'Nome con spazi': 'ok' };
const sc = (n: string) => (Object.hasOwn(vars, n) ? vars[n] : null);

describe('formula', () => {
	it('arithmetic & precedence', () => {
		expect(run('price * qty + 1', sc)).toBe(31);
		expect(run('1 + 2 * 3', sc)).toBe(7);
		expect(run('(1 + 2) * 3', sc)).toBe(9);
		expect(run('10 - 2 - 3', sc)).toBe(5);
		expect(run('20 / 2 / 5', sc)).toBe(2);
		expect(run('-price + 4', sc)).toBe(-6);
		expect(run('7 % 3', sc)).toBe(1);
		expect(run('1 / 0', sc)).toBe(null);
	});
	it('comparison & logic', () => {
		expect(run('price > 5 and qty < 5', sc)).toBe(true);
		expect(run('price > 5 && qty > 5', sc)).toBe(false);
		expect(run('not done', sc)).toBe(true);
		expect(run('!done || false', sc)).toBe(true);
		expect(run('name == "mela"', sc)).toBe(true);
		expect(run('name = "Pera"', sc)).toBe(false);
		expect(run('name != "Pera"', sc)).toBe(true);
		expect(run('empty == ""', sc)).toBe(true);
		expect(run('empty > 3', sc)).toBe(false);
		expect(run('empty < 3', sc)).toBe(false);
		expect(run('1 < 2 == true', sc)).toBe(true);
	});
	it('ternary & if', () => {
		expect(run('done ? "sì" : "no"', sc)).toBe('no');
		expect(run('if(price > 5, "caro", "economico")', sc)).toBe('caro');
		expect(run('price > 100 ? "a" : price > 5 ? "b" : "c"', sc)).toBe('b');
		expect(run('if(true, 1)', sc)).toBe(1);
		expect(run('if(false, 1)', sc)).toBe(null);
	});
	it('strings & lists', () => {
		expect(run('concat(name, " x", qty)', sc)).toBe('Mela x3');
		expect(run('name + "!"', sc)).toBe('Mela!');
		expect(run('upper(name)', sc)).toBe('MELA');
		expect(run('len(tags)', sc)).toBe(2);
		expect(run('contains(tags, "#Lavoro")', sc)).toBe(true);
		expect(run('contains(name, "el")', sc)).toBe(true);
		expect(run('sum([1,2,3])', sc)).toBe(6);
		expect(run('join(tags, " / ")', sc)).toBe('lavoro / casa');
		expect(run("'a\\'b'", sc)).toBe("a'b");
		expect(run('prop("Nome con spazi")', sc)).toBe('ok');
		expect(run('`Nome con spazi`', sc)).toBe('ok');
		expect(run('due-date', sc)).toBe('2026-01-01');
		expect(run('price-1', sc)).toBe(9);
		expect(run('"5" + 1', sc)).toBe(6);
	});
	it('dates', () => {
		expect(run('dateDiff(due, "2026-10-01", "days")', sc)).toBe(4);
		expect(run('due - "2026-10-01"', sc)).toBe(4);
		expect(toStr(run('dateAdd(due, 1, "months")', sc))).toBe('2026-11-05');
		expect(toStr(run('due + 3', sc))).toBe('2026-10-08');
		expect(run('formatDate(due, "DD/MM/YYYY")', sc)).toBe('05/10/2026');
		expect(run('due > "2026-10-01"', sc)).toBe(true);
		expect(run('year(due)', sc)).toBe(2026);
	});
	it('errors', () => {
		expect(() => parse('1 +')).toThrow(FormulaError);
		expect(() => parse('(1')).toThrow(FormulaError);
		expect(() => parse('"abc')).toThrow(FormulaError);
		expect(() => parse('1 2')).toThrow(FormulaError);
		expect(() => run('nope(1)', sc)).toThrow(FormulaError);
		expect(() => parse('a # b')).toThrow(FormulaError);
		// no access to JS globals
		expect(run('constructor', sc)).toBe(null);
		expect(() => run('constructor(1)', sc)).toThrow(FormulaError);
		expect(run('__proto__', sc)).toBe(null);
	});
});

function row(name: string, fm: Record<string, unknown>, folder = 'Progetti'): Row {
	return { path: `${folder}/${name}.md`, name, folder, fm, tags: [], ctime: 0, mtime: 0 };
}

describe('db model', () => {
	const rows = [
		row('B', { stato: 'Fatto', prezzo: 5, data: '2026-10-02' }),
		row('A', { stato: 'In corso', prezzo: 20 }),
		row('C', { stato: 'Fatto', prezzo: 1, data: '2026-09-01' }),
		row('D', {}),
	];
	it('normalizes config', () => {
		const c = normalizeConfig({ view: 'board', columns: 'stato, prezzo', formulas: { iva: 'prezzo * 1.22' } });
		expect(c.columns).toEqual(['nome', 'stato', 'prezzo']);
		expect(c.view).toBe('board');
		expect(c.types.iva).toBe('formula');
		expect(normalizeConfig(null).view).toBe('table');
		expect(normalizeConfig({ view: 'weird' }).view).toBe('table');
		const s = serializeConfig(c);
		expect(s.formulas).toEqual({ iva: 'prezzo * 1.22' });
		expect(normalizeConfig(s)).toEqual(c);
	});
	it('filters, sorts, searches', () => {
		const cfg = normalizeConfig({ columns: ['stato', 'prezzo'], filter: 'stato == "fatto"', sort: 'prezzo desc' });
		expect(applyQuery(rows, cfg).rows.map((r) => r.name)).toEqual(['B', 'C']);
		const cfg2 = normalizeConfig({ columns: ['prezzo'], sort: 'prezzo' });
		expect(applyQuery(rows, cfg2).rows.map((r) => r.name)).toEqual(['C', 'B', 'A', 'D']);
		const cfg3 = normalizeConfig({ columns: ['data'], sort: 'data desc' });
		expect(applyQuery(rows, cfg3).rows.map((r) => r.name)).toEqual(['B', 'C', 'A', 'D']);
		expect(applyQuery(rows, normalizeConfig({ columns: ['stato'] }), 'corso').rows.map((r) => r.name)).toEqual(['A']);
		const bad = applyQuery(rows, normalizeConfig({ filter: 'stato ==' }));
		expect(bad.error).toMatch(/Filtro/);
		expect(bad.rows.length).toBe(4);
		const f = normalizeConfig({ columns: ['tot'], formulas: { tot: 'prezzo * 2' }, sort: 'tot desc' });
		expect(applyQuery(rows, f).rows.map((r) => r.name)).toEqual(['A', 'B', 'C', 'D']);
		const ferr = applyQuery(rows, normalizeConfig({ columns: ['x'], formulas: { x: 'foo(' } }));
		expect(ferr.error).toBe(undefined); // not evaluated unless used
	});
	it('groups', () => {
		const g = groupRows(rows, normalizeConfig({}), 'stato');
		expect([...g.keys()]).toEqual(['Fatto', 'In corso', EMPTY_GROUP]);
		expect(g.get('Fatto')!.length).toBe(2);
	});
	it('guesses types & coerces input', () => {
		expect(guessType(rows, 'prezzo')).toBe('number');
		expect(guessType(rows, 'data')).toBe('date');
		expect(guessType([row('x', { ok: true })], 'ok')).toBe('checkbox');
		expect(guessType([row('x', { r: '[[A]]' })], 'r')).toBe('link');
		expect(coerceInput('number', '3,5')).toBe(3.5);
		expect(coerceInput('tags', '#a, b c')).toEqual(['a', 'b', 'c']);
		expect(coerceInput('link', 'A, [[B]]')).toEqual(['[[A]]', '[[B]]']);
		expect(coerceInput('text', '  ')).toBe(null);
		expect(parseSort('Data di scadenza decrescente')).toEqual({ field: 'Data di scadenza', desc: true });
	});
	it('source membership', () => {
		expect(inSource('P/a.md', 'P', false)).toBe(true);
		expect(inSource('P/x/a.md', 'P', false)).toBe(false);
		expect(inSource('P/x/a.md', 'P', true)).toBe(true);
		expect(inSource('PX/a.md', 'P', true)).toBe(false);
		expect(inSource('a.md', '', false)).toBe(true);
		expect(inSource('a.md', '/', false)).toBe(true);
	});
});

describe('prototype safety', () => {
	it('row props named like Object members', () => {
		const r = row('X', {});
		const cfg = normalizeConfig({ columns: ['constructor', 'toString'] });
		expect(applyQuery([r], cfg, 'zzz').rows.length).toBe(0);
		expect(applyQuery([r], normalizeConfig({ filter: 'constructor == ""' })).rows.length).toBe(1);
	});
});
