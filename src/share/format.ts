import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Format of Ambraia's shared links ("c2…"). Used both by the plugin and by the static viewer page,
 * so it imports nothing from Obsidian.
 *
 * The link keeps only a 256-bit secret in the URL fragment (after "#"): browsers never send the
 * fragment to a server, so neither the page that shows the note nor the relay can read anything.
 * Whoever opens the link posts an encrypted request through a relay (ntfy protocol); any of the
 * owner's devices that is online finds the matching profile (each profile of a link has its own
 * password, rights, expiry and number of openings), checks it, and answers with the current note
 * encrypted for that request. Profiles that may edit get a session token to send changes back,
 * which the device merges line by line with the current note.
 */

export const ARGON = { log2m: 15, t: 3 } as const; // 32 MiB, 3 passes (above OWASP's minimum)
export const DEFAULT_RELAY = 'https://ntfy.sh';
/** Largest note served by a live link (the relay accepts 2 MB attachments). */
export const MAX_LIVE_BYTES = 1_400_000;

const te = new TextEncoder();
const td = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
	const b = new Uint8Array(n);
	globalThis.crypto.getRandomValues(b);
	return b;
}

export function b64u(b: Uint8Array): string {
	let s = '';
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
	try {
		const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

const cat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};

const kdf = (ikm: Uint8Array, info: string, len = 32, salt?: Uint8Array) => hkdf(sha256, ikm, salt, te.encode(info), len);

/** Constant-time comparison of two byte arrays. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
	return d === 0;
}

export async function passwordKey(password: string, salt: Uint8Array, log2m: number, t: number): Promise<Uint8Array> {
	if (log2m < 10 || log2m > 18 || t < 1 || t > 10) throw new ShareError('corrupt');
	return argon2idAsync(te.encode(password.normalize('NFC')), salt, { m: 2 ** log2m, t, p: 1, dkLen: 32, asyncTick: 20 });
}

export type ShareFailure = 'corrupt' | 'password' | 'expired' | 'notyet' | 'revoked' | 'exhausted' | 'gone' | 'locked' | 'too-large' | 'offline' | 'unsupported' | 'readonly' | 'session' | 'conflict';

export class ShareError extends Error {
	constructor(public code: ShareFailure) {
		super(code);
		this.name = 'ShareError';
	}
}

/** Shared content: plain Markdown and a title. Never HTML. */
export interface SharedNote {
	title: string;
	md: string;
	created: number;
	expires: number | null;
	/** openings left after this one for the profile (null = unlimited) */
	left?: number | null;
	/** the profile may send changes back */
	canEdit?: boolean;
	/** name of the profile (shown to the reader) */
	profile?: string;
	/** token for sending changes (editing profiles only) */
	session?: string;
}

// ------------------------------------------------------------------ live links

const LIVE_V = 3;
const F_RELAY = 1;

export interface LiveLink {
	secret: Uint8Array;
	relay: string;
	log2m: number;
	t: number;
}

/** Keys and names derived from the secret of a link. */
export interface LiveKeys {
	/** request/refusal key for everyone who has the link */
	k0: Uint8Array;
	/** topic where requests are posted */
	topic: string;
	/** Argon2id salt of the passwords */
	salt: Uint8Array;
}

export function liveKeys(secret: Uint8Array): LiveKeys {
	return {
		k0: kdf(secret, 'ambraia live k0'),
		topic: 'a' + b64u(kdf(secret, 'ambraia live topic', 18)),
		salt: kdf(secret, 'ambraia live salt', 16),
	};
}

/** Key of a profile: only those who know its password (or everyone, without one) can derive it. */
export async function liveK1(secret: Uint8Array, password: string, log2m: number = ARGON.log2m, t: number = ARGON.t): Promise<Uint8Array> {
	const pk = password ? await passwordKey(password, liveKeys(secret).salt, log2m, t) : new Uint8Array(32);
	return kdf(cat(secret, pk), 'ambraia live k1');
}

export function encodeLive(l: LiveLink): string {
	const custom = l.relay && l.relay.replace(/\/+$/, '') !== DEFAULT_RELAY;
	const relay = custom ? te.encode(l.relay.replace(/\/+$/, '')) : new Uint8Array(0);
	return 'c2' + b64u(cat(new Uint8Array([LIVE_V, custom ? F_RELAY : 0, l.log2m, l.t]), l.secret, relay));
}

export function decodeLive(frag: string): LiveLink {
	if (!frag.startsWith('c2')) throw new ShareError(frag.startsWith('c1') || frag.startsWith('s1') ? 'unsupported' : 'corrupt');
	const b = unb64u(frag.slice(2));
	if (!b || b.length < 36 || b[0] !== LIVE_V) throw new ShareError('corrupt');
	const relay = b[1] & F_RELAY ? td.decode(b.subarray(36)) : DEFAULT_RELAY;
	if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(relay)) throw new ShareError('corrupt');
	return { secret: b.slice(4, 36), relay, log2m: b[2], t: b[3] };
}

const respTopic = (k0: Uint8Array, n: Uint8Array) => 'a' + b64u(kdf(k0, 'ambraia live resp', 18, n));
const proofOf = (k1: Uint8Array, n: Uint8Array) => hmac(sha256, k1, cat(te.encode('proof'), n));
const editKey = (k1: Uint8Array, n: Uint8Array) => kdf(k1, 'ambraia live edit', 32, n);

/** A change sent by an editing profile: the text it started from and the new text. */
export interface LiveEdit {
	base: string;
	text: string;
}

/** What a reader posts: proves knowledge of the link (k0) and of a profile key (k1). */
export function makeRequest(
	keys: LiveKeys,
	k1: Uint8Array,
	opts: { session?: string; edit?: LiveEdit } = {},
	nonce = randomBytes(16),
	now = Date.now(),
): { body: string; nonce: Uint8Array; replyTopic: string } {
	const iv = randomBytes(24);
	const o: Record<string, unknown> = { n: b64u(nonce), p: b64u(proofOf(k1, nonce)), at: now, op: opts.edit ? 'save' : 'open' };
	if (opts.edit) {
		const eiv = randomBytes(24);
		o.s = opts.session ?? '';
		o.e = b64u(cat(eiv, xchacha20poly1305(editKey(k1, nonce), eiv, te.encode('e1')).encrypt(te.encode(JSON.stringify({ b: opts.edit.base, m: opts.edit.text })))));
	}
	const ct = xchacha20poly1305(keys.k0, iv, te.encode('q2')).encrypt(te.encode(JSON.stringify(o)));
	return { body: 'q2' + b64u(cat(iv, ct)), nonce, replyTopic: respTopic(keys.k0, nonce) };
}

export interface OpenedRequest {
	nonce: Uint8Array;
	proof: Uint8Array;
	at: number;
	op: 'open' | 'save';
	session: string;
	/** encrypted change (save requests), readable with the profile key */
	edit: Uint8Array | null;
	replyTopic: string;
}

/** Largest request accepted (a change carries the note twice, base64 encoded). */
const MAX_REQUEST = Math.ceil(MAX_LIVE_BYTES * 2 * 1.4) + 4096;

/** Device side: null for anything that was not made with this link. */
export function openRequest(keys: LiveKeys, body: string): OpenedRequest | null {
	if (typeof body !== 'string' || !body.startsWith('q2') || body.length > MAX_REQUEST) return null;
	const b = unb64u(body.slice(2).trim());
	if (!b || b.length < 24 + 16) return null;
	try {
		const pt = xchacha20poly1305(keys.k0, b.subarray(0, 24), te.encode('q2')).decrypt(b.subarray(24));
		const o = JSON.parse(td.decode(pt)) as { n?: string; p?: string; at?: number; op?: string; s?: string; e?: string };
		const n = unb64u(String(o.n ?? ''));
		const p = unb64u(String(o.p ?? ''));
		if (!n || n.length !== 16 || !p || typeof o.at !== 'number') return null;
		const op = o.op === 'save' ? 'save' : 'open';
		const edit = op === 'save' ? unb64u(String(o.e ?? '')) : null;
		if (op === 'save' && (!edit || edit.length < 24 + 16)) return null;
		return { nonce: n, proof: p, at: o.at, op, session: typeof o.s === 'string' ? o.s : '', edit, replyTopic: respTopic(keys.k0, n) };
	} catch {
		return null;
	}
}

/** True when the request was made with this profile key. */
export function proofMatches(k1: Uint8Array, req: OpenedRequest): boolean {
	return sameBytes(req.proof, proofOf(k1, req.nonce));
}

/** Device side: the change of a save request, once the profile is known. */
export function openEdit(k1: Uint8Array, req: OpenedRequest): LiveEdit | null {
	if (!req.edit) return null;
	try {
		const o = JSON.parse(td.decode(xchacha20poly1305(editKey(k1, req.nonce), req.edit.subarray(0, 24), te.encode('e1')).decrypt(req.edit.subarray(24)))) as { b?: unknown; m?: unknown };
		return typeof o.b === 'string' && typeof o.m === 'string' ? { base: o.b, text: o.m } : null;
	} catch {
		return null;
	}
}

export type LiveAnswer = { note: SharedNote } | { saved: { text: string; merged: boolean } } | { error: ShareFailure; text?: string };

/** Device side: the note / the saved text (encrypted with k1, only for this request) or a refusal (with k0). */
export function makeResponse(keys: LiveKeys, k1: Uint8Array | null, nonce: Uint8Array, r: LiveAnswer): string {
	const iv = randomBytes(24);
	const ok = !('error' in r) && !!k1;
	const key = ok ? kdf(k1!, 'ambraia live answer', 32, nonce) : keys.k0;
	let body: Record<string, unknown>;
	if ('note' in r) body = { t: r.note.title, m: r.note.md, c: r.note.created, e: r.note.expires, l: r.note.left ?? null, w: !!r.note.canEdit, p: r.note.profile ?? '', s: r.note.session ?? '' };
	else if ('saved' in r) body = { saved: 1, m: r.saved.text, mg: r.saved.merged };
	else body = { err: r.error };
	// a conflict tells the editor the current text: only with the profile key
	if ('error' in r && r.error === 'conflict' && k1 && r.text !== undefined) {
		const k = kdf(k1, 'ambraia live answer', 32, nonce);
		const ct = xchacha20poly1305(k, iv, cat(te.encode('r2'), nonce)).encrypt(te.encode(JSON.stringify({ err: 'conflict', m: r.text })));
		return 'r2' + b64u(cat(new Uint8Array([2]), iv, ct));
	}
	const ct = xchacha20poly1305(key, iv, cat(te.encode('r2'), nonce)).encrypt(te.encode(JSON.stringify(body)));
	return 'r2' + b64u(cat(new Uint8Array([ok ? 1 : 0]), iv, ct));
}

export class ConflictError extends ShareError {
	constructor(public current: string) {
		super('conflict');
	}
}

/** Reader side: the note or the saved text, or throws the device's refusal. */
export function openResponse(keys: LiveKeys, k1: Uint8Array, nonce: Uint8Array, body: string): SharedNote | { saved: string; merged: boolean } {
	if (typeof body !== 'string' || !body.startsWith('r2')) throw new ShareError('corrupt');
	const b = unb64u(body.trim().slice(2));
	if (!b || b.length < 1 + 24 + 16) throw new ShareError('corrupt');
	const ok = b[0] === 1 || b[0] === 2;
	const key = ok ? kdf(k1, 'ambraia live answer', 32, nonce) : keys.k0;
	let o: { t?: unknown; m?: unknown; c?: unknown; e?: unknown; l?: unknown; w?: unknown; p?: unknown; s?: unknown; err?: unknown; saved?: unknown; mg?: unknown };
	try {
		o = JSON.parse(td.decode(xchacha20poly1305(key, b.subarray(1, 25), cat(te.encode('r2'), nonce)).decrypt(b.subarray(25))));
	} catch {
		throw new ShareError('corrupt');
	}
	if (b[0] === 2) throw new ConflictError(typeof o.m === 'string' ? o.m : '');
	if (!ok) {
		const known: ShareFailure[] = ['password', 'expired', 'notyet', 'revoked', 'exhausted', 'gone', 'locked', 'too-large', 'readonly', 'session', 'conflict'];
		throw new ShareError(known.includes(o.err as ShareFailure) ? (o.err as ShareFailure) : 'corrupt');
	}
	if (typeof o.m !== 'string') throw new ShareError('corrupt');
	if (o.saved) return { saved: o.m, merged: !!o.mg };
	return {
		title: typeof o.t === 'string' ? o.t : '',
		md: o.m,
		created: Number(o.c) || 0,
		expires: typeof o.e === 'number' ? o.e : null,
		left: typeof o.l === 'number' ? o.l : null,
		canEdit: o.w === true,
		profile: typeof o.p === 'string' ? o.p : '',
		session: typeof o.s === 'string' ? o.s : '',
	};
}

// ------------------------------------------------------------------ sessions of editing profiles

/** Token given to an editing profile at opening; any device of the vault can check it. */
export function makeSession(skey: Uint8Array, profile: string, nonce: string, until: number): string {
	const payload = b64u(te.encode(JSON.stringify({ p: profile, n: nonce, x: until })));
	return payload + '.' + b64u(hmac(sha256, skey, te.encode('session|' + payload)));
}

export function checkSession(skey: Uint8Array, token: string, now = Date.now()): { profile: string; nonce: string; until: number } | null {
	const [payload, sig] = String(token).split('.');
	const s = unb64u(sig ?? '');
	if (!payload || !s || !sameBytes(s, hmac(sha256, skey, te.encode('session|' + payload)))) return null;
	try {
		const o = JSON.parse(td.decode(unb64u(payload)!)) as { p?: unknown; n?: unknown; x?: unknown };
		if (typeof o.p !== 'string' || typeof o.n !== 'string' || typeof o.x !== 'number' || o.x < now) return null;
		return { profile: o.p, nonce: o.n, until: o.x };
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------ links

/** Fragment of a link (accepts the whole URL or only the part after "#"). */
export function fragmentOf(link: string): string {
	const s = link.trim();
	const i = s.indexOf('#');
	return (i >= 0 ? s.slice(i + 1) : s).trim();
}

export const isLink = (frag: string): boolean => frag.startsWith('c2');

export function buildUrl(viewer: string, frag: string): string {
	const base = viewer.replace(/#.*$/, '');
	return `${base}${base.endsWith('/') || base.includes('?') || /\.html?$/.test(base) ? '' : '/'}#${frag}`;
}
