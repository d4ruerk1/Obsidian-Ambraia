import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { IntegrityError } from './engine';

/** Algorithms offered to the user (all authenticated, 256-bit keys). */
export type Alg = 'aes-gcm' | 'xchacha20' | 'aes-ctr-hmac';
export const ALGS: Alg[] = ['aes-gcm', 'xchacha20', 'aes-ctr-hmac'];
export const ALG_NAMES: Record<Alg, string> = {
	'aes-gcm': 'AES-256-GCM',
	xchacha20: 'XChaCha20-Poly1305',
	'aes-ctr-hmac': 'AES-256-CTR + HMAC-SHA-256',
};
const ALG_ID: Record<Alg, number> = { 'aes-gcm': 1, xchacha20: 2, 'aes-ctr-hmac': 3 };
const NONCE: Record<Alg, number> = { 'aes-gcm': 12, xchacha20: 24, 'aes-ctr-hmac': 16 };

export type KdfType = 'argon2id' | 'pbkdf2';
export type Kdf = { type: 'argon2id'; m: number; t: number; p: number } | { type: 'pbkdf2'; i: number };
export const KDF_DEFAULTS: Record<KdfType, Kdf> = {
	// RFC 9106 second recommendation (64 MiB) / OWASP 2023 for PBKDF2-SHA-256
	argon2id: { type: 'argon2id', m: 65536, t: 3, p: 1 },
	pbkdf2: { type: 'pbkdf2', i: 600000 },
};

export const KEYFILE = '.ambraia-crypt.json';
const MAGIC = [0x4f, 0x42, 0x58, 0x31]; // "OBX1"

export interface Keyfile {
	format: 'ambraia-crypt';
	v: 1;
	alg: Alg;
	names: boolean;
	kdf: Kdf;
	salt: string;
	kid: string;
	wrap: string;
	check: string;
}

export class WrongKeyError extends Error {}

const subtle = () => window.crypto.subtle;
const rnd = (n: number) => window.crypto.getRandomValues(new Uint8Array(n));
const te = new TextEncoder();
const u8 = (b: ArrayBuffer | Uint8Array) => (b instanceof Uint8Array ? b : new Uint8Array(b));
/** Copies into a fresh ArrayBuffer-backed view (WebCrypto rejects shared/offset views in some engines). */
const own = (b: Uint8Array) => new Uint8Array(b);

export const b64 = (b: Uint8Array) => {
	let s = '';
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s);
};
export const unb64 = (s: string) => {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
};

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32(b: Uint8Array): string {
	let out = '';
	let bits = 0;
	let val = 0;
	for (const x of b) {
		val = (val << 8) | x;
		bits += 8;
		while (bits >= 5) {
			out += B32[(val >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(val << (5 - bits)) & 31];
	return out;
}
export function unbase32(s: string): Uint8Array | null {
	const out: number[] = [];
	let bits = 0;
	let val = 0;
	for (const c of s) {
		const i = B32.indexOf(c);
		if (i < 0) return null;
		val = ((val << 5) | i) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			out.push((val >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};

async function hkdf(key: Uint8Array, salt: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
	const k = await subtle().importKey('raw', own(key), 'HKDF', false, ['deriveBits']);
	return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: te.encode(info) }, k, bytes * 8));
}

const hmacKey = (k: Uint8Array, usage: KeyUsage[]) => subtle().importKey('raw', own(k), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
const hmac = async (k: Uint8Array, data: Uint8Array) => new Uint8Array(await subtle().sign('HMAC', await hmacKey(k, ['sign']), own(data)));
const aesKey = (k: Uint8Array, name: 'AES-GCM' | 'AES-CTR') => subtle().importKey('raw', own(k), { name }, false, ['encrypt', 'decrypt']);

/** Constant-time comparison. */
const equal = (a: Uint8Array, b: Uint8Array) => {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
	return d === 0;
};

// ------------------------------------------------------------------ master key

function validKdf(k: Kdf): boolean {
	// bounds also protect against a tampered key file asking for absurd work
	if (k?.type === 'argon2id') return k.m >= 8192 && k.m <= 1048576 && k.t >= 1 && k.t <= 10 && k.p >= 1 && k.p <= 4;
	if (k?.type === 'pbkdf2') return k.i >= 100000 && k.i <= 10000000;
	return false;
}

async function deriveKek(password: string, salt: Uint8Array, kdf: Kdf): Promise<Uint8Array> {
	const pw = te.encode(password.normalize('NFC'));
	if (kdf.type === 'argon2id') return argon2idAsync(pw, salt, { m: kdf.m, t: kdf.t, p: kdf.p, dkLen: 32, asyncTick: 25 });
	const k = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
	return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: own(salt), iterations: kdf.i }, k, 256));
}

const wrapAad = (k: Omit<Keyfile, 'wrap' | 'check'>) =>
	te.encode(JSON.stringify([k.format, k.v, k.alg, k.names, k.kdf.type === 'argon2id' ? [k.kdf.m, k.kdf.t, k.kdf.p] : [k.kdf.i], k.salt, k.kid]));

const checkOf = async (dek: Uint8Array, kid: string) => b64((await hmac(dek, te.encode('ambraia-check:' + kid))).slice(0, 16));

async function wrap(meta: Omit<Keyfile, 'wrap' | 'check'>, dek: Uint8Array, password: string): Promise<Keyfile> {
	const kek = await deriveKek(password, unb64(meta.salt), meta.kdf);
	const iv = rnd(12);
	const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: wrapAad(meta) }, await aesKey(kek, 'AES-GCM'), own(dek)));
	kek.fill(0);
	return { ...meta, wrap: b64(concat(iv, ct)), check: await checkOf(dek, meta.kid) };
}

export async function createKeyfile(password: string, alg: Alg, names: boolean, kdfType: KdfType): Promise<{ keyfile: Keyfile; dek: Uint8Array }> {
	const dek = rnd(32);
	const meta = { format: 'ambraia-crypt' as const, v: 1 as const, alg, names, kdf: KDF_DEFAULTS[kdfType], salt: b64(rnd(16)), kid: b64(rnd(9)) };
	return { keyfile: await wrap(meta, dek, password), dek };
}

/** New password, same data key: files stay as they are. */
export async function rewrapKeyfile(k: Keyfile, dek: Uint8Array, password: string, kdfType?: KdfType): Promise<Keyfile> {
	const { wrap: _w, check: _c, ...meta } = k;
	return wrap({ ...meta, kdf: kdfType ? KDF_DEFAULTS[kdfType] : meta.kdf, salt: b64(rnd(16)) }, dek, password);
}

export function parseKeyfile(data: ArrayBuffer | string): Keyfile {
	const k = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as Keyfile;
	if (k?.format !== 'ambraia-crypt' || k.v !== 1 || !ALGS.includes(k.alg) || !validKdf(k.kdf) || typeof k.wrap !== 'string' || typeof k.salt !== 'string') {
		throw new IntegrityError('Unsupported or damaged encryption key file');
	}
	return k;
}

export async function unlockKeyfile(k: Keyfile, password: string): Promise<Uint8Array> {
	const kek = await deriveKek(password, unb64(k.salt), k.kdf);
	const w = unb64(k.wrap);
	try {
		const dek = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: w.slice(0, 12), additionalData: wrapAad(k) }, await aesKey(kek, 'AES-GCM'), w.slice(12)));
		if (dek.length !== 32) throw new Error('len');
		return dek;
	} catch {
		throw new WrongKeyError('wrong-key');
	} finally {
		kek.fill(0);
	}
}

/** Whether a cached data key belongs to this key file (without the password). */
export async function keyMatches(k: Keyfile, dek: Uint8Array): Promise<boolean> {
	return equal(te.encode(await checkOf(dek, k.kid)), te.encode(k.check));
}

// ------------------------------------------------------------------ content + names

export class Cipher {
	private nameKeys: Promise<[CryptoKey, CryptoKey]>;
	private encCache = new Map<string, string>();
	private decCache = new Map<string, string | null>();

	constructor(
		private dek: Uint8Array,
		public alg: Alg,
		public names: boolean,
	) {
		this.nameKeys = (async () => {
			const e = await hkdf(dek, new Uint8Array(0), 'ambraia names enc', 32);
			const m = await hkdf(dek, new Uint8Array(0), 'ambraia names mac', 32);
			return [await aesKey(e, 'AES-CTR'), await hmacKey(m, ['sign'])];
		})();
	}

	async encrypt(plain: ArrayBuffer): Promise<ArrayBuffer> {
		const alg = this.alg;
		const salt = rnd(16);
		const nonce = rnd(NONCE[alg]);
		const header = concat(new Uint8Array([...MAGIC, ALG_ID[alg]]), salt, nonce);
		const keys = await hkdf(this.dek, salt, 'ambraia file ' + alg, alg === 'aes-ctr-hmac' ? 64 : 32);
		const pt = u8(plain);
		let body: Uint8Array;
		if (alg === 'aes-gcm') {
			body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: header }, await aesKey(keys, 'AES-GCM'), own(pt)));
		} else if (alg === 'xchacha20') {
			body = xchacha20poly1305(keys, nonce, header).encrypt(pt);
		} else {
			const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-CTR', counter: nonce, length: 64 }, await aesKey(keys.slice(0, 32), 'AES-CTR'), own(pt)));
			body = concat(ct, await hmac(keys.slice(32), concat(header, ct)));
		}
		keys.fill(0);
		return concat(header, body).buffer;
	}

	async decrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
		const d = u8(data);
		if (d.length < 5 || MAGIC.some((m, i) => d[i] !== m)) throw new IntegrityError('Not an Ambraia encrypted file');
		const alg = (Object.keys(ALG_ID) as Alg[]).find((a) => ALG_ID[a] === d[4]);
		if (!alg) throw new IntegrityError('Unknown encryption algorithm');
		const hl = 5 + 16 + NONCE[alg];
		if (d.length < hl + 16) throw new IntegrityError('Truncated encrypted file');
		const header = d.slice(0, hl);
		const salt = d.slice(5, 21);
		const nonce = d.slice(21, hl);
		const body = d.slice(hl);
		const keys = await hkdf(this.dek, salt, 'ambraia file ' + alg, alg === 'aes-ctr-hmac' ? 64 : 32);
		try {
			if (alg === 'aes-gcm') return await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: header }, await aesKey(keys, 'AES-GCM'), body);
			if (alg === 'xchacha20') return own(xchacha20poly1305(keys, nonce, header).decrypt(body)).buffer;
			const ct = body.slice(0, body.length - 32);
			const ok = await subtle().verify('HMAC', await hmacKey(keys.slice(32), ['verify']), body.slice(body.length - 32), concat(header, ct));
			if (!ok) throw new Error('mac');
			return await subtle().decrypt({ name: 'AES-CTR', counter: nonce, length: 64 }, await aesKey(keys.slice(0, 32), 'AES-CTR'), ct);
		} catch (e) {
			if (e instanceof IntegrityError) throw e;
			throw new IntegrityError('File failed the integrity check (damaged or modified outside Ambraia)');
		} finally {
			keys.fill(0);
		}
	}

	/** Deterministic authenticated name encryption (SIV construction: HMAC-derived IV + AES-CTR). */
	async encName(name: string): Promise<string> {
		if (!this.names) return name;
		const hit = this.encCache.get(name);
		if (hit) return hit;
		const [ek, mk] = await this.nameKeys;
		const pt = te.encode(name.normalize('NFC'));
		const iv = new Uint8Array(await subtle().sign('HMAC', mk, pt)).slice(0, 16);
		const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, ek, pt));
		const out = base32(concat(iv, ct));
		if (out.length > 255) throw new IntegrityError('Name too long to be encrypted');
		this.encCache.set(name, out);
		this.decCache.set(out, name);
		return out;
	}

	/** null = not one of ours (or tampered): the item is ignored. */
	async decName(enc: string): Promise<string | null> {
		if (!this.names) return enc;
		if (this.decCache.has(enc)) return this.decCache.get(enc)!;
		let res: string | null = null;
		const raw = enc.length >= 27 ? unbase32(enc) : null;
		if (raw && raw.length >= 17) {
			const [ek, mk] = await this.nameKeys;
			const iv = raw.slice(0, 16);
			const pt = new Uint8Array(await subtle().decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, ek, raw.slice(16)));
			const mac = new Uint8Array(await subtle().sign('HMAC', mk, pt)).slice(0, 16);
			if (equal(mac, iv)) {
				try {
					res = new TextDecoder('utf-8', { fatal: true }).decode(pt);
				} catch {
					res = null;
				}
			}
		}
		if (this.decCache.size > 50000) this.decCache.clear();
		this.decCache.set(enc, res);
		if (res !== null) this.encCache.set(res, enc);
		return res;
	}
}

// ------------------------------------------------------------------ passwords and link codes

/** 125-bit random master key, easy to copy: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX */
export function generateMasterKey(): string {
	const s = base32(rnd(16)).toUpperCase().slice(0, 25);
	return s.match(/.{5}/g)!.join('-');
}

/** Rough strength estimate: 0 (weak) … 4 (excellent). */
export function strength(pw: string): number {
	if (!pw) return 0;
	let pool = 0;
	if (/[a-z]/.test(pw)) pool += 26;
	if (/[A-Z]/.test(pw)) pool += 26;
	if (/[0-9]/.test(pw)) pool += 10;
	if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
	const unique = new Set(pw).size;
	const bits = Math.log2(Math.max(pool, 2)) * Math.min(pw.length, unique * 2);
	if (pw.length < 10 || bits < 45) return pw.length < 6 ? 0 : 1;
	if (bits < 65) return 2;
	if (bits < 90) return 3;
	return 4;
}
export const MIN_STRENGTH = 2;

// ------------------------------------------------------------------ one-time pairing codes and small sealed records

/** Crockford base32: no I, L, O, U (nothing to confuse when typing a code by hand). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIR_CODE_LEN = 8;

/** Random 8-character pairing code (40 bits), e.g. "7K3M9QXD". */
export function newPairCode(): string {
	const b = rnd(PAIR_CODE_LEN);
	let s = '';
	for (const x of b) s += CROCKFORD[x & 31];
	return s;
}

/** Normalizes what the user typed ("7k3m-9qxd", O→0, I/L→1); null when it cannot be a code. */
export function normalizePairCode(input: string): string | null {
	const s = input
		.toUpperCase()
		.replace(/[\s\-_.]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1');
	if (s.length !== PAIR_CODE_LEN) return null;
	for (const c of s) if (!CROCKFORD.includes(c)) return null;
	return s;
}

export const formatPairCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

/** Argon2id parameters for pairing codes: slow enough against guessing, fine on phones. */
const PAIR_KDF: Kdf = { type: 'argon2id', m: 19456, t: 2, p: 1 };

export interface SealedRecord {
	v: 1;
	salt?: string;
	iv: string;
	ct: string;
}

async function gcmSeal(key: Uint8Array, data: unknown, aad: string): Promise<{ iv: string; ct: string }> {
	const iv = rnd(12);
	const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, await aesKey(key, 'AES-GCM'), te.encode(JSON.stringify(data))));
	return { iv: b64(iv), ct: b64(ct) };
}

async function gcmOpen<T>(key: Uint8Array, r: { iv: string; ct: string }, aad: string): Promise<T | null> {
	try {
		const pt = await subtle().decrypt({ name: 'AES-GCM', iv: own(unb64(r.iv)), additionalData: te.encode(aad) }, await aesKey(key, 'AES-GCM'), own(unb64(r.ct)));
		return JSON.parse(new TextDecoder().decode(pt)) as T;
	} catch {
		return null;
	}
}

/** Key derived from a pairing code (salted, Argon2id). */
export async function pairKey(code: string, salt: Uint8Array): Promise<Uint8Array> {
	return deriveKek(code, salt, PAIR_KDF);
}

/** Encrypts a record with a pairing code. `aad` binds it to its file name. */
export async function sealWithCode(code: string, data: unknown, aad: string): Promise<{ record: SealedRecord; key: Uint8Array }> {
	const salt = rnd(16);
	const key = await pairKey(code, salt);
	return { record: { v: 1, salt: b64(salt), ...(await gcmSeal(key, data, aad)) }, key };
}

/** Opens a record sealed with a pairing code: null for a wrong code or a tampered file. */
export async function openWithCode<T>(code: string, r: SealedRecord, aad: string): Promise<{ data: T; key: Uint8Array } | null> {
	if (r?.v !== 1 || typeof r.salt !== 'string' || typeof r.iv !== 'string' || typeof r.ct !== 'string') return null;
	const key = await pairKey(code, unb64(r.salt));
	const data = await gcmOpen<T>(key, r, aad);
	return data === null ? null : { data, key };
}

/** Encrypts a small record with a 256-bit key (device list, remote commands). */
export async function sealWithKey(key: Uint8Array, data: unknown, aad: string): Promise<SealedRecord> {
	return { v: 1, ...(await gcmSeal(key, data, aad)) };
}

export async function openWithKey<T>(key: Uint8Array, r: SealedRecord, aad: string): Promise<T | null> {
	if (r?.v !== 1 || typeof r.iv !== 'string' || typeof r.ct !== 'string') return null;
	return gcmOpen<T>(key, r, aad);
}

/** Independent sub-key of the data key (never used to encrypt files). */
export async function subKey(dek: Uint8Array, label: string): Promise<Uint8Array> {
	return hkdf(dek, new Uint8Array(0), label, 32);
}

export const randomKey = () => rnd(32);
export const randomHex = (bytes: number) => Array.from(rnd(bytes), (x) => x.toString(16).padStart(2, '0')).join('');

/** Short, stable identifier of a string (SHA-256, hex). */
export async function shortHash(s: string, chars = 16): Promise<string> {
	const h = new Uint8Array(await subtle().digest('SHA-256', te.encode(s)));
	return Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('').slice(0, chars);
}

// ------------------------------------------------------------------ device keys (pairing, roles)

/** Short hex tag of `data` under `key` (opaque file names of the device list). */
export async function keyedTag(key: Uint8Array, data: string, chars = 20): Promise<string> {
	return Array.from(await hmac(key, te.encode(data)), (x) => x.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, chars);
}

const EC = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ES = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** Ephemeral ECDH key pair for one pairing: the private half never leaves memory. */
export async function ecdhPair(): Promise<{ pub: string; priv: CryptoKey }> {
	const kp = (await subtle().generateKey(EC, true, ['deriveBits'])) as CryptoKeyPair;
	return { pub: b64(new Uint8Array(await subtle().exportKey('raw', kp.publicKey))), priv: kp.privateKey };
}

/** 256-bit key shared by the two ends of a pairing (ECDH P-256 + HKDF bound to both public keys). */
export async function ecdhShared(priv: CryptoKey, theirPub: string, label: string): Promise<Uint8Array> {
	const pub = await subtle().importKey('raw', own(unb64(theirPub)), EC, false, []);
	const bits = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 256));
	return hkdf(bits, new Uint8Array(0), 'ambraia pairing v2 ' + label, 32);
}

/** Six digits both screens show during pairing: they match only when nobody sits in between. */
export async function pairCheck(pubA: string, pubB: string): Promise<string> {
	const h = new Uint8Array(await subtle().digest('SHA-256', te.encode(`${pubA}|${pubB}`)));
	const n = ((h[0] << 16) | (h[1] << 8) | h[2]) % 1_000_000;
	const s = String(n).padStart(6, '0');
	return `${s.slice(0, 3)} ${s.slice(3)}`;
}

export interface SignKeys {
	/** public key, raw P-256 point (base64) */
	pub: string;
	/** private key as JWK (kept only in the device keychain) */
	jwk: JsonWebKey;
}

/** Long-lived signing key of a device (ECDSA P-256): proves who sent a command or changed roles. */
export async function newSignKeys(): Promise<SignKeys> {
	const kp = (await subtle().generateKey(ES, true, ['sign', 'verify'])) as CryptoKeyPair;
	return { pub: b64(new Uint8Array(await subtle().exportKey('raw', kp.publicKey))), jwk: await subtle().exportKey('jwk', kp.privateKey) };
}

/** Canonical JSON (sorted keys) so that signer and verifier hash the same bytes. */
export function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	if (v && typeof v === 'object')
		return `{${Object.keys(v as Record<string, unknown>)
			.filter((k) => (v as Record<string, unknown>)[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	return JSON.stringify(v);
}

export async function signData(keys: SignKeys, data: unknown): Promise<string> {
	const k = await subtle().importKey('jwk', keys.jwk, ES, false, ['sign']);
	return b64(new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, k, te.encode(canonical(data)))));
}

export async function verifyData(pub: string, data: unknown, sig: string): Promise<boolean> {
	try {
		const k = await subtle().importKey('raw', own(unb64(pub)), ES, false, ['verify']);
		return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, k, own(unb64(sig)), te.encode(canonical(data)));
	} catch {
		return false;
	}
}
