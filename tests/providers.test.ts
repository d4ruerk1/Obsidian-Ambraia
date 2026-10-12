import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SyncEngine, RootMissingError } from '../src/sync/engine';
import { emptyState, RemoteAPI, SyncState } from '../src/sync/types';
import { Dropbox } from '../src/sync/providers/dropbox';
import { OneDrive } from '../src/sync/providers/onedrive';
import { PCloud } from '../src/sync/providers/pcloud';
import { GoogleDrive } from '../src/sync/providers/gdrive';
import { LocalFolder } from '../src/sync/providers/localFolder';
import { SecureRemote, writeKeyfile } from '../src/sync/secureRemote';
import { Cipher, createKeyfile } from '../src/sync/crypto';
import { Cloud, dropboxHttp, gdriveHttp, onedriveHttp, pcloudHttp } from './cloud-fakes';
import { FakeLocal } from './app-fake';
import { HttpFn } from '../src/sync/http';

(globalThis as any).window ??= globalThis;
(globalThis as any).window.require = createRequire(import.meta.url);

const FOLDER = 'Ambraia/My Vault';
const token = async () => 'TOKEN';
const tmpDirs: string[] = [];
afterAll(() => {
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

interface Backend {
	name: string;
	make(): { client: () => RemoteAPI; files: () => Record<string, string> | Promise<Record<string, string>>; cloud?: Cloud };
}

const httpBackend = (name: string, mk: (c: Cloud) => HttpFn, client: (h: HttpFn) => RemoteAPI, ci = false): Backend => ({
	name,
	make() {
		const cloud = new Cloud(ci);
		const http = mk(cloud);
		return { client: () => client(http), files: () => cloud.files(FOLDER), cloud };
	},
});

const BACKENDS: Backend[] = [
	httpBackend('Google Drive', gdriveHttp, (h) => new GoogleDrive(h, token, FOLDER, 0)),
	httpBackend('Dropbox', dropboxHttp, (h) => new Dropbox(h, token, FOLDER), true),
	httpBackend('OneDrive', onedriveHttp, (h) => new OneDrive(h, token, FOLDER), true),
	httpBackend('pCloud', pcloudHttp, (h) => new PCloud(h, token, 'api.pcloud.test', FOLDER)),
	{
		name: 'MEGA/Proton folder',
		make() {
			const base = fs.mkdtempSync(path.join(os.tmpdir(), 'obx-'));
			tmpDirs.push(base);
			const files = () => {
				const out: Record<string, string> = {};
				const root = path.join(base, ...FOLDER.split('/'));
				const walk = (d: string, rel: string) => {
					if (!fs.existsSync(d)) return;
					for (const e of fs.readdirSync(d, { withFileTypes: true })) {
						if (e.name.startsWith('.')) continue;
						const r = rel ? `${rel}/${e.name}` : e.name;
						if (e.isDirectory()) walk(path.join(d, e.name), r);
						else out[r] = fs.readFileSync(path.join(d, e.name), 'utf8');
					}
				};
				walk(root, '');
				return out;
			};
			return { client: () => new LocalFolder(base, FOLDER, ['.ambraia-crypt.json']), files };
		},
	},
];

class Device {
	local = new FakeLocal();
	state: SyncState = emptyState('k');
	dirty = new Set<string>();
	constructor(public remote: RemoteAPI) {}
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
	async sync(full = false) {
		const r = await new SyncEngine(this.state, this.local, this.remote, { maxFileSize: 1e8 }).run(this.dirty, full);
		this.dirty = new Set(r.retry);
		expect(r.errors).toEqual([]);
		return r;
	}
	files() {
		return Object.fromEntries([...this.local.files.keys()].map((p) => [p, this.local.get(p)!]));
	}
}

for (const b of BACKENDS) {
	for (const encrypted of [false, true]) {
		describe(`${b.name}${encrypted ? ' + encryption' : ''}`, () => {
			let env: ReturnType<Backend['make']>;
			let A: Device;
			let B: Device;
			const wrap = async (r: RemoteAPI) => {
				if (!encrypted) return r;
				const { keyfile, dek } = await createKeyfile('master key for the tests!', 'aes-gcm', true, 'pbkdf2');
				const root = (await r.findRoot()) ?? (await r.createRoot());
				await writeKeyfile(r, root.id, keyfile);
				(wrap as any).dek = dek;
				return new SecureRemote(r, new Cipher(dek, 'aes-gcm', true));
			};
			const second = async () => (encrypted ? new SecureRemote(env.client(), new Cipher((wrap as any).dek, 'aes-gcm', true)) : env.client());
			beforeEach(async () => {
				env = b.make();
				A = new Device(await wrap(env.client()));
				B = new Device(await second());
			});

			it('creates the chosen folder, uploads, downloads and propagates edits', async () => {
				A.write('Note.md', 'ciao');
				A.write('Cartella/Sotto/Profonda.md', 'profonda');
				A.write('Città/日本語 è.md', 'unicode');
				A.write('vuoto.md', '');
				await A.sync();
				await B.sync();
				expect(B.files()).toEqual(A.files());
				const remote = await env.files();
				if (encrypted) {
					expect(Object.keys(remote).join()).not.toMatch(/Note|Cartella|Città/);
					expect(Object.values(remote).join()).not.toMatch(/ciao|profonda/);
				} else expect(remote).toEqual(A.files());
				B.write('Note.md', 'ciao da B');
				await B.sync();
				await A.sync();
				expect(A.local.get('Note.md')).toBe('ciao da B');
				// nothing changed -> nothing uploaded or downloaded
				const r = await A.sync(true);
				expect(r.uploaded.length + r.downloaded.length).toBe(0);
			});

			it('renames, moves and deletes', async () => {
				A.write('P/a.md', 'a');
				A.write('P/Q/b.md', 'b');
				A.write('c.md', 'c');
				await A.sync();
				await B.sync();
				await A.mv('P', 'Progetti');
				await A.mv('c.md', 'Progetti/c2.md');
				await A.sync();
				await B.sync();
				expect(B.files()).toEqual({ 'Progetti/a.md': 'a', 'Progetti/Q/b.md': 'b', 'Progetti/c2.md': 'c' });
				await B.del('Progetti/Q');
				B.dirty.add('Progetti/Q/b.md');
				await B.sync();
				await A.sync();
				expect(A.files()).toEqual({ 'Progetti/a.md': 'a', 'Progetti/c2.md': 'c' });
				expect(B.local.trash).toEqual(['Progetti/Q']);
			});

			it('concurrent edits keep both versions', async () => {
				A.write('x.md', 'base');
				await A.sync();
				await B.sync();
				A.write('x.md', 'versione A');
				B.write('x.md', 'versione B');
				await A.sync();
				await B.sync();
				await A.sync();
				expect(Object.values(A.files()).sort()).toEqual(['versione A', 'versione B']);
				expect(B.files()).toEqual(A.files());
			});

			it('a large file round-trips', async () => {
				const big = 'x'.repeat(5 * 1024 * 1024 + 123) + 'fine';
				A.write('big.md', big);
				await A.sync();
				await B.sync();
				expect(B.local.get('big.md')).toBe(big);
			});

			it('stops instead of deleting local files when the cloud folder disappears', async () => {
				A.write('a.md', '1');
				await A.sync();
				if (env.cloud) env.cloud.trash(env.cloud.byPath(FOLDER)!);
				else fs.renameSync(path.join((env.client() as any).rootAbs), (env.client() as any).rootAbs + '-moved');
				await expect(new SyncEngine(A.state, A.local, A.remote, { maxFileSize: 1e8 }).run(new Set(), true)).rejects.toBeInstanceOf(RootMissingError);
				expect(A.local.get('a.md')).toBe('1');
			});

			for (const seed0 of (process.env.SEEDS ?? '7,42,1234').split(',').map(Number))
			it(`random edits on three devices converge (seed ${seed0})`, async () => {
				const C = new Device(await second());
				let seed = seed0;
				const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
				const devs = [A, B, C];
				const names = ['a.md', 'F/b.md', 'F/G/c.md', 'H/d.md'];
				for (let step = 0; step < 40; step++) {
					const d = devs[Math.floor(rnd() * 3)];
					const op = rnd();
					const existing = [...d.local.files.keys()];
					if (op < 0.45) d.write(names[Math.floor(rnd() * names.length)], `s${step}`);
					else if (op < 0.55 && existing.length) await d.del(existing[Math.floor(rnd() * existing.length)]);
					else if (op < 0.62 && existing.length) {
						const n = existing[Math.floor(rnd() * existing.length)];
						const to = `R/${step}-${n.split('/').pop()}`;
						await d.mv(n, to);
					} else await d.sync(rnd() < 0.3);
				}
				for (let round = 0; round < 3; round++) for (const d of devs) await d.sync(round === 0);
				expect(B.files()).toEqual(A.files());
				expect(C.files()).toEqual(A.files());
				if (!encrypted) expect(await env.files()).toEqual(A.files());
			}, 30_000);
		});
	}
}

describe('vault folders', () => {
	it('Google Drive folds twin vault folders (and twin parents) into the oldest and lists the vault folders', async () => {
		const cloud = new Cloud(false);
		const http = gdriveHttp(cloud);
		const te = new TextEncoder();
		const a = new GoogleDrive(http, token, FOLDER, 0);
		const root = await a.createRoot();
		await a.upload('a.md', root.id, te.encode('a').buffer as ArrayBuffer);
		// another device created "Ambraia/My Vault" at the same moment: a second parent and a second vault folder
		const parent2 = cloud.add('ROOT', 'Ambraia', true);
		const twin = cloud.add(parent2.id, 'My Vault', true, undefined, { ambraiaRoot: FOLDER });
		cloud.add(twin.id, 'b.md', false, te.encode('b'), { ambraiaVault: FOLDER });
		const b = new GoogleDrive(http, token, FOLDER, 0);
		expect((await b.findRoot())!.id).toBe(root.id);
		const names = (await b.listAll()).map((f) => f.name).sort();
		expect(names).toEqual(expect.arrayContaining(['a.md', 'b.md']));
		expect(cloud.alive(twin)).toBe(false);
		expect(cloud.alive(parent2)).toBe(false);
		expect(await b.vaultFolders!()).toEqual([FOLDER]);
		// a new device asking for the same folder never creates a third one
		const c = new GoogleDrive(http, token, FOLDER, 0);
		expect((await c.createRoot()).id).toBe(root.id);
	});

	it('the twin in the oldest parent wins: the vault folder moves there and the empty parent goes', async () => {
		const cloud = new Cloud(false);
		const http = gdriveHttp(cloud);
		const p1 = cloud.add('ROOT', 'Ambraia', true);
		cloud.add(p1.id, 'Altro', true);
		const p2 = cloud.add('ROOT', 'Ambraia', true);
		const v = cloud.add(p2.id, 'My Vault', true, undefined, { ambraiaRoot: FOLDER });
		const d = new GoogleDrive(http, token, FOLDER, 0);
		expect((await d.findRoot())!.id).toBe(v.id);
		expect(v.parent).toBe(p1.id);
		expect(cloud.alive(p2)).toBe(false);
	});
});

describe('provider safety details', () => {
	it('OneDrive never sends the bearer token to pre-authenticated upload/download URLs', async () => {
		const cloud = new Cloud(true);
		const http = onedriveHttp(cloud);
		const A = new Device(new OneDrive(http, token, FOLDER));
		A.write('big.bin', 'y'.repeat(12 * 1024 * 1024));
		await A.sync();
		const B = new Device(new OneDrive(http, token, FOLDER));
		await B.sync();
		const pre = cloud.requests.filter((r) => /dl\.fake|up\.fake/.test(r.url));
		expect(pre.length).toBeGreaterThan(2);
		for (const r of pre) expect(r.headers?.Authorization).toBeUndefined();
	});

	it('Dropbox refuses to overwrite a version it has not seen (optimistic locking)', async () => {
		const cloud = new Cloud(true);
		const dbx = new Dropbox(dropboxHttp(cloud), token, FOLDER);
		const root = await dbx.createRoot();
		const f = await dbx.upload('a.md', root.id, new TextEncoder().encode('1').buffer as ArrayBuffer);
		await dbx.update(f.id, new TextEncoder().encode('2').buffer as ArrayBuffer, f);
		await expect(dbx.update(f.id, new TextEncoder().encode('3').buffer as ArrayBuffer, f)).rejects.toMatchObject({ status: 409 });
	});

	it('the local folder backend cannot escape its folder', async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), 'obx-'));
		tmpDirs.push(base);
		const lf = new LocalFolder(base, 'V');
		const root = await lf.createRoot();
		await lf.listAll(root.id);
		await expect(lf.upload('../evil.md', root.id, new ArrayBuffer(1))).rejects.toThrow();
		await expect(lf.createFolder('..', root.id)).rejects.toThrow();
		expect(fs.existsSync(path.join(base, 'evil.md'))).toBe(false);
	});
});
