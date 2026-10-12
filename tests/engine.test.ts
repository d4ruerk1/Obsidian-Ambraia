import { describe, it, expect, beforeEach } from 'vitest';
import { SyncEngine, MassDeleteError } from '../src/sync/engine';
import { emptyState, RemoteAPI, SyncState } from '../src/sync/types';
import { SecureRemote, writeKeyfile } from '../src/sync/secureRemote';
import { Alg, Cipher, createKeyfile, unlockKeyfile } from '../src/sync/crypto';
import { DriveMode, FakeDrive, FakeLocal } from './app-fake';

type Mode = { drive: DriveMode; alg?: Alg };
const MODES: [string, Mode][] = [
	['feed', { drive: 'feed' }],
	['probe', { drive: 'probe' }],
	['snapshot', { drive: 'snapshot' }],
	['feed+xchacha20', { drive: 'feed', alg: 'xchacha20' }],
	['probe+aes-gcm', { drive: 'probe', alg: 'aes-gcm' }],
	['snapshot+aes-ctr-hmac', { drive: 'snapshot', alg: 'aes-ctr-hmac' }],
];

/** one data key per test file run is enough (Argon2 is slow on purpose) */
let keyCache: Promise<{ kf: Awaited<ReturnType<typeof createKeyfile>>['keyfile']; dek: Uint8Array }> | null = null;
const testKey = () => (keyCache ??= createKeyfile('correct horse battery staple 42', 'aes-gcm', true, 'pbkdf2').then(({ keyfile, dek }) => ({ kf: keyfile, dek })));

class Device {
	local = new FakeLocal();
	state: SyncState;
	dirty = new Set<string>();
	lastReport: any;
	private remote: RemoteAPI | null = null;
	constructor(
		public drive: FakeDrive,
		public key = 'Vault',
		public mode: Mode = { drive: 'feed' },
	) {
		this.state = emptyState(key);
	}
	/** the remote stack the manager would use (plain or encrypted) */
	async api(): Promise<RemoteAPI> {
		if (this.remote) return this.remote;
		const inner = this.drive.api(this.key);
		if (!this.mode.alg) return (this.remote = inner);
		const { kf, dek } = await testKey();
		let root = await inner.findRoot();
		if (!root) {
			root = await inner.createRoot();
			await writeKeyfile(inner, root.id, { ...kf, alg: this.mode.alg });
		}
		const cipher = new Cipher(dek, this.mode.alg, true);
		const d = this.drive;
		const encName = cipher.encName.bind(cipher);
		cipher.encName = async (n: string) => {
			const e = await encName(n);
			d.plainNames.set(e, n);
			return e;
		};
		d.codec = cipher;
		return (this.remote = new SecureRemote(inner, cipher));
	}
	write(p: string, t: string) {
		this.local.put(p, t);
		this.dirty.add(p);
	}
	async del(p: string) {
		await this.local.remove(p);
		this.dirty.add(p);
	}
	async mv(a: string, b: string) {
		await this.local.rename(a, b);
		this.state.pendingRenames.push({ from: a, to: b });
	}
	async sync(full = false, allowMassDelete = false) {
		const e = new SyncEngine(this.state, this.local, await this.api(), { maxFileSize: 1e8, allowMassDelete });
		const d = this.dirty;
		this.dirty = new Set();
		const r = await e.run(d, full);
		for (const p of r.retry) this.dirty.add(p);
		this.lastReport = r;
		return r;
	}
	files() {
		const o: Record<string, string> = {};
		for (const [p] of this.local.files) o[p] = this.local.get(p)!;
		return o;
	}
}

describe.each(MODES)('engine [%s]', (_label, mode) => {
/** calls that a cycle without changes is allowed to make */
const idle = (c: string) => (mode.drive === 'feed' ? c === 'listChanges' : mode.drive === 'probe' ? c === 'probe' || c === 'listAll' : c === 'listAll');
let drive: FakeDrive;
let A: Device;
let B: Device;
beforeEach(() => {
	drive = new FakeDrive(mode.drive);
	A = new Device(drive, 'Vault', mode);
	B = new Device(drive, 'Vault', mode);
});

describe('basic sync', () => {
	it('uploads a new vault and downloads it on a second device', async () => {
		A.write('Note.md', 'hello');
		A.write('Folder/Sub/Deep.md', 'deep');
		A.write('Folder/img.png', '\u0001\u0002binary');
		await A.sync();
		expect((await drive.snapshot())).toEqual(A.files());
		await B.sync();
		expect(B.files()).toEqual(A.files());
		expect(B.local.folders.has('Folder/Sub')).toBe(true);
	});

	it('is idempotent: a second cycle makes only the change-feed call', async () => {
		A.write('a.md', '1');
		await A.sync();
		drive.calls = [];
		await A.sync();
		await A.sync(true);
		expect(drive.calls.filter((c) => !idle(c))).toEqual([]);
	});

	it('propagates edits both ways quickly (event-driven)', async () => {
		A.write('a.md', 'v1');
		await A.sync();
		await B.sync();
		B.write('a.md', 'v2 from B');
		await B.sync();
		await A.sync();
		expect(A.local.get('a.md')).toBe('v2 from B');
		A.write('a.md', 'v3 from A');
		await A.sync();
		await B.sync();
		expect(B.local.get('a.md')).toBe('v3 from A');
	});

	it('detects changes made while Obsidian was closed (full scan, no events)', async () => {
		A.write('a.md', 'v1');
		await A.sync();
		A.local.put('a.md', 'edited outside');
		A.local.put('new.md', 'created outside');
		A.dirty.clear();
		await A.sync(true);
		expect(await drive.text('a.md')).toBe('edited outside');
		expect(await drive.text('new.md')).toBe('created outside');
	});

	it('handles unicode names and empty files', async () => {
		A.write('Città/Perché è così.md', '');
		A.write('日本語.md', 'こんにちは');
		await A.sync();
		await B.sync();
		expect(B.files()).toEqual(A.files());
	});
});

describe('vault folder copied to another device (e.g. PC → phone)', () => {
	const copyFiles = (from: Device, to: Device) => {
		for (const [p] of from.local.files) to.local.put(p, from.local.get(p)!); // new mtimes, as after a copy
		for (const f of from.local.folders) to.local.folders.add(f);
	};
	beforeEach(async () => {
		A.write('Note.md', 'hello');
		A.write('Cartella/Lista.md', '- uno\n- due');
		A.write('.obsidian/app.json', '{"vimMode":false}');
		await A.sync(true);
	});

	it('with the copied sync state: nothing is re-uploaded or duplicated, then edits flow both ways', async () => {
		copyFiles(A, B);
		B.state = JSON.parse(JSON.stringify(A.state));
		const r = await B.sync(true);
		expect(r.uploaded).toEqual([]);
		expect(r.downloaded).toEqual([]);
		expect(r.conflicts).toEqual([]);
		expect(B.files()).toEqual(A.files());
		B.write('Note.md', 'dal telefono');
		await B.sync();
		await A.sync(true);
		expect(A.local.get('Note.md')).toBe('dal telefono');
		A.write('Cartella/Lista.md', '- uno\n- due\n- tre');
		await A.sync();
		await B.sync(true);
		expect(B.local.get('Cartella/Lista.md')).toBe('- uno\n- due\n- tre');
		expect([...B.local.files.keys()].some((p) => p.includes('conflitto'))).toBe(false);
	});

	it('without the sync state: identical files are linked by content, no conflict copies', async () => {
		copyFiles(A, B);
		const r = await B.sync(true);
		expect(r.uploaded).toEqual([]);
		expect(r.conflicts).toEqual([]);
		expect(B.files()).toEqual(A.files());
		await A.sync(true);
		expect(A.lastReport.downloaded).toEqual([]);
		expect(Object.keys(A.files()).sort()).toEqual(Object.keys(B.files()).sort());
	});

	it('a file changed on the PC after the copy wins over the stale copy, without conflicts', async () => {
		copyFiles(A, B);
		B.state = JSON.parse(JSON.stringify(A.state));
		A.write('Note.md', 'modificata dopo la copia');
		await A.sync();
		const r = await B.sync(true);
		expect(r.conflicts).toEqual([]);
		expect(B.local.get('Note.md')).toBe('modificata dopo la copia');
	});
});

describe('renames and moves', () => {
	it('local rename keeps the same Drive file and renames on the other device', async () => {
		A.write('old.md', 'x');
		await A.sync();
		await B.sync();
		const id = drive.find('old.md')!.id;
		await A.mv('old.md', 'Moved/new.md');
		await A.sync();
		expect(drive.find('Moved/new.md')!.id).toBe(id);
		await B.sync();
		expect(B.files()).toEqual({ 'Moved/new.md': 'x' });
		expect(B.local.trash).toEqual([]);
	});

	it('folder rename moves all children on the other device', async () => {
		A.write('P/a.md', 'a');
		A.write('P/Q/b.md', 'b');
		await A.sync();
		await B.sync();
		await A.mv('P', 'Projects');
		await A.sync();
		await B.sync();
		expect(B.files()).toEqual({ 'Projects/a.md': 'a', 'Projects/Q/b.md': 'b' });
		expect(B.local.folders.has('P')).toBe(false);
		expect(drive.calls.filter((c) => c === 'upload').length).toBe(mode.alg ? 3 : 2); // + key file
	});

	it('rename + edit in the same cycle', async () => {
		A.write('a.md', '1');
		await A.sync();
		await B.sync();
		await A.mv('a.md', 'b.md');
		A.write('b.md', '2');
		await A.sync();
		await B.sync();
		expect(B.files()).toEqual({ 'b.md': '2' });
	});

	it('remote rename done by another client', async () => {
		A.write('a.md', '1');
		await A.sync();
		await drive.remoteRename('a.md', 'z.md');
		await A.sync();
		expect(A.files()).toEqual({ 'z.md': '1' });
	});
});

describe('deletions', () => {
	it('deletes propagate (to the trash) and empty folders are removed', async () => {
		A.write('F/a.md', 'a');
		A.write('b.md', 'b');
		await A.sync();
		await B.sync();
		await A.del('F');
		A.dirty.add('F/a.md');
		await A.sync();
		expect((await drive.snapshot())).toEqual({ 'b.md': 'b' });
		await B.sync();
		expect(B.files()).toEqual({ 'b.md': 'b' });
		expect(B.local.folders.has('F')).toBe(false);
	});

	it('remote folder trashed but local has a new file inside -> keep and re-upload', async () => {
		A.write('F/a.md', 'a');
		await A.sync();
		await B.sync();
		B.write('F/new.md', 'precious');
		drive.remoteTrash('F');
		await B.sync();
		await B.sync();
		expect(B.local.get('F/new.md')).toBe('precious');
		expect(await drive.text('F/new.md')).toBe('precious');
		expect(B.local.get('F/a.md')).toBeUndefined();
	});

	it('local delete vs remote edit -> edit wins (restored)', async () => {
		A.write('a.md', '1');
		await A.sync();
		await B.sync();
		await B.del('a.md');
		A.write('a.md', 'important edit');
		await A.sync();
		await B.sync();
		expect(B.local.get('a.md')).toBe('important edit');
	});

	it('local edit vs remote delete -> edit is re-uploaded', async () => {
		A.write('a.md', '1');
		await A.sync();
		await B.sync();
		await A.del('a.md');
		await A.sync();
		B.write('a.md', 'kept');
		await B.sync();
		await A.sync();
		expect(A.local.get('a.md')).toBe('kept');
	});

	it('blocks suspicious mass deletions unless confirmed', async () => {
		for (let i = 0; i < 40; i++) A.write(`n${i}.md`, String(i));
		await A.sync();
		await B.sync();
		for (let i = 0; i < 40; i++) await A.del(`n${i}.md`);
		await expect(A.sync()).rejects.toBeInstanceOf(MassDeleteError);
		expect(Object.keys((await drive.snapshot())).length).toBe(40);
		for (let i = 0; i < 40; i++) A.dirty.add(`n${i}.md`);
		await A.sync(false, true);
		expect(Object.keys((await drive.snapshot())).length).toBe(0);
	});
});

describe('conflicts never lose data', () => {
	it('concurrent edits keep both versions', async () => {
		A.write('a.md', 'base');
		await A.sync();
		await B.sync();
		A.write('a.md', 'from A');
		B.write('a.md', 'from B');
		await A.sync();
		await B.sync();
		await A.sync();
		await B.sync();
		const vals = Object.values(B.files()).sort();
		expect(vals).toEqual(['from A', 'from B']);
		expect(A.files()).toEqual(B.files());
		expect((await drive.snapshot())).toEqual(B.files());
	});

	it('same new path created on two offline devices', async () => {
		A.write('Daily/2026-10-02.md', 'A notes');
		B.write('Daily/2026-10-02.md', 'B notes');
		await A.sync();
		await B.sync();
		await A.sync();
		await B.sync();
		expect(Object.values(A.files()).sort()).toEqual(['A notes', 'B notes']);
		expect(A.files()).toEqual(B.files());
	});

	it('identical content on both sides links without conflict copies', async () => {
		A.write('x.md', 'same');
		B.write('x.md', 'same');
		await A.sync();
		await B.sync();
		expect(B.lastReport.conflicts).toEqual([]);
		expect(B.files()).toEqual({ 'x.md': 'same' });
	});

	it('duplicate folders created concurrently on Drive are merged', async () => {
		A.write('Proj/a.md', 'a');
		B.write('Proj/b.md', 'b');
		// both reach Drive "simultaneously": B has not seen A's folder yet
		await A.sync();
		(B.state as any).rootId = null;
		await B.sync();
		await A.sync();
		await B.sync();
		expect(A.files()).toEqual({ 'Proj/a.md': 'a', 'Proj/b.md': 'b' });
		expect(B.files()).toEqual(A.files());
		const projFolders = [...drive.files.values()].filter((f) => drive.pathOf(f.id) === 'Proj' && !drive.isTrashed(f.id));
		expect(projFolders.length).toBe(1);
	});
});

describe('resilience', () => {
	it('recovers after transient server errors', async () => {
		A.write('a.md', '1');
		A.write('b.md', '2');
		await A.sync();
		A.write('a.md', '1b');
		A.write('b.md', '2b');
		drive.failNext = 2; // listChanges ok? first call fails -> whole cycle throws
		await expect(A.sync()).rejects.toBeTruthy();
		A.dirty.add('a.md');
		A.dirty.add('b.md');
		drive.failNext = 0;
		await A.sync();
		expect((await drive.snapshot())).toEqual({ 'a.md': '1b', 'b.md': '2b' });
	});

	it('a failing upload is retried in the next cycle', async () => {
		A.write('a.md', '1');
		await A.sync();
		A.write('a.md', '2');
		const api = await A.api();
		const origUpdate = api.update.bind(api);
		let failed = false;
		api.update = async (...args: Parameters<RemoteAPI['update']>) => {
			if (!failed) {
				failed = true;
				throw new Error('timeout');
			}
			return origUpdate(...args);
		};
		const e = new SyncEngine(A.state, A.local, api, { maxFileSize: 1e8 });
		const r = await e.run(new Set(['a.md']));
		expect(r.retry).toContain('a.md');
		const r2 = await e.run(new Set(r.retry));
		expect(r2.uploaded).toContain('a.md');
		expect(await drive.text('a.md')).toBe('2');
	});

	it('stops if the Drive root folder is deleted (no local wipe)', async () => {
		A.write('a.md', '1');
		await A.sync();
		const root = [...drive.files.values()].find((f) => f.root)!;
		root.trashed = true;
		(drive as any).touch(root.id);
		await expect(A.sync()).rejects.toThrow(/root-/);
		expect(A.local.get('a.md')).toBe('1');
	});

	it('ignores files of other vaults sharing the same Drive', async () => {
		const C = new Device(drive, 'Other', mode);
		C.write('secret.md', 'other vault');
		await C.sync();
		A.write('a.md', 'mine');
		await A.sync();
		await A.sync(true);
		expect(A.files()).toEqual({ 'a.md': 'mine' });
	});
});

describe('randomised multi-device convergence', () => {
	const rnd = (seed: number) => () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	for (let seed = 1; seed <= Number(process.env.SEEDS ?? (mode.alg ? 15 : 40)); seed++) {
		it(`seed ${seed}`, async () => {
			const r = rnd(seed);
			const devs = [A, B, new Device(drive, 'Vault', mode)];
			const names = ['a.md', 'b.md', 'F/c.md', 'F/G/d.md', 'H/e.md'];
			const written = new Set<string>();
			for (let step = 0; step < Number(process.env.STEPS ?? 40); step++) {
				const d = devs[Math.floor(r() * devs.length)];
				const op = r();
				const existing = [...d.local.files.keys()];
				if (op < 0.45) {
					const n = names[Math.floor(r() * names.length)];
					const content = `s${seed}-${step}`;
					d.write(n, content);
					written.add(content);
				} else if (op < 0.55 && existing.length) {
					const n = existing[Math.floor(r() * existing.length)];
					await d.del(n);
				} else if (op < 0.58 && d.local.folders.size) {
					const fs = [...d.local.folders].filter((f) => !f.includes('/'));
					if (fs.length) {
						const f = fs[Math.floor(r() * fs.length)];
						const to = f + 'x';
						if (!d.local.folders.has(to) && !d.local.files.has(to)) await d.mv(f, to);
					}
				} else if (op < 0.6) {
					// edit without event (e.g. external editor) - only full scan catches it
					const n = names[Math.floor(r() * names.length)];
					d.local.put(n, `ext${seed}-${step}`);
				} else if (op < 0.66 && existing.length) {
					const n = existing[Math.floor(r() * existing.length)];
					const to = 'R/' + n.split('/').pop()!.replace('.md', `-${step}.md`);
					if (!d.local.files.has(to)) await d.mv(n, to);
				} else {
					await d.sync(r() < 0.2);
				}
			}
			// settle
			for (let round = 0; round < 4; round++) for (const d of devs) await d.sync(round === 0);
			const ref = (await drive.snapshot());
			for (const d of devs) expect(d.files()).toEqual(ref);
			// an extra full cycle must be a no-op
			drive.calls = [];
			for (const d of devs) await d.sync(true);
			expect(drive.calls.filter((c) => !idle(c))).toEqual([]);
		});
	}
});

describe('mass delete restore', () => {
	it('restores files when the user refuses the mass deletion', async () => {
		for (let i = 0; i < 40; i++) A.write(`n${i}.md`, String(i));
		await A.sync();
		for (let i = 0; i < 40; i++) await A.del(`n${i}.md`);
		await expect(A.sync()).rejects.toBeInstanceOf(MassDeleteError);
		for (let i = 0; i < 40; i++) A.dirty.add(`n${i}.md`);
		const e = new SyncEngine(A.state, A.local, await A.api(), { maxFileSize: 1e8, allowMassDelete: true, massDeleteMode: 'restore' });
		await e.run(A.dirty, true);
		expect(Object.keys(A.files()).length).toBe(40);
		await B.sync();
		expect(Object.keys(B.files()).length).toBe(40);
	});
});
});
