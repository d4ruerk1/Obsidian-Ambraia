// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { Modal } from 'obsidian';
import { FakeApp, FakeDrive, FakeLocal, installDomShim } from './app-fake';
import { KEYFILE } from '../src/sync/crypto';

installDomShim();
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
let setupModal: typeof import('../src/sync/setupModal');
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
	setupModal = await import('../src/sync/setupModal');
	(globalThis as any).__ambraiaDeviceId = (await import('../src/sync/devices')).deviceId;
});
const KEY = 'Una chiave principale molto lunga 2024!';
const tick = async (n = 30) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
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

const buttons = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].filter((b) => b.textContent === text) as HTMLButtonElement[];
async function click(el: HTMLElement, text: string) {
	const b = buttons(el, text)[0];
	expect(b, `button "${text}"`).toBeTruthy();
	b.click();
	await tick();
	for (let i = 0; i < 200 && b.disabled; i++) await new Promise((r) => setTimeout(r, 10));
	await tick();
}
const type = (input: Element, v: string) => (input as any).__change(v);
const settingInput = (el: HTMLElement, name: string, sel = 'input') => {
	const s = [...el.querySelectorAll('.setting-item')].find((x) => x.firstChild?.textContent === name);
	expect(s, `setting "${name}"`).toBeTruthy();
	return s!.querySelector(sel)!;
};
const step = (m: any) => m.step as string;

describe('sync setup wizard', () => {
	it('every service shows its step-by-step (?) guide', async () => {
		const { app, plugin } = await device(new FakeDrive('probe'));
		const m: any = new setupModal.SetupModal(app, plugin);
		m.open();
		const cards = [...m.contentEl.querySelectorAll('.ambraia-provider')] as HTMLElement[];
		expect(cards.map((c) => c.querySelector('.ambraia-provider-name')!.textContent)).toEqual(['Google Drive', 'Dropbox', 'Microsoft OneDrive', 'pCloud', 'MEGA', 'Proton Drive']);
		for (let i = 0; i < cards.length; i++) {
			const card = [...m.contentEl.querySelectorAll('.ambraia-provider')][i] as HTMLElement;
			if (card.classList.contains('is-disabled')) continue;
			card.click();
			await tick();
			expect(step(m)).toBe('connect');
			const help = m.contentEl.querySelector('.ambraia-help-btn') as HTMLElement | null;
			if (!help) {
				// Google Drive: the steps are on screen, no hidden guide
				expect(m.contentEl.querySelectorAll('.ambraia-steps li').length).toBeGreaterThanOrEqual(3);
				await click(m.contentEl, 'Indietro');
				continue;
			}
			help.click();
			const box = m.contentEl.querySelector('.ambraia-help')!;
			expect(box.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
			help.click();
			expect(m.contentEl.querySelector('.ambraia-help')).toBeNull();
			await click(m.contentEl, 'Indietro');
			expect(step(m)).toBe('choose');
		}
		m.close();
	});

	it('first device: folder + encryption; second device unlocks with the master key', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		A.local.put('Diario/Oggi.md', 'nota segreta');
		const m: any = new setupModal.SetupModal(A.app, A.plugin);
		m.open();
		m.provider = 'dropbox';
		m.creds = { provider: 'dropbox', clientId: 'key', refreshToken: 'refresh' };
		m.go('folder');
		type(settingInput(m.contentEl, 'Cartella nel cloud'), ' Archivio//Note UI/ ');
		await click(m.contentEl, 'Continua');
		expect(step(m)).toBe('encrypt');
		expect(A.plugin.sync.primary.t.folder).toBe('Archivio/Note UI');

		// guide, weak key and mismatched confirmation are refused
		(m.contentEl.querySelector('.ambraia-help-btn') as HTMLElement).click();
		expect(m.contentEl.querySelector('.ambraia-help')!.textContent).toContain('XChaCha20');
		type(settingInput(m.contentEl, 'Algoritmo', 'select'), 'xchacha20');
		type(settingInput(m.contentEl, 'Chiave principale'), 'corta');
		type(settingInput(m.contentEl, 'Ripeti la chiave'), 'corta');
		await click(m.contentEl, 'Avvia la sincronizzazione');
		expect(m.contentEl.querySelector('.ambraia-setup-status')!.textContent).toContain('troppo debole');
		type(settingInput(m.contentEl, 'Chiave principale'), KEY);
		type(settingInput(m.contentEl, 'Ripeti la chiave'), KEY + 'x');
		await click(m.contentEl, 'Avvia la sincronizzazione');
		expect(m.contentEl.querySelector('.ambraia-setup-status')!.textContent).toContain('non coincidono');
		expect(m.contentEl.querySelector('.ambraia-meter')!.getAttribute('data-level')).toBe('4');
		type(settingInput(m.contentEl, 'Ripeti la chiave'), KEY);
		// the master key cannot be recovered: the user must confirm it is saved somewhere
		await click(m.contentEl, 'Avvia la sincronizzazione');
		expect(step(m)).toBe('encrypt');
		const ack = m.contentEl.querySelector('.ambraia-key-ack input') as HTMLInputElement;
		ack.checked = true;
		ack.dispatchEvent(new Event('change'));
		await click(m.contentEl, 'Avvia la sincronizzazione');
		expect(step(m)).toBe('done');
		await A.plugin.sync.idle();
		await A.plugin.sync.syncNow(true);
		await A.plugin.sync.idle();
		expect(A.plugin.sync.primary.t).toMatchObject({ enabled: true, encrypt: true, alg: 'xchacha20', provider: 'dropbox' });
		const live = [...drive.files.values()].filter((f: any) => !f.root && !drive.isTrashed(f.id)) as any[];
		expect(live.some((f) => f.name === KEYFILE)).toBe(true);
		for (const f of live) {
			expect(f.name).not.toMatch(/Diario|Oggi/);
			if (f.data && f.name !== KEYFILE) expect(new TextDecoder().decode(f.data)).not.toContain('segreta');
		}
		m.close();

		// second device: same folder → the wizard detects the encryption and asks for the key
		const B = await device(drive);
		const n: any = new setupModal.SetupModal(B.app, B.plugin);
		n.open();
		n.provider = 'dropbox';
		n.creds = { provider: 'dropbox', clientId: 'key', refreshToken: 'refresh' };
		n.go('folder');
		// the folder already in the cloud is offered; written with other capitals it is still the same one
		for (let i = 0; i < 50 && !n.contentEl.querySelector('.ambraia-folder-chip'); i++) await new Promise((r) => setTimeout(r, 10));
		expect([...n.contentEl.querySelectorAll('.ambraia-folder-chip')].map((c: any) => c.dataset.folder)).toContain('Archivio/Note UI');
		type(settingInput(n.contentEl, 'Cartella nel cloud'), 'archivio/note ui');
		await click(n.contentEl, 'Continua');
		expect(B.plugin.sync.primary.t.folder).toBe('Archivio/Note UI');
		expect(step(n)).toBe('encrypt');
		expect(n.contentEl.textContent).toContain('XChaCha20-Poly1305');
		type(settingInput(n.contentEl, 'Chiave principale'), 'chiave sbagliata 123456');
		await click(n.contentEl, 'Sblocca e sincronizza');
		expect(n.contentEl.querySelector('.ambraia-setup-status')!.textContent).toContain('non corretta');
		type(settingInput(n.contentEl, 'Chiave principale'), KEY);
		await click(n.contentEl, 'Sblocca e sincronizza');
		expect(step(n)).toBe('done');
		await B.plugin.sync.idle();
		await B.plugin.sync.syncNow(true);
		await B.plugin.sync.idle();
		expect(B.local.get('Diario/Oggi.md')).toBe('nota segreta');
		expect(B.plugin.sync.primary.t.encrypt).toBe(true);
	});

	it('settings tab: sync and encryption sections render in every state, (?) guides open', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		const tab = A.plugin.settingTabs[0];
		const { showSettingsPage } = (await import('obsidian')) as any;
		const render = (t = 'sync') => {
			const pageEl: HTMLElement = showSettingsPage(tab, t);
			for (const b of pageEl.querySelectorAll('.ambraia-help-btn')) (b as HTMLElement).click();
			return pageEl;
		};
		let el = render('general');
		expect(settingInput(el, 'Lingua', 'select').querySelectorAll('option').length).toBe(10);
		await A.plugin.sync.add({ provider: 'pcloud', enabled: true }, { provider: 'pcloud', clientId: 'id', clientSecret: 's', refreshToken: 't', apiHost: 'eapi.pcloud.com' });
		A.plugin.sync.settingsChanged();
		await A.plugin.sync.idle();
		el = render();
		expect(el.textContent).toContain('pCloud');
		expect(el.querySelectorAll('.ambraia-help').length).toBeGreaterThan(0);
		await A.plugin.sync.primary.setupEncryption({ password: KEY, alg: 'aes-gcm', names: true, kdf: 'pbkdf2' });
		await A.plugin.sync.idle();
		el = render();
		expect(buttons(el, 'Cambia chiave principale').length + buttons(el, 'Cambia').length).toBeGreaterThan(0);
		expect(el.textContent).toContain('AES-256-GCM');
		expect(buttons(el, 'Aggiungi').length).toBe(1);

		// a second service: both are listed, each with its own switch; the key can be shared or dedicated
		const second = await A.plugin.sync.add({ provider: 'dropbox', folder: 'Altro', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r' });
		A.plugin.sync.settingsChanged();
		await A.plugin.sync.idle();
		await second.setupEncryption({ password: KEY, alg: 'aes-gcm', names: true, kdf: 'pbkdf2' });
		await A.plugin.sync.idle();
		el = render();
		expect(el.querySelectorAll('.ambraia-target').length).toBe(2);
		expect(el.textContent).toContain('Dropbox');
		expect(el.textContent).toContain('Uguale per tutti i servizi');
		expect(buttons(el, 'Rimuovi').length).toBe(2);
	});
});

describe('simple sign-in and new devices', () => {
	const obs = () => import('obsidian') as any;
	const apps = () => import('../src/sync/apps');

	it('built-in app: one "Sign in" button, device code on phones, then the folder step', async () => {
		const { Platform, net } = await obs();
		const { BUILTIN_APPS } = await apps();
		BUILTIN_APPS.gdrive = { clientId: 'pub.apps.googleusercontent.com', clientSecret: 'installed-app' };
		Object.assign(Platform, { isDesktopApp: false, isMobile: true });
		const opened: string[] = [];
		const open = window.open;
		window.open = ((u: string) => void opened.push(u)) as any;
		const bodies: string[] = [];
		net.handler = async (req: any) => {
			bodies.push(String(req.body));
			if (req.url.endsWith('/device/code')) return { status: 200, json: { device_code: 'DEV', user_code: 'QWER-TYUI', verification_url: 'https://www.google.com/device', interval: 2, expires_in: 600 } };
			return { status: 200, json: { access_token: 'AT', refresh_token: 'RT-1', expires_in: 3600 } };
		};
		try {
			const { app, plugin } = await device(new FakeDrive('probe'));
			const m: any = new setupModal.SetupModal(app, plugin);
			m.open();
			(m.contentEl.querySelector('.ambraia-provider') as HTMLElement).click();
			await tick();
			expect(step(m)).toBe('connect');
			expect(m.contentEl.querySelectorAll('input').length).toBe(0); // no client id / secret to type
			expect(m.contentEl.textContent).toContain('drive.file');
			const login = m.contentEl.querySelector('.ambraia-login-btn') as HTMLButtonElement;
			expect(login.textContent).toBe('Accedi con Google Drive');
			login.click();
			await tick();
			for (let i = 0; i < 100 && !m.contentEl.querySelector('.ambraia-device-code'); i++) await new Promise((r) => setTimeout(r, 10));
			expect(m.contentEl.querySelector('.ambraia-device-code')!.textContent).toBe('QWER-TYUI');
			expect(opened).toEqual([]); // the code is shown first, then one tap copies it and opens the page
			await click(m.contentEl, 'Copia il codice e apri la pagina');
			expect(opened).toEqual(['https://www.google.com/device']);
			expect(m.contentEl.querySelector('.ambraia-login-btn')!.classList.contains('ambraia-hidden')).toBe(true);
			for (let i = 0; i < 400 && step(m) === 'connect'; i++) await new Promise((r) => setTimeout(r, 10));
			expect(step(m)).toBe('folder');
			expect(m.creds).toMatchObject({ provider: 'gdrive', clientId: 'pub.apps.googleusercontent.com', refreshToken: 'RT-1' });
			expect(bodies[0]).toContain('scope=https');
			m.close();
		} finally {
			delete BUILTIN_APPS.gdrive;
			Object.assign(Platform, { isDesktopApp: true, isMobile: false });
			window.open = open;
			net.handler = null;
		}
	}, 15000);

	it('own app (no built-in): fields + guide, code pasted from Dropbox is exchanged', async () => {
		const { net } = await obs();
		const open = window.open;
		window.open = (() => null) as any;
		net.handler = async (req: any) => {
			expect(req.url).toBe('https://api.dropboxapi.com/oauth2/token');
			expect(String(req.body)).toContain('code=PASTED');
			expect(String(req.body)).toContain('code_verifier=');
			return { status: 200, json: { access_token: 'a', refresh_token: 'dbx-r', expires_in: 14400 } };
		};
		try {
			const { app, plugin } = await device(new FakeDrive('probe'));
			const m: any = new setupModal.SetupModal(app, plugin);
			m.open();
			([...m.contentEl.querySelectorAll('.ambraia-provider')][1] as HTMLElement).click();
			await tick();
			expect(m.contentEl.querySelector('.ambraia-help-btn')).toBeTruthy();
			const login = m.contentEl.querySelector('.ambraia-login-btn') as HTMLButtonElement;
			login.click();
			await tick();
			expect(m.contentEl.querySelector('.ambraia-setup-status')!.textContent).toContain('Compila');
			type(settingInput(m.contentEl, 'App key'), ' my-key ');
			login.click();
			await tick();
			const ta = m.contentEl.querySelector('.ambraia-auth-box textarea') as HTMLTextAreaElement;
			ta.value = 'PASTED';
			await click(m.contentEl, 'Conferma');
			for (let i = 0; i < 100 && step(m) === 'connect'; i++) await new Promise((r) => setTimeout(r, 10));
			expect(step(m)).toBe('folder');
			expect(m.creds).toMatchObject({ provider: 'dropbox', clientId: 'my-key', refreshToken: 'dbx-r' });
			m.close();
		} finally {
			window.open = open;
			net.handler = null;
		}
	});

	it('one-time code: the new device signs in by itself and gets folder and data key', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		A.local.put('Nota.md', 'segreta');
		const am = await A.plugin.sync.add({ provider: 'dropbox', folder: 'Vault', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r' });
		await am.setupEncryption({ password: KEY, alg: 'aes-gcm', names: true, kdf: 'pbkdf2' });
		await A.plugin.sync.idle();
		const pm: any = new setupModal.PairModal(A.app, am);
		pm.open();
		for (let i = 0; i < 300 && !pm.offer; i++) await new Promise((r) => setTimeout(r, 10));
		const code: string = pm.offer.code;
		expect(pm.contentEl.querySelector('.ambraia-pair-code')!.textContent).toBe(`${code.slice(0, 4)}-${code.slice(4)}`);

		const B = await device(drive);
		const m: any = new setupModal.SetupModal(B.app, B.plugin);
		m.open();
		(m.contentEl.querySelector('.ambraia-choice') as HTMLElement).click();
		expect(step(m)).toBe('link');
		([...m.contentEl.querySelectorAll('.ambraia-provider')] as HTMLElement[])[1].click(); // Dropbox
		expect(step(m)).toBe('connect');
		await m.afterSignIn({ provider: 'dropbox', clientId: 'k', refreshToken: 'own-token-of-B' });
		expect(step(m)).toBe('code');
		const input = m.contentEl.querySelector('.ambraia-pair-input') as HTMLInputElement;
		input.value = 'ZZZZ-ZZZZ';
		await click(m.contentEl, 'Collega');
		expect(m.contentEl.querySelector('.ambraia-setup-status')!.textContent).toContain('non valido');
		input.value = code.toLowerCase();
		buttons(m.contentEl, 'Collega')[0].click();
		// A must approve: until then nothing secret travels
		const ack = await (async () => {
			for (let i = 0; i < 400; i++) {
				const a = await pm.offer.checkAck();
				if (a) return a;
				await new Promise((r) => setTimeout(r, 20));
			}
			return null;
		})();
		expect(ack?.name).toBeTruthy();
		for (let i = 0; i < 400 && !m.contentEl.querySelector('.ambraia-pair-check'); i++) await new Promise((r) => setTimeout(r, 20));
		expect(m.contentEl.querySelector('.ambraia-pair-check')!.textContent).toBe(pm.offer.check);
		expect(B.plugin.sync.managers.length).toBe(0);
		await pm.offer.approve();
		for (let i = 0; i < 500 && step(m) !== 'done'; i++) await new Promise((r) => setTimeout(r, 20));
		expect(step(m)).toBe('done');
		const bm = B.plugin.sync.managers[0];
		expect(bm.folder).toBe('Vault');
		expect(bm.t.encrypt).toBe(true);
		expect(bm.unlocked).toBe(true); // no master key typed on B
		expect(bm.credentials.refreshToken).toBe('own-token-of-B'); // A's access never travelled
		await B.plugin.sync.syncNow();
		await B.plugin.sync.idle();
		expect(new TextDecoder().decode(await B.local.read('Nota.md'))).toBe('segreta');
		m.close();
		// the code is now spent
		pm.close();
		const C = await device(drive);
		const m2: any = new setupModal.SetupModal(C.app, C.plugin, undefined, 'pair');
		m2.open();
		([...m2.contentEl.querySelectorAll('.ambraia-provider')] as HTMLElement[])[1].click();
		await m2.afterSignIn({ provider: 'dropbox', clientId: 'k', refreshToken: 'c' });
		(m2.contentEl.querySelector('.ambraia-pair-input') as HTMLInputElement).value = code;
		await click(m2.contentEl, 'Collega');
		expect(step(m2)).toBe('code');
		m2.close();
	});

	it('closing the code window invalidates the code', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		const am = await A.plugin.sync.add({ provider: 'dropbox', folder: 'Vault', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r' });
		const pm: any = new setupModal.PairModal(A.app, am);
		pm.open();
		for (let i = 0; i < 300 && !pm.offer; i++) await new Promise((r) => setTimeout(r, 10));
		const code: string = pm.offer.code;
		pm.close();
		await tick();
		const { redeemCode, PAIR_FOLDER } = await import('../src/sync/devices');
		expect(await redeemCode(drive.api(PAIR_FOLDER) as any, code, { id: 'b', name: 'B' })).toBeNull();
	});

	it('device list: a device can be disconnected or erased remotely', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		const B = await device(drive);
		B.local.put('Locale.md', 'x');
		const am = await A.plugin.sync.add({ provider: 'dropbox', folder: 'Vault', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r' });
		const bm = await B.plugin.sync.add({ provider: 'dropbox', folder: 'Vault', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r2' });
		await am.beat(true);
		// B is in A's circle (as after pairing): it shares the circle key
		for (const [k, v] of (A.app as any).secrets as Map<string, string>) if (k === 'ambraia-circle') (B.app as any).secrets.set(k, v);
		await bm.beat(true);
		const reg = (await am.registry())!;
		const list = await reg.list(deviceIdOf(A));
		expect(list.length).toBe(2);
		const { deviceId } = await import('../src/sync/devices');
		const bid = deviceId(B.app as any);
		expect(list.some((e: any) => e.info.id === bid)).toBe(true);
		await reg.send(bid, 'disconnect', { id: deviceId(A.app as any), name: 'A' });
		expect((await reg.list(deviceIdOf(A))).find((e: any) => e.info.id === bid)?.pending).toBe('disconnect');
		await bm.beat(true);
		expect(B.plugin.sync.managers.length).toBe(0);
		expect(B.plugin.settings.syncTargets.length).toBe(0);
		expect((await reg.list(deviceIdOf(A))).some((e: any) => e.info.id === bid)).toBe(false);
	});

	it('settings synced from another device keep this device’s sync switches', async () => {
		const { app, plugin } = await device(new FakeDrive('probe'));
		const mine = await plugin.sync.add({ provider: 'dropbox', folder: 'Mine', enabled: true });
		plugin.loadData = async () => ({ ...plugin.settings, syncTargets: [{ ...mine.t, folder: 'Other', enabled: false }], language: 'en', pinned: ['Home.md'] });
		const ref = plugin.settings;
		await plugin.onExternalSettingsChange();
		expect(plugin.settings).toBe(ref);
		expect(plugin.settings).toMatchObject({ language: 'en', pinned: ['Home.md'] });
		expect(plugin.settings.syncTargets[0]).toBe(mine.t);
		expect(mine.t).toMatchObject({ folder: 'Mine', enabled: true });
		void app;
	});
});

describe('several cloud services', () => {
	it('adding a second service: the wizard offers the shared master key and checks it', async () => {
		const one = new FakeDrive('probe');
		const two = new FakeDrive('probe');
		const A = await device(one);
		A.plugin.sync.remoteFactory = (c: any, folder: string) => (c.provider === 'pcloud' ? one : two).api(folder);
		A.local.put('Nota.md', 'testo');
		const first = await A.plugin.sync.add({ provider: 'pcloud', folder: 'Uno', enabled: true }, { provider: 'pcloud', clientId: 'id', clientSecret: 's', accessToken: 't' });
		A.plugin.sync.settingsChanged();
		await first.setupEncryption({ password: KEY, alg: 'aes-gcm', names: true, kdf: 'pbkdf2' });
		await A.plugin.sync.idle();

		const m: any = new setupModal.SetupModal(A.app, A.plugin);
		m.open();
		expect(m.titleEl.textContent).toBe('Aggiungi un servizio cloud');
		expect(m.contentEl.textContent).toContain('Già attivi: pCloud');
		m.provider = 'dropbox';
		m.creds = { provider: 'dropbox', clientId: 'key', refreshToken: 'refresh' };
		m.go('folder');
		type(settingInput(m.contentEl, 'Cartella nel cloud'), 'Due');
		await click(m.contentEl, 'Continua');
		expect(step(m)).toBe('encrypt');
		expect(A.plugin.sync.managers.length).toBe(2);
		expect(m.contentEl.textContent).toContain('Stessa chiave principale degli altri servizi');
		type(settingInput(m.contentEl, 'Chiave principale condivisa'), 'una chiave diversa e lunga 99!');
		await click(m.contentEl, 'Avvia la sincronizzazione');
		expect(m.contentEl.querySelector('.ambraia-setup-status')!.textContent).toContain('non coincide');
		type(settingInput(m.contentEl, 'Chiave principale condivisa'), KEY);
		await click(m.contentEl, 'Avvia la sincronizzazione');
		expect(step(m)).toBe('done');
		const second = A.plugin.sync.managers[1];
		expect(second.t).toMatchObject({ provider: 'dropbox', folder: 'Due', encrypt: true, sharedKey: true, enabled: true });
		expect(m.contentEl.textContent).toContain('Servizi attivi insieme');
		m.close();
		await A.plugin.sync.syncNow();
		await A.plugin.sync.idle();
		const stored = [...two.files.values()].filter((f: any) => f.data && !f.root && !two.isTrashed(f.id)) as any[];
		expect(stored.some((f) => f.name === KEYFILE)).toBe(true);
		expect(stored.length).toBeGreaterThan(1);
		for (const f of stored) {
			expect(f.name).not.toContain('Nota');
			expect(new TextDecoder().decode(f.data)).not.toContain('testo');
		}
	});
});

const deviceIdOf = (d: { app: unknown }) => (globalThis as any).__ambraiaDeviceId(d.app);

describe('devices without roles', () => {
	/** Real pairing through the cloud: A shows a code, B redeems it, A approves. */
	async function pair(drive: FakeDrive, inviter: any, newcomer: { app: any; plugin: any }) {
		const { redeemCode, PAIR_FOLDER, deviceId } = await import('../src/sync/devices');
		const { deviceSignKeys } = await import('../src/sync/manager');
		const offer = await inviter.startPairing();
		const claim: any = await redeemCode(drive.api(PAIR_FOLDER) as any, offer.code, { id: deviceId(newcomer.app), name: 'new', spub: (await deviceSignKeys(newcomer.app)).pub });
		expect(claim && claim !== 'outdated').toBeTruthy();
		expect(await offer.checkAck()).toBeTruthy();
		expect(offer.check).toBe(claim.check);
		await offer.approve();
		const p = await claim.wait(undefined, 5);
		expect(p && p !== 'denied').toBeTruthy();
		const m = await newcomer.plugin.sync.add({ provider: 'dropbox', folder: p.folder, enabled: false }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r-' + Math.random() });
		expect(await m.adoptPairing(p)).toBe(true);
		await newcomer.plugin.sync.idle();
		return m;
	}

	it('every device can link devices and remove any other one, the first one too', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		const B = await device(drive);
		const C = await device(drive);
		const am = await A.plugin.sync.add({ provider: 'dropbox', folder: 'Vault', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r' });
		await am.beat(true);
		const bm = await pair(drive, am, B);
		await bm.beat(true);
		// B (not the first device) links C: no owner or administrator is needed
		const cm = await pair(drive, bm, C);
		await cm.beat(true);
		await am.beat(true);
		const regA = (await am.registry())!;
		const listA = await regA.list(deviceIdOf(A));
		expect(listA.length).toBe(3);
		expect(listA.every((e: any) => e.trusted)).toBe(true);
		// C removes A, the first device
		const regC = (await cm.registry())!;
		await regC.send(deviceIdOf(A), 'disconnect', { id: deviceIdOf(C), name: 'C' });
		expect((await regC.list(deviceIdOf(C))).find((e: any) => e.info.id === deviceIdOf(A))?.pending).toBe('disconnect');
		await am.beat(true);
		expect(A.plugin.sync.managers.length).toBe(0);
		// B learns that A is gone: a command A could still sign is ignored everywhere
		const regB = (await bm.registry())!;
		const listB = await regB.list(deviceIdOf(B));
		expect(listB.some((e: any) => e.info.id === deviceIdOf(A))).toBe(false);
		const { signData } = await import('../src/sync/crypto');
		const { deviceSignKeys } = await import('../src/sync/manager');
		const ak = await deviceSignKeys(A.app as any);
		const body = { target: deviceIdOf(B), action: 'wipe', from: { id: deviceIdOf(A), name: 'A' }, at: Date.now() };
		// forge a wipe for B written with the (still known) circle key, signed by the removed A
		const { sealWithKey, keyedTag } = await import('../src/sync/crypto');
		const key = (regB as any).key as Uint8Array;
		const name = `x${await keyedTag(key, `command:${deviceIdOf(B)}`)}.bin`;
		const root = await (regB as any).remote.findRoot();
		const forged = { t: 'command', d: { ...body, sig: await signData(ak, body) } };
		await (regB as any).remote.upload(name, root.id, new TextEncoder().encode(JSON.stringify(await sealWithKey(key, forged, name))).buffer);
		expect(await regB.commandFor(deviceIdOf(B))).toBeNull();
		await bm.beat(true);
		expect(B.plugin.sync.managers.length).toBe(1);
	});

	it('shared links travel signed in the device list; records written by other keys are ignored', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		const B = await device(drive);
		const am = await A.plugin.sync.add({ provider: 'dropbox', folder: 'Vault', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r' });
		await am.beat(true);
		const bm = await pair(drive, am, B);
		await bm.beat(true);
		await am.beat(true);
		await A.plugin.shares.store.load();
		await B.plugin.shares.store.load();
		const r = await A.plugin.shares.store.create('n.md', 'n', { expires: null, profiles: [{ label: 'L', canEdit: false, maxUses: null, expires: null, password: '' }] });
		await am.beat(true);
		await bm.beat(true);
		expect(B.plugin.shares.store.get(r.id)?.secret).toBe(r.secret);
		// a new service set up on B sees which folder the other devices of the chain use on that provider
		const chain = await bm.chainFolders.call({ hub: B.plugin.sync, app: B.app } as any, 'dropbox');
		expect([...chain.entries()].some(([f, who]) => f === 'Vault' && who.length === 1)).toBe(true);
		// B revokes it: A learns it
		B.plugin.shares.store.revoke(r.id);
		await bm.beat(true);
		await am.beat(true);
		expect(A.plugin.shares.store.get(r.id)?.revoked).toBe(true);
		// a record written with the circle key but signed by an unknown device is ignored
		const { signData, sealWithKey, keyedTag, newSignKeys } = await import('../src/sync/crypto');
		const regB = (await bm.registry())!;
		const key = (regB as any).key as Uint8Array;
		const fake = { ...r, id: 'f'.repeat(16), path: 'secret.md', revoked: false, updated: Date.now() };
		const name = `x${await keyedTag(key, `share:${fake.id}`)}.bin`;
		const root = await (regB as any).remote.findRoot();
		const keys = await newSignKeys();
		const rec = { t: 'share', d: fake, by: 'intruder', sig: await signData(keys, { id: fake.id, d: fake }) };
		await (regB as any).remote.upload(name, root.id, new TextEncoder().encode(JSON.stringify(await sealWithKey(key, rec, name))).buffer);
		expect((await regB.readShares()).some((x: any) => x.id === fake.id)).toBe(false);
		await bm.beat(true);
		expect(B.plugin.shares.store.get(fake.id)).toBeNull();
	});

	it('a removal can be withdrawn before it runs, and a device of an unknown chain is not trusted', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		const B = await device(drive);
		const X = await device(drive);
		const am = await A.plugin.sync.add({ provider: 'dropbox', folder: 'Vault', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r' });
		await am.beat(true);
		const bm = await pair(drive, am, B);
		await bm.beat(true);
		const regA = (await am.registry())!;
		await regA.send(deviceIdOf(B), 'wipe', { id: deviceIdOf(A), name: 'A' });
		await regA.cancel(deviceIdOf(B), { id: deviceIdOf(A), name: 'A' });
		await bm.beat(true);
		expect(B.plugin.sync.managers.length).toBe(1);
		expect((await regA.list(deviceIdOf(A))).find((e: any) => e.info.id === deviceIdOf(B))?.pending).toBeNull();
		// X steals the circle key (not a pairing): it shows up as not verified and cannot send commands
		const xm = await X.plugin.sync.add({ provider: 'dropbox', folder: 'Vault', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'rx' });
		(X.app as any).secrets.set('ambraia-circle', (A.app as any).secrets.get('ambraia-circle'));
		(X.app as any).secrets.set('ambraia-circle-trust', JSON.stringify({ v: 1, members: {}, revoked: {}, restored: {} }));
		await xm.beat(true);
		const entry = (await regA.list(deviceIdOf(A))).find((e: any) => e.info.id === deviceIdOf(X));
		expect(entry?.trusted).toBe(false);
		const regX = (await xm.registry())!;
		await regX.send(deviceIdOf(A), 'wipe', { id: deviceIdOf(X), name: 'X' });
		await am.beat(true);
		expect(A.plugin.sync.managers.length).toBe(1);
	});

	it('a device removed earlier can be linked again with a new code', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		const B = await device(drive);
		const am = await A.plugin.sync.add({ provider: 'dropbox', folder: 'Vault', enabled: true }, { provider: 'dropbox', clientId: 'k', refreshToken: 'r' });
		await am.beat(true);
		let bm = await pair(drive, am, B);
		await bm.beat(true);
		const regA = (await am.registry())!;
		await regA.send(deviceIdOf(B), 'disconnect', { id: deviceIdOf(A), name: 'A' });
		await bm.beat(true);
		expect(B.plugin.sync.managers.length).toBe(0);
		bm = await pair(drive, am, B);
		await bm.beat(true);
		expect(B.plugin.sync.managers.length).toBe(1);
		const e = (await regA.list(deviceIdOf(A))).find((x: any) => x.info.id === deviceIdOf(B));
		expect(e?.trusted).toBe(true);
		expect(e?.pending).toBeNull();
	});
});
