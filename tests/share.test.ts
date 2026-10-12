// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FakeApp } from './app-fake';
import { buildUrl, checkSession, ConflictError, decodeLive, encodeLive, fragmentOf, liveK1, liveKeys, makeRequest, makeResponse, makeSession, openEdit, openRequest, openResponse, proofMatches, randomBytes, ShareError } from '../src/share/format';
import { Relay } from '../src/share/relay';
import { DuplicatePasswordError, mergeShare, ProfileInput, profileState, ShareRecord, ShareStore, shareState } from '../src/share/store';
import { LiveServer } from '../src/share/server';
import { openLink } from '../src/share/client';
import { mergeEdit, shareableMarkdown, splitFrontmatter } from '../src/share/content';
import { renderMarkdown } from '../src/share/markdown';
import { FakeNtfy } from './ntfy-fake';

const FAST = { log2m: 10, t: 1 };
const code = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'ok';
	} catch (e) {
		return e instanceof ShareError ? e.code : String(e);
	}
};

type Files = Record<string, string>;
const P = (o: Partial<ProfileInput> = {}): ProfileInput => ({ label: 'Lettura', canEdit: false, maxUses: null, expires: null, password: '', ...o });

function device(relay: FakeNtfy, app = new FakeApp(), files: Files = {}, saveDelay = () => 0) {
	const store = new ShareStore({ app: app as never, viewerUrl: () => 'https://viewer.test/share/', relayUrl: () => relay.base, deviceName: () => 'PC', argon: () => FAST });
	const server = new LiveServer(store, {
		read: async (p, forEdit) => (p in files ? (forEdit ? splitFrontmatter(files[p]).body : shareableMarkdown(files[p])) : null),
		applyEdit: async (p, base, text) => {
			if (!(p in files)) return null;
			const r = mergeEdit(files[p], base, text);
			if (r === 'conflict') return r;
			files[p] = r.md;
			return { text: r.text, merged: r.merged };
		},
		http: relay.http,
		socket: null,
		saveDelay,
	});
	return { app, store, server, files };
}

/** Delivers every request to the servers (instead of their subscriptions). */
function wire(relay: FakeNtfy, servers: LiveServer[]) {
	relay.onPublish = (m) => {
		for (const s of servers) void s.onMessage(new Relay(relay.base, relay.http), m);
	};
}

const sharedList = () => {
	const list = new Map<string, unknown>();
	return { readShares: async () => [...list.values()], writeShare: async (id: string, d: unknown) => void list.set(id, d), removeShare: async (id: string) => void list.delete(id) };
};

const open = (relay: FakeNtfy, url: string, password = '', timeoutMs = 3000) => openLink(url, { password, http: relay.http, socket: null, pollMs: 15, timeoutMs });
const read = async (relay: FakeNtfy, url: string, password = '') => (await open(relay, url, password)).note;

describe('shared links: format', () => {
	it('link encoding, profiles proven by their key, refusals readable only with the link', async () => {
		const secret = randomBytes(32);
		const frag = encodeLive({ secret, relay: 'https://relay.test', ...FAST });
		expect(frag.startsWith('c2')).toBe(true);
		const l = decodeLive(fragmentOf(buildUrl('https://v.test/share', frag)));
		expect(l.relay).toBe('https://relay.test');
		expect(decodeLive(encodeLive({ secret, relay: 'https://ntfy.sh', ...FAST })).relay).toBe('https://ntfy.sh');
		expect(() => decodeLive('c2' + frag.slice(2, 10))).toThrow();
		// links of older versions are recognised as such
		expect(() => decodeLive('s1abc')).toThrow(expect.objectContaining({ code: 'unsupported' }));

		const keys = liveKeys(secret);
		const k1 = await liveK1(secret, 'pw', FAST.log2m, FAST.t);
		const k1Empty = await liveK1(secret, '');
		const good = makeRequest(keys, k1);
		const req = openRequest(keys, good.body)!;
		expect(req.op).toBe('open');
		expect(proofMatches(k1, req)).toBe(true);
		expect(proofMatches(k1Empty, req)).toBe(false);
		// another link cannot even be read
		expect(openRequest(liveKeys(randomBytes(32)), good.body)).toBeNull();

		const note = { title: 'T', md: 'ciao', created: 1, expires: null, left: 2, canEdit: true, profile: 'Bozza', session: 'tok' };
		const ans = makeResponse(keys, k1, good.nonce, { note });
		expect(openResponse(keys, k1, good.nonce, ans)).toMatchObject({ md: 'ciao', left: 2, canEdit: true, profile: 'Bozza', session: 'tok' });
		// the note is bound to the request and to the profile key
		const other = makeRequest(keys, k1Empty);
		expect(() => openResponse(keys, k1, other.nonce, ans)).toThrow();
		expect(() => openResponse(keys, k1Empty, good.nonce, ans)).toThrow();
		const no = makeResponse(keys, null, other.nonce, { error: 'password' });
		expect(() => openResponse(keys, k1Empty, other.nonce, no)).toThrow(expect.objectContaining({ code: 'password' }));
	});

	it('changes travel encrypted with the profile key; conflicts carry the current text', async () => {
		const secret = randomBytes(32);
		const keys = liveKeys(secret);
		const k1 = await liveK1(secret, 'pw', FAST.log2m, FAST.t);
		const save = makeRequest(keys, k1, { session: 's', edit: { base: 'a', text: 'b' } });
		const req = openRequest(keys, save.body)!;
		expect(req).toMatchObject({ op: 'save', session: 's' });
		expect(openEdit(k1, req)).toEqual({ base: 'a', text: 'b' });
		expect(openEdit(await liveK1(secret, ''), req)).toBeNull();
		const ok = makeResponse(keys, k1, save.nonce, { saved: { text: 'b', merged: true } });
		expect(openResponse(keys, k1, save.nonce, ok)).toEqual({ saved: 'b', merged: true });
		const c = makeResponse(keys, k1, save.nonce, { error: 'conflict', text: 'attuale' });
		let err: unknown;
		try {
			openResponse(keys, k1, save.nonce, c);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ConflictError);
		expect((err as ConflictError).current).toBe('attuale');
		// without the profile key the current text stays unreadable
		const kEmpty = await liveK1(secret, '');
		expect(() => openResponse(keys, kEmpty, save.nonce, c)).toThrow(expect.objectContaining({ code: 'corrupt' }));
	});

	it('session tokens are signed and expire', () => {
		const skey = randomBytes(32);
		const t = makeSession(skey, 'p1', 'n', Date.now() + 1000);
		expect(checkSession(skey, t)).toMatchObject({ profile: 'p1', nonce: 'n' });
		expect(checkSession(randomBytes(32), t)).toBeNull();
		expect(checkSession(skey, t, Date.now() + 2000)).toBeNull();
		const [payload, sig] = t.split('.');
		expect(checkSession(skey, payload.slice(0, -2) + 'AA.' + sig)).toBeNull();
	});
});

describe('shared links: content and rendering', () => {
	it('shares only the text: no properties, comments, embeds or local images', () => {
		const md = '---\nsegreto: sì\ntags: [x]\n---\n# Titolo %%nota privata%%\n\n%%\nblocco\nprivato\n%%\nVedi [[Altra nota|questa]] e [[Nota#Sezione]].\n![[foto.png]]\n![locale](allegati/a.png) ![web](https://example.com/a.png)\nRiga ^abc123\n';
		const out = shareableMarkdown(md);
		expect(out).not.toMatch(/segreto|privat|abc123|allegati|\[\[/);
		expect(out).toContain('questa');
		expect(out).toContain('Nota › Sezione');
		expect(out).toContain('https://example.com/a.png');
	});

	it('never interprets HTML or unsafe links', () => {
		const root = document.createElement('div');
		renderMarkdown(document, root, '<img src=x onerror=alert(1)>\n\n[a](javascript:alert(1)) [b](https://ok.test) ![i](https://img.test/x.png)\n\n<script>alert(1)</script>\n\n- [x] fatto\n\n> [!note] Titolo\n> testo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\n<b>x</b>\n```');
		expect(root.querySelector('img, script, iframe')).toBeNull();
		expect(root.querySelector('[onerror]')).toBeNull();
		const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));
		expect(hrefs.every((h) => /^https:/.test(h ?? ''))).toBe(true);
		expect(hrefs).toContain('https://ok.test');
		expect(root.textContent).toContain('<script>alert(1)</script>');
		expect(root.querySelector('table td')?.textContent).toBe('1');
		expect(root.querySelector('pre code')?.textContent).toBe('<b>x</b>');
	});
});

describe('shared links: merging changes', () => {
	it('keeps properties, merges changes made meanwhile, reports clashes', () => {
		const md = '---\ntag: x\n---\nuno\ndue\ntre\n';
		const base = splitFrontmatter(md).body;
		expect(mergeEdit(md, base, 'uno\nDUE\ntre\n')).toEqual({ md: '---\ntag: x\n---\nuno\nDUE\ntre\n', text: 'uno\nDUE\ntre\n', merged: false });
		// the owner changed another line meanwhile (also offline, then synced)
		const owner = '---\ntag: x\n---\nUNO\ndue\ntre\n';
		expect(mergeEdit(owner, base, 'uno\ndue\nTRE\n')).toMatchObject({ text: 'UNO\ndue\nTRE\n', merged: true, md: '---\ntag: x\n---\nUNO\ndue\nTRE\n' });
		// same line on both sides: nothing is overwritten
		expect(mergeEdit(owner, base, 'uno?\ndue\ntre\n')).toBe('conflict');
	});
});

describe('shared links: store', () => {
	it('merges settings by time and openings by union per profile, honouring counter resets', () => {
		const prof = { id: 'p1', label: 'L', k1: 'k', password: false, canEdit: false, maxUses: 3, expires: null, grants: [{ n: 'x', at: 5 }] };
		const base: ShareRecord = { id: 'a'.repeat(16), path: 'n.md', title: 'n', created: 1, updated: 10, by: 'PC', expires: null, revoked: false, deleted: false, url: 'u', secret: 's', relay: 'r', log2m: 10, t: 1, skey: 'k', profiles: [prof] };
		const other: ShareRecord = { ...base, updated: 20, profiles: [{ ...prof, maxUses: 5, grants: [{ n: 'y', at: 6 }] }] };
		const m = mergeShare(base, other);
		expect(m.profiles[0].maxUses).toBe(5);
		expect(m.profiles[0].grants.map((g) => g.n)).toEqual(['x', 'y']);
		const reset = mergeShare({ ...base, profiles: [{ ...prof, grants: [{ n: 'z', at: 30 }] }] }, { ...other, profiles: [{ ...other.profiles[0], resetAt: 25 }] });
		expect(reset.profiles[0].grants.map((g) => g.n)).toEqual(['z']);
		const full = { ...prof, grants: [1, 2, 3].map((i) => ({ n: String(i), at: i })) };
		expect(profileState(base, full)).toBe('exhausted');
		expect(profileState(base, { ...prof, expires: 5 }, 6)).toBe('expired');
		expect(profileState({ ...base, expires: 5 }, prof, 6)).toBe('expired');
		expect(shareState({ ...base, revoked: true })).toBe('revoked');
	});

	it('profiles: one key per password, no two alike, password kept unless changed', async () => {
		const a = device(new FakeNtfy());
		await a.store.load();
		await expect(a.store.create('n.md', 'n', { expires: null, profiles: [P(), P({ label: 'B' })] })).rejects.toBeInstanceOf(DuplicatePasswordError);
		const r = await a.store.create('n.md', 'n', { expires: null, profiles: [P({ label: 'Modifica', canEdit: true, maxUses: 1, password: 'uno' }), P()] });
		expect(r.url).toContain('#c2');
		expect(r.profiles.map((p) => [p.label, p.password, p.canEdit])).toEqual([
			['Modifica', true, true],
			['Lettura', false, false],
		]);
		expect(JSON.stringify(r)).not.toContain('uno');
		const k = r.profiles[0].k1;
		const u = await a.store.update(r.id, { profiles: [{ ...P({ label: 'Modifica', canEdit: true, maxUses: 2 }), id: r.profiles[0].id, password: undefined }] });
		expect(u.profiles).toHaveLength(1);
		expect(u.profiles[0]).toMatchObject({ k1: k, password: true, maxUses: 2 });
	});

	it('keeps the list encrypted on disk and in sync through the device list', async () => {
		const relay = new FakeNtfy();
		const a = device(relay);
		await a.store.load();
		const r = await a.store.create('riservata.md', 'riservata', { expires: null, profiles: [P()] });
		await a.store.save();
		for (const f of await listAll(a.app)) expect(await (a.app.vault as any).adapter.read(f)).not.toContain('riservata');
		const again = device(relay, a.app);
		await again.store.load();
		expect(again.store.get(r.id)?.url).toBe(r.url);

		// two devices through a shared list
		const reg = sharedList();
		const b = device(relay);
		await b.store.load();
		await a.store.syncWith(reg);
		await b.store.syncWith(reg);
		expect(b.store.get(r.id)).toBeTruthy();
		b.store.remove(r.id);
		await b.store.syncWith(reg);
		await a.store.syncWith(reg);
		expect(a.store.get(r.id)).toBeNull();
	});
});

async function listAll(app: FakeApp): Promise<string[]> {
	const a = (app.vault as any).adapter;
	const out: string[] = [];
	const walk = async (d: string) => {
		const l = await a.list(d);
		out.push(...l.files);
		for (const f of l.folders) await walk(f);
	};
	await walk('');
	return out;
}

describe('shared links: live answers', () => {
	it('answers with the current note; revoke, expiry and rename', async () => {
		const relay = new FakeNtfy();
		const d = device(relay, undefined, { 'n.md': '---\np: 1\n---\nprima versione %%privato%%' });
		await d.store.load();
		wire(relay, [d.server]);
		const r = await d.store.create('n.md', 'Nota', { expires: null, profiles: [P()] });
		const first = await open(relay, r.url);
		expect(first.note.md).toContain('prima versione');
		expect(first.note.canEdit).toBe(false);
		expect(first.save).toBeUndefined();
		d.files['n.md'] = 'seconda versione';
		const n = await read(relay, r.url);
		expect(n.md).toContain('seconda versione');
		expect(n.md).not.toContain('p: 1');

		d.files['nuovo.md'] = d.files['n.md'];
		delete d.files['n.md'];
		d.store.onRename('n.md', 'nuovo.md');
		expect((await read(relay, r.url)).md).toContain('seconda');

		await d.store.update(r.id, { expires: Date.now() - 1 });
		expect(await code(open(relay, r.url))).toBe('expired');
		await d.store.update(r.id, { expires: null });
		d.store.revoke(r.id);
		expect(await code(open(relay, r.url))).toBe('revoked');
		d.store.remove(r.id);
		expect(await code(open(relay, r.url))).toBe('revoked');
	}, 30_000);

	it('profiles on the same link: own password, rights, openings and expiry', async () => {
		const relay = new FakeNtfy();
		const d = device(relay, undefined, { 'n.md': '---\nsegreto: 1\n---\nriga %%nota%%\n' });
		await d.store.load();
		wire(relay, [d.server]);
		const day = Date.now() + 86400_000;
		const r = await d.store.create('n.md', 'Nota', {
			expires: Date.now() + 7 * 86400_000,
			profiles: [P({ label: 'Modifica', canEdit: true, maxUses: 1, password: 'scrivi' }), P({ label: 'Lettura', password: 'leggi', expires: day })],
		});
		// no profile without password: the reader is asked for one
		expect(await code(open(relay, r.url))).toBe('password');
		expect(await code(open(relay, r.url, 'altro'))).toBe('password');

		const reader = await open(relay, r.url, 'leggi');
		expect(reader.note).toMatchObject({ profile: 'Lettura', canEdit: false, left: null, expires: day });
		expect(reader.note.md).not.toContain('nota');
		expect(reader.save).toBeUndefined();
		expect((await read(relay, r.url, 'leggi')).profile).toBe('Lettura');

		const editor = await open(relay, r.url, 'scrivi');
		expect(editor.note).toMatchObject({ profile: 'Modifica', canEdit: true, left: 0 });
		// editors get the body as it is (comments included), never the properties
		expect(editor.note.md).toBe('riga %%nota%%\n');
		expect(await code(open(relay, r.url, 'scrivi'))).toBe('exhausted');
		// the opening used up still allows saving
		const saved = await editor.save!(editor.note.md, 'riga %%nota%%\nnuova\n');
		expect(saved).toEqual({ text: 'riga %%nota%%\nnuova\n', merged: false });
		expect(d.files['n.md']).toBe('---\nsegreto: 1\n---\nriga %%nota%%\nnuova\n');
		// the reading profile still works
		expect((await read(relay, r.url, 'leggi')).md).toContain('nuova');

		// expired profile: stops opening and saving
		await d.store.update(r.id, { profiles: r.profiles.map((p) => ({ id: p.id, label: p.label, canEdit: p.canEdit, maxUses: p.maxUses, expires: Date.now() - 1 })) });
		expect(await code(open(relay, r.url, 'leggi'))).toBe('expired');
		expect(await code(editor.save!('x', 'y'))).toBe('expired');
	}, 30_000);

	it('changes are merged with what changed meanwhile; clashes and forged requests are refused', async () => {
		const relay = new FakeNtfy();
		const d = device(relay, undefined, { 'n.md': 'uno\ndue\ntre\n' });
		await d.store.load();
		wire(relay, [d.server]);
		const r = await d.store.create('n.md', 'Nota', { expires: null, profiles: [P({ label: 'Modifica', canEdit: true, password: 'w' }), P()] });
		const ed = await open(relay, r.url, 'w');
		const base = ed.note.md;
		// the owner changes the first line (e.g. offline, synced later)
		d.files['n.md'] = 'UNO\ndue\ntre\n';
		expect(await ed.save!(base, 'uno\ndue\nTRE\n')).toEqual({ text: 'UNO\ndue\nTRE\n', merged: true });
		expect(d.files['n.md']).toBe('UNO\ndue\nTRE\n');
		// same line changed on both sides: the editor gets the current text
		d.files['n.md'] = 'UNO\ndue!\nTRE\n';
		let err: unknown;
		try {
			await ed.save!('UNO\ndue\nTRE\n', 'UNO\ndue?\nTRE\n');
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ConflictError);
		expect((err as ConflictError).current).toBe('UNO\ndue!\nTRE\n');
		expect(d.files['n.md']).toBe('UNO\ndue!\nTRE\n');

		// a reading profile cannot save, a forged session neither
		const l = decodeLive(fragmentOf(r.url));
		const keys = liveKeys(l.secret);
		const k1r = await liveK1(l.secret, '');
		const k1w = await liveK1(l.secret, 'w', l.log2m, l.t);
		const ask = async (k1: Uint8Array, session: string) => {
			const q = makeRequest(keys, k1, { session, edit: { base: 'UNO\ndue!\nTRE\n', text: 'rotto' } });
			await new Relay(relay.base, relay.http).publish(keys.topic, q.body);
			await new Promise((res) => setTimeout(res, 100));
			const replies = relay.msgs.filter((m) => m.topic === q.replyTopic);
			expect(replies).toHaveLength(1);
			return code(Promise.resolve().then(() => openResponse(keys, k1, q.nonce, replies[0].body)));
		};
		expect(await ask(k1r, '')).toBe('readonly');
		expect(await ask(k1w, '')).toBe('session');
		expect(await ask(k1w, makeSession(randomBytes(32), r.profiles[0].id, 'n', Date.now() + 1000))).toBe('session');
		expect(d.files['n.md']).toBe('UNO\ndue!\nTRE\n');
	}, 30_000);

	it('with two devices online only one applies a change', async () => {
		const relay = new FakeNtfy();
		const files: Files = { 'n.md': 'a\n' };
		const a = device(relay, undefined, files, () => 0);
		const b = device(relay, undefined, files, () => 150);
		await a.store.load();
		await b.store.load();
		const r = await a.store.create('n.md', 'Nota', { expires: null, profiles: [P({ canEdit: true })] });
		const reg = sharedList();
		await a.store.syncWith(reg);
		await b.store.syncWith(reg);
		let applied = 0;
		for (const dev of [a, b]) {
			const host = (dev.server as any).host;
			const orig = host.applyEdit;
			host.applyEdit = (...x: unknown[]) => (applied++, orig(...x));
		}
		wire(relay, [a.server, b.server]);
		const ed = await open(relay, r.url);
		expect(await ed.save!('a\n', 'a\nb\n')).toEqual({ text: 'a\nb\n', merged: false });
		await new Promise((res) => setTimeout(res, 400));
		expect(applied).toBe(1);
		expect(files['n.md']).toBe('a\nb\n');
	}, 30_000);

	it('missing passwords are not counted as wrong guesses; ten wrong ones pause the link', async () => {
		const relay = new FakeNtfy();
		const d = device(relay, undefined, { 'n.md': 'x' });
		await d.store.load();
		wire(relay, [d.server]);
		const r = await d.store.create('n.md', 'Nota', { expires: null, profiles: [P({ password: 'giusta' })] });
		for (let i = 0; i < 12; i++) expect(await code(open(relay, r.url))).toBe('password');
		expect((await read(relay, r.url, 'giusta')).md).toContain('x');
		const l = decodeLive(fragmentOf(r.url));
		const keys = liveKeys(l.secret);
		for (let i = 0; i < 10; i++) await new Relay(relay.base, relay.http).publish(keys.topic, makeRequest(keys, randomBytes(32)).body);
		await new Promise((res) => setTimeout(res, 50));
		expect(await code(open(relay, r.url, 'giusta'))).toBe('locked');
	}, 30_000);

	it('limits openings per profile, also when two devices answer together, and the count can be reset', async () => {
		const relay = new FakeNtfy();
		const a = device(relay, undefined, { 'n.md': 'nota' });
		const b = device(relay, undefined, { 'n.md': 'nota' });
		await a.store.load();
		await b.store.load();
		const r = await a.store.create('n.md', 'Nota', { expires: null, profiles: [P({ maxUses: 2 }), P({ label: 'Altro', password: 'p' })] });
		const reg = sharedList();
		await a.store.syncWith(reg);
		await b.store.syncWith(reg);
		wire(relay, [a.server, b.server]);
		const results = await Promise.all([0, 1, 2, 3].map(() => code(open(relay, r.url))));
		expect(results.filter((x) => x === 'ok').length).toBe(2);
		expect(results.filter((x) => x === 'exhausted').length).toBe(2);
		// the other profile has its own count
		expect((await read(relay, r.url, 'p')).profile).toBe('Altro');
		await a.store.syncWith(reg);
		await b.store.syncWith(reg);
		expect(a.store.get(r.id)!.profiles[0].grants.length).toBe(2);
		expect(await code(open(relay, r.url))).toBe('exhausted');
		await new Promise((res) => setTimeout(res, 2100)); // the relay counts in seconds
		await a.store.update(r.id, { reset: [r.profiles[0].id] });
		await a.store.syncWith(reg);
		await b.store.syncWith(reg);
		expect((await read(relay, r.url)).left).toBe(1);
	}, 30_000);

	it('nobody online: the reader is told so', async () => {
		const relay = new FakeNtfy();
		const d = device(relay, undefined, { 'n.md': 'x' });
		await d.store.load();
		const r = await d.store.create('n.md', 'Nota', { expires: null, profiles: [P()] });
		expect(await code(open(relay, r.url, '', 200))).toBe('offline');
	});
});
