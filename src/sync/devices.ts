import { App, Platform } from 'obsidian';
import type { Remote } from './providers';
import type { RemoteFile } from './types';
import type { Alg } from './crypto';
import {
	b64,
	ecdhPair,
	ecdhShared,
	formatPairCode,
	keyedTag,
	newPairCode,
	openWithCode,
	openWithKey,
	pairCheck,
	randomHex,
	randomKey,
	SealedRecord,
	sealWithCode,
	sealWithKey,
	shortHash,
	SignKeys,
	signData,
	unb64,
	verifyData,
} from './crypto';

/**
 * Linking devices and managing them, without any server in between.
 *
 * Everything travels through the user's own cloud, in small end-to-end encrypted files kept
 * outside the vault folder (".ambraia/…", never synced as notes, never readable without a key that
 * exists only on the linked devices):
 * - pairing (v2): the device already set up publishes a one-time offer sealed with an 8-character
 *   code (Argon2id + AES-GCM) that expires after 5 minutes. The offer holds no secret, only a fresh
 *   ECDH P-256 public key. The new device answers with its own public key; both screens show the
 *   same 6-digit check and the user approves on the first device. Only then folder, encryption
 *   settings, data key and circle key travel, encrypted with the ECDH shared key. Account access
 *   (tokens) never leaves a device: the new device signs in to the cloud by itself.
 * - device list ("circle"): records encrypted with the circle key (a sub-key of the data key for
 *   encrypted folders, a random key kept in each device's keychain for plain folders), stored
 *   under opaque names. There are no roles: every device of the list can link new devices and
 *   remove any device, itself included. Each device is introduced by the device that approved it
 *   (a signed certificate, ECDSA P-256) and every removal is signed and checked by all devices.
 */

export const PAIR_FOLDER = '.ambraia/pairing';
export const DEVICES_ROOT = '.ambraia/devices';
export const CODE_TTL = 5 * 60_000;
/** The approval must arrive within this time after the code was used. */
export const GRANT_TTL = 3 * 60_000;
/** Commands older than this are ignored (a device that comes back after months is not wiped by surprise). */
export const COMMAND_TTL = 30 * 86400_000;
const ID_KEY = 'ambraia-device-id';
const NAME_KEY = 'ambraia-device-name';

type LocalStore = { loadLocalStorage(k: string): unknown; saveLocalStorage(k: string, v: unknown): void };
const store = (app: App) => app as unknown as LocalStore;

/** Random id of this device for this vault (local storage: never synced, not copied with the vault). */
export function deviceId(app: App): string {
	const rawId: unknown = store(app).loadLocalStorage(ID_KEY);
	let id = typeof rawId === 'string' ? rawId : '';
	if (!/^[a-f0-9]{16}$/.test(id)) {
		id = randomHex(8);
		store(app).saveLocalStorage(ID_KEY, id);
	}
	return id;
}

export function platformName(): string {
	if (Platform.isIosApp) return Platform.isTablet ? 'iPad' : 'iPhone';
	if (Platform.isAndroidApp) return Platform.isTablet ? 'Android tablet' : 'Android';
	if (Platform.isMacOS) return 'Mac';
	if (Platform.isWin) return 'Windows';
	if (Platform.isLinux) return 'Linux';
	return 'Obsidian';
}

/** Name shown to the other devices; defaults to the computer name or the platform. */
export function deviceName(app: App): string {
	const rawName: unknown = store(app).loadLocalStorage(NAME_KEY);
	const saved = (typeof rawName === 'string' ? rawName : '').trim();
	if (saved) return saved.slice(0, 60);
	try {
		if (Platform.isDesktopApp) {
			const os = (window as unknown as { require: (m: string) => { hostname(): string } }).require('os');
			const h = os.hostname().replace(/\.local$/, '').trim();
			if (h) return h.slice(0, 60);
		}
	} catch {
		/* not available */
	}
	return platformName();
}

export function setDeviceName(app: App, name: string) {
	store(app).saveLocalStorage(NAME_KEY, name.trim().slice(0, 60) || null);
}

/** Forgets this device's id (after an erase requested by another device: a new pairing starts fresh). */
export function resetDeviceId(app: App) {
	store(app).saveLocalStorage(ID_KEY, null);
}

// ------------------------------------------------------------------ small file helpers

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (o: unknown) => {
	const u = enc.encode(JSON.stringify(o));
	return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
};

async function rootOf(r: Remote, create: boolean): Promise<RemoteFile | null> {
	const f = await r.findRoot();
	if (f || !create) return f;
	return r.createRoot();
}

async function children(r: Remote, root: RemoteFile): Promise<RemoteFile[]> {
	return (await r.listAll(root.id)).filter((f) => !f.isFolder && f.parentId === root.id);
}

async function readJson<T>(r: Remote, f: RemoteFile): Promise<T | null> {
	try {
		return JSON.parse(dec.decode(await r.download(f.id))) as T;
	} catch {
		return null;
	}
}

async function writeJson(r: Remote, root: RemoteFile, name: string, data: unknown, existing?: RemoteFile | null) {
	const cur = existing ?? (await r.findChild(root.id, name));
	if (cur) return r.update(cur.id, toBuf(data), cur);
	return r.upload(name, root.id, toBuf(data));
}

async function remove(r: Remote, f: RemoteFile | null | undefined) {
	if (!f) return;
	try {
		await r.trash(f.id);
	} catch {
		/* already gone */
	}
}

// ------------------------------------------------------------------ pairing

/** What a new device receives once the pairing is approved. No account credentials. */
export interface PairPayload {
	v: 3;
	provider: string;
	folder: string;
	encrypt: boolean;
	alg?: Alg;
	names?: boolean;
	sharedKey?: boolean;
	/** Data key (base64) and its id: present only when the folder is encrypted and unlocked. */
	kid?: string;
	dek?: string;
	/** Key of the device list of plain folders (base64): never stored in the cloud. */
	circle?: string;
	/** Certificate of the new device, signed by the approving device. */
	cert?: DeviceCert;
	/** Devices of the list known to the approving device (id → signing key) and removed ones. */
	members?: Record<string, string>;
	revoked?: Record<string, number>;
	from: { id: string; name: string };
	exp: number;
}

/** Public part of an offer: readable only with the code, it carries no secret. */
interface OfferData {
	v: 3;
	provider: string;
	folder: string;
	from: { id: string; name: string };
	/** inviter's ephemeral ECDH public key */
	apub: string;
	exp: number;
}

interface OfferFile extends SealedRecord {
	exp: number;
}

export interface AckData {
	id: string;
	name: string;
	platform?: string;
	/** new device's ephemeral ECDH public key */
	bpub: string;
	/** new device's long-lived signing key (bound to the check digits) */
	spub: string;
	at: number;
}

type Grant = { ok: true; payload: PairPayload } | { ok: false };

const offerName = (id: string) => `offer-${id}.json`;
const ackName = (id: string) => `ack-${id}.json`;
const grantName = (id: string) => `grant-${id}.json`;

/** An offer waiting on the cloud while the code window is open (inviting device). */
export class PairingOffer {
	readonly code: string;
	readonly id = randomHex(8);
	readonly expires: number;
	/** the device that used the code, waiting for approval */
	ack: AckData | null = null;
	/** 6 digits shown on both screens once the code has been used */
	check = '';
	private file: RemoteFile | null = null;
	private root: RemoteFile | null = null;
	private closed = false;
	private ecdh: { pub: string; priv: CryptoKey } | null = null;

	constructor(
		private remote: Remote,
		private base: Pick<PairPayload, 'provider' | 'folder' | 'from'>,
		private grant: (ack: AckData) => Promise<Omit<PairPayload, 'v' | 'exp' | 'provider' | 'folder' | 'from'>>,
		now = Date.now(),
	) {
		this.code = newPairCode();
		this.expires = now + CODE_TTL;
	}

	get display() {
		return formatPairCode(this.code);
	}

	get expired() {
		return Date.now() > this.expires;
	}

	/** Uploads the sealed offer (and removes expired leftovers). */
	async publish() {
		this.root = await rootOf(this.remote, true);
		const root = this.root!;
		const now = Date.now();
		for (const f of await children(this.remote, root)) {
			if (!/^(offer|ack|grant)-/.test(f.name)) continue;
			const o = f.name.startsWith('offer-') ? await readJson<OfferFile>(this.remote, f) : null;
			// acks and grants live seconds; offers until they expire
			const age = now - Date.parse(String(f.modifiedTime ?? f.createdTime ?? '')) || 0;
			if (f.name.startsWith('offer-') ? !o || typeof o.exp !== 'number' || o.exp < now : age > CODE_TTL || isNaN(age)) await remove(this.remote, f);
		}
		this.ecdh = await ecdhPair();
		const name = offerName(this.id);
		const data: OfferData = { v: 3, ...this.base, apub: this.ecdh.pub, exp: this.expires };
		const { record } = await sealWithCode(this.code, data, name);
		if (this.closed) return;
		this.file = await writeJson(this.remote, root, name, { ...record, exp: this.expires } satisfies OfferFile);
	}

	/**
	 * The new device's answer, once it has used the code. The offer is deleted at once: nobody else
	 * can use the code. Nothing secret has been sent yet: see approve().
	 */
	async checkAck(): Promise<AckData | null> {
		if (this.ack) return this.ack;
		if (!this.root || this.closed || !this.ecdh) return null;
		if (this.expired) {
			await this.revoke();
			return null;
		}
		const f = await this.remote.findChild(this.root.id, ackName(this.id));
		if (!f) return null;
		const raw = await readJson<SealedRecord>(this.remote, f);
		const res = raw ? await openWithCode<AckData>(this.code, raw, ackName(this.id)) : null;
		await remove(this.remote, f);
		if (!res || typeof res.data.bpub !== 'string' || typeof res.data.spub !== 'string' || !/^[a-f0-9]{16}$/.test(String(res.data.id))) return null;
		await this.removeOffer();
		this.ack = res.data;
		this.check = await pairCheck(this.ecdh.pub, `${res.data.bpub}|${res.data.spub}`);
		return this.ack;
	}

	/** User confirmed on this device: settings and keys travel encrypted for the new device only. */
	async approve(): Promise<void> {
		if (!this.root || !this.ack || !this.ecdh || this.closed) throw new Error('pairing closed');
		const k = await ecdhShared(this.ecdh.priv, this.ack.bpub, this.id);
		const payload: PairPayload = { v: 3, ...this.base, ...(await this.grant(this.ack)), exp: Date.now() + GRANT_TTL };
		const name = grantName(this.id);
		await writeJson(this.remote, this.root, name, await sealWithKey(k, { ok: true, payload } satisfies Grant, name));
		this.closed = true;
		this.ecdh = null;
	}

	/** User refused: the new device is told so and gets nothing. */
	async reject(): Promise<void> {
		if (this.root && this.ack && this.ecdh && !this.closed) {
			const k = await ecdhShared(this.ecdh.priv, this.ack.bpub, this.id);
			const name = grantName(this.id);
			await writeJson(this.remote, this.root, name, await sealWithKey(k, { ok: false } satisfies Grant, name)).catch(() => undefined);
		}
		await this.revoke();
	}

	private async removeOffer() {
		const f = this.file ?? (this.root ? await this.remote.findChild(this.root.id, offerName(this.id)).catch(() => null) : null);
		this.file = null;
		await remove(this.remote, f);
	}

	/** Deletes the offer: the code stops working immediately. */
	async revoke() {
		this.closed = true;
		this.ecdh = null;
		await this.removeOffer();
		if (this.root) await remove(this.remote, await this.remote.findChild(this.root.id, ackName(this.id)).catch(() => null));
	}
}

/** New device, after typing the code: waits for the approval on the other device. */
export interface PairingClaim {
	provider: string;
	folder: string;
	from: { id: string; name: string };
	/** same 6 digits as on the other screen */
	check: string;
	/** Resolves with the settings (approved), 'denied', or null (expired / cancelled). */
	wait(signal?: { cancelled: boolean }, every?: number): Promise<PairPayload | 'denied' | null>;
}

/** New device: looks for an offer that opens with the code and answers it with its public key. */
export async function redeemCode(remote: Remote, code: string, me: { id: string; name: string; platform?: string; spub: string }): Promise<PairingClaim | 'outdated' | null> {
	const root = await rootOf(remote, false);
	if (!root) return null;
	const now = Date.now();
	const offers = (await children(remote, root)).filter((f) => /^offer-[a-f0-9]{16}\.json$/.test(f.name));
	const metas: { f: RemoteFile; o: OfferFile }[] = [];
	for (const f of offers) {
		const o = await readJson<OfferFile>(remote, f);
		if (o && typeof o.exp === 'number' && o.exp > now) metas.push({ f, o });
	}
	metas.sort((a, b) => b.o.exp - a.o.exp);
	for (const { f, o } of metas.slice(0, 5)) {
		const res = await openWithCode<OfferData>(code, o, f.name);
		if (!res) continue;
		const p = res.data;
		if ((p.v as number) === 2) return 'outdated';
		if (p.v !== 3 || typeof p.folder !== 'string' || typeof p.apub !== 'string' || p.exp < Date.now()) return null;
		const id = f.name.slice('offer-'.length, -'.json'.length);
		const mine = await ecdhPair();
		const { record } = await sealWithCode(code, { ...me, bpub: mine.pub, at: Date.now() } satisfies AckData, ackName(id));
		await writeJson(remote, root, ackName(id), record);
		const k = await ecdhShared(mine.priv, p.apub, id);
		const check = await pairCheck(p.apub, `${mine.pub}|${me.spub}`);
		const until = Math.max(p.exp, Date.now()) + GRANT_TTL;
		return {
			provider: p.provider,
			folder: p.folder,
			from: p.from,
			check,
			async wait(signal, every = 2500) {
				while (!signal?.cancelled && Date.now() < until) {
					const g = await remote.findChild(root.id, grantName(id)).catch(() => null);
					if (g) {
						const raw = await readJson<SealedRecord>(remote, g);
						const res = raw ? await openWithKey<Grant>(k, raw, grantName(id)) : null;
						if (res) {
							await remove(remote, g);
							if (!res.ok) return 'denied';
							const pl = res.payload;
							if (pl?.v !== 3 || typeof pl.folder !== 'string' || pl.exp < Date.now()) return null;
							if (pl.cert && (pl.cert.id !== me.id || pl.cert.pub !== me.spub)) return null;
							return pl;
						}
					}
					await new Promise((r) => window.setTimeout(r, every));
				}
				return null;
			},
		};
	}
	return null;
}

export const payloadKey = (p: PairPayload) => (p.dek ? unb64(p.dek) : null);
export const encodeKey = (k: Uint8Array) => b64(k);

// ------------------------------------------------------------------ device list

export interface DeviceInfo {
	id: string;
	name: string;
	platform: string;
	version: string;
	firstSeen: number;
	lastSeen: number;
	/** signing key of the device (ECDSA P-256) */
	pub?: string;
	/** proof that a device already in the list let this one in (see DeviceCert) */
	cert?: DeviceCert;
	/** cloud folders this device syncs (provider + path), so new services join the same folder */
	folders?: { p: string; f: string }[];
}

/**
 * Introduction of a device: its signing key, signed by the device that approved its pairing
 * (`by`, itself introduced the same way) or by itself for the first device of a list. Every device
 * accepts a certificate whose chain reaches a device it already trusts: nobody is "owner" or
 * "administrator", every device of the list has the same rights.
 */
export interface DeviceCert {
	id: string;
	pub: string;
	at: number;
	by?: DeviceCert;
	sig: string;
}

/** 'cancel' withdraws an earlier removal (or lets a removed device in again after a new pairing). */
export type DeviceAction = 'disconnect' | 'wipe';
export type CommandAction = DeviceAction | 'cancel';

export interface DeviceCommand {
	target: string;
	action: CommandAction;
	from: { id: string; name: string };
	at: number;
	/** sender's certificate: any device of the list may send commands */
	cert?: DeviceCert;
	/** signature of the sender over target, action, from and at */
	sig?: string;
}

export interface DeviceEntry {
	info: DeviceInfo;
	/** A removal sent to this device that it has not executed yet. */
	pending: DeviceAction | null;
	/** The device was let in by a device of the list (false: unknown, e.g. still on an old version). */
	trusted: boolean;
}

/** What this device knows about the list: trusted keys and removed devices (keychain, never in the cloud). */
export interface TrustState {
	v: 1;
	members: Record<string, string>;
	revoked: Record<string, number>;
	/** removals already withdrawn (time of the withdrawal) */
	restored: Record<string, number>;
}

export const emptyTrust = (): TrustState => ({ v: 1, members: {}, revoked: {}, restored: {} });

/** Device-only keys of a registry (keychain): never written to the cloud. */
export interface RegistryKeys {
	/** circle key of a plain folder */
	circleKey(): Uint8Array | null;
	setCircleKey(k: Uint8Array): void;
	/** this device's signing keys (created on first use) */
	signKeys(): Promise<SignKeys>;
	/** trusted devices and removals known to this device (null: never stored, e.g. after an update) */
	trust(): TrustState | null;
	saveTrust(t: TrustState): void;
	/** certificate of this device in this list */
	cert(): DeviceCert | null;
	setCert(c: DeviceCert | null): void;
}

type Rec = { t: 'device'; d: DeviceInfo } | { t: 'command'; d: DeviceCommand } | { t: 'share'; d: unknown };

const LEGACY_DEV = /^device-([a-f0-9]{16})\.json$/;
const OPAQUE = /^x[0-9a-f]{20}\.bin$/;
const KEY_FILE = 'key.json';
const MAX_CHAIN = 24;

/** Folder of the device list for one cloud folder (devices of the same vault share it). */
export async function devicesFolder(vaultFolder: string): Promise<string> {
	return `${DEVICES_ROOT}/${await shortHash(vaultFolder.toLowerCase())}`;
}

export class NotAllowedError extends Error {
	constructor(msg = 'not allowed') {
		super(msg);
		this.name = 'NotAllowedError';
	}
}

const certBody = (c: DeviceCert) => ({ id: c.id, pub: c.pub, at: c.at, by: c.by ? { id: c.by.id, pub: c.by.pub } : null });
const cmdBody = (c: DeviceCommand) => ({ target: c.target, action: c.action, from: c.from, at: c.at });

/** Certificate signed by `signer` (the approving device) or self-signed when `by` is absent. */
export async function issueCert(signer: SignKeys, id: string, pub: string, by?: DeviceCert | null): Promise<DeviceCert> {
	const c: DeviceCert = { id, pub, at: Date.now(), ...(by ? { by } : {}), sig: '' };
	c.sig = await signData(signer, certBody(c));
	return c;
}

function validCertShape(c: unknown, depth = 0): c is DeviceCert {
	if (!c || typeof c !== 'object' || depth > MAX_CHAIN) return false;
	const x = c as DeviceCert;
	return typeof x.id === 'string' && /^[a-f0-9]{16}$/.test(x.id) && typeof x.pub === 'string' && typeof x.sig === 'string' && typeof x.at === 'number' && (x.by === undefined || validCertShape(x.by, depth + 1));
}

/**
 * Checks a certificate chain against what this device trusts. Returns the certificates that become
 * trusted (from the leaf up to the first one already trusted), or null when the chain does not
 * reach a trusted, not removed device or a signature is wrong.
 */
export async function verifyCert(c: DeviceCert, trust: TrustState): Promise<DeviceCert[] | null> {
	if (!validCertShape(c)) return null;
	const path: DeviceCert[] = [];
	let cur: DeviceCert | undefined = c;
	while (cur) {
		if (trust.revoked[cur.id]) return null;
		const signer: string = cur.by ? cur.by.pub : cur.pub;
		if (!(await verifyData(signer, certBody(cur), cur.sig))) return null;
		if (trust.members[cur.id] === cur.pub) return path;
		if (trust.members[cur.id] && trust.members[cur.id] !== cur.pub) return null; // a known device with another key
		path.push(cur);
		cur = cur.by;
	}
	return null;
}

/** Opaque record names of the device list (see nameOf). */
const RECORD = /^x[0-9a-z]{8,}\.bin$/i;
const STALE_LIST = 60 * 24 * 3600_000;

/**
 * Device list of one cloud folder. Every record is AES-GCM encrypted with the circle key and
 * stored under a name derived from it, so the cloud sees only opaque, unlinkable files.
 *
 * All devices are equal: any device of the list can link a new device, and any device can remove
 * any other one (or itself). Removals are signed, kept as small tombstones and checked by every
 * device, so a removed device cannot come back or send commands without a new pairing.
 */
export class DeviceRegistry {
	private root: RemoteFile | null = null;
	private key: Uint8Array | null;
	private plain: boolean;

	constructor(
		private remote: Remote,
		key: Uint8Array | null,
		private keys: RegistryKeys,
	) {
		this.key = key;
		this.plain = !key;
	}

	/** True when the folder already has a device list this device was never let into. */
	outsider = false;

	private async open(create: boolean): Promise<RemoteFile | null> {
		if (!this.root) this.root = await rootOf(this.remote, create);
		if (!this.root) return null;
		if (!this.key) this.key = this.keys.circleKey();
		if (!this.key) this.key = await this.legacyKey(this.root);
		if (!this.key && create) {
			// records of a list this device cannot read: another device already started it. A second,
			// parallel list is never created: pairing brings the key.
			// Records nobody has refreshed for STALE_LIST are an abandoned list: removed, a new one starts.
			const foreign = (await children(this.remote, this.root)).filter((f) => RECORD.test(f.name));
			const fresh = (f: RemoteFile) => {
				const t = Date.parse(String(f.modifiedTime ?? ''));
				return !Number.isFinite(t) || Date.now() - t < STALE_LIST;
			};
			if (foreign.some(fresh)) {
				this.outsider = true;
				return null;
			}
			for (const f of foreign) await remove(this.remote, f);
			// first device of a plain folder: a new circle, its key stays in the keychain
			this.key = randomKey();
			this.keys.setCircleKey(this.key);
		}
		if (this.key) this.outsider = false;
		return this.key ? this.root : null;
	}

	/** Older pre-release builds kept the key of plain folders in the cloud: taken once, then deleted. */
	private async legacyKey(root: RemoteFile): Promise<Uint8Array | null> {
		const files = (await children(this.remote, root)).filter((f) => f.name === KEY_FILE);
		files.sort((a, b) => String(a.createdTime ?? a.modifiedTime ?? '').localeCompare(String(b.createdTime ?? b.modifiedTime ?? '')) || a.id.localeCompare(b.id));
		for (const f of files) {
			const o = await readJson<{ k?: string }>(this.remote, f);
			if (o?.k) {
				const k = unb64(o.k);
				this.keys.setCircleKey(k);
				return k;
			}
		}
		return null;
	}

	private async nameOf(kind: 'device' | 'command' | 'share', id = ''): Promise<string> {
		return `x${await keyedTag(this.key!, `${kind}:${id}`)}.bin`;
	}

	private async readRec<T>(f: RemoteFile): Promise<T | null> {
		const raw = await readJson<SealedRecord>(this.remote, f);
		return raw && this.key ? openWithKey<T>(this.key, raw, f.name) : null;
	}

	private async write(name: string, rec: Rec, existing?: RemoteFile | null) {
		return writeJson(this.remote, this.root!, name, await sealWithKey(this.key!, rec, name), existing);
	}

	// ---------------------------------------------------------------- trust

	private trustState(): TrustState {
		const t = this.keys.trust();
		if (t && t.v === 1 && t.members && t.revoked) return { v: 1, members: { ...t.members }, revoked: { ...t.revoked }, restored: { ...(t.restored ?? {}) } };
		return emptyTrust();
	}

	/** This device's certificate; the first device of a list (or one updated from an older format) signs its own. */
	async ownCert(me: string): Promise<DeviceCert> {
		const sign = await this.keys.signKeys();
		const c = this.keys.cert();
		if (c && c.id === me && c.pub === sign.pub && validCertShape(c)) return c;
		const self = await issueCert(sign, me, sign.pub);
		this.keys.setCert(self);
		const t = this.trustState();
		t.members[me] = sign.pub;
		delete t.revoked[me];
		this.keys.saveTrust(t);
		return self;
	}

	/**
	 * Reads every record once and updates what this device trusts: devices introduced by trusted
	 * devices become trusted, valid removals revoke their target, withdrawn removals restore it.
	 */
	private async scan(me: string): Promise<{ devices: Map<string, DeviceInfo>; cmds: Map<string, DeviceCommand>; trust: TrustState; shares: { f: RemoteFile; d: unknown }[] }> {
		const root = this.root!;
		const files = await children(this.remote, root);
		const devices = new Map<string, DeviceInfo>();
		const rawCmds: DeviceCommand[] = [];
		const shares: { f: RemoteFile; d: unknown }[] = [];
		for (const f of files) {
			if (OPAQUE.test(f.name)) {
				const rec = await this.readRec<Rec>(f);
				if (!rec) continue; // another circle (or garbage): not ours to read
				if (rec.t === 'device' && rec.d && typeof rec.d.id === 'string' && f.name === (await this.nameOf('device', rec.d.id))) devices.set(rec.d.id, rec.d);
				else if (rec.t === 'command' && rec.d && typeof rec.d.target === 'string' && f.name === (await this.nameOf('command', rec.d.target))) rawCmds.push(rec.d);
				else if (rec.t === 'share') shares.push({ f, d: rec.d });
			} else {
				const m = LEGACY_DEV.exec(f.name);
				if (!m || devices.has(m[1])) continue;
				const info = await this.readRec<DeviceInfo>(f);
				if (info && info.id === m[1]) devices.set(info.id, info);
			}
		}
		let trust = this.keys.trust();
		if (!trust) {
			// first run of this version on a device that was already in the list (the older format had owner and
			// administrators): every device listed now, with a signing key, is a device of the list
			trust = emptyTrust();
			for (const d of devices.values()) if (d.pub) trust.members[d.id] = d.pub;
		} else trust = this.trustState();
		await this.ownCert(me);
		trust.members[me] = (await this.keys.signKeys()).pub;
		// commands first (in time order), so that a removed device cannot introduce anyone
		const cmds = new Map<string, DeviceCommand>();
		for (const c of rawCmds.sort((a, b) => a.at - b.at)) {
			if (!(await this.validCommand(c, trust))) continue;
			cmds.set(c.target, c);
			if (c.action === 'cancel') {
				if ((trust.revoked[c.target] ?? 0) <= c.at) {
					delete trust.revoked[c.target];
					trust.restored[c.target] = c.at;
				}
			} else if ((trust.restored[c.target] ?? 0) < c.at && c.target !== me) {
				trust.revoked[c.target] = Math.max(trust.revoked[c.target] ?? 0, c.at);
				delete trust.members[c.target];
			}
		}
		// introductions (repeated: a chain may pass through devices met later in the loop)
		for (let round = 0; round < 4; round++) {
			let learned = false;
			for (const d of devices.values()) {
				if (!d.cert || trust.members[d.id] || trust.revoked[d.id] || d.cert.id !== d.id || d.cert.pub !== d.pub) continue;
				const path = await verifyCert(d.cert, trust);
				if (!path) continue;
				for (const p of path) if (!trust.revoked[p.id]) trust.members[p.id] = p.pub;
				learned = true;
			}
			if (!learned) break;
		}
		this.keys.saveTrust(trust);
		return { devices, cmds, trust, shares };
	}

	private async validCommand(c: DeviceCommand, trust: TrustState): Promise<boolean> {
		if (!c || !['disconnect', 'wipe', 'cancel'].includes(c.action) || typeof c.at !== 'number' || c.at > Date.now() + 86400_000) return false;
		if (!c.from || typeof c.from.id !== 'string' || !c.sig) return false;
		if (trust.revoked[c.from.id] && trust.revoked[c.from.id] < c.at) return false;
		let pub = trust.members[c.from.id] ?? null;
		if (c.cert && c.cert.id === c.from.id) {
			if (!pub) {
				const path = await verifyCert(c.cert, trust);
				if (path) pub = c.cert.pub;
			} else if (c.cert.pub !== pub) return false;
		}
		if (!pub) return false;
		return verifyData(pub, cmdBody(c), c.sig);
	}

	/** True when this device is trusted by itself and has not been removed. */
	isTrusted(id: string): boolean {
		const t = this.trustState();
		return !!t.members[id] && !t.revoked[id];
	}

	// ---------------------------------------------------------------- heartbeat and commands

	/** Publishes this device; returns a removal addressed to it, if any. */
	async heartbeat(me: Omit<DeviceInfo, 'firstSeen' | 'lastSeen' | 'pub' | 'cert'>): Promise<DeviceCommand | null> {
		const root = await this.open(true);
		if (!root || !this.key) return null;
		const { devices, cmds } = await this.scan(me.id);
		const mine = cmds.get(me.id);
		if (mine && mine.action !== 'cancel') return this.forMe(mine);
		const sign = await this.keys.signKeys();
		const cert = await this.ownCert(me.id);
		const name = await this.nameOf('device', me.id);
		const cur = await this.remote.findChild(root.id, name);
		const old = devices.get(me.id);
		let firstSeen = old?.firstSeen ?? 0;
		// record of an older version, readable with the same key: carried over, then deleted
		const legacy = await this.remote.findChild(root.id, `device-${me.id}.json`);
		if (legacy) {
			const l = await this.readRec<DeviceInfo>(legacy);
			if (l?.firstSeen && (!firstSeen || l.firstSeen < firstSeen)) firstSeen = l.firstSeen;
			await remove(this.remote, legacy);
		}
		const now = Date.now();
		const info: DeviceInfo = { ...me, pub: sign.pub, cert, firstSeen: firstSeen || now, lastSeen: now };
		await this.write(name, { t: 'device', d: info }, cur);
		await this.dropLegacy(root);
		return null;
	}

	/** Commands older than COMMAND_TTL never erase data by surprise: the device is only disconnected. */
	private forMe(c: DeviceCommand): DeviceCommand {
		if (c.action === 'wipe' && Date.now() - c.at > COMMAND_TTL) return { ...c, action: 'disconnect' };
		return c;
	}

	/** key.json and the roles record of the older format go away as soon as no device of an older version is left. */
	private async dropLegacy(root: RemoteFile) {
		const files = await children(this.remote, root);
		if (files.some((f) => LEGACY_DEV.test(f.name))) return;
		if (this.plain) for (const f of files) if (f.name === KEY_FILE) await remove(this.remote, f);
	}

	/** A valid removal for this device (forged or unverifiable ones are ignored). */
	async commandFor(id: string): Promise<DeviceCommand | null> {
		const root = await this.open(false);
		if (!root) return null;
		const { cmds } = await this.scan(id);
		const c = cmds.get(id);
		return c && c.action !== 'cancel' ? this.forMe(c) : null;
	}

	async list(me?: string): Promise<DeviceEntry[]> {
		const root = await this.open(false);
		if (!root) return [];
		const self = me ?? this.keys.cert()?.id ?? '';
		const { devices, cmds, trust } = await this.scan(self);
		return [...devices.values()]
			.map((info) => {
				const c = cmds.get(info.id);
				const pending = c && c.action !== 'cancel' ? c.action : null;
				return { info, pending, trusted: !!trust.members[info.id] && trust.members[info.id] === info.pub };
			})
			.sort((a, b) => b.info.lastSeen - a.info.lastSeen);
	}

	/** Any device of the list: asks a device (also the first one) to disconnect or erase itself. */
	async send(target: string, action: CommandAction, from: { id: string; name: string }) {
		const root = await this.open(true);
		if (!root || !this.key) throw new Error('device list unavailable');
		const { trust } = await this.scan(from.id);
		const sign = await this.keys.signKeys();
		if (trust.revoked[from.id] || trust.members[from.id] !== sign.pub) throw new NotAllowedError();
		if (target === from.id && action !== 'cancel') throw new NotAllowedError('use leave');
		const cert = await this.ownCert(from.id);
		const body = { target, action, from, at: Date.now() };
		const cmd: DeviceCommand = { ...body, cert, sig: await signData(sign, body) };
		await this.write(await this.nameOf('command', target), { t: 'command', d: cmd });
		// applied here at once (the other devices apply it when they read the list)
		const t = this.trustState();
		if (action === 'cancel') {
			delete t.revoked[target];
			t.restored[target] = body.at;
		} else {
			t.revoked[target] = body.at;
			delete t.members[target];
		}
		this.keys.saveTrust(t);
	}

	/** Withdraws a removal that the device has not executed yet. */
	async cancel(target: string, from: { id: string; name: string }) {
		await this.send(target, 'cancel', from);
	}

	/** Removes a device record from the list; the removal (if any) stays, so it cannot come back. */
	async forget(id: string) {
		const root = await this.open(false);
		if (!root) return;
		for (const n of [await this.nameOf('device', id), `device-${id}.json`, `command-${id}.json`]) await remove(this.remote, await this.remote.findChild(root.id, n));
	}

	/** Before approving a pairing: a device removed earlier with the same id is let in again. */
	async readmit(target: string, from: { id: string; name: string }) {
		const root = await this.open(false);
		if (!root) return;
		const { cmds } = await this.scan(from.id);
		const c = cmds.get(target);
		if (c && c.action !== 'cancel') await this.send(target, 'cancel', from);
	}

	/** Trusted keys to hand to a new device, and this device's certificate (it signs the new one). */
	async introduce(me: string): Promise<{ members: Record<string, string>; revoked: Record<string, number>; cert: DeviceCert; sign: SignKeys }> {
		const root = await this.open(true);
		if (root) await this.scan(me);
		const t = this.trustState();
		const cert = await this.ownCert(me);
		return { members: t.members, revoked: t.revoked, cert, sign: await this.keys.signKeys() };
	}

	// ---------------------------------------------------------------- shared links (see share/)

	/**
	 * Encrypted records of shared links, readable by every device of the list. Each record is signed
	 * by the device that wrote it: records of removed or unknown devices are ignored, so a removed
	 * device cannot make the others serve notes through a link it invents.
	 */
	async readShares(): Promise<unknown[]> {
		const root = await this.open(false);
		if (!root) return [];
		const trust = this.trustState();
		const out: unknown[] = [];
		for (const f of await children(this.remote, root)) {
			if (!OPAQUE.test(f.name)) continue;
			const rec = await this.readRec<Rec & { by?: string; sig?: string }>(f);
			if (rec?.t !== 'share' || !rec.d || typeof (rec.d as { id?: unknown }).id !== 'string') continue;
			const id = (rec.d as { id: string }).id;
			if (f.name !== (await this.nameOf('share', id))) continue;
			const pub = typeof rec.by === 'string' && !trust.revoked[rec.by] ? trust.members[rec.by] : undefined;
			if (!pub || typeof rec.sig !== 'string' || !(await verifyData(pub, { id, d: rec.d }, rec.sig))) continue;
			out.push(rec.d);
		}
		return out;
	}

	/** Writes a shared link signed by this device (only trusted devices write). */
	async writeShare(id: string, d: unknown, me: string) {
		const root = await this.open(true);
		if (!root || !this.key) return;
		const trust = this.trustState();
		const sign = await this.keys.signKeys();
		if (trust.revoked[me] || trust.members[me] !== sign.pub) return;
		const name = await this.nameOf('share', id);
		await this.write(name, { t: 'share', d, by: me, sig: await signData(sign, { id, d }) } as Rec, await this.remote.findChild(root.id, name));
	}

	async removeShare(id: string) {
		const root = await this.open(false);
		if (root) await remove(this.remote, await this.remote.findChild(root.id, await this.nameOf('share', id)));
	}
}
