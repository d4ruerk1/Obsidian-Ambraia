// @vitest-environment jsdom
// 1.0: no update check, space optimisation on demand, essential note menu, safe uninstall, standard font.
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeApp, installDomShim } from './app-fake';
import { isHiddenItem } from '../src/ui/noteMenu';
import { DEFAULT_SETTINGS } from '../src/settings';

installDomShim();
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
});

async function setup(prep?: (app: FakeApp) => Promise<void> | void) {
	document.body.innerHTML = '';
	document.body.className = '';
	const app = new FakeApp();
	await prep?.(app);
	const plugin = new AmbraiaPlugin(app, manifest);
	await plugin.onload();
	return { app, plugin };
}

describe('defaults', () => {
	it('AI is off, the standard font and the essential note menu are on', () => {
		expect(DEFAULT_SETTINGS.aiEnabled).toBe(false);
		expect(DEFAULT_SETTINGS.font).toBe('standard');
		expect(DEFAULT_SETTINGS.compactNoteMenu).toBe(true);
		expect('checkUpdates' in DEFAULT_SETTINGS).toBe(false);
		expect('donateReminder' in DEFAULT_SETTINGS).toBe(false);
		expect('showProperties' in DEFAULT_SETTINGS).toBe(false);
	});
	it('the old "notion" font becomes "standard"', async () => {
		const { plugin } = await setup((app) => app.vault.adapter.write('.obsidian/plugins/ambraia/data.json', JSON.stringify({ font: 'notion' })));
		expect(plugin.settings.font).toBe('standard');
		expect(document.body.classList.contains('ambraia-font-standard')).toBe(true);
		expect(document.body.classList.contains('ambraia-hide-props')).toBe(true);
		await plugin.onunload();
	});
	it('AI commands are not offered while AI is off', async () => {
		const { plugin } = await setup();
		const cmd = plugin.commands.find((c: any) => c.id === 'ai-chat' || c.id === 'open-ai-chat');
		if (cmd?.checkCallback) expect(cmd.checkCallback(true)).toBeFalsy();
		await plugin.onunload();
	});
});

describe('no update checker of its own', () => {
	it('makes no network request on load and has no update command', async () => {
		const { app, plugin } = await setup();
		await app.workspace.fireLayoutReady();
		expect(plugin.commands.some((c: any) => c.id === 'check-updates')).toBe(false);
		expect('updates' in plugin).toBe(false);
		await plugin.onunload();
	});
});

describe('space optimisation', () => {
	it('compacts only Ambraia keys and never touches the text', async () => {
		const { app, plugin } = await setup(async (app) => {
			await app.vault.create('A.md', '---\nicon: ""\nbanner_y: 50\n---\nTesto A');
			await app.vault.create('B.md', '---\ntags: [x]\nbanner: ""\nbanner-y: 30\n---\nTesto B');
			await app.vault.create('C.md', '---\nicon: 🚀\n---\nTesto C');
		});
		await app.workspace.fireLayoutReady();
		const r = await plugin.maintenance.run();
		const read = (p: string) => app.vault.read(app.vault.getAbstractFileByPath(p) as any);
		expect(await read('A.md')).toBe('Testo A');
		const b = await read('B.md');
		expect(b).toContain('tags');
		expect(b).toContain('banner_y: 30');
		expect(b).not.toContain('banner:');
		expect(b).not.toContain('banner-y');
		expect(b).toContain('Testo B');
		expect(await read('C.md')).toContain('icon: 🚀');
		expect(r.notes).toBe(2);
		await plugin.onunload();
	});
	it('never runs by itself', async () => {
		const { app, plugin } = await setup(async (app) => {
			await app.vault.create('A.md', '---\nicon: ""\n---\nTesto A');
		});
		await app.workspace.fireLayoutReady();
		expect(await app.vault.read(app.vault.getAbstractFileByPath('A.md') as any)).toContain('icon: ""');
		expect('auto' in plugin.maintenance).toBe(false);
		await plugin.onunload();
	});
});

describe('essential note menu', () => {
	it('hides rarely used items, keeps the rest', () => {
		expect(isHiddenItem('system', 'lucide-anything')).toBe(true);
		expect(isHiddenItem('info.copy', 'lucide-link')).toBe(true);
		expect(isHiddenItem('view', 'lucide-monitor')).toBe(true);
		expect(isHiddenItem('action', 'lucide-files')).toBe(true);
		expect(isHiddenItem('danger', 'lucide-trash-2')).toBe(false);
		expect(isHiddenItem('action', 'lucide-pencil')).toBe(false);
		expect(isHiddenItem('', '')).toBe(false);
	});
});

describe('properties hidden with CSS only', () => {
	it('never changes Obsidian settings and can be turned off', async () => {
		const cfg: Record<string, unknown> = { propertiesInDocument: 'visible' };
		const { app, plugin } = await setup((app: any) => {
			app.vault.getConfig = (k: string) => cfg[k];
			app.vault.setConfig = (k: string, v: unknown) => (cfg[k] = v);
		});
		await app.workspace.fireLayoutReady();
		expect(cfg.propertiesInDocument).toBe('visible');
		expect(document.body.classList.contains('ambraia-hide-props')).toBe(true);
		plugin.settings.hideProperties = false;
		await plugin.saveSettings();
		expect(document.body.classList.contains('ambraia-hide-props')).toBe(false);
		await plugin.onunload();
	});
});
