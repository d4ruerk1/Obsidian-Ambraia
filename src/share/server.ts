import { checkSession, liveK1, liveKeys, makeResponse, makeSession, MAX_LIVE_BYTES, openEdit, openRequest, proofMatches, LiveAnswer, OpenedRequest, unb64u, b64u } from './format';
import { Relay, RelayHttp, RelayMessage } from './relay';
import { ShareProfile, ShareRecord, ShareStore, profileState, shareState } from './store';

/**
 * Answers shared links while Obsidian is open on this device. Any device of the vault that has the
 * link (directly or through the encrypted device list) can answer; the openings are counted in the
 * same order on every device, so a limit holds even when two devices answer together, and only
 * one device applies each change sent by an editing profile.
 */

export interface ServerHost {
	/** What a profile receives: the note for reading, or its body for editing (null: gone). */
	read(path: string, forEdit: boolean): Promise<string | null>;
	/** Applies a change made on `base`; merged with what changed in the meantime. */
	applyEdit(path: string, base: string, text: string): Promise<{ text: string; merged: boolean } | 'conflict' | null>;
	http: RelayHttp;
	/** WebSocket class (tests pass a fake or null). */
	socket?: typeof WebSocket | null;
	/** Wait before applying a change, so that only one device applies it (ms). */
	saveDelay?(): number;
}

/** Requests older than this are not answered (the reader gave up long ago). */
const MAX_AGE = 3 * 60_000;
/** Wrong passwords tolerated per link in WINDOW before the link pauses for WINDOW. */
const MAX_FAILS = 10;
const WINDOW = 15 * 60_000;
/** An editing session lasts at most this long after opening. */
const SESSION = 12 * 3600_000;

interface Watch {
	rec: ShareRecord;
	topic: string;
}

export class LiveServer {
	private subs: { close(): void }[] = [];
	private handled = new Set<string>();
	private fails = new Map<string, number[]>();
	private key = '';
	private running = false;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private store: ShareStore,
		private host: ServerHost,
	) {}

	start() {
		this.running = true;
		this.refresh();
	}

	stop() {
		this.running = false;
		for (const s of this.subs) s.close();
		this.subs = [];
		this.key = '';
	}

	/** Re-subscribes when the set of links changes. */
	refresh() {
		if (!this.running) return;
		const watches = this.watches();
		const key = watches
			.map((w) => `${w.rec.relay}|${w.topic}`)
			.sort()
			.join(',');
		if (key === this.key) return;
		for (const s of this.subs) s.close();
		this.subs = [];
		this.key = key;
		const byRelay = new Map<string, Watch[]>();
		for (const w of watches) byRelay.set(w.rec.relay, [...(byRelay.get(w.rec.relay) ?? []), w]);
		for (const [base, list] of byRelay) {
			const relay = new Relay(base, this.host.http);
			// topics in groups (a subscription URL stays short)
			for (let i = 0; i < list.length; i += 40) {
				const topics = list.slice(i, i + 40).map((w) => w.topic);
				this.subs.push(relay.subscribe(topics, (m) => this.enqueue(relay, m), { since: '5m', socket: this.host.socket }));
			}
		}
	}

	private enqueue(relay: Relay, m: RelayMessage) {
		this.queue = this.queue.then(() => this.onMessage(relay, m)).catch(() => undefined);
	}

	private watches(): Watch[] {
		const out: Watch[] = [];
		for (const rec of this.store.live()) {
			const secret = unb64u(rec.secret ?? '');
			if (!secret || secret.length !== 32 || !rec.relay) continue;
			out.push({ rec, topic: liveKeys(secret).topic });
		}
		return out;
	}

	/** One message from the relay: a request for one of the links of this vault. */
	async onMessage(relay: Relay, m: RelayMessage) {
		if (this.handled.has(m.id)) return;
		this.handled.add(m.id);
		if (this.handled.size > 5000) this.handled.clear();
		if (Date.now() - m.time * 1000 > MAX_AGE) return;
		const w = this.watches().find((x) => x.topic === m.topic && x.rec.relay === relay.base);
		if (!w) return;
		const body = await relay.body(m);
		if (!body) return;
		const secret = unb64u(w.rec.secret)!;
		const keys = liveKeys(secret);
		const req = openRequest(keys, body);
		if (!req) return; // not made with this link: nothing to say
		if (Math.abs(req.at - m.time * 1000) > MAX_AGE) return;
		// the record may have changed while waiting
		const rec = this.store.live().find((r) => r.id === w.rec.id);
		if (!rec) return;
		const profile = rec.profiles.find((p) => proofMatches(unb64u(p.k1)!, req)) ?? null;
		if (req.op === 'save' && profile) {
			// one device applies a change: the others see the answer already given and stay quiet
			await new Promise((r) => setTimeout(r, this.host.saveDelay?.() ?? 300 + Math.random() * 2500));
			try {
				const since = String(Math.floor(Date.now() / 1000) - 600);
				if ((await relay.poll([req.replyTopic], since)).length) return;
			} catch {
				/* the relay is busy: answer anyway */
			}
		}
		const answer = await this.decide(relay, rec, profile, req, m, secret);
		await relay.publish(req.replyTopic, makeResponse(keys, profile && !('error' in answer && answer.error !== 'conflict') ? unb64u(profile.k1)! : null, req.nonce, answer));
	}

	private async decide(relay: Relay, rec: ShareRecord, p: ShareProfile | null, req: OpenedRequest, m: RelayMessage, secret: Uint8Array): Promise<LiveAnswer> {
		const state = shareState(rec);
		if (state) return { error: state };
		const now = Date.now();
		const recent = (this.fails.get(rec.id) ?? []).filter((t) => now - t < WINDOW);
		if (recent.length >= MAX_FAILS) return { error: 'locked' };
		if (!p) {
			// the reader first asks without a password: that is not a wrong guess
			if (!proofMatches(await liveK1(secret, ''), req)) this.fails.set(rec.id, [...recent, now]);
			return { error: 'password' };
		}
		return req.op === 'save' ? this.save(rec, p, req) : this.open(relay, rec, p, req, m);
	}

	private async open(relay: Relay, rec: ShareRecord, p: ShareProfile, req: OpenedRequest, m: RelayMessage): Promise<LiveAnswer> {
		const n = b64u(req.nonce);
		const already = p.grants.some((g) => g.n === n);
		const st = profileState(rec, p);
		if (st && !(st === 'exhausted' && already)) return { error: st };
		if (!already && p.maxUses != null) {
			const rank = await this.rank(relay, rec, p, n, m);
			if (rank >= p.maxUses) return { error: 'exhausted' };
		}
		const md = await this.host.read(rec.path, p.canEdit);
		if (md === null) return { error: 'gone' };
		if (new TextEncoder().encode(md).length > MAX_LIVE_BYTES) return { error: 'too-large' };
		if (!already) this.store.recordGrant(rec.id, p.id, { n, at: m.time * 1000 });
		const used = p.grants.length + (already ? 0 : 1);
		const until = Math.min(Date.now() + SESSION, p.expires ?? Infinity, rec.expires ?? Infinity);
		return {
			note: {
				title: rec.title,
				md,
				created: rec.created,
				expires: Math.min(p.expires ?? Infinity, rec.expires ?? Infinity) === Infinity ? null : Math.min(p.expires ?? Infinity, rec.expires ?? Infinity),
				left: p.maxUses != null ? Math.max(0, p.maxUses - used) : null,
				canEdit: p.canEdit,
				profile: p.label,
				session: p.canEdit ? makeSession(unb64u(rec.skey)!, p.id, n, until) : '',
			},
		};
	}

	private async save(rec: ShareRecord, p: ShareProfile, req: OpenedRequest): Promise<LiveAnswer> {
		if (!p.canEdit) return { error: 'readonly' };
		const s = checkSession(unb64u(rec.skey)!, req.session);
		if (!s || s.profile !== p.id) return { error: 'session' };
		// a profile that expired or was revoked stops editing too (used-up openings do not)
		const st = profileState(rec, p);
		if (st && st !== 'exhausted') return { error: st };
		const edit = openEdit(unb64u(p.k1)!, req);
		if (!edit) return { error: 'corrupt' };
		if (new TextEncoder().encode(edit.text).length > MAX_LIVE_BYTES) return { error: 'too-large' };
		const r = await this.host.applyEdit(rec.path, edit.base, edit.text);
		if (r === null) return { error: 'gone' };
		if (r === 'conflict') return { error: 'conflict', text: (await this.host.read(rec.path, true)) ?? '' };
		return { saved: r };
	}

	/**
	 * Position of an opening among those of a profile with a limit: openings already counted
	 * first, then the valid requests still cached on the relay in the relay's own order. Every
	 * device computes the same position, so two devices never let in more readers than allowed.
	 */
	private async rank(relay: Relay, rec: ShareRecord, p: ShareProfile, n: string, m: RelayMessage): Promise<number> {
		const order = p.grants.map((g) => g.n);
		const keys = liveKeys(unb64u(rec.secret)!);
		const k1 = unb64u(p.k1)!;
		const since = Math.floor(Math.max(rec.created, p.resetAt ?? 0, Date.now() - 12 * 3600_000) / 1000);
		let cached: RelayMessage[] = [];
		try {
			cached = await relay.poll([keys.topic], String(since));
		} catch {
			cached = [];
		}
		if (!cached.some((c) => c.id === m.id)) cached.push(m);
		for (const c of cached) {
			if (c.time * 1000 < (p.resetAt ?? 0) - 1000) continue;
			// requests nobody could answer in time (all devices offline) do not take a place
			if (c.id !== m.id && Date.now() - c.time * 1000 > MAX_AGE) continue;
			const b = await relay.body(c.id === m.id ? m : c);
			const r = b ? openRequest(keys, b) : null;
			if (!r || r.op !== 'open' || !proofMatches(k1, r)) continue;
			const id = b64u(r.nonce);
			if (!order.includes(id)) order.push(id);
		}
		const i = order.indexOf(n);
		return i < 0 ? order.length : i;
	}
}
