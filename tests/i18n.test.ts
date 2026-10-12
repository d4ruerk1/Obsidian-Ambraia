import { describe, expect, it, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LANGS, setLanguage, tx, currentLanguage, isRtl, unpack } from '../src/i18n';

const source: string[] = JSON.parse(fs.readFileSync('i18n/source.json', 'utf8'));

describe('interface languages', () => {
	afterAll(() => setLanguage('it'));

	it('ships a complete pack for every language, with intact placeholders', () => {
		expect(unpack('it')).toEqual(source);
		for (const l of Object.keys(LANGS)) {
			const arr = unpack(l);
			expect(arr.length, l).toBe(source.length);
			arr.forEach((t, i) => {
				if (!t) return;
				const ph = (s: string) => (s.match(/\{\d\}/g) ?? []).sort().join();
				expect(ph(t), `${l}: ${source[i]}`).toBe(ph(source[i]));
			});
		}
	});

	it('every tx() literal in the sources is in the packs (otherwise the build fails)', async () => {
		const { i18nPlugin } = await import('../scripts/i18n-esbuild.mjs');
		let onLoad: ((a: { path: string }) => Promise<{ errors?: unknown[]; contents?: string } | undefined>) | null = null;
		i18nPlugin().setup({ onLoad: (_f: unknown, cb: typeof onLoad) => (onLoad = cb) } as never);
		const files: string[] = [];
		const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') && files.push(path.resolve(d, e.name))));
		walk('src');
		for (const f of files) {
			const r = await onLoad!({ path: f });
			expect(r?.errors ?? [], f).toEqual([]);
			if (r?.contents) expect(r.contents, f).not.toMatch(/(?<![\w$.])tx\(\s*'(?:[^'\\]|\\.)*'/);
		}
	});

	it('translates by source text and by build index, and falls back safely', () => {
		setLanguage('en');
		expect(currentLanguage()).toBe('en');
		expect(tx('Sincronizza ora')).toBe('Sync now');
		const i = source.indexOf('Chiave principale');
		expect((tx as (s: number) => string)(i)).toBe('Master key');
		expect(tx('Collegato a {0}.', 'Dropbox')).toBe('Connected to Dropbox.');
		expect(tx('Testo che non esiste {0}', 1)).toBe('Testo che non esiste 1');
		setLanguage('de');
		expect(tx('Sincronizza ora')).not.toBe('Sincronizza ora');
		setLanguage('ar');
		expect(isRtl()).toBe(true);
		setLanguage('xx');
		expect(currentLanguage()).toBe('it'); // unsupported → Obsidian's language (mocked as Italian)
		setLanguage('it');
		expect(tx('Sincronizza ora')).toBe('Sincronizza ora');
	});
});
