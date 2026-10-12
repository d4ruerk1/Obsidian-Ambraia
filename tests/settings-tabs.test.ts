// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeApp, FakeDrive, FakeLocal, installDomShim } from './app-fake';

installDomShim();
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', author: 'd4ruerk1', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
let setupModal: typeof import('../src/sync/setupModal');
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
	setupModal = await import('../src/sync/setupModal');
});
const tick = async (n = 30) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const until = async (ok: () => boolean, ms = 8000) => {
	for (let t = 0; t < ms && !ok(); t += 20) await new Promise((r) => setTimeout(r, 20));
	expect(ok()).toBe(true);
};
async function device(drive: FakeDrive) {
	const app = new FakeApp();
	const plugin = new AmbraiaPlugin(app, manifest);
	await plugin.onload();
	plugin.settings.syncKdf = 'pbkdf2';
	plugin.sync.remoteFactory = (_c: unknown, folder: string) => drive.api(folder);
	const local = new FakeLocal();
	Object.assign(local, { setOptions() {}, isConfigPath: () => false, listConfigOnly: async () => [] });
	(plugin.sync as any).local = local;
	await app.workspace.fireLayoutReady();
	return { app, plugin, local };
}
const buttons = (el: Element, text: string) => [...el.querySelectorAll('button')].filter((b) => b.textContent === text) as HTMLButtonElement[];
const settingInputs = (el: Element, name: string) => {
	const s = [...el.querySelectorAll('.setting-item')].find((x) => x.firstChild?.textContent === name);
	expect(s, `setting "${name}"`).toBeTruthy();
	return [...s!.querySelectorAll('input')] as HTMLInputElement[];
};
const step = (m: any) => m.step as string;

describe('settings as floating horizontal tabs', () => {
	it('every tab and every button of every tab can be used like a user would', async () => {
		const { plugin } = await device(new FakeDrive('probe'));
		const tab = plugin.settingTabs[0];
		tab.display();
		const root: HTMLElement = tab.containerEl;
		const bar = root.querySelector('.ambraia-set-tabs')!;
		expect(bar.getAttribute('role')).toBe('tablist');
		const tabs = [...bar.querySelectorAll('.ambraia-set-tab')] as HTMLElement[];
		expect(tabs.length).toBe(6);
		const opened: string[] = [];
		const { Modal } = (await import('obsidian')) as any;
		const origOpen = Modal.prototype.open;
		Modal.prototype.open = function (this: any) {
			opened.push(this.constructor.name);
			return origOpen.call(this);
		};
		try {
			for (const t of tabs) {
				t.click();
				await tick();
				const panel = root.querySelector('.ambraia-set-panel')!;
				expect(t.classList.contains('is-active')).toBe(true);
				expect(panel.getAttribute('data-section')).toBe(t.dataset.section);
				expect(panel.querySelectorAll('.setting-item').length, t.textContent!).toBeGreaterThan(0);
				// toggles change the setting and survive the redraw
				for (const tg of [...panel.querySelectorAll('.checkbox-container')].slice(0, 3) as HTMLElement[]) tg.click();
				await tick();
				expect(root.querySelectorAll('.ambraia-set-tabs').length).toBe(1);
			}
			// Sync tab: "Configura" opens the wizard, which has the Google Drive fields
			tabs[2].click();
			const cfg = buttons(root, 'Configura')[0];
			expect(cfg).toBeTruthy();
			cfg.click();
			expect(opened).toContain('SetupModal');
		} finally {
			Modal.prototype.open = origOpen;
		}
	});

	it('Google Drive with your own app: Client ID and secret fields are there and work (also pasting the JSON)', async () => {
		const { Platform, net } = (await import('obsidian')) as any;
		const opened: string[] = [];
		const open = window.open;
		window.open = ((u: string) => void opened.push(u)) as any;
		const bodies: string[] = [];
		net.handler = async (req: any) => {
			bodies.push(String(req.body));
			if (req.url.endsWith('/device/code')) return { status: 200, json: { device_code: 'DEV', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', interval: 2, expires_in: 600 } };
			return { status: 200, json: { access_token: 'AT', refresh_token: 'RT-own', expires_in: 3600 } };
		};
		try {
			const { app, plugin } = await device(new FakeDrive('probe'));
			const m: any = new setupModal.SetupModal(app, plugin);
			m.open();
			const gd = [...m.contentEl.querySelectorAll('.ambraia-provider')].find((c: any) => c.textContent.startsWith('Google Drive')) as HTMLElement;
			gd.click();
			await tick();
			expect(step(m)).toBe('connect');
			expect(m.contentEl.querySelectorAll('ol.ambraia-steps li').length).toBe(4);
			const [cid] = settingInputs(m.contentEl, 'Client ID');
			const [secret] = settingInputs(m.contentEl, 'Client secret');
			expect(secret.type).toBe('password');
			// the fields come before the sign-in button
			const login = m.contentEl.querySelector('.ambraia-login-btn') as HTMLButtonElement;
			expect(cid.compareDocumentPosition(login) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			login.click();
			await tick();
			expect(m.contentEl.querySelector('.ambraia-setup-status')!.textContent).toContain('Client ID');
			(cid as any).__change('123-abc');
			(secret as any).__change('GOCSPX-x');
			login.click();
			await tick();
			expect(m.contentEl.querySelector('.ambraia-setup-status')!.textContent).toContain('.apps.googleusercontent.com');
			// pasting the JSON downloaded from Google fills both
			(cid as any).__change(JSON.stringify({ installed: { client_id: '42-xyz.apps.googleusercontent.com', client_secret: 'GOCSPX-json' } }));
			await tick();
			expect(m.clientId).toBe('42-xyz.apps.googleusercontent.com');
			expect(m.clientSecret).toBe('GOCSPX-json');
			expect(settingInputs(m.contentEl, 'Client ID')[0].value).toBe('42-xyz.apps.googleusercontent.com');
			(m.contentEl.querySelector('.ambraia-login-btn') as HTMLButtonElement).click();
			await until(() => !!m.contentEl.querySelector('.ambraia-device-code'));
			expect(m.contentEl.querySelector('.ambraia-device-code')!.textContent).toBe('ABCD-EFGH');
			expect(bodies[0]).toContain('client_id=42-xyz.apps.googleusercontent.com');
			await until(() => step(m) === 'folder');
			expect(m.creds).toMatchObject({ provider: 'gdrive', clientId: '42-xyz.apps.googleusercontent.com', clientSecret: 'GOCSPX-json', refreshToken: 'RT-own' });
			m.close();
		} finally {
			window.open = open;
			net.handler = null;
			Object.assign(Platform, { isDesktopApp: true, isMobile: false });
		}
	}, 20000);

	it('multi-device: "Collega un altro dispositivo" shows an 8-character code that links the other device', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		A.local.put('Nota.md', 'ciao');
		await A.plugin.sync.add({ provider: 'gdrive', folder: 'Vault', enabled: true }, { provider: 'gdrive', clientId: 'c.apps.googleusercontent.com', clientSecret: 's', refreshToken: 'rA' });
		A.plugin.sync.settingsChanged();
		await A.plugin.sync.idle();
		// from the settings, like a user
		const tab = A.plugin.settingTabs[0];
		tab.display();
		(tab.containerEl.querySelector('.ambraia-set-tab[data-section="sync"]') as HTMLElement).click();
		const { Modal } = (await import('obsidian')) as any;
		let pm: any = null;
		const origOpen = Modal.prototype.open;
		Modal.prototype.open = function (this: any) {
			if (this instanceof setupModal.PairModal) pm = this;
			return origOpen.call(this);
		};
		try {
			buttons(tab.containerEl, 'Collega un dispositivo')[0].click();
		} finally {
			Modal.prototype.open = origOpen;
		}
		expect(pm).toBeTruthy();
		await until(() => !!pm.offer);
		const shown = pm.contentEl.querySelector('.ambraia-pair-code')!.textContent as string;
		expect(shown).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		const code = shown.replace('-', '');
		expect(code.length).toBe(8);
		expect(pm.contentEl.querySelector('.ambraia-pair-timer')!.textContent).toMatch(/\d+:\d\d/);
		// the client ID to reuse on the other device (own app)
		expect(pm.contentEl.textContent).toContain('c.apps.googleusercontent.com');

		// new device: "I already have Ambraia" → Google Drive → sign in → code
		const B = await device(drive);
		const m: any = new setupModal.SetupModal(B.app, B.plugin);
		m.open();
		(m.contentEl.querySelector('.ambraia-choice') as HTMLElement).click();
		expect(step(m)).toBe('link');
		([...m.contentEl.querySelectorAll('.ambraia-provider')].find((c: any) => c.textContent.startsWith('Google Drive')) as HTMLElement).click();
		expect(step(m)).toBe('connect');
		expect(settingInputs(m.contentEl, 'Client ID').length).toBe(1); // same app as the other device
		await m.afterSignIn({ provider: 'gdrive', clientId: 'c.apps.googleusercontent.com', clientSecret: 's', refreshToken: 'rB' });
		expect(step(m)).toBe('code');
		const input = m.contentEl.querySelector('.ambraia-pair-input') as HTMLInputElement;
		// typing formats as XXXX-XXXX and is case-insensitive
		input.value = code.toLowerCase();
		input.dispatchEvent(new Event('input'));
		expect(input.value).toBe(shown);
		buttons(m.contentEl, 'Collega')[0].click();
		// nothing arrives until the first device approves: both show the same 6 digits
		await until(() => !!m.contentEl.querySelector('.ambraia-pair-check'), 10000);
		await until(() => buttons(pm.contentEl, 'Approva').length > 0, 10000);
		expect(pm.contentEl.querySelector('.ambraia-pair-check')!.textContent).toBe(m.contentEl.querySelector('.ambraia-pair-check')!.textContent);
		expect(pm.contentEl.querySelector('.ambraia-pair-check')!.textContent).toMatch(/^\d{3} ?\d{3}$/);
		buttons(pm.contentEl, 'Approva')[0].click();
		await until(() => step(m) === 'done', 15000);
		const bm = B.plugin.sync.managers[0];
		expect(bm.folder).toBe('Vault');
		expect(bm.credentials.refreshToken).toBe('rB');
		await B.plugin.sync.syncNow();
		await B.plugin.sync.idle();
		expect(new TextDecoder().decode(await B.local.read('Nota.md'))).toBe('ciao');
		m.close();
		// the first device shows the confirmation
		await until(() => /Dispositivo collegato/.test(pm.contentEl.textContent), 10000);
		pm.close();
	}, 40000);
});
