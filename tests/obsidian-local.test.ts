import { describe, expect, it } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { ObsidianLocal } from '../src/sync/obsidianLocal';

const PLUGIN = '.obsidian/plugins/ambraia';
const CONFIG = [
	'.obsidian/app.json', '.obsidian/appearance.json', '.obsidian/hotkeys.json', '.obsidian/core-plugins.json', '.obsidian/community-plugins.json',
	'.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.obsidian/graph.json',
	'.obsidian/themes/Minimal/theme.css', '.obsidian/snippets/wide.css',
	'.obsidian/plugins/dataview/main.js', '.obsidian/plugins/dataview/manifest.json', '.obsidian/plugins/dataview/data.json',
	`${PLUGIN}/main.js`, `${PLUGIN}/manifest.json`, `${PLUGIN}/styles.css`, `${PLUGIN}/data.json`, `${PLUGIN}/sync-state.json`, `${PLUGIN}/link.ambraia`, `${PLUGIN}/models/x.bin`,
];

function fakeApp() {
	const files = new Map<string, number>(CONFIG.map((p) => [p, 10]));
	const loaded: (TFile | TFolder)[] = [];
	const add = (path: string, folder = false) => {
		const f = folder ? new TFolder() : new TFile();
		(f as any).path = path;
		if (!folder) (f as any).stat = { mtime: 1, size: 3 };
		loaded.push(f);
	};
	add('Notes', true);
	add('Notes/a.md');
	add('img.png');
	add('.trash/old.md');
	const dirs = () => {
		const d = new Set<string>();
		for (const p of files.keys()) {
			const parts = p.split('/');
			for (let i = 1; i < parts.length; i++) d.add(parts.slice(0, i).join('/'));
		}
		return d;
	};
	const adapter = {
		list: async (dir: string) => {
			const all = dirs();
			const kids = (xs: Iterable<string>) => [...xs].filter((p) => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/'));
			return { files: kids(files.keys()), folders: kids(all) };
		},
		stat: async (p: string) => (files.has(p) ? { type: 'file', mtime: 5, size: files.get(p) } : dirs().has(p) ? { type: 'folder' } : null),
	};
	return { vault: { configDir: '.obsidian', adapter, getAllLoadedFiles: () => loaded, getAbstractFileByPath: () => null } } as any;
}
const opts = (o: Partial<{ s: boolean; a: boolean; p: boolean }> = {}) => ({ configSettings: o.s ?? true, configAppearance: o.a ?? true, configPlugins: o.p ?? true, ignorePatterns: 'Archive/**\n# comment\n*.tmp', pluginDir: PLUGIN });

describe('whole vault folder sync (ObsidianLocal)', () => {
	it('by default syncs notes, settings, themes and plugins — never device layout, cache, trash or sync state', async () => {
		const l = new ObsidianLocal(fakeApp(), opts());
		const paths = (await l.list()).filter((e) => !e.isFolder).map((e) => e.path).sort();
		expect(paths).toEqual(
			[
				'Notes/a.md', 'img.png',
				'.obsidian/app.json', '.obsidian/appearance.json', '.obsidian/hotkeys.json', '.obsidian/core-plugins.json', '.obsidian/community-plugins.json',
				'.obsidian/themes/Minimal/theme.css', '.obsidian/snippets/wide.css',
				'.obsidian/plugins/dataview/main.js', '.obsidian/plugins/dataview/manifest.json', '.obsidian/plugins/dataview/data.json',
				`${PLUGIN}/main.js`, `${PLUGIN}/manifest.json`, `${PLUGIN}/styles.css`, `${PLUGIN}/data.json`,
			].sort(),
		);
	});

	it('each part can be turned off', async () => {
		const only = async (o: Parameters<typeof opts>[0]) => (await new ObsidianLocal(fakeApp(), opts(o)).list()).filter((e) => !e.isFolder && e.path.startsWith('.obsidian')).map((e) => e.path);
		expect(await only({ s: false, a: false, p: false })).toEqual([]);
		const noPlugins = await only({ p: false });
		expect(noPlugins.some((p) => p.includes('/plugins/'))).toBe(false);
		expect(noPlugins).not.toContain('.obsidian/community-plugins.json');
		expect(noPlugins).toContain('.obsidian/hotkeys.json');
		const noLook = await only({ a: false });
		expect(noLook.some((p) => p.includes('themes') || p.includes('snippets') || p.endsWith('appearance.json'))).toBe(false);
	});

	it('ignore rules, hidden folders and system files', () => {
		const l = new ObsidianLocal(fakeApp(), opts());
		for (const p of ['Archive/x.md', 'a/b.tmp', '.git/config', 'x/.DS_Store', '.hidden/n.md', '.trash/a.md', `${PLUGIN}/link.ambraia`, `${PLUGIN}/sync-state.json`, '.obsidian/workspace.json'])
			expect(l.isIgnored(p), p).toBe(true);
		for (const p of ['Archivio/x.md', 'a/b.md', '.obsidian/plugins/dataview/data.json', `${PLUGIN}/data.json`]) expect(l.isIgnored(p), p).toBe(false);
	});
});
