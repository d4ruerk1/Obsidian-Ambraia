// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeApp, FakeDrive, FakeLocal, installDomShim } from './app-fake';
import { WrongKeyError, KEYFILE } from '../src/sync/crypto';

installDomShim();
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
});

const KEY = 'una chiave principale lunga 2024!';

async function device(drive: FakeDrive, app = new FakeApp(), data: unknown = null) {
	const plugin = new AmbraiaPlugin(app, manifest);
	plugin.data = data;
	await plugin.onload();
	plugin.settings.syncKdf = 'pbkdf2';
	const hub = plugin.sync;
	hub.remoteFactory = (_c: unknown, folder: string) => drive.api(folder);
	const local = new FakeLocal();
	Object.assign(local, { setOptions() {}, isConfigPath: () => false, listConfigOnly: async () => [] });
	(hub as any).local = local;
	await app.workspace.fireLayoutReady();
	return {
		app,
		plugin,
		hub,
		local,
		get mgr() {
			return hub.primary!;
		},
	};
}
type Dev = Awaited<ReturnType<typeof device>>;

async function connect(d: Dev, folder = 'Ambraia/Test', provider: 'dropbox' | 'gdrive' = 'dropbox') {
	const m = await d.hub.add({ provider, folder, enabled: true }, { provider, clientId: 'k', refreshToken: 'refresh-secret' });
	d.hub.settingsChanged();
	await m.idle();
	return m;
}
async function cycle(...ds: Dev[]) {
	for (const d of ds) {
		await d.mgr.idle();
		await d.mgr.syncNow(true);
		await d.mgr.idle();
	}
}
const files = (d: Dev) => Object.fromEntries([...d.local.files.keys()].map((p) => [p, d.local.get(p)]));

describe('sync manager: encryption lifecycle across devices', () => {
	it('plain → encrypted → key change → restart → plain, without losing data', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		const B = await device(drive);
		A.local.put('Note/Uno.md', 'primo');
		A.local.put('Due.md', 'secondo');
		await connect(A);
		await connect(B);
		await cycle(A, B);
		expect(files(B)).toEqual(files(A));
		expect(A.mgr.status).toBe('idle');

		// A turns encryption on: plain copy goes to the trash, everything is re-uploaded encrypted
		B.local.put('DaB.md', 'scritto su B');
		await cycle(B);
		await A.mgr.setupEncryption({ password: KEY, alg: 'xchacha20', names: true, kdf: 'pbkdf2' });
		await A.mgr.idle();
		expect(A.mgr.t.encrypt).toBe(true);
		const live = [...drive.files.values()].filter((f) => !f.root && !drive.isTrashed(f.id));
		expect(live.some((f) => f.name === KEYFILE)).toBe(true);
		for (const f of live) {
			expect(f.name).not.toMatch(/Uno|Due|Note|DaB/);
			if (f.data && f.name !== KEYFILE) expect(new TextDecoder().decode(f.data)).not.toMatch(/primo|secondo|scritto/);
		}
		expect(files(A)).toEqual({ 'Note/Uno.md': 'primo', 'Due.md': 'secondo', 'DaB.md': 'scritto su B' });

		// B notices and waits for the key; the wrong key is refused
		await cycle(B);
		expect(B.mgr.status).toBe('locked');
		await expect(B.mgr.unlock('sbagliata sbagliata 123', true)).rejects.toBeInstanceOf(WrongKeyError);
		await B.mgr.unlock(KEY, true);
		await B.mgr.idle();
		await cycle(B, A, B);
		expect(B.mgr.status).toBe('idle');
		expect(files(B)).toEqual(files(A));
		expect(B.local.trash).toEqual([]);

		// edits flow both ways encrypted
		A.local.put('Due.md', 'secondo v2');
		await cycle(A, B);
		expect(B.local.get('Due.md')).toBe('secondo v2');

		// master key change: B keeps working with its remembered data key
		await A.mgr.changeMasterKey(KEY, 'nuova chiave principale 2025!');
		await A.mgr.idle();
		B.local.put('Tre.md', 'dopo il cambio');
		await cycle(B, A);
		expect(B.mgr.status).toBe('idle');
		expect(A.local.get('Tre.md')).toBe('dopo il cambio');

		// restart of B: the data key is remembered in the secret storage
		await B.plugin.onunload();
		const B2 = await device(drive, B.app, B.plugin.data);
		B2.local = B.local;
		(B2.hub as any).local = B.local;
		await B2.mgr.idle();
		await cycle(B2);
		expect(B2.mgr.status).toBe('idle');

		// A turns encryption off: B pauses (key file gone) until told to follow
		await A.mgr.reformat(null);
		await A.mgr.idle();
		expect(drive.find(KEYFILE)).toBeUndefined();
		await cycle(B2);
		expect(B2.mgr.status).toBe('error');
		expect(B2.local.get('Tre.md')).toBe('dopo il cambio');
		await B2.mgr.turnOffEncryptionHere();
		await B2.mgr.idle();
		await cycle(B2, A, B2);
		expect(files(B2)).toEqual(files(A));
		expect(await drive.snapshot()).toEqual(files(A));
		await A.plugin.onunload();
		await B2.plugin.onunload();
	}, 60_000);

	it('forgets the key on restart when "remember" is off', async () => {
		const drive = new FakeDrive('feed');
		const A = await device(drive);
		A.local.put('a.md', 'x');
		await connect(A);
		A.mgr.t.remember = false;
		await A.mgr.setupEncryption({ password: KEY, alg: 'aes-gcm', names: false, kdf: 'pbkdf2' });
		await A.mgr.idle();
		expect([...A.app.secrets.values()].join()).not.toMatch(/"k":/);
		await A.plugin.onunload();
		const A2 = await device(drive, A.app, A.plugin.data);
		(A2.hub as any).local = A.local;
		await cycle(A2);
		expect(A2.mgr.status).toBe('locked');
		await A2.plugin.onunload();
	}, 30_000);
});

describe('sync manager: credentials and settings', () => {
	it('keeps secrets out of data.json and migrates legacy Google credentials', async () => {
		const app = new FakeApp();
		app.secrets.set('ambraia-google-drive', JSON.stringify({ clientId: 'id', clientSecret: 's', refreshToken: 'legacy-refresh' }));
		const d = await device(new FakeDrive(), app);
		expect(d.mgr.credentials?.provider).toBe('gdrive');
		expect(app.secrets.get('ambraia-sync')).toContain('legacy-refresh');
		expect(app.secrets.get('ambraia-google-drive')).toBe('');
		await d.plugin.saveSettings();
		expect(JSON.stringify(d.plugin.data ?? d.plugin.settings)).not.toContain('legacy-refresh');
		await d.plugin.onunload();
	});

	it('moves legacy plaintext secrets of data.json into the secret storage', async () => {
		const app = new FakeApp();
		const plugin = new AmbraiaPlugin(app, manifest);
		plugin.data = { credentialsFallback: JSON.stringify({ clientId: 'i', clientSecret: 's', refreshToken: 'old' }), aiKeysFallback: { openai: 'sk-old' }, syncEnabled: true, vaultKey: 'MyVault' };
		await plugin.loadSettings();
		expect(JSON.stringify(plugin.settings)).not.toMatch(/sk-old|"old"/);
		expect(app.secrets.get('ambraia-ai-openai')).toBe('sk-old');
		expect(app.secrets.get('ambraia-google-drive')).toContain('old');
		// the Drive folder of older versions is kept
		expect(plugin.settings.syncTargets[0].folder).toBe('MyVault');
		expect(plugin.settings.syncTargets[0].enabled).toBe(true);
		expect(JSON.stringify(plugin.settings)).not.toMatch(/"syncEnabled"|"vaultKey"/);
	});

	it('the remote folder is configurable and the state follows it', async () => {
		const drive = new FakeDrive('feed');
		const A = await device(drive);
		A.local.put('a.md', '1');
		await connect(A);
		await cycle(A);
		expect(drive.files.size).toBeGreaterThan(1);
		A.mgr.t.folder = 'Altro/Percorso';
		await A.mgr.resetState();
		A.mgr.settingsChanged();
		await cycle(A);
		const roots = [...drive.files.values()].filter((f) => f.root).map((f) => f.root);
		expect(roots.sort()).toEqual(['Altro/Percorso', 'Ambraia/Test']);
		await A.plugin.onunload();
	});
});

describe('sync manager: several cloud services at once', () => {
	it('keeps two services in sync through the vault, each with its own state and credentials', async () => {
		const gdrive = new FakeDrive('feed');
		const mega = new FakeDrive('probe');
		const A = await device(gdrive);
		A.hub.remoteFactory = (c: any, folder: string) => (c.provider === 'gdrive' ? gdrive : mega).api(folder);
		A.local.put('Note.md', 'uno');
		const g = await connect(A, 'Ambraia/G', 'gdrive');
		const d = await connect(A, 'Ambraia/D', 'dropbox');
		expect(A.hub.managers.length).toBe(2);
		expect(g.id).toBe('main');
		expect(d.id).not.toBe('main');
		await A.hub.syncNow();
		await A.hub.idle();
		expect(await gdrive.snapshot()).toEqual({ 'Note.md': 'uno' });
		expect(await mega.snapshot()).toEqual({ 'Note.md': 'uno' });
		// separate secrets and state files per service
		expect(A.app.secrets.get('ambraia-sync')).toContain('gdrive');
		expect(A.app.secrets.get('ambraia-sync-' + d.id)).toContain('dropbox');

		// a second device only on Dropbox writes a note: A downloads it and forwards it to Google Drive
		const B = await device(mega);
		await connect(B, 'Ambraia/D', 'dropbox');
		await cycle(B);
		B.local.put('DaB.md', 'scritto su B');
		await cycle(B);
		await d.syncNow(true);
		await A.hub.idle();
		await new Promise((r) => setTimeout(r, 20));
		await A.hub.idle();
		expect(A.local.get('DaB.md')).toBe('scritto su B');
		await g.syncNow(true);
		await A.hub.idle();
		expect((await gdrive.snapshot())['DaB.md']).toBe('scritto su B');

		// removing a service forgets only that one
		await A.hub.remove(d);
		expect(A.hub.managers.map((m) => m.id)).toEqual(['main']);
		expect(A.app.secrets.get('ambraia-sync-' + d.id)).toBe('');
		expect(A.plugin.settings.syncTargets.length).toBe(1);
		await A.plugin.onunload();
		await B.plugin.onunload();
	}, 60_000);

	it('shared master key unlocks every service at once; a dedicated key stays separate', async () => {
		const one = new FakeDrive('feed');
		const two = new FakeDrive('feed');
		const three = new FakeDrive('feed');
		const pick = (c: any, folder: string) => (folder === 'F/1' ? one : folder === 'F/2' ? two : three).api(folder);
		const A = await device(one);
		A.hub.remoteFactory = pick;
		A.local.put('a.md', 'x');
		const m1 = await connect(A, 'F/1');
		const m2 = await connect(A, 'F/2');
		const m3 = await connect(A, 'F/3');
		await A.hub.syncNow();
		await A.hub.idle();
		await m1.setupEncryption({ password: KEY, alg: 'aes-gcm', names: true, kdf: 'pbkdf2' });
		await m2.setupEncryption({ password: KEY, alg: 'xchacha20', names: true, kdf: 'pbkdf2' });
		m3.t.sharedKey = false;
		await m3.setupEncryption({ password: 'una chiave dedicata solo per tre!', alg: 'aes-gcm', names: true, kdf: 'pbkdf2' });
		await A.hub.idle();
		expect(await A.hub.verifyShared(KEY, m3)).toBe(true);
		await expect(A.hub.verifyShared('una chiave dedicata solo per tre!', m3)).rejects.toBeInstanceOf(WrongKeyError);

		// new device, nothing remembered: one password unlocks both shared services
		const B = await device(one);
		B.hub.remoteFactory = pick;
		const b1 = await connect(B, 'F/1');
		const b2 = await connect(B, 'F/2');
		const b3 = await connect(B, 'F/3');
		await B.hub.syncNow();
		await B.hub.idle();
		expect([b1.status, b2.status, b3.status]).toEqual(['locked', 'locked', 'locked']);
		const done = await B.hub.unlock(b1, KEY, false);
		expect(done.map((m) => m.id).sort()).toEqual([b1.id, b2.id].sort());
		expect(b3.status).toBe('locked');
		await B.hub.idle();

		// changing the shared key changes it on both services, not on the dedicated one
		await A.hub.changeKey(m1, KEY, 'nuova chiave condivisa 2026!');
		await expect(m2.verifyKey(KEY)).rejects.toBeInstanceOf(WrongKeyError);
		await m2.verifyKey('nuova chiave condivisa 2026!');
		await m3.verifyKey('una chiave dedicata solo per tre!');
		await A.plugin.onunload();
		await B.plugin.onunload();
	}, 60_000);
});
