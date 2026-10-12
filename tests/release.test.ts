// @vitest-environment jsdom
// Loads the built main.js the way Obsidian does (code evaluated with require/module/exports)
// and starts the plugin on the fake app. Skipped when main.js has not been built.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import * as obsidian from 'obsidian';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import * as cmLang from '@codemirror/language';
import { FakeApp, installDomShim } from './app-fake';

installDomShim();
const code = fs.existsSync('main.js') ? fs.readFileSync('main.js', 'utf8') : '';
describe.skipIf(!code)('release build', () => {
	it('loads, exports the plugin class and starts with the sync hub', async () => {
		const module = { exports: {} as any };
		const req = (id: string) => {
			if (id === 'obsidian') return obsidian;
			if (id === '@codemirror/state') return cmState;
			if (id === '@codemirror/view') return cmView;
			if (id === '@codemirror/language') return cmLang;
			throw new Error('unexpected require ' + id);
		};
		const t = performance.now();
		new Function('require', 'module', 'exports', code)(req, module, module.exports);
		const ms = performance.now() - t;
		const Plugin = module.exports.default ?? module.exports;
		expect(typeof Plugin).toBe('function');
		const app = new FakeApp();
		const plugin = new Plugin(app, { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' });
		await plugin.onload();
		await app.workspace.fireLayoutReady();
		expect(Array.isArray(plugin.settings.syncTargets)).toBe(true);
		expect(typeof plugin.sync.add).toBe('function');
		expect(ms).toBeLessThan(3000);
		await plugin.onunload();
	});
});

describe('store review (1.0.1)', () => {
	const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${d}/${e.name}`) : e.name.endsWith('.ts') ? [`${d}/${e.name}`] : []));
	const src = files('src')
		.filter((f) => !f.endsWith('packs.ts'))
		.map((f) => fs.readFileSync(f, 'utf8'))
		.join('\n');
	it('no private-API patching of Uninstall, no electron.remote, no YouTube/DuckDuckGo scraping', () => {
		expect(src).not.toMatch(/uninstallPlugin/);
		expect(src).not.toMatch(/electron[^;\n]*\.remote|remote\?\.dialog/);
		expect(src).not.toMatch(/captionTracks|timedtext|ytInitialPlayerResponse/);
		expect(src).not.toMatch(/html\.duckduckgo\.com/);
	});
	it('no direct inline style assignments (setCssStyles / setCssProps / CSS classes instead)', () => {
		expect(src.replace(/style="[^"]*"/g, '')).not.toMatch(/\.style\.[a-zA-Z]+\s*=(?!=)|\.style\.setProperty\(/);
	});
});
