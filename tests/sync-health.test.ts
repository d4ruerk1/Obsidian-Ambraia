// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Notice } from 'obsidian';
import { FakeApp, FakeDrive, FakeLocal, installDomShim } from './app-fake';
import { apiRequest, classifyResponse, HttpResponse } from '../src/sync/http';
import { tokenRequest } from '../src/sync/oauth';
import { AuthError, LimitError, NetworkError, QuotaError, SyncEngine, isNoSpace } from '../src/sync/engine';
import { PCloud } from '../src/sync/providers/pcloud';
import { emptyState, HttpError } from '../src/sync/types';

installDomShim();
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
});
beforeEach(() => {
	Notice.all.length = 0;
});
const notices = (re: RegExp) => (Notice as any).all.filter((n: string) => re.test(n));

// ------------------------------------------------------------------ helpers

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse => {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* html */
	}
	return { status, text, json, arrayBuffer: new ArrayBuffer(0), headers };
};
const seq = (...list: HttpResponse[]) => {
	const calls: string[] = [];
	const http = async (r: { url: string }) => {
		calls.push(r.url);
		return list[Math.min(calls.length - 1, list.length - 1)];
	};
	return { http, calls };
};
const req = { url: 'https://api.example/x', method: 'POST' };

async function device(drive: FakeDrive, app = new FakeApp(), local = new FakeLocal(), data: unknown = null) {
	const plugin = new AmbraiaPlugin(app, manifest);
	plugin.data = data;
	await plugin.onload();
	const hub = plugin.sync;
	hub.remoteFactory = (_c: unknown, folder: string) => drive.api(folder);
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
async function connect(d: Dev, folder = 'Ambraia/Test', provider = 'dropbox') {
	const m = await d.hub.add({ provider, folder, enabled: true }, { provider, clientId: 'k', refreshToken: 'r' });
	d.hub.settingsChanged();
	await m.idle();
	return m;
}
async function cycle(...ds: Dev[]) {
	for (const d of ds) {
		for (const m of d.hub.managers) {
			await m.idle();
			await m.syncNow(true);
			await m.idle();
		}
	}
}
const files = (d: Dev) => Object.fromEntries([...d.local.files.keys()].sort().map((p) => [p, d.local.get(p)]));

// ------------------------------------------------------------------ classification

describe('upstream answers are classified, whatever the provider', () => {
	it('recognises "account full" on every service and never retries it', async () => {
		const cases: [number, unknown][] = [
			[403, { error: { errors: [{ reason: 'storageQuotaExceeded' }], message: 'The user’s Drive storage quota has been exceeded.' } }],
			[409, { error_summary: 'path/insufficient_space/..', error: { '.tag': 'path' } }],
			[507, { error: { code: 'insufficientStorage', message: 'Insufficient Space Available' } }],
			[403, { error: { code: 'quotaLimitReached', message: 'Quota limit reached' } }],
		];
		for (const [status, body] of cases) {
			expect(classifyResponse(res(status, body))).toBe('quota');
			const { http, calls } = seq(res(status, body));
			await expect(apiRequest(http, null, req, { label: 'X' })).rejects.toBeInstanceOf(QuotaError);
			expect(calls.length).toBe(1);
		}
	});

	it('does not mistake API rate quotas or per-file download caps for a full account', () => {
		expect(classifyResponse(res(403, { error: { message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'", errors: [{ reason: 'rateLimitExceeded' }] } }))).toBeNull();
		expect(classifyResponse(res(403, { error: { errors: [{ reason: 'downloadQuotaExceeded' }] } }))).toBeNull();
		expect(classifyResponse(res(404, 'not found'))).toBeNull();
		expect(classifyResponse(res(200, 'storageQuotaExceeded'))).toBeNull();
		expect(classifyResponse(res(403, { error: { errors: [{ reason: 'dailyLimitExceeded' }] } }))).toBe('limit');
	});

	it('long Retry-After and daily caps become a LimitError instead of blocking the cycle', async () => {
		let r = seq(res(429, {}, { 'Retry-After': '900' }));
		const e1 = await apiRequest(r.http, null, req, { label: 'X' }).catch((e) => e);
		expect(e1).toBeInstanceOf(LimitError);
		expect(e1.waitMs).toBe(900_000);
		expect(r.calls.length).toBe(1);
		r = seq(res(403, { error: { errors: [{ reason: 'dailyLimitExceeded' }] } }));
		const e2 = await apiRequest(r.http, null, req, { label: 'X' }).catch((e) => e);
		expect(e2).toBeInstanceOf(LimitError);
		expect(e2.waitMs).toBe(3600_000);
		// short throttling still retried transparently
		r = seq(res(429, {}, { 'Retry-After': '0' }), res(200, { ok: 1 }));
		expect((await apiRequest(r.http, null, req, { label: 'X' })).status).toBe(200);
		// throttling that never ends: LimitError (cycle aborted), not a per-file error
		r = seq(res(429, {}));
		await expect(apiRequest(r.http, null, req, { label: 'X', retries: 0 })).rejects.toBeInstanceOf(LimitError);
	});

	it('server outages carry the status code; transport errors do not', async () => {
		let r = seq(res(503, 'Service Unavailable'));
		const e = await apiRequest(r.http, null, req, { label: 'OneDrive', retries: 0 }).catch((x) => x);
		expect(e).toBeInstanceOf(NetworkError);
		expect(e.status).toBe(503);
		const boom = async () => {
			throw new Error('getaddrinfo ENOTFOUND');
		};
		const t = await apiRequest(boom as any, null, req, { label: 'X' }).catch((x) => x);
		expect(t).toBeInstanceOf(NetworkError);
		expect(t.status).toBeUndefined();
		r = seq(res(400, { error: 'weird' }));
		await expect(apiRequest(r.http, null, req, { label: 'X' })).rejects.toBeInstanceOf(HttpError);
	});

	it('token endpoint hiccups and captive portals never ask the user to reconnect', async () => {
		const call = (r: HttpResponse) => tokenRequest((async () => r) as any, 'https://t', { grant_type: 'refresh_token' });
		await expect(call(res(400, { error: 'temporarily_unavailable' }))).rejects.toBeInstanceOf(NetworkError);
		await expect(call(res(503, 'down'))).rejects.toBeInstanceOf(NetworkError);
		await expect(call(res(200, '<html>Hotel Wi-Fi login</html>'))).rejects.toBeInstanceOf(NetworkError);
		await expect(call(res(400, { error: 'invalid_grant' }))).rejects.toBeInstanceOf(AuthError);
	});

	it('pCloud result codes: over quota and too many requests', async () => {
		const pc = (j: unknown) => new PCloud((async () => res(200, j)) as any, async () => 't', 'eapi.pcloud.com', 'Ambraia/V');
		await expect(pc({ result: 2008, error: 'User is over quota.' }).createFolder('x', 'd0')).rejects.toBeInstanceOf(QuotaError);
		await expect(pc({ result: 4000, error: 'Too many login tries' }).createFolder('x', 'd0')).rejects.toBeInstanceOf(LimitError);
		expect(await pc({ result: 0, quota: 1000, usedquota: 250 }).space()).toEqual({ used: 250, total: 1000 });
	});

	it('detects a full local disk on desktop and mobile', () => {
		expect(isNoSpace(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(true);
		expect(isNoSpace(new Error("ENOSPC: no space left on device, write '/v/a.md'"))).toBe(true);
		expect(isNoSpace(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }))).toBe(true);
		expect(isNoSpace(new Error('ENOENT'))).toBe(false);
		expect(isNoSpace(null)).toBe(false);
	});
});

// ------------------------------------------------------------------ engine

describe('engine with a full cloud', () => {
	const setup = async () => {
		const drive = new FakeDrive('feed');
		const local = new FakeLocal();
		const state = emptyState('v');
		const eng = (o: Record<string, unknown> = {}) => new SyncEngine(state, local, drive.api('V'), { maxFileSize: 1e9, ...o });
		return { drive, local, state, eng };
	};

	it('pre-flight: nothing is uploaded when the batch cannot fit, downloads go on', async () => {
		const { drive, local, eng } = await setup();
		local.put('a.md', 'aaaa');
		await eng().run(new Set(), true);
		await drive.remoteEdit('a.md', 'remote edit');
		for (let i = 0; i < 5; i++) local.put(`n${i}.md`, 'x'.repeat(100));
		const asked: number[] = [];
		const r = await eng({ canUpload: async (b: number) => (asked.push(b), false) }).run(new Set(), true);
		expect(asked).toEqual([500]);
		expect(r.quota).toBe('preflight');
		expect(r.heldBack.sort()).toEqual(['n0.md', 'n1.md', 'n2.md', 'n3.md', 'n4.md']);
		expect(r.errors).toEqual([]);
		expect(drive.calls.filter((c) => c === 'upload')).toEqual(['upload']); // only the first sync
		expect(local.get('a.md')).toBe('remote edit');
	});

	it('a quota error stops the remaining uploads but not downloads or deletions', async () => {
		const { drive, local, eng } = await setup();
		local.put('keep.md', 'k');
		local.put('old.md', 'o');
		await eng().run(new Set(), true);
		await drive.remoteEdit('keep.md', 'changed remotely');
		local.remove('old.md');
		drive.capacity = drive.used + 150;
		for (let i = 0; i < 4; i++) local.put(`big${i}.md`, 'y'.repeat(100));
		const r = await eng().run(new Set(), true);
		expect(r.quota).toMatch(/storageQuotaExceeded/);
		expect(r.uploaded.length).toBe(1);
		expect(r.heldBack.length).toBe(3);
		expect(r.errors).toEqual([]);
		expect(r.deletedRemote).toEqual(['old.md']);
		expect(local.get('keep.md')).toBe('changed remotely');
		expect(drive.calls.filter((c) => c === 'upload').length).toBe(2 + 2); // 2 initial + 1 ok + 1 refused
		// held-back files are retried next time
		expect(r.retry).toEqual(expect.arrayContaining(r.heldBack));
	});

	it('noUploads mode holds conflicts back too (never a half-resolved conflict)', async () => {
		const { drive, local, eng } = await setup();
		local.put('c.md', 'base');
		await eng().run(new Set(), true);
		await drive.remoteEdit('c.md', 'remote');
		local.put('c.md', 'local');
		const r = await eng({ noUploads: true }).run(new Set(['c.md']), true);
		expect(r.heldBack).toEqual(['c.md']);
		expect(local.get('c.md')).toBe('local');
		expect([...local.files.keys()]).toEqual(['c.md']);
	});
});

// ------------------------------------------------------------------ manager

describe('manager: Google Drive plan downgraded / cloud full', () => {
	it('warns once, keeps the vault safe, keeps downloading, resumes by itself', async () => {
		const drive = new FakeDrive('feed');
		const A = await device(drive);
		const B = await device(drive);
		A.local.put('Nota.md', 'ciao');
		await connect(A, 'Ambraia/Test', 'gdrive');
		await connect(B, 'Ambraia/Test', 'gdrive');
		await cycle(A, B);
		// plan downgraded: less space than already used
		drive.capacity = Math.floor(drive.used / 2);
		const before = await drive.snapshot();
		A.local.put('Nuova.md', 'x'.repeat(500));
		A.local.put('Nota.md', 'ciao modificata su A');
		await cycle(A);
		expect(A.mgr.status).toBe('full');
		expect(A.mgr.quota).not.toBeNull();
		expect(notices(/esaurito/).length).toBe(1);
		expect(notices(/esaurito/)[0]).toMatch(/Google Drive/);
		expect(await drive.snapshot()).toEqual(before); // nothing half-uploaded
		// one refused attempt at most (space unknown from cache), then everything else is held back
		expect(drive.calls.filter((c) => c === 'upload' || c === 'update').length).toBeLessThanOrEqual(2);
		expect(A.mgr.pendingCount).toBe(2);
		expect(A.mgr.problem?.kind).toBe('quota');
		expect(A.mgr.statusText().tip).toMatch(/pieno/);
		// B (another device) can still edit: A keeps receiving
		B.local.put('DaB.md', 'b');
		drive.capacity = null;
		await cycle(B);
		drive.capacity = 1;
		await cycle(A, A, A);
		expect(A.local.get('DaB.md')).toBe('b');
		expect(notices(/esaurito/).length).toBe(1); // no spam
		// periodic recheck: still full → stays quiet
		await A.mgr.recheckQuota();
		await A.mgr.idle();
		expect(A.mgr.status).toBe('full');
		// user frees space → next recheck resumes and says so
		drive.capacity = 10_000_000;
		await A.mgr.recheckQuota();
		await A.mgr.idle();
		await A.mgr.idle();
		expect(A.mgr.quota).toBeNull();
		expect(notices(/di nuovo spazio/).length).toBe(1);
		await cycle(A);
		expect(A.mgr.status).toBe('idle');
		expect(await drive.text('Nuova.md')).toBe('x'.repeat(500));
		expect(await drive.text('Nota.md')).toBe('ciao modificata su A');
	});

	it('first backup larger than the free space: no partial upload at all', async () => {
		const drive = new FakeDrive('probe');
		drive.capacity = 2000;
		const A = await device(drive);
		for (let i = 0; i < 10; i++) A.local.put(`Note/${i}.md`, 'z'.repeat(400));
		await connect(A);
		await cycle(A);
		expect(A.mgr.status).toBe('full');
		expect(drive.calls.filter((c) => c === 'upload').length).toBe(0);
		const n = notices(/servono circa/);
		expect(n.length).toBe(1);
		expect(n[0]).toMatch(/3[.,]9 KB/);
		expect(A.mgr.space).toEqual({ used: 0, total: 2000 });
	});

	it('services without a space API: learns from the refused upload, probes again later', async () => {
		const drive = new FakeDrive('probe');
		drive.spaceApi = false;
		const A = await device(drive);
		A.local.put('a.md', 'a');
		await connect(A);
		await cycle(A);
		drive.capacity = drive.used;
		A.local.put('b.md', 'bbbb');
		await cycle(A);
		expect(A.mgr.status).toBe('full');
		expect(notices(/esaurito/).length).toBe(1);
		await A.mgr.recheckQuota();
		await A.mgr.idle();
		expect(A.mgr.status).toBe('full');
		drive.capacity = null;
		await A.mgr.recheckQuota();
		await A.mgr.idle();
		await A.mgr.idle();
		expect(A.mgr.quota).toBeNull();
		expect(await drive.text('b.md')).toBe('bbbb');
	});

	it('remembers a full cloud across restarts without warning again', async () => {
		const drive = new FakeDrive('probe');
		const app = new FakeApp();
		const local = new FakeLocal();
		const A = await device(drive, app, local);
		local.put('a.md', 'a');
		await connect(A);
		await cycle(A);
		drive.capacity = drive.used;
		local.put('b.md', 'bbbb');
		await cycle(A);
		expect(notices(/esaurito/).length).toBe(1);
		await A.plugin.onunload();
		const A2 = await device(drive, app, local, A.plugin.data);
		await A2.mgr.idle();
		await cycle(A2);
		expect(A2.mgr.status).toBe('full');
		expect(notices(/esaurito/).length).toBe(1);
	});

	it('warns early when the cloud is almost full', async () => {
		const drive = new FakeDrive('probe');
		drive.capacity = 10_000;
		const A = await device(drive);
		A.local.put('a.md', 'q'.repeat(9_800));
		await connect(A);
		await cycle(A);
		expect(A.mgr.status).toBe('idle');
		expect(notices(/restano solo/).length).toBe(1);
		A.local.put('b.md', 'w');
		(A.mgr as any).spaceAt = 0;
		await cycle(A);
		expect(notices(/restano solo/).length).toBe(1); // once every few days
	});
});

describe('manager: outages, limits and unexpected answers', () => {
	it('OneDrive down: quiet at first, one notice when it lasts, one when it is back', async () => {
		const drive = new FakeDrive('feed');
		const A = await device(drive);
		A.local.put('a.md', 'a');
		await connect(A, 'Ambraia/Test', 'onedrive' as any);
		await cycle(A);
		drive.fault = () => new NetworkError('OneDrive 503: Service Unavailable', 503);
		A.local.put('b.md', 'b');
		await cycle(A, A);
		expect(A.mgr.status).toBe('offline');
		expect(A.mgr.statusText().tip).toMatch(/503/);
		expect(notices(/non risponde/).length).toBe(0);
		(A.mgr as any).failSince -= 11 * 60_000;
		await cycle(A, A);
		expect(notices(/non risponde/).length).toBe(1);
		expect(notices(/non risponde/)[0]).toMatch(/OneDrive/);
		await cycle(A, A, A);
		expect(notices(/non risponde/).length).toBe(1);
		expect(A.mgr.problem?.kind).toBe('outage');
		drive.fault = null;
		await cycle(A);
		expect(A.mgr.status).toBe('idle');
		expect(A.mgr.problem).toBeNull();
		expect(notices(/funziona di nuovo/).length).toBe(1);
		expect(await drive.text('b.md')).toBe('b');
	});

	it('plain offline device: no alarm, just the status', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		await connect(A);
		await cycle(A);
		drive.fault = () => new NetworkError('Failed to fetch');
		for (let i = 0; i < 4; i++) await cycle(A);
		(A.mgr as any).failSince -= 60 * 60_000;
		await cycle(A, A);
		expect(A.mgr.status).toBe('offline');
		expect(notices(/raggiungibile|non risponde/).length).toBe(0);
	});

	it('one service unreachable while another works: reported as a service problem', async () => {
		const g = new FakeDrive('feed');
		const o = new FakeDrive('probe');
		const A = await device(g);
		A.hub.remoteFactory = (c: any, folder: string) => (c.provider === 'gdrive' ? g : o).api(folder);
		A.local.put('n.md', 'n');
		await connect(A, 'Ambraia/G', 'gdrive');
		const od = await connect(A, 'Ambraia/O', 'onedrive');
		await cycle(A);
		o.fault = () => new NetworkError('ECONNRESET');
		A.local.put('m.md', 'm');
		await cycle(A, A);
		(od as any).failSince -= 11 * 60_000;
		await cycle(A, A);
		expect(od.status).toBe('offline');
		expect(notices(/non è raggiungibile/).length).toBe(1);
		expect(A.hub.managers[0].status).toBe('idle');
		expect(await g.text('m.md')).toBe('m');
	});

	it('daily limit: tells the user when it will resume and waits instead of hammering', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		await connect(A);
		await cycle(A);
		drive.fault = () => new LimitError('Google Drive 403: dailyLimitExceeded', 3600_000);
		await cycle(A);
		expect(A.mgr.status).toBe('offline');
		expect(notices(/limite di utilizzo/).length).toBe(1);
		expect((A.mgr as any).backoffUntil - Date.now()).toBeGreaterThan(50 * 60_000);
		const calls = drive.calls.length;
		(A.mgr as any).tick();
		await A.mgr.idle();
		expect(drive.calls.length).toBe(calls);
		drive.fault = null;
		await cycle(A);
		expect(notices(/funziona di nuovo/).length).toBe(1);
	});

	it('unexpected answers: growing backoff, one notice, recovery', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		await connect(A);
		await cycle(A);
		drive.fault = (c) => (c === 'probe' || c === 'listAll' ? new HttpError(400, 'Dropbox 400: invalid_select_admin') : null);
		await cycle(A, A);
		expect(notices(/in modo inatteso/).length).toBe(0);
		await cycle(A, A, A);
		expect(notices(/in modo inatteso/).length).toBe(1);
		expect((A.mgr as any).backoffMs).toBeGreaterThanOrEqual(80_000);
		drive.fault = null;
		await cycle(A);
		expect(A.mgr.status).toBe('idle');
		expect(notices(/funziona di nuovo/).length).toBe(1);
	});

	it('a single file refused again and again is reported once, the rest syncs', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		A.hub.remoteFactory = (_c: any, folder: string) => {
			const api = drive.api(folder);
			const up = api.upload.bind(api);
			api.upload = async (name, parent, data) => {
				if (name === 'Rotto.md') throw new HttpError(400, 'Dropbox 400: path/disallowed_name');
				return up(name, parent, data);
			};
			return api;
		};
		A.local.put('Rotto.md', 'r');
		A.local.put('Ok.md', 'ok');
		await connect(A);
		for (let i = 0; i < 5; i++) await cycle(A);
		expect(await drive.text('Ok.md')).toBe('ok');
		const n = notices(/non riescono a sincronizzarsi/);
		expect(n.length).toBe(1);
		expect(n[0]).toMatch(/Rotto\.md/);
		expect(A.mgr.problem?.kind).toBe('files');
	});

	it('local disk full: stops writing, says so, resumes', async () => {
		const drive = new FakeDrive('probe');
		const local = new FakeLocal();
		const A = await device(drive, new FakeApp(), local);
		await connect(A);
		await cycle(A);
		const B = await device(drive);
		await connect(B);
		B.local.put('grande.md', 'g');
		await cycle(B);
		const write = local.write.bind(local);
		local.write = async () => {
			throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
		};
		await cycle(A);
		expect(A.mgr.status).toBe('error');
		expect(notices(/questo dispositivo è esaurito/).length).toBe(1);
		local.write = write;
		await cycle(A);
		expect(local.get('grande.md')).toBe('g');
		expect(A.mgr.status).toBe('idle');
	});
});

// ------------------------------------------------------------------ chaos

/** Small deterministic PRNG so failures are reproducible. */
const rng = (seed: number) => () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

describe('chaos: random upstream failures never lose or corrupt data', () => {
	// CHAOS=500 npx vitest run tests/sync-health.test.ts  → many more random runs
	const extra = Array.from({ length: Number(process.env.CHAOS ?? 0) }, (_, i) => 10_000 + i);
	for (const seed of [1, 7, 42, 99, 2024, 31337, 5, 13, 77, 123, 4242, 65535, ...extra]) {
		it(`seed ${seed}`, async () => {
			const rand = rng(seed);
			const mode = (['feed', 'probe', 'snapshot'] as const)[seed % 3];
			const drive = new FakeDrive(mode);
			const A = await device(drive);
			const B = await device(drive);
			await connect(A, 'Ambraia/Test', 'gdrive');
			await connect(B, 'Ambraia/Test', 'gdrive');
			await cycle(A, B);
			if (seed % 4 === 0) {
				A.plugin.settings.syncKdf = 'pbkdf2';
				await A.mgr.setupEncryption({ password: 'chiave principale del caos 1', alg: 'aes-gcm', names: true, kdf: 'pbkdf2' });
				await cycle(B);
				await B.mgr.unlock('chiave principale del caos 1', true);
				await cycle(A, B);
				expect(A.mgr.t.encrypt && B.mgr.t.encrypt).toBe(true);
			}
			const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
			const faults: (() => Error)[] = [
				() => new NetworkError('ETIMEDOUT'),
				() => new NetworkError('OneDrive 502', 502),
				() => new LimitError('429', 1000),
				() => new HttpError(500, 'boom'),
				() => new HttpError(400, 'unexpected'),
				() => new QuotaError('full'),
			];
			const written = new Map<string, Set<string>>();
			for (let round = 0; round < Number(process.env.CHAOS_ROUNDS ?? 25); round++) {
				const d = rand() < 0.5 ? A : B;
				const p = `${rand() < 0.3 ? 'Cartella/' : ''}f${Math.floor(rand() * 6)}.md`;
				const v = `${d === A ? 'A' : 'B'}-${round}`;
				const r0 = rand();
				if (r0 < 0.12 && d.local.files.has(p)) await d.local.remove(p);
				else if (r0 < 0.2 && d.local.files.has(p)) {
					const to = `f${Math.floor(rand() * 6)}.md`;
					if (!d.local.files.has(to)) await d.local.rename(p, to);
					const text = d.local.get(to);
					if (text !== undefined) {
						if (!written.has(to)) written.set(to, new Set());
						written.get(to)!.add(text);
					}
				} else {
					d.local.put(p, v);
					if (!written.has(p)) written.set(p, new Set());
					written.get(p)!.add(v);
				}
				const rate = rand() * 0.5;
				drive.fault = (c) => (rand() < rate ? pick(faults)() : null);
				drive.capacity = rand() < 0.2 ? drive.used : null;
				await cycle(pick([A, B]));
			}
			// the world heals: everything must converge
			drive.fault = null;
			drive.capacity = null;
			for (let i = 0; i < 4; i++) {
				for (const d of [A, B]) {
					(d.mgr as any).backoffUntil = 0;
					if (d.mgr.quota) await d.mgr.recheckQuota();
				}
				await cycle(A, B);
			}
			expect(A.mgr.quota).toBeNull();
			expect(B.mgr.quota).toBeNull();
			expect(files(A)).toEqual(files(B));
			if (!A.mgr.t.encrypt) {
				const snap = await drive.snapshot();
				expect(Object.fromEntries(Object.entries(snap).sort())).toEqual(files(A));
			} else {
				const live = [...drive.files.values()].filter((f) => !f.isFolder && !f.root && !drive.isTrashed(f.id) && drive.inVault(f));
				expect(live.length).toBe(Object.keys(files(A)).length + 1); // + key file
			}
			// one version only: never a "(conflitto …)" copy, every line comes from something a device wrote
			const allLines = new Set([...written.values()].flatMap((set) => [...set]).flatMap((t) => t.split('\n')));
			for (const [p, text] of Object.entries(files(A))) {
				expect(p).not.toMatch(/conflitto/);
				for (const line of text.split('\n')) expect(allLines.has(line), `${p}: ${line}`).toBe(true);
			}
			expect(A.mgr.status).toBe('idle');
			expect(B.mgr.status).toBe('idle');
		}, 60_000);
	}
});

describe('regressions found while testing', () => {
	it('a local write that fails (locked file, permissions, full disk) never deletes the file elsewhere', async () => {
		const drive = new FakeDrive('probe');
		const local = new FakeLocal();
		const A = await device(drive, new FakeApp(), local);
		await connect(A);
		await cycle(A);
		const B = await device(drive);
		await connect(B);
		B.local.put('grande.md', 'g');
		await cycle(B);
		const write = local.write.bind(local);
		local.write = async () => {
			throw new Error('EBUSY: resource busy or locked');
		};
		await cycle(A, A);
		local.write = write;
		await cycle(A, B);
		expect(await drive.snapshot()).toEqual({ 'grande.md': 'g' });
		expect(files(B)).toEqual({ 'grande.md': 'g' });
		expect(files(A)).toEqual({ 'grande.md': 'g' });
	});
});

describe('broken or changed upstream APIs never look like deleted files', () => {
	it('a listing suddenly empty (all files "gone") asks before deleting anything, even in a small vault', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		for (const n of ['a', 'b', 'c', 'd']) A.local.put(`${n}.md`, n);
		await connect(A);
		await cycle(A);
		A.hub.remoteFactory = (_c: unknown, folder: string) => {
			const api = drive.api(folder);
			const all = api.listAll.bind(api);
			api.listAll = async (id) => (await all(id)).filter((f) => f.isFolder);
			(api.probe as any).changed = async () => ({ changed: true, token: 'x' });
			return api;
		};
		(A.mgr as any).inner = null;
		(A.mgr as any).secure = null;
		await cycle(A);
		expect(A.mgr.status).toBe('paused');
		expect(Object.keys(files(A)).length).toBe(4);
		expect(A.local.trash).toEqual([]);
	});

	it('items without ids (API changed) stop the cycle instead of corrupting the index', async () => {
		const drive = new FakeDrive('probe');
		const A = await device(drive);
		A.local.put('a.md', 'a');
		await connect(A);
		await cycle(A);
		A.hub.remoteFactory = (_c: unknown, folder: string) => {
			const api = drive.api(folder);
			api.listAll = async () => [{ name: 'x' } as any];
			(api.probe as any).changed = async () => ({ changed: true, token: 'x' });
			return api;
		};
		(A.mgr as any).inner = null;
		(A.mgr as any).secure = null;
		for (let i = 0; i < 4; i++) await cycle(A);
		expect(A.mgr.status).toBe('error');
		expect(A.mgr.problem?.kind).toBe('unexpected');
		expect(notices(/in modo inatteso/).length).toBe(1);
		expect(files(A)).toEqual({ 'a.md': 'a' });
	});

	it('cloud folder missing: one notice, nothing touched, resumes by itself when it is back', async () => {
		const drive = new FakeDrive('feed');
		const A = await device(drive);
		A.local.put('a.md', 'a');
		await connect(A);
		await cycle(A);
		const root = [...drive.files.values()].find((f) => f.root)!;
		root.trashed = true;
		drive.touch(root.id);
		A.local.put('b.md', 'b');
		await cycle(A, A, A);
		expect(A.mgr.status).toBe('error');
		expect(A.mgr.started).toBe(true);
		expect(notices(/eliminata o spostata/).length).toBe(1);
		expect(files(A)).toEqual({ 'a.md': 'a', 'b.md': 'b' });
		root.trashed = false;
		drive.touch(root.id);
		await cycle(A);
		expect(A.mgr.status).toBe('idle');
		expect(await drive.text('b.md')).toBe('b');
		expect(notices(/funziona di nuovo/).length).toBe(1);
	});

	it('garbage 200 answers from every provider are errors, never an empty folder', async () => {
		const { GoogleDrive } = await import('../src/sync/providers/gdrive');
		const { Dropbox } = await import('../src/sync/providers/dropbox');
		const { OneDrive } = await import('../src/sync/providers/onedrive');
		const bodies: unknown[] = [{}, null, '<html>Wi-Fi login</html>', { files: null }, { value: 'x' }, { entries: {} }, { result: 0 }, { metadata: {} }];
		const mk = (b: unknown) => (async () => res(200, b)) as any;
		const token = async () => 't';
		for (const b of bodies) {
			const ps = [new GoogleDrive(mk(b), token, 'V', 0), new Dropbox(mk(b), token, 'V'), new OneDrive(mk(b), token, 'V'), new PCloud(mk(b), token, 'h', 'V')];
			for (const p of ps) {
				const out = await p.listAll('root1').then(
					(r) => r,
					() => 'error',
				);
				if (out !== 'error') expect(out, `${p.constructor.name} ${JSON.stringify(b)}`).toEqual([]);
				const root = await p.findRoot().then(
					(r) => r,
					() => 'error',
				);
				expect(root === 'error' || (root && typeof (root as any).id === 'string'), `${p.constructor.name} findRoot ${JSON.stringify(b)}`).toBe(true);
			}
		}
	});
});
