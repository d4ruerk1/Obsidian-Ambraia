// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Notice } from 'obsidian';
import { FakeApp, FakeDrive, FakeLocal, installDomShim } from './app-fake';
import { merge2, merge3, isMergeable } from '../src/sync/merge';

installDomShim();
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
});
beforeEach(() => {
	(Notice as any).all.length = 0;
});
const notices = (re: RegExp) => (Notice as any).all.filter((n: string) => re.test(n));

describe('three-way merge of notes', () => {
	const base = 'Titolo\n\nUno\nDue\nTre\n';
	it('edits to different lines are both kept', () => {
		const r = merge3(base, 'Titolo\n\nUno (A)\nDue\nTre\n', 'Titolo\n\nUno\nDue\nTre (B)\n', true)!;
		expect(r).toEqual({ text: 'Titolo\n\nUno (A)\nDue\nTre (B)\n', clean: true });
	});
	it('the same line changed on both sides: the newer side wins and the merge is marked unclean', () => {
		expect(merge3(base, 'Titolo\n\nUno A\nDue\nTre\n', 'Titolo\n\nUno B\nDue\nTre\n', true)).toEqual({ text: 'Titolo\n\nUno A\nDue\nTre\n', clean: false });
		expect(merge3(base, 'Titolo\n\nUno A\nDue\nTre\n', 'Titolo\n\nUno B\nDue\nTre\n', false)).toEqual({ text: 'Titolo\n\nUno B\nDue\nTre\n', clean: false });
	});
	it('both appended at the end: both additions kept, older first', () => {
		const r = merge3(base, base + '- da A\n', base + '- da B\n', true)!;
		expect(r.clean).toBe(true);
		expect(r.text).toBe(base + '- da B\n- da A\n');
	});
	it('deletion on one side, edit elsewhere on the other', () => {
		const r = merge3(base, 'Titolo\n\nDue\nTre\n', 'Titolo\n\nUno\nDue\nTre!\n', true)!;
		expect(r).toEqual({ text: 'Titolo\n\nDue\nTre!\n', clean: true });
	});
	it('identical edits, one side unchanged, empty base', () => {
		expect(merge3(base, 'x', 'x', true)).toEqual({ text: 'x', clean: true });
		expect(merge3(base, base, 'y', true)).toEqual({ text: 'y', clean: true });
		expect(merge3('', 'a\n', 'b\n', true)!.text).toBe('b\na\n');
	});
	it('notes created on two devices from the same template: shared lines kept once', () => {
		const t = '# 2026-10-03\n\n## Note\n';
		expect(merge2(t + '- comprare il latte\n', t + '- chiamare Marco\n')).toBe(t + '- comprare il latte\n- chiamare Marco\n');
	});
	it('only text formats are merged line by line', () => {
		expect(isMergeable('a/b.md')).toBe(true);
		expect(isMergeable('a.canvas')).toBe(false);
		expect(isMergeable('img.png')).toBe(false);
	});
	it('random edits: merge never invents lines and keeps non-overlapping edits', () => {
		let seed = 9;
		const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
		let unclean = 0;
		for (let n = 0; n < 300; n++) {
			const lines = Array.from({ length: 5 + Math.floor(rand() * 30) }, (_, i) => `riga ${i}`);
			const edit = (tag: string, from: number, to: number) => lines.map((l, i) => (i >= from && i < to && rand() < 0.5 ? `${l} ${tag}` : l)).filter((_, i) => i < from || i >= to || rand() > 0.1);
			const half = Math.floor(lines.length / 2);
			const a = edit('A', 0, half);
			const b = edit('B', half, lines.length);
			const r = merge3(lines.join('\n'), a.join('\n'), b.join('\n'), rand() < 0.5)!;
			const pool = new Set([...lines, ...a, ...b]);
			for (const l of r.text.split('\n')) expect(pool.has(l)).toBe(true);
			// adjacent edits (no untouched line between them) are a clash, as in git: newer side wins there
			if (r.clean) {
				for (const l of [...a, ...b]) if (/ [AB]$/.test(l)) expect(r.text.split('\n')).toContain(l);
			} else unclean++;
		}
		expect(unclean).toBeLessThan(150);
	});
});

// ------------------------------------------------------------------ end to end

async function device(drive: FakeDrive, app = new FakeApp()) {
	const plugin = new AmbraiaPlugin(app, manifest);
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
async function connect(d: Dev) {
	const m = await d.hub.add({ provider: 'gdrive', folder: 'Ambraia/T', enabled: true }, { provider: 'gdrive', clientId: 'k', refreshToken: 'r' });
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
const files = (d: Dev) => Object.fromEntries([...d.local.files.keys()].sort().map((p) => [p, d.local.get(p)]));
const cloudFiles = (drive: FakeDrive) => [...drive.files.values()].filter((f) => !f.isFolder && !f.root && !drive.isTrashed(f.id) && drive.inVault(f) && f.name !== '.ambraia-crypt.json');

async function pair(mode: 'feed' | 'probe' = 'feed') {
	const drive = new FakeDrive(mode);
	const A = await device(drive);
	const B = await device(drive);
	A.local.put('Nota.md', 'Titolo\n\nUno\nDue\nTre\n');
	await connect(A);
	await connect(B);
	await cycle(A, B);
	return { drive, A, B };
}

describe('two devices edit the same note: always one version in the cloud', () => {
	it('different parts: both edits combined, no copies anywhere', async () => {
		const { drive, A, B } = await pair();
		A.local.put('Nota.md', 'Titolo\n\nUno (da A)\nDue\nTre\n');
		await cycle(A);
		B.local.put('Nota.md', 'Titolo\n\nUno\nDue\nTre (da B)\n');
		await cycle(B, A);
		const want = 'Titolo\n\nUno (da A)\nDue\nTre (da B)\n';
		expect(files(A)).toEqual({ 'Nota.md': want });
		expect(files(B)).toEqual({ 'Nota.md': want });
		expect(cloudFiles(drive).length).toBe(1);
		expect(await drive.text('Nota.md')).toBe(want);
		expect(notices(/Ambraia/).length).toBe(0); // decided automatically, no pop-ups
		expect(B.local.trash.length).toBe(0);
	});

	it('same lines: newer version wins, no extra copy anywhere', async () => {
		const { drive, A, B } = await pair();
		B.local.put('Nota.md', 'Titolo\n\nUno B\nDue\nTre\n');
		A.local.put('Nota.md', 'Titolo\n\nUno A\nDue\nTre\n');
		await cycle(A); // A reaches the cloud first
		await cycle(B, A);
		expect(cloudFiles(drive).length).toBe(1);
		expect(files(A)).toEqual(files(B));
		expect(Object.keys(files(A))).toEqual(['Nota.md']);
		expect(files(A)['Nota.md']).toBe('Titolo\n\nUno A\nDue\nTre\n'); // A edited last
		expect(B.local.trash.length).toBe(0);
		expect(notices(/Ambraia/).length).toBe(0);
	});

	it('the same new note created on both devices: one file with both contents', async () => {
		const { drive, A, B } = await pair();
		A.local.put('Oggi.md', '# Oggi\n- da A\n');
		B.local.put('Oggi.md', '# Oggi\n- da B\n');
		await cycle(A, B, A);
		expect(cloudFiles(drive).length).toBe(2);
		expect(files(A)).toEqual(files(B));
		const t = files(A)['Oggi.md']!;
		expect(t).toMatch(/da A/);
		expect(t).toMatch(/da B/);
		expect(t.match(/# Oggi/g)!.length).toBe(1);
	});

	it('duplicates already in the cloud (two uploads at the same instant) are folded into one', async () => {
		const { drive, A, B } = await pair('probe');
		const n = drive.find('Nota.md')!;
		drive.new({ name: 'Nota.md', parentId: n.parentId, data: new TextEncoder().encode('Titolo\n\nUno\nDue\nTre\nQuattro\n').buffer as ArrayBuffer });
		await cycle(A, B, A);
		expect(cloudFiles(drive).length).toBe(1);
		expect(files(A)).toEqual(files(B));
		expect(files(A)['Nota.md']).toBe('Titolo\n\nUno\nDue\nTre\nQuattro\n');
	});

	it('binary files: newer wins, nothing else kept', async () => {
		const { drive, A, B } = await pair();
		A.local.put('img.png', 'v0');
		await cycle(A, B);
		A.local.put('img.png', 'vA');
		await cycle(A);
		B.local.put('img.png', 'vB');
		await cycle(B, A);
		expect(cloudFiles(drive).length).toBe(2);
		expect(files(A)).toEqual(files(B));
		expect(files(A)['img.png']).toBe('vB');
		expect(Object.keys(files(B)).length).toBe(2);
	});

	it('with end-to-end encryption too', async () => {
		const { drive, A, B } = await pair();
		await A.mgr.setupEncryption({ password: 'chiave principale molto lunga 1', alg: 'aes-gcm', names: true, kdf: 'pbkdf2' });
		await cycle(B);
		await B.mgr.unlock('chiave principale molto lunga 1', true);
		await cycle(A, B);
		A.local.put('Nota.md', 'Titolo\n\nUno (A)\nDue\nTre\n');
		await cycle(A);
		B.local.put('Nota.md', 'Titolo\n\nUno\nDue\nTre (B)\n');
		await cycle(B, A);
		expect(files(A)).toEqual({ 'Nota.md': 'Titolo\n\nUno (A)\nDue\nTre (B)\n' });
		expect(files(B)).toEqual(files(A));
		expect(cloudFiles(drive).length).toBe(1);
	});

	it('an old "keep both" setting is ignored: still one version', async () => {
		const { drive, A, B } = await pair();
		B.plugin.settings.conflictMode = 'copy';
		A.local.put('Nota.md', 'A');
		await cycle(A);
		B.local.put('Nota.md', 'B');
		await cycle(B, A);
		expect(cloudFiles(drive).length).toBe(1);
		expect(files(A)).toEqual({ 'Nota.md': 'B' });
		expect(files(B)).toEqual(files(A));
	});

	it('stored ancestors are cleaned up when no longer needed', async () => {
		const { A } = await pair();
		for (let i = 0; i < 5; i++) {
			A.local.put('Nota.md', `versione ${i}`);
			await cycle(A);
		}
		const dir = '.obsidian/plugins/ambraia/state/sync-base';
		const before = (await A.app.vault.adapter.list(dir)).files.length;
		expect(before).toBeGreaterThan(1);
		await A.hub.gcBases(true);
		expect((await A.app.vault.adapter.list(dir)).files.length).toBe(1);
	});
});

describe('old conflict copies are cleaned up automatically', () => {
	const C = (n: string, i = '') => `${n} (conflitto 2026-01-02 10.30${i})`;
	it('existing copies: the newest prevails under the original name, the rest goes away everywhere', async () => {
		const drive = new FakeDrive('feed');
		const A = await device(drive);
		const B = await device(drive);
		A.local.put('Nota.md', 'vecchia');
		A.local.put(C('Nota') + '.md', 'più recente');
		A.local.put(C('Nota', ' 2') + '.md', 'intermedia');
		A.local.files.get(C('Nota', ' 2') + '.md')!.mtime = A.local.files.get('Nota.md')!.mtime + 500;
		A.local.put(C('Diario') + '.md', 'solo copia'); // original gone
		A.local.put('Cartella/' + C('img') + '.png', 'png nuovo');
		A.local.put('Cartella/img.png', 'png più nuovo');
		for (let i = 0; i < 30; i++) A.local.put(C(`n${i}`) + '.md', `x${i}`); // many copies: no mass-delete prompt
		await connect(A);
		await connect(B);
		await cycle(A, B, A, B);
		const want = { 'Cartella/img.png': 'png più nuovo', 'Diario.md': 'solo copia', 'Nota.md': 'più recente', ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`n${i}.md`, `x${i}`])) };
		expect(files(A)).toEqual(Object.fromEntries(Object.entries(want).sort()));
		expect(files(B)).toEqual(files(A));
		expect(cloudFiles(drive).length).toBe(Object.keys(want).length);
		expect(cloudFiles(drive).some((f) => /conflitto/.test(f.name))).toBe(false);
		expect(A.mgr.status).not.toBe('error');
		expect(notices(/eliminare|delete/i).length).toBe(0);
	});

	it('a copy arriving later from an old device is folded in too', async () => {
		const { drive, A, B } = await pair();
		const n = drive.find('Nota.md')!;
		drive.new({ name: C('Nota') + '.md', parentId: n.parentId, data: new TextEncoder().encode('dal vecchio dispositivo').buffer as ArrayBuffer });
		await cycle(B, A, B);
		expect(files(A)).toEqual({ 'Nota.md': 'dal vecchio dispositivo' });
		expect(files(B)).toEqual(files(A));
		expect(cloudFiles(drive).length).toBe(1);
	});

	it('a file/folder clash keeps both (they cannot be merged)', async () => {
		const drive = new FakeDrive('feed');
		const A = await device(drive);
		A.local.put('Progetto/a.md', 'a');
		A.local.put(C('Progetto'), 'file');
		await connect(A);
		await cycle(A, A);
		expect(Object.keys(files(A)).sort()).toEqual(['Progetto/a.md', C('Progetto')].sort());
	});

	it('the 1.7.0 backup folder .trash/Ambraia is removed', async () => {
		const drive = new FakeDrive('feed');
		const A = await device(drive);
		const a = A.app.vault.adapter;
		await a.mkdir('.trash/Ambraia');
		await a.write('.trash/Ambraia/Nota (2026-01-01 10.00.00).md', 'x');
		A.local.put('Nota.md', 'n');
		await connect(A);
		await cycle(A);
		expect(await a.exists('.trash/Ambraia')).toBe(false);
	});
});
