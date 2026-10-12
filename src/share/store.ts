import type { App } from 'obsidian';
import { ensureStateDir, stateDir } from '../storage';
import { openWithKey, randomKey, sealWithKey, b64, unb64 } from '../sync/crypto';
import { ARGON, b64u, buildUrl, encodeLive, liveK1, randomBytes, unb64u } from './format';

/**
 * Shared links created in this vault. Kept on the device in an encrypted file (key in the
 * keychain) and, when a cloud service is connected, also in its end-to-end encrypted device list,
 * so every linked device can manage the links and answer them.
 *
 * A link has one or more profiles. Each profile has its own password (at most one profile has
 * none), rights (read or edit), number of openings and expiry, never beyond the link's own.
 */
export interface ShareGrant {
	/** request nonce (base64url) */
	n: string;
	/** time of the request on the relay (ms) */
	at: number;
}

export interface ShareProfile {
	id: string;
	label: string;
	/** key derived from secret and password: devices never store the password itself */
	k1: string;
	password: boolean;
	canEdit: boolean;
	/** openings allowed (null = no limit) */
	maxUses: number | null;
	/** null = until the link expires */
	expires: number | null;
	grants: ShareGrant[];
	/** openings counted before this time no longer count (counter reset) */
	resetAt?: number;
	lastOpened?: number;
}

export interface ShareRecord {
	id: string;
	path: string;
	title: string;
	created: number;
	updated: number;
	/** name of the device that created it */
	by: string;
	expires: number | null;
	revoked: boolean;
	deleted: boolean;
	url: string;
	secret: string;
	relay: string;
	log2m: number;
	t: number;
	/** key of the session tokens of editing profiles */
	skey: string;
	profiles: ShareProfile[];
}

/** Settings of a profile, as entered by the user. */
export interface ProfileInput {
	id?: string;
	label: string;
	/** undefined = keep the current password, '' = no password */
	password?: string;
	canEdit: boolean;
	maxUses: number | null;
	expires: number | null;
}

const FILE = 'shares.bin';
const KEY_ID = 'ambraia-shares-key';
/** Deleted links are remembered this long, so that every device learns about the deletion. */
const TOMBSTONE_TTL = 45 * 86400_000;

export class DuplicatePasswordError extends Error {
	constructor() {
		super('two profiles with the same password');
		this.name = 'DuplicatePasswordError';
	}
}

const hexId = (n: number) => Array.from(randomBytes(n), (x) => x.toString(16).padStart(2, '0')).join('');

export function usesOf(p: ShareProfile): number {
	return p.grants?.length ?? 0;
}

/** Why a link does not open any more (null: it works). */
export function shareState(r: ShareRecord, now = Date.now()): 'revoked' | 'expired' | null {
	if (r.revoked || r.deleted) return 'revoked';
	if (r.expires && now > r.expires) return 'expired';
	return null;
}

/** Why a profile does not open any more (null: it works). */
export function profileState(r: ShareRecord, p: ShareProfile, now = Date.now()): 'revoked' | 'expired' | 'exhausted' | null {
	const s = shareState(r, now);
	if (s) return s;
	if (p.expires && now > p.expires) return 'expired';
	if (p.maxUses != null && usesOf(p) >= p.maxUses) return 'exhausted';
	return null;
}

function mergeGrants(a: ShareGrant[] = [], b: ShareGrant[] = [], resetAt = 0): ShareGrant[] {
	const grants = new Map<string, ShareGrant>();
	for (const g of [...a, ...b]) {
		if (!g || typeof g.n !== 'string') continue;
		const cur = grants.get(g.n);
		if (!cur || g.at < cur.at) grants.set(g.n, g);
	}
	return [...grants.values()].filter((g) => g.at >= resetAt).sort((x, y) => x.at - y.at || x.n.localeCompare(y.n));
}

/** Newer settings win; openings are merged, so no device can lose a count of another one. */
export function mergeShare(a: ShareRecord, b: ShareRecord): ShareRecord {
	const newer = b.updated > a.updated ? b : a;
	const older = newer === a ? b : a;
	const profiles = newer.profiles.map((p) => {
		const o = older.profiles.find((x) => x.id === p.id);
		if (!o) return p;
		const resetAt = Math.max(p.resetAt ?? 0, o.resetAt ?? 0);
		const out: ShareProfile = { ...p, grants: mergeGrants(p.grants, o.grants, resetAt) };
		if (resetAt) out.resetAt = resetAt;
		const last = Math.max(p.lastOpened ?? 0, o.lastOpened ?? 0);
		if (last) out.lastOpened = last;
		return out;
	});
	return { ...newer, profiles };
}

function validRecord(r: unknown): r is ShareRecord {
	if (!r || typeof r !== 'object') return false;
	const x = r as ShareRecord;
	return (
		typeof x.id === 'string' &&
		/^[a-f0-9]{16}$/.test(x.id) &&
		typeof x.path === 'string' &&
		typeof x.updated === 'number' &&
		typeof x.url === 'string' &&
		typeof x.secret === 'string' &&
		typeof x.skey === 'string' &&
		Array.isArray(x.profiles) &&
		x.profiles.every((p) => p && typeof p.id === 'string' && typeof p.k1 === 'string' && Array.isArray(p.grants))
	);
}

export interface StoreHost {
	app: App;
	viewerUrl(): string;
	relayUrl(): string;
	deviceName(): string;
	/** Argon2id cost of new links (tests use a cheap one). */
	argon?(): { log2m: number; t: number };
}

export class ShareStore {
	private records = new Map<string, ShareRecord>();
	private listeners: (() => void)[] = [];
	private memKey: Uint8Array | null = null;
	loaded = false;

	constructor(private host: StoreHost) {}

	private get app() {
		return this.host.app;
	}

	onChange(fn: () => void) {
		this.listeners.push(fn);
		return () => (this.listeners = this.listeners.filter((l) => l !== fn));
	}

	private emit() {
		for (const l of this.listeners) l();
	}

	// ---------------------------------------------------------------- persistence

	private key(): Uint8Array {
		try {
			const raw = this.app.secretStorage.getSecret(KEY_ID);
			if (raw) return unb64(raw);
			const k = randomKey();
			this.app.secretStorage.setSecret(KEY_ID, b64(k));
			return k;
		} catch {
			// no keychain: links live for this session only
			return (this.memKey ??= randomKey());
		}
	}

	private get path() {
		return `${stateDir(this.app)}/${FILE}`;
	}

	async load() {
		this.records.clear();
		try {
			const a = this.app.vault.adapter;
			if (await a.exists(this.path)) {
				const raw = JSON.parse(await a.read(this.path)) as { v: number; iv: string; ct: string };
				const list = await openWithKey<ShareRecord[]>(this.key(), raw as never, FILE);
				for (const r of Array.isArray(list) ? list : []) if (validRecord(r)) this.records.set(r.id, r);
			}
		} catch {
			/* unreadable (e.g. keychain reset): start empty */
		}
		this.purge();
		this.loaded = true;
		this.emit();
	}

	private saving: Promise<void> = Promise.resolve();

	save(): Promise<void> {
		this.saving = this.saving.then(async () => {
			try {
				await ensureStateDir(this.app);
				const sealed = await sealWithKey(this.key(), [...this.records.values()], FILE);
				const a = this.app.vault.adapter;
				const tmp = this.path + '.tmp';
				await a.write(tmp, JSON.stringify(sealed));
				if (await a.exists(this.path)) await a.remove(this.path);
				await a.rename(tmp, this.path);
			} catch {
				/* next change saves again */
			}
		});
		return this.saving;
	}

	private purge(now = Date.now()) {
		for (const r of [...this.records.values()]) if (r.deleted && now - r.updated > TOMBSTONE_TTL) this.records.delete(r.id);
	}

	private put(r: ShareRecord) {
		this.records.set(r.id, r);
		void this.save();
		this.emit();
	}

	// ---------------------------------------------------------------- queries

	get(id: string): ShareRecord | null {
		const r = this.records.get(id);
		return r && !r.deleted ? r : null;
	}

	all(): ShareRecord[] {
		return [...this.records.values()].filter((r) => !r.deleted).sort((a, b) => b.created - a.created);
	}

	forPath(path: string): ShareRecord[] {
		return this.all().filter((r) => r.path === path);
	}

	/** Links that devices must answer (deleted links answer "revoked" for a while). */
	live(): ShareRecord[] {
		return [...this.records.values()].filter((r) => r.secret && (!r.deleted || Date.now() - r.updated < 7 * 86400_000));
	}

	// ---------------------------------------------------------------- changes

	/** Profiles from the user's settings: passwords become keys, no two profiles share one. */
	private async buildProfiles(secret: Uint8Array, input: ProfileInput[], cur: ShareProfile[] = [], log2m: number = ARGON.log2m, t: number = ARGON.t): Promise<ShareProfile[]> {
		const out: ShareProfile[] = [];
		for (const p of input) {
			const old = p.id ? cur.find((x) => x.id === p.id) : undefined;
			let k1 = old?.k1;
			let password = old?.password ?? false;
			if (p.password !== undefined || !old) {
				k1 = b64u(await liveK1(secret, p.password ?? '', log2m, t));
				password = !!p.password;
			}
			if (out.some((x) => x.k1 === k1)) throw new DuplicatePasswordError();
			out.push({
				id: old?.id ?? hexId(4),
				label: p.label.trim() || (p.canEdit ? 'Edit' : 'Read'),
				k1: k1!,
				password,
				canEdit: p.canEdit,
				maxUses: p.maxUses,
				expires: p.expires,
				grants: old?.grants ?? [],
				...(old?.resetAt ? { resetAt: old.resetAt } : {}),
				...(old?.lastOpened ? { lastOpened: old.lastOpened } : {}),
			});
		}
		if (!out.length) throw new Error('no profile');
		return out;
	}

	/** New link: only a secret travels, the note is served by the devices of the vault. */
	async create(path: string, title: string, opts: { expires: number | null; profiles: ProfileInput[] }): Promise<ShareRecord> {
		const secret = randomBytes(32);
		const relay = this.host.relayUrl();
		const { log2m, t } = this.host.argon?.() ?? ARGON;
		const url = buildUrl(this.host.viewerUrl(), encodeLive({ secret, relay, log2m, t }));
		const now = Date.now();
		const r: ShareRecord = {
			id: hexId(8),
			path,
			title,
			created: now,
			updated: now,
			by: this.host.deviceName(),
			expires: opts.expires,
			revoked: false,
			deleted: false,
			url,
			secret: b64u(secret),
			relay,
			log2m,
			t,
			skey: b64u(randomBytes(32)),
			profiles: await this.buildProfiles(secret, opts.profiles, [], log2m, t),
		};
		this.put(r);
		return r;
	}

	/** New settings for a link and its profiles (profiles left out are removed). */
	async update(id: string, patch: { expires?: number | null; revoked?: boolean; profiles?: ProfileInput[]; reset?: string[] }) {
		const cur = this.records.get(id);
		if (!cur) throw new Error('unknown link');
		const next: ShareRecord = { ...cur, updated: Date.now() };
		if (patch.expires !== undefined) next.expires = patch.expires;
		if (patch.revoked !== undefined) next.revoked = patch.revoked;
		if (patch.profiles) next.profiles = await this.buildProfiles(unb64u(cur.secret)!, patch.profiles, cur.profiles, cur.log2m, cur.t);
		for (const pid of patch.reset ?? []) next.profiles = next.profiles.map((p) => (p.id === pid ? { ...p, grants: [], resetAt: Date.now() } : p));
		this.put(next);
		return next;
	}

	/** Stops a link at once, for everyone. */
	revoke(id: string) {
		const cur = this.records.get(id);
		if (!cur) return;
		this.put({ ...cur, revoked: true, updated: Date.now() });
	}

	/** Removes a link from the list (and revokes it). */
	remove(id: string) {
		const cur = this.records.get(id);
		if (!cur) return;
		this.put({ ...cur, revoked: true, deleted: true, updated: Date.now() });
	}

	/** A device answered a link: the opening is counted (also on the other devices). */
	recordGrant(id: string, profile: string, g: ShareGrant) {
		const cur = this.records.get(id);
		const p = cur?.profiles.find((x) => x.id === profile);
		if (!cur || !p || p.grants.some((x) => x.n === g.n)) return;
		// the count is not a settings change: "updated" stays, so it never overrides newer settings
		const profiles = cur.profiles.map((x) => (x.id === profile ? { ...x, grants: [...x.grants, g], lastOpened: Math.max(x.lastOpened ?? 0, g.at) } : x));
		this.records.set(id, { ...cur, profiles });
		void this.save();
		this.emit();
	}

	onRename(oldPath: string, newPath: string) {
		for (const r of this.records.values()) if (r.path === oldPath) this.put({ ...r, path: newPath, updated: Date.now() });
	}

	// ---------------------------------------------------------------- cloud copy

	/** Two-way merge with the encrypted copy kept in a device list. */
	async syncWith(list: { readShares(): Promise<unknown[]>; writeShare(id: string, d: unknown): Promise<unknown>; removeShare(id: string): Promise<void> }) {
		if (!this.loaded) return;
		const remote = new Map<string, ShareRecord>();
		for (const r of await list.readShares()) if (validRecord(r)) remote.set(r.id, r);
		let changed = false;
		for (const [id, r] of remote) {
			const mine = this.records.get(id);
			const merged = mine ? mergeShare(mine, r) : r;
			if (!mine || JSON.stringify(merged) !== JSON.stringify(mine)) {
				this.records.set(id, merged);
				changed = true;
			}
		}
		const now = Date.now();
		for (const [id, r] of remote) if (!this.records.has(id) || (r.deleted && now - r.updated > TOMBSTONE_TTL)) await list.removeShare(id);
		for (const [id, r] of this.records) {
			if (r.deleted && now - r.updated > TOMBSTONE_TTL) continue;
			const there = remote.get(id);
			if (!there || JSON.stringify(there) !== JSON.stringify(r)) await list.writeShare(id, r);
		}
		this.purge();
		if (changed) {
			await this.save();
			this.emit();
		}
	}
}
