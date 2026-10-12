import { ensureStateDir } from '../storage';
import { App, Notice, Platform, requestUrl, TAbstractFile, TFolder } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { SyncEngine, NetworkError, AuthError, RootMissingError, MassDeleteError, LimitError, LocalSpaceError, QuotaError } from './engine';
import { formatBytes } from './health';
import { cleanPath, HttpFn, redact } from './http';
import { Credentials, makeRemote, ProviderId, providerMeta, Remote } from './providers';
import { ObsidianLocal } from './obsidianLocal';
import { emptyReport, emptyState, migrateState, Space, SyncReport, SyncState } from './types';
import { EncryptionStateError, readKeyfile, SecureRemote, writeKeyfile } from './secureRemote';
import { b64, Cipher, KEYFILE, createKeyfile, Keyfile, keyMatches, rewrapKeyfile, subKey, unb64, unlockKeyfile } from './crypto';
import { DeviceCert, DeviceCommand, DeviceRegistry, deviceId, deviceName, devicesFolder, emptyTrust, issueCert, PAIR_FOLDER, PairingOffer, PairPayload, payloadKey, platformName, RegistryKeys, TrustState } from './devices';
import { newSignKeys, SignKeys } from './crypto';
import { LogModal, MassDeleteModal } from './modals';
import type { SyncHub } from './hub';
import type { SyncTarget } from '../settings';
import { tx } from '../i18n';

export { LogModal };

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'auth' | 'paused' | 'locked' | 'full';

/** Something wrong on the service side, shown in the settings card until it is solved. */
export interface Problem {
	kind: 'quota' | 'outage' | 'limit' | 'unexpected' | 'files' | 'local-space' | 'root';
	msg: string;
	since: number;
	/** The user has already been told. */
	notified?: boolean;
}

const HEALTH = 'ambraia-sync-health';
const MIN = 60_000;
const HOUR = 60 * MIN;
/** How often a full cloud is checked again for free space. */
export const QUOTA_RECHECK = 30 * MIN;
/** A service that keeps failing for this long while the device is online gets reported. */
export const OUTAGE_AFTER = 10 * MIN;

const SECRET_CREDS = 'ambraia-sync';
const LEGACY_CREDS = ['ambraia-google-drive'];
const SECRET_KEY = 'ambraia-sync-key';
const LOCAL_BASE = 'ambraia-sync-local-base';
/** Left by versions that moved account access with a code + PIN: removed when found. */
export const HANDOFF_FILE = 'link.ambraia';
/** How often a device refreshes its entry in the device list and looks for commands. */
const BEAT_EVERY = 10 * MIN;

export const obsidianHttp: HttpFn = async (req) => {
	const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, contentType: req.contentType, throw: false });
	let textCache: string | undefined;
	const text = () => {
		if (textCache === undefined) {
			try {
				textCache = res.text;
			} catch {
				textCache = '';
			}
		}
		return textCache;
	};
	return {
		status: res.status,
		headers: res.headers,
		get text() {
			return text();
		},
		get json() {
			try {
				return JSON.parse(text()) as unknown;
			} catch {
				return null;
			}
		},
		get arrayBuffer() {
			return res.arrayBuffer;
		},
	};
};

export interface LogEntry {
	time: number;
	level: 'info' | 'warn' | 'error';
	msg: string;
}

/** Encryption that will be set up on the cloud folder. */
export interface EncryptionChoice {
	password: string;
	alg: Keyfile['alg'];
	names: boolean;
	kdf: 'argon2id' | 'pbkdf2';
}

export class SyncManager {
	status: SyncStatus = 'off';
	statusDetail = '';
	state: SyncState;
	log: LogEntry[] = [];
	private dirty = new Set<string>();
	private running = false;
	private blocked = false;
	private again = false;
	private againFull = false;
	private lastRemoteCheck = 0;
	private lastFull = 0;
	private lastConfigScan = 0;
	private backoffUntil = 0;
	private backoffMs = 0;
	private pushTimer: number | null = null;
	private ticker: number | null = null;
	started = false;
	private creds: Credentials | null = null;
	private inner: Remote | null = null;
	private secure: SecureRemote | null = null;
	/** Unlocked data key (memory only unless "remember" is on). */
	private dek: Uint8Array | null = null;
	private pendingMassDelete = false;
	private unlockShown = false;
	// ---- health of the service
	/** Cloud full: uploads are held back (downloads go on) until space is back. */
	quota: { since: number; reason: string } | null = null;
	/** Next cycle tries uploads again to find out whether space is back (no space API). */
	private quotaProbe = false;
	private quotaCheckAt = 0;
	space: Space | null = null;
	spaceAt = 0;
	private spaceBusy: Promise<Space | null> | null = null;
	private uploadedSinceSpace = 0;
	private plannedBytes = 0;
	problem: Problem | null = null;
	lastOk = 0;
	private failSince = 0;
	private failCount = 0;
	private errStreak = 0;
	private fileFails = new Map<string, number>();

	constructor(
		private app: App,
		private plugin: AmbraiaPlugin,
		readonly hub: SyncHub,
		/** The service this manager syncs with (same object as in settings.syncTargets). */
		public t: SyncTarget,
	) {
		this.state = emptyState(this.stateKey);
	}

	get id() {
		return this.t.id;
	}

	get settings() {
		return this.plugin.settings;
	}

	/** Shared view of the local vault. */
	private get local(): ObsidianLocal {
		return this.hub.local;
	}

	/** The first service keeps the storage names of the single-service versions. */
	private sfx(name: string) {
		return this.t.id === 'main' ? name : `${name}-${this.t.id}`;
	}

	get provider(): ProviderId {
		return this.creds?.provider ?? this.t.provider;
	}

	get providerName() {
		return providerMeta(this.provider).name;
	}

	/** "Google Drive · Ambraia/Vault": tells services of the same kind apart. */
	get label() {
		const same = this.hub.managers.filter((m) => m.provider === this.provider).length > 1;
		return same ? `${this.providerName} · ${this.folder}` : this.providerName;
	}

	/** Cloud directory used for this vault. */
	get folder() {
		return cleanPath(this.t.folder) || defaultFolder(this.app.vault.getName());
	}

	get isFolderProvider() {
		return this.provider === 'mega' || this.provider === 'proton';
	}

	/** MEGA / Proton Drive: local folder of the desktop app (stored per device). */
	get localBase(): string {
		try {
			return String(this.app.loadLocalStorage(this.sfx(LOCAL_BASE)) ?? '');
		} catch {
			return '';
		}
	}

	setLocalBase(p: string) {
		this.app.saveLocalStorage(this.sfx(LOCAL_BASE), p || null);
		this.inner = null;
		this.secure = null;
	}

	/** Identifies the remote the saved state belongs to (legacy Drive states used the bare folder). */
	get stateKey() {
		const p = this.provider;
		if (p === 'gdrive' && this.t.id === 'main') return this.folder;
		return `${p}:${this.isFolderProvider ? this.localBase + '|' : ''}${this.folder}`;
	}

	/** In the state folder (survives plugin updates); read from the plugin folder as a fallback. */
	private get statePath() {
		return `${this.plugin.stateDir}/${this.sfx('sync-state')}.json`;
	}

	private get legacyStatePath() {
		return `${this.pluginDir}/${this.sfx('sync-state')}.json`;
	}

	private get pluginDir() {
		return this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/ambraia`;
	}

	onChange(cb: () => void) {
		this.hub.onChange(cb);
	}

	private emit() {
		this.hub.emit();
	}

	addLog(level: LogEntry['level'], msg: string) {
		this.log.push({ time: Date.now(), level, msg: redact(msg) });
		this.hub.logChanged();
		if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
	}

	// ------------------------------------------------------------ credentials (OS secret storage only)

	private secret(id: string): string | null {
		try {
			return this.app.secretStorage.getSecret(id) || null;
		} catch {
			return null;
		}
	}

	private setSecret(id: string, v: string) {
		this.app.secretStorage.setSecret(id, v);
	}

	loadCredentials(): Credentials | null {
		let raw = this.secret(this.sfx(SECRET_CREDS));
		let legacy = false;
		if (!raw && this.t.id === 'main') {
			for (const id of LEGACY_CREDS) if ((raw = this.secret(id))) break;
			legacy = !!raw;
		}
		if (!raw) return null;
		try {
			const c = JSON.parse(raw) as Credentials;
			if (!c.provider) c.provider = 'gdrive';
			if (legacy) {
				this.setSecret(SECRET_CREDS, JSON.stringify(c));
				for (const id of LEGACY_CREDS) this.setSecret(id, '');
			}
			return c;
		} catch {
			return null;
		}
	}

	async saveCredentials(c: Credentials | null) {
		this.setSecret(this.sfx(SECRET_CREDS), c ? JSON.stringify(c) : '');
		this.creds = c;
		this.inner = null;
		this.secure = null;
		if (c && this.t.provider !== c.provider) {
			this.t.provider = c.provider;
			await this.plugin.saveSettings();
		}
	}

	get connected() {
		const c = this.creds;
		if (!c) return false;
		if (c.provider === 'mega' || c.provider === 'proton') return !!this.localBase;
		return !!(c.refreshToken || c.accessToken);
	}

	get credentials() {
		return this.creds;
	}

	private remoteFor(c: Credentials, folder = this.folder): Remote {
		if (this.hub.remoteFactory) return this.hub.remoteFactory(c, folder);
		return makeRemote(obsidianHttp, c, {
			folder,
			localBase: this.localBase,
			onRotate: (n) => {
				this.creds = n;
				this.setSecret(this.sfx(SECRET_CREDS), JSON.stringify(n));
			},
		}).remote;
	}

	private getInner(): Remote {
		if (!this.creds) throw new AuthError('not-connected');
		if (!this.inner) this.inner = this.remoteFor(this.creds);
		return this.inner;
	}

	/** Checks credentials (and folder) without changing anything. Returns the account label. */
	async test(c: Credentials): Promise<string> {
		const r = this.remoteFor(c);
		await r.findRoot();
		try {
			return (await r.account?.()) || providerMeta(c.provider).name;
		} catch {
			return providerMeta(c.provider).name;
		}
	}

	// ------------------------------------------------------------ data key

	private cachedKey(kid: string): Uint8Array | null {
		if (this.dek) return this.dek;
		const raw = this.secret(this.sfx(SECRET_KEY));
		if (!raw) return null;
		try {
			const o = JSON.parse(raw) as { kid: string; k: string };
			return o.kid === kid ? unb64(o.k) : null;
		} catch {
			return null;
		}
	}

	private keepKey(kid: string, dek: Uint8Array) {
		this.dek = dek;
		try {
			this.setSecret(this.sfx(SECRET_KEY), this.t.remember ? JSON.stringify({ kid, k: b64(dek) }) : '');
		} catch {
			/* memory only */
		}
	}

	forgetKey() {
		this.dek = null;
		try {
			this.setSecret(this.sfx(SECRET_KEY), '');
		} catch {
			/* ignore */
		}
	}

	get unlocked() {
		return !!this.dek;
	}

	/**
	 * Inspects the cloud folder: plain or encrypted, and whether this device has the key.
	 * Returns false when sync has to wait for the master key.
	 */
	private async prepare(): Promise<boolean> {
		const inner = this.getInner();
		const root = await inner.findRoot();
		const kf = root ? await readKeyfile(inner, root.id) : null;
		if (!kf) {
			if (this.t.encrypt) throw new EncryptionStateError('keyfile-missing');
			if (this.state.keyKid) this.resetStateMemory();
			this.secure = new SecureRemote(inner, null);
			if (root) this.secure.bind(root.id, null);
			return true;
		}
		if (!this.t.encrypt) {
			// another device turned encryption on
			this.t.encrypt = true;
			await this.plugin.saveSettings();
			this.addLog('info', tx('La cartella nel cloud è cifrata: serve la chiave principale.'));
		}
		let dek = this.cachedKey(kf.keyfile.kid);
		if (dek && !(await keyMatches(kf.keyfile, dek))) dek = null;
		if (!dek) {
			this.dek = null;
			this.setLocked();
			return false;
		}
		this.dek = dek;
		if (this.state.keyKid !== kf.keyfile.kid) {
			// different key = different remote files: start a fresh, non-destructive comparison
			this.resetStateMemory();
			this.state.keyKid = kf.keyfile.kid;
		}
		this.secure = new SecureRemote(inner, new Cipher(dek, kf.keyfile.alg, kf.keyfile.names), kf.file.rev);
		this.secure.bind(root!.id, kf.file.id);
		return true;
	}

	private setLocked() {
		this.stop('locked');
		if (!this.unlockShown) {
			this.unlockShown = true;
			this.hub.requestUnlock(this);
		}
	}

	openUnlock() {
		this.hub.openUnlock(this);
	}

	/** Reads the key file and checks the master key without changing anything. */
	async verifyKey(password: string): Promise<Uint8Array> {
		const inner = this.getInner();
		const root = await inner.findRoot();
		const kf = root ? await readKeyfile(inner, root.id) : null;
		if (!kf) throw new EncryptionStateError('keyfile-missing');
		return unlockKeyfile(kf.keyfile, password);
	}

	/** Unlocks with the master key; throws WrongKeyError. */
	async unlock(password: string, remember: boolean) {
		const inner = this.getInner();
		const root = await inner.findRoot();
		const kf = root ? await readKeyfile(inner, root.id) : null;
		if (!kf) throw new EncryptionStateError('keyfile-missing');
		const dek = await unlockKeyfile(kf.keyfile, password);
		this.t.remember = remember;
		this.t.encrypt = true;
		await this.plugin.saveSettings();
		this.keepKey(kf.keyfile.kid, dek);
		this.secure = null;
		this.unlockShown = false;
		if (this.t.enabled) this.start();
	}

	/** Vault folders already on this account (next to the configured one). */
	async vaultFolders(): Promise<string[]> {
		try {
			return (await this.getInner().vaultFolders?.()) ?? [];
		} catch {
			return [];
		}
	}

	/** Folders that the other devices of the chain use on this provider, with their names. */
	async chainFolders(provider: string): Promise<Map<string, string[]>> {
		const out = new Map<string, string[]>();
		const me = deviceId(this.app);
		for (const m of this.hub.managers) {
			if (!m.connected || m === this) continue;
			try {
				const reg = await m.registry();
				for (const e of (await reg?.list(me)) ?? []) {
					if (e.info.id === me) continue;
					for (const x of e.info.folders ?? []) {
						if (x.p !== provider || typeof x.f !== 'string') continue;
						const names = out.get(x.f) ?? [];
						if (!names.includes(e.info.name)) names.push(e.info.name);
						out.set(x.f, names);
					}
				}
			} catch {
				/* offline: no suggestion from this service */
			}
		}
		return out;
	}

	/** Reads the key file of the configured folder (null = plain / empty). */
	async inspectRemote(): Promise<{ keyfile: Keyfile | null; hasFiles: boolean }> {
		const inner = this.getInner();
		const root = await inner.findRoot();
		if (!root) return { keyfile: null, hasFiles: false };
		const kf = await readKeyfile(inner, root.id);
		const all = await inner.listAll(root.id);
		return { keyfile: kf?.keyfile ?? null, hasFiles: all.some((f) => !(f.parentId === root.id && f.name === KEYFILE)) };
	}

	/** Waits for the running cycle and keeps new ones from starting while fn runs. */
	private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
		this.blocked = true;
		try {
			while (this.running) await new Promise((r) => window.setTimeout(r, 100));
			return await fn();
		} finally {
			this.blocked = false;
		}
	}

	/**
	 * Rewrites the cloud folder with a new encryption setting (or plain when null).
	 * Order matters for safety: everything is synced first, the state is reset before anything
	 * is removed, the new key file is written before old files go to the cloud trash.
	 * @param presync false only when the old data cannot be read anymore (forgotten key).
	 */
	async reformat(target: EncryptionChoice | null, presync = true) {
		try {
			await this.doReformat(target, presync);
		} catch (e) {
			this.secure = null;
			this.setStatus('error', redact(String((e as Error)?.message ?? e)));
			throw e;
		} finally {
			if (this.t.enabled) this.start();
		}
	}

	private async doReformat(target: EncryptionChoice | null, presync: boolean) {
		await this.exclusive(async () => {
			this.stop('syncing');
			this.statusDetail = tx('Riorganizzo i file nel cloud…');
			const inner = this.getInner();
			if (presync) {
				if (!this.secure && !(await this.prepare())) throw new Error(tx('Sblocca prima la cifratura con la chiave principale.'));
				const report = await this.hub.serial(() => this.engine('block').run(new Set(this.dirty), true));
				this.dirty.clear();
				if (report.errors.length || report.heldBack.length) {
					for (const p of report.retry) this.dirty.add(p);
					throw new Error(tx('Alcuni file non sono stati sincronizzati: riprova prima di cambiare la cifratura.'));
				}
			}
			await this.ensureRoomForEverything();
			const root = (await inner.findRoot()) ?? (await inner.createRoot());
			const old = await readKeyfile(inner, root.id).catch(() => null);
			this.resetStateMemory();
			let keep: string | null = null;
			if (target) {
				const { keyfile, dek } = await createKeyfile(target.password, target.alg, target.names, target.kdf);
				const file = await writeKeyfile(inner, root.id, keyfile, old?.file);
				keep = file.id;
				this.state.keyKid = keyfile.kid;
				this.keepKey(keyfile.kid, dek);
			} else {
				this.forgetKey();
			}
			this.t.encrypt = !!target;
			if (target) {
				this.t.alg = target.alg;
				this.t.names = target.names;
			}
			this.t.enabled = true;
			await this.plugin.saveSettings();
			await this.saveStateNow();
			for (const f of await inner.listAll(root.id)) {
				if (f.parentId === root.id && f.id !== keep) await (f.isFolder && inner.trashTree ? inner.trashTree(f.id) : inner.trash(f.id));
			}
			this.secure = null;
			this.addLog('info', target ? tx('Cartella nel cloud cifrata con {0}.', target.alg) : tx('Cifratura disattivata: i file nel cloud sono ora in chiaro.'));
		});
	}

	/**
	 * Rewriting the cloud folder uploads the whole vault again (and the old copies stay in the
	 * cloud trash for a while): refuse up front when it cannot fit, instead of leaving half of it.
	 */
	private async ensureRoomForEverything() {
		this.spaceAt = 0;
		const s = await this.getSpace(0);
		if (!s) return;
		let need = 0;
		for (const e of await this.local.list()) if (!e.isFolder && !this.local.isIgnored(e.path)) need += e.size;
		const free = s.total - s.used;
		if (free < need) throw new QuotaError(tx('Spazio insufficiente su {0}: per riscrivere i file servono circa {1}, ma ne restano {2}. Libera spazio (svuota anche il cestino del cloud) e riprova.', this.label, formatBytes(need), formatBytes(Math.max(0, free))));
	}

	/** First connection to an empty or new folder with encryption. */
	async setupEncryption(target: EncryptionChoice) {
		const { keyfile, hasFiles } = await this.inspectRemote();
		if (keyfile) throw new Error(tx('Questa cartella è già cifrata: usa la sua chiave principale.'));
		await this.reformat(target, hasFiles);
	}

	/** New master key, same data key: no file is re-uploaded. */
	async changeMasterKey(current: string, next: string) {
		await this.exclusive(async () => {
			const inner = this.getInner();
			const root = await inner.findRoot();
			const kf = root ? await readKeyfile(inner, root.id) : null;
			if (!root || !kf) throw new EncryptionStateError('keyfile-missing');
			const dek = await unlockKeyfile(kf.keyfile, current);
			const nk = await rewrapKeyfile(kf.keyfile, dek, next, this.settings.syncKdf);
			await writeKeyfile(inner, root.id, nk, kf.file);
			this.keepKey(nk.kid, dek);
			this.secure = null;
			this.addLog('info', tx('Chiave principale cambiata.'));
		});
		this.requestSync();
	}

	/** Remote turned plain on another device: follow it on this one. */
	async turnOffEncryptionHere() {
		this.t.encrypt = false;
		this.forgetKey();
		await this.plugin.saveSettings();
		await this.resetState();
		this.start();
	}

	// ------------------------------------------------------------ pairing and device list

	/** Small control folders next to the vault folder (pairing offers, device list). */
	controlRemote(folder: string, creds: Credentials | null = this.creds): Remote {
		if (!creds) throw new AuthError('not-connected');
		return this.remoteFor(creds, folder);
	}

	/**
	 * One-time code for a new device: valid 5 minutes, deleted when used, expired or when the window
	 * closes. Nothing secret is attached to the code: folder, encryption settings, data key and
	 * circle key are sent only after the user approves the new device, encrypted for it alone.
	 * Account access never travels: the new device signs in to the cloud by itself.
	 * Any device of the list can invite: the new device gets a certificate signed by this one.
	 */
	async startPairing(): Promise<PairingOffer> {
		if (!this.connected) throw new AuthError('not-connected');
		if (this.t.encrypt && !this.dek) await this.prepare().catch(() => false);
		const me = { id: deviceId(this.app), name: deviceName(this.app) };
		const offer = new PairingOffer(this.controlRemote(PAIR_FOLDER), { provider: this.provider, folder: this.folder, from: me }, async (ack) => {
			const dek = this.t.encrypt ? this.dek : null;
			const reg = await this.registry();
			const ck = this.circleKey();
			let intro: { cert?: DeviceCert; members?: Record<string, string>; revoked?: Record<string, number> } = {};
			if (reg) {
				// a device removed earlier with the same id is let in again by this new approval
				await reg.readmit(ack.id, me).catch(() => undefined);
				const { members, revoked, cert, sign } = await reg.introduce(me.id);
				const rest = { ...revoked };
				delete rest[ack.id];
				intro = { cert: await issueCert(sign, ack.id, ack.spub, cert), members: { ...members, [ack.id]: ack.spub }, revoked: rest };
				const t = this.trust() ?? emptyTrust();
				t.members[ack.id] = ack.spub;
				delete t.revoked[ack.id];
				this.saveTrust(t);
			}
			return {
				encrypt: this.t.encrypt,
				alg: this.t.alg,
				names: this.t.names,
				sharedKey: this.t.sharedKey,
				kid: dek ? this.state.keyKid : undefined,
				dek: dek ? b64(dek) : undefined,
				circle: !this.t.encrypt && ck ? b64(ck) : undefined,
				...intro,
			};
		});
		await offer.publish();
		return offer;
	}

	// ------------------------------------------------------------ device keys (keychain only)

	private circleKey(): Uint8Array | null {
		const v = this.secret(this.sfx('ambraia-circle'));
		return v ? unb64(v) : null;
	}

	/** Trusted devices and removals known to this device for this service (keychain). */
	private trust(): TrustState | null {
		const raw = this.secret(this.sfx('ambraia-circle-trust'));
		if (!raw) return null;
		try {
			const t = JSON.parse(raw) as TrustState;
			return t && t.v === 1 && t.members && t.revoked ? t : null;
		} catch {
			return null;
		}
	}

	private saveTrust(t: TrustState) {
		const v = JSON.stringify(t);
		if (this.secret(this.sfx('ambraia-circle-trust')) !== v) this.setSecret(this.sfx('ambraia-circle-trust'), v);
	}

	private registryKeys(): RegistryKeys {
		return {
			circleKey: () => this.circleKey(),
			setCircleKey: (k) => this.setSecret(this.sfx('ambraia-circle'), b64(k)),
			signKeys: () => deviceSignKeys(this.app),
			trust: () => this.trust(),
			saveTrust: (t) => this.saveTrust(t),
			cert: () => {
				const raw = this.secret(this.sfx('ambraia-circle-cert'));
				try {
					return raw ? (JSON.parse(raw) as DeviceCert) : null;
				} catch {
					return null;
				}
			},
			setCert: (c) => this.setSecret(this.sfx('ambraia-circle-cert'), c ? JSON.stringify(c) : ''),
		};
	}

	/**
	 * New device, after the code: takes over encryption settings and data key.
	 * Returns false when the master key is still needed.
	 */
	async adoptPairing(p: PairPayload): Promise<boolean> {
		// circle key (plain folders), certificate and trusted devices travel only inside the approved, encrypted grant
		if (p.circle) this.setSecret(this.sfx('ambraia-circle'), p.circle);
		if (p.cert) this.setSecret(this.sfx('ambraia-circle-cert'), JSON.stringify(p.cert));
		if (p.members) this.saveTrust({ v: 1, members: { ...p.members }, revoked: { ...(p.revoked ?? {}) }, restored: {} });
		this.registryCache = null;
		this.t.alg = p.alg ?? this.t.alg;
		this.t.names = p.names ?? this.t.names;
		this.t.sharedKey = p.sharedKey ?? this.t.sharedKey;
		const dek = payloadKey(p);
		if (p.encrypt) {
			const inner = this.getInner();
			const root = await inner.findRoot();
			const kf = root ? await readKeyfile(inner, root.id) : null;
			this.t.encrypt = !!kf;
			if (kf && dek && kf.keyfile.kid === p.kid && (await keyMatches(kf.keyfile, dek))) {
				this.keepKey(kf.keyfile.kid, dek);
				this.t.enabled = true;
				await this.plugin.saveSettings();
				this.start();
				return true;
			}
			if (kf) {
				await this.plugin.saveSettings();
				return false;
			}
		}
		this.t.encrypt = false;
		this.t.enabled = true;
		await this.plugin.saveSettings();
		this.start();
		return true;
	}

	private registryCache: { key: string; reg: DeviceRegistry } | null = null;
	private lastBeat = 0;

	/** Device list of this cloud folder; null while an encrypted folder is locked. */
	async registry(): Promise<DeviceRegistry | null> {
		if (!this.connected) return null;
		if (this.t.encrypt && !this.dek) await this.prepare().catch(() => false);
		if (this.t.encrypt && !this.dek) return null;
		const cacheKey = `${this.provider}|${this.folder}|${this.t.encrypt ? this.state.keyKid : 'plain'}`;
		if (this.registryCache?.key === cacheKey) return this.registryCache.reg;
		const key = this.t.encrypt && this.dek ? await subKey(this.dek, 'ambraia devices v1') : null;
		const reg = new DeviceRegistry(this.controlRemote(await devicesFolder(this.folder)), key, this.registryKeys());
		this.registryCache = { key: cacheKey, reg };
		return reg;
	}

	/** Publishes this device in the list and runs a command addressed to it. */
	async beat(force = false) {
		if (!force && Date.now() - this.lastBeat < BEAT_EVERY) return;
		this.lastBeat = Date.now();
		try {
			const reg = await this.registry();
			if (!reg) return;
			const folders = this.hub.managers.filter((m) => m.connected).map((m) => ({ p: m.t.provider, f: m.folder }));
			const cmd = await reg.heartbeat({ id: deviceId(this.app), name: deviceName(this.app), platform: platformName(), version: this.plugin.manifest.version, folders });
			if (cmd) return void (await this.hub.runCommand(this, cmd));
			// shared links travel with the device list (encrypted), so every device can answer and manage them
			const me = deviceId(this.plugin.app);
			await this.plugin.shares?.syncWith({ readShares: () => reg.readShares(), writeShare: (id, d) => reg.writeShare(id, d, me), removeShare: (id) => reg.removeShare(id) });
		} catch (e) {
			this.addLog('warn', tx('Elenco dispositivi non aggiornato: {0}', (e as Error)?.message ?? e));
		}
	}

	/** Removes this device from the list (before forgetting the service here). */
	async leaveRegistry() {
		try {
			const reg = this.connected ? await this.registry() : null;
			await reg?.forget(deviceId(this.app));
		} catch {
			/* offline: the entry simply ages */
		}
		this.registryCache = null;
	}

	/** A command arrived for this device: acknowledged by deleting it with the entry. */
	commandDone(_c: DeviceCommand) {
		return this.leaveRegistry();
	}

	/** New sign-in for a service whose access expired or was revoked: folder, encryption and state stay. */
	async reauthenticate(c: Credentials) {
		this.stop('off');
		await this.saveCredentials(c);
		this.errStreak = 0;
		this.backoffUntil = 0;
		this.backoffMs = 0;
		this.problem = null;
		this.registryCache = null;
		this.addLog('info', tx('Accesso a {0} rinnovato.', this.providerName));
		if (this.t.enabled) this.start();
		this.emit();
	}

	// ------------------------------------------------------------ lifecycle

	/** Loads credentials and state; starts when enabled. Returns false when this device still has to be linked. */
	async init(): Promise<boolean> {
		this.creds = this.loadCredentials();
		await this.loadState();
		this.loadHealth();
		if (this.t.enabled && this.connected) this.start();
		else this.setStatus('off');
		return this.connected;
	}

	private async loadState() {
		try {
			const adapter = this.app.vault.adapter;
			for (const p of [this.statePath, this.legacyStatePath]) {
				if (!(await adapter.exists(p))) continue;
				const s = JSON.parse(await adapter.read(p)) as SyncState;
				if (s && s.vaultKey === this.stateKey) {
					this.state = migrateState({ ...emptyState(this.stateKey), ...s });
					return;
				}
			}
		} catch (e) {
			this.addLog('warn', tx('Stato della sincronizzazione illeggibile, verrà ricostruito: {0}', e));
		}
		this.state = emptyState(this.stateKey);
	}

	private saveStateNow = async () => {
		try {
			await ensureStateDir(this.app);
			const tmp = this.statePath + '.tmp';
			await this.app.vault.adapter.write(tmp, JSON.stringify(this.state));
			if (await this.app.vault.adapter.exists(this.statePath)) await this.app.vault.adapter.remove(this.statePath);
			await this.app.vault.adapter.rename(tmp, this.statePath);
		} catch (e) {
			this.addLog('error', tx('Impossibile salvare lo stato: {0}', e));
		}
	};

	/** Vault events, forwarded by the hub. */
	onDelete(f: TAbstractFile) {
		if (f instanceof TFolder) {
			for (const k of Object.keys(this.state.base)) if (k.startsWith(f.path + '/')) this.dirty.add(k);
		}
		this.onLocal(f.path);
	}

	onRename(f: TAbstractFile, oldPath: string) {
		if (!this.started) return;
		const ignoredOld = this.local.isIgnored(oldPath);
		const ignoredNew = this.local.isIgnored(f.path);
		if (!ignoredOld && !ignoredNew) this.state.pendingRenames.push({ from: oldPath, to: f.path });
		if (!ignoredOld) this.dirty.add(oldPath);
		if (f instanceof TFolder) {
			for (const k of Object.keys(this.state.base)) if (k.startsWith(oldPath + '/')) this.dirty.add(k);
		}
		this.onLocal(f.path);
	}

	wake() {
		if (this.started) this.requestSync();
	}

	/** Leaving the foreground: push what is pending. */
	flush() {
		if (this.started && this.dirty.size) this.requestSync();
	}

	/** Files changed on disk by another service: send them here too. */
	markDirty(paths: string[], full = false) {
		if (!this.started) return;
		for (const p of paths) if (!this.local.isIgnored(p)) this.dirty.add(p);
		if (paths.length || full) this.requestSync(full);
	}

	onLocal(path: string) {
		if (!this.started || this.local.isIgnored(path)) return;
		this.dirty.add(path);
		this.emit();
		if (this.pushTimer) window.clearTimeout(this.pushTimer);
		this.pushTimer = window.setTimeout(() => {
			this.pushTimer = null;
			this.requestSync();
		}, Math.max(300, this.settings.pushDelayMs));
	}

	start() {
		if (this.started) return;
		if (!this.connected) {
			this.setStatus('off');
			return;
		}
		if (this.state.vaultKey !== this.stateKey) this.state = emptyState(this.stateKey);
		this.started = true;
		this.setStatus('idle');
		this.ticker = window.setInterval(() => this.tick(), 1000);
		this.plugin.registerInterval(this.ticker);
		this.requestSync(true);
	}

	stop(status: SyncStatus = 'off') {
		this.started = false;
		if (this.ticker) window.clearInterval(this.ticker);
		this.ticker = null;
		if (this.pushTimer) window.clearTimeout(this.pushTimer);
		this.pushTimer = null;
		this.setStatus(status);
	}

	async unload() {
		this.started = false;
		if (this.ticker) window.clearInterval(this.ticker);
		await this.saveStateNow();
	}

	/** Call after changing provider, folder or sync options. */
	settingsChanged() {
		if (this.state.vaultKey !== this.stateKey && !this.running) {
			this.inner = null;
			this.secure = null;
			this.state = emptyState(this.stateKey);
		}
		if (this.t.enabled && this.connected && !this.started && this.status !== 'locked') this.start();
		if ((!this.t.enabled || !this.connected) && this.started) this.stop();
		if (!this.t.enabled && !this.started && this.status !== 'off' && this.status !== 'paused' && this.status !== 'locked') this.setStatus('off');
		this.emit();
	}

	private tick() {
		if (!this.started || this.running) return;
		const now = Date.now();
		if (this.quota && now - this.quotaCheckAt >= QUOTA_RECHECK) {
			this.quotaCheckAt = now;
			void this.recheckQuota();
		}
		if (now < this.backoffUntil) return;
		const focused = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
		const interval = (focused ? this.settings.pollSeconds : this.settings.backgroundPollSeconds) * 1000;
		if (now - this.lastRemoteCheck >= Math.max(2000, interval)) {
			const full = now - this.lastFull > 10 * 60_000;
			this.requestSync(full);
			return;
		}
		const anyConfig = this.settings.syncConfigSettings || this.settings.syncConfigAppearance || this.settings.syncConfigPlugins;
		if (anyConfig && now - this.lastConfigScan > 30_000) {
			this.lastConfigScan = now;
			void this.scanConfig();
		}
	}

	/** Config files don't emit vault events: compare stat with the last synced state. */
	private async scanConfig() {
		try {
			const entries = await this.local.listConfigOnly();
			const seen = new Set<string>();
			for (const e of entries) {
				seen.add(e.path);
				const b = this.state.base[e.path];
				if (!b || (!e.isFolder && (b.mtime !== e.mtime || b.size !== e.size))) this.dirty.add(e.path);
			}
			for (const k of Object.keys(this.state.base)) {
				if (this.local.isConfigPath(k) && !seen.has(k)) this.dirty.add(k);
			}
			if (this.dirty.size) this.requestSync();
		} catch (e) {
			this.addLog('warn', tx('Scansione configurazione: {0}', e));
		}
	}

	requestSync(full = false) {
		if (!this.started) return;
		if (this.running || this.blocked) {
			this.again = true;
			this.againFull = this.againFull || full;
			return;
		}
		void this.runLoop(full);
	}

	async syncNow(full = true) {
		if (!this.connected) {
			new Notice(tx('Ambraia: collega prima un servizio cloud dalle impostazioni.'));
			return;
		}
		if (this.status === 'locked') {
			this.openUnlock();
			return;
		}
		if (!this.started) {
			if (!this.t.enabled) {
				this.t.enabled = true;
				await this.plugin.saveSettings();
			}
			this.start();
			return;
		}
		this.backoffUntil = 0;
		if (this.quota) {
			// the user may have freed space: look again now
			this.quotaProbe = true;
			this.spaceAt = 0;
		}
		this.requestSync(full);
	}

	private async runLoop(full: boolean) {
		this.running = true;
		try {
			let doFull = full;
			do {
				this.again = false;
				await this.hub.serial(() => this.cycle(doFull));
				doFull = this.againFull;
				this.againFull = false;
			} while (this.again && this.started && !this.blocked && Date.now() >= this.backoffUntil);
		} finally {
			this.running = false;
			this.emit();
		}
	}

	private engine(massMode: 'block' | 'allow' | 'restore') {
		return new SyncEngine(this.state, this.local, this.secure!, {
			maxFileSize: this.settings.maxFileSizeMB * 1024 * 1024,
			allowMassDelete: massMode !== 'block',
			massDeleteMode: massMode,
			conflictLabel: tx('conflitto'),
			log: (m) => this.addLog('info', m),
			conflictMode: 'merge',
			bases: this.hub.bases,
			noUploads: !!this.quota && !this.quotaProbe,
			canUpload: (bytes) => this.checkSpace(bytes),
		});
	}

	private async cycle(full: boolean, massMode: 'block' | 'allow' | 'restore' = 'block') {
		const snapshot = this.dirty;
		this.dirty = new Set();
		this.lastRemoteCheck = Date.now();
		if (full) this.lastFull = Date.now();
		const busy = snapshot.size > 0 || full;
		try {
			if (!this.secure) {
				if (!(await this.prepare())) {
					for (const p of snapshot) this.dirty.add(p);
					return;
				}
				full = true;
			}
			if (busy || full) this.setStatus('syncing');
			const report = await this.engine(massMode).run(snapshot, full);
			for (const p of report.retry) this.dirty.add(p);
			this.handleReport(report);
			this.hub.localChanged(this, report);
			await this.hub.tidy(report);
			this.backoffMs = 0;
			this.backoffUntil = 0;
			await this.saveStateNow();
			this.afterCycle(report);
			await this.hub.gcBases();
		} catch (e) {
			for (const p of snapshot) this.dirty.add(p);
			await this.saveStateNow();
			this.handleError(e);
		}
	}

	private handleError(e: unknown) {
		const name = this.label;
		const now = Date.now();
		if (e instanceof LimitError) {
			const wait = Math.max(30_000, e.waitMs);
			this.backoffMs = 0;
			this.backoffUntil = now + wait;
			const at = new Date(now + wait).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			const msg = tx('{0} ha ricevuto troppe richieste o ha raggiunto un limite di utilizzo: riprendo da solo alle {1}. Le modifiche restano su questo dispositivo.', name, at);
			this.addLog('warn', `${msg} (${e.message})`);
			this.setStatus('offline', msg);
			const since = this.problem?.kind === 'limit' ? this.problem.since : now;
			this.noteProblem('limit', msg, wait >= 30 * MIN || now - since >= 30 * MIN);
			return;
		}
		if (e instanceof NetworkError) {
			if (!this.failSince) this.failSince = now;
			this.failCount++;
			const server = (e.status ?? 0) >= 500;
			const online = typeof navigator === 'undefined' || navigator.onLine !== false;
			const othersOk = this.hub.managers.some((m) => m !== this && m.started && m.lastOk > now - 15 * MIN && m.status !== 'offline');
			this.backoffMs = Math.min(server && this.failCount > 3 ? 5 * MIN : 60_000, Math.max(3000, this.backoffMs * 2));
			this.backoffUntil = now + this.backoffMs;
			if (server || (online && othersOk)) {
				// the device is online: the problem is on the service side
				const msg = server
					? tx('{0} non risponde correttamente (errore {1} del server). Riprovo automaticamente; le modifiche restano su questo dispositivo.', name, e.status)
					: tx('{0} non è raggiungibile, mentre la connessione funziona. Riprovo automaticamente; le modifiche restano su questo dispositivo.', name);
				this.setStatus('offline', msg);
				this.noteProblem('outage', msg, now - this.failSince >= OUTAGE_AFTER && this.failCount >= 3);
				return;
			}
			this.setStatus('offline', tx('Nessuna connessione: riproverò automaticamente'));
			return;
		}
		if (e instanceof QuotaError) {
			// refused outside the upload phase (folder creation, key file…): same treatment
			const r = emptyReport();
			r.quota = e.message || 'quota';
			this.enterQuota(r);
			this.backoffMs = 0;
			this.backoffUntil = now + 5 * MIN;
			this.setStatus('full', tx('{0} è pieno: caricamenti sospesi', name));
			return;
		}
		if (e instanceof LocalSpaceError) {
			this.backoffMs = 0;
			this.backoffUntil = now + 10 * MIN;
			const msg = tx('Lo spazio su questo dispositivo è esaurito: non riesco a salvare i file ricevuti da {0}. Libera spazio; riprovo ogni 10 minuti.', name);
			this.addLog('error', `${msg} (${e.message})`);
			this.setStatus('error', msg);
			this.noteProblem('local-space', msg, true, true);
			return;
		}
		if (e instanceof EncryptionStateError) {
			this.secure = null;
			if (e.kind === 'keyfile-missing') {
				const msg = tx('Il file della chiave di cifratura manca nella cartella nel cloud. Per proteggere i dati la sincronizzazione è in pausa: ripristinalo dal cestino del cloud oppure, se hai disattivato la cifratura su un altro dispositivo, disattivala anche qui (Impostazioni → Sincronizzazione).');
				this.addLog('error', msg);
				new Notice('Ambraia: ' + msg, 15000);
				this.stop('error');
				this.statusDetail = msg;
				return;
			}
			// the key file changed or appeared: inspect it again on the next cycle
			this.addLog('info', tx('Impostazioni di cifratura cambiate nel cloud: le rileggo.'));
			this.again = true;
			this.againFull = true;
			return;
		}
		if (e instanceof AuthError) {
			const m = e.message;
			const msg =
				m === 'no-folder'
					? tx('Scegli la cartella dell’app {0} in Impostazioni → Sincronizzazione.', name)
					: m === 'desktop-only'
						? tx('{0} funziona solo su computer (tramite la sua app desktop).', name)
						: tx('Accesso a {0} scaduto o revocato: ricollega il servizio dalle impostazioni.', name) + (m && m !== 'not-connected' ? ` (${m})` : '');
			this.addLog('error', msg);
			new Notice(`Ambraia: ${msg}`, 10000);
			this.stop('auth');
			this.statusDetail = msg;
			return;
		}
		if (e instanceof RootMissingError) {
			const msg = tx('La cartella "{0}" su {1} è stata eliminata o spostata. La sincronizzazione è in pausa: ripristinala dal cestino oppure usa "Riallinea da zero" nelle impostazioni.', this.folder, name);
			// nothing is touched while the folder is missing; look again every 15 minutes in case
			// it was a hiccup of the service or the user restores it from the trash
			this.backoffMs = 0;
			this.backoffUntil = now + 15 * MIN;
			this.setStatus('error', msg);
			this.noteProblem('root', msg, true, true);
			return;
		}
		if (e instanceof MassDeleteError) {
			this.stop('paused');
			this.statusDetail = tx('In attesa di conferma: {0} eliminazioni', e.count);
			this.askMassDelete(e);
			return;
		}
		this.addLog('error', String((e as Error)?.stack ?? e));
		// unexpected answers: back off further and further, tell the user once it persists
		this.errStreak++;
		this.backoffMs = Math.min(this.errStreak >= 3 ? 30 * MIN : 120_000, Math.max(5000, this.backoffMs * 2));
		this.backoffUntil = now + this.backoffMs;
		const detail = redact(String((e as Error)?.message ?? e));
		this.setStatus('error', detail);
		if (this.errStreak >= 3) {
			const mins = Math.max(1, Math.round(this.backoffMs / MIN));
			this.noteProblem('unexpected', tx('{0} risponde in modo inatteso ({1}). Riprovo automaticamente ogni {2} minuti; se il problema continua controlla lo stato del servizio o ricollega l’account dalle impostazioni.', name, detail.slice(0, 160), mins), true);
		}
	}

	// ------------------------------------------------------------ service health

	private alertKey(kind: string) {
		return `${this.id}:${kind}`;
	}

	/** Records a service-side problem; tells the user once (deduplicated across restarts). */
	private noteProblem(kind: Problem['kind'], msg: string, notify: boolean, sticky = false) {
		const p = this.problem?.kind === kind ? this.problem : { kind, msg, since: Date.now() };
		p.msg = msg;
		this.problem = p;
		if (notify && !p.notified) {
			p.notified = true;
			this.addLog('warn', msg);
			this.hub.alerts.show(this.alertKey(kind), msg, { cooldownMs: 6 * HOUR, sticky });
		}
		this.emit();
	}

	/** A cycle went through: clear outages / limits and say so when the user was warned. */
	private recovered() {
		this.failSince = 0;
		this.failCount = 0;
		this.errStreak = 0;
		const p = this.problem;
		if (!p || p.kind === 'quota' || p.kind === 'files') return;
		this.problem = null;
		const key = this.alertKey(p.kind);
		this.hub.alerts.dismiss(key);
		this.hub.alerts.reset(key);
		if (p.notified) {
			const msg = tx('{0} funziona di nuovo: sincronizzazione ripresa.', this.label);
			this.addLog('info', msg);
			new Notice('Ambraia: ' + msg, 6000);
		}
	}

	private afterCycle(report: SyncReport) {
		this.lastOk = Date.now();
		this.recovered();
		if (report.uploaded.length) this.uploadedSinceSpace += this.plannedBytes;
		this.plannedBytes = 0;
		if (report.quota) this.enterQuota(report);
		else if (this.quota && (report.uploaded.length || this.quotaProbe)) {
			// uploads went through, or the probe found nothing to refuse: say so only when it is certain
			const s = this.space;
			const fresh = !!s && Date.now() - this.spaceAt < 5 * MIN && s.total - s.used > 0;
			this.leaveQuota(report.uploaded.length > 0 || fresh);
		}
		this.quotaProbe = false;
		this.trackFileErrors(report);
		if (this.quota) this.setStatus('full', tx('{0} è pieno: caricamenti sospesi', this.label));
		else this.setStatus(report.errors.length ? 'error' : 'idle', report.errors.length ? tx('{0} errori (verranno ritentati)', report.errors.length) : '');
		// tests that replace the cloud call beat() explicitly
		if (this.hub.deviceList && !this.hub.remoteFactory) void this.beat();
	}

	/** Free space on the account (cached; null = unknown / unlimited / not supported). */
	async getSpace(maxAgeMs = 15 * MIN): Promise<Space | null> {
		if (Date.now() - this.spaceAt < maxAgeMs) return this.space;
		if (this.spaceBusy) return this.spaceBusy;
		let inner: Remote;
		try {
			inner = this.getInner();
		} catch {
			return null;
		}
		if (!inner.space) return null;
		this.spaceBusy = (async () => {
			try {
				const s = await inner.space!();
				this.space = s && s.total > 0 ? s : null;
				this.uploadedSinceSpace = 0;
			} catch (e) {
				this.addLog('info', tx('Spazio disponibile non leggibile: {0}', e));
			} finally {
				this.spaceAt = Date.now();
				this.spaceBusy = null;
			}
			this.emit();
			return this.space;
		})();
		return this.spaceBusy;
	}

	private shortBy: { free: number; need: number } | null = null;

	/** Pre-flight before uploading: never start uploads that cannot fit in the cloud. */
	private async checkSpace(bytes: number): Promise<boolean> {
		this.plannedBytes = bytes;
		const s = await this.getSpace(bytes > 20 * 1024 * 1024 ? 2 * MIN : 15 * MIN);
		if (!s) return true;
		const free = s.total - s.used - this.uploadedSinceSpace;
		if (free < bytes) {
			this.shortBy = { free: Math.max(0, free), need: bytes };
			return false;
		}
		const left = free - bytes;
		if (left < Math.max(s.total * 0.03, Math.min(200 * 1024 * 1024, s.total * 0.1))) {
			const msg = tx('Su {0} restano solo {1} liberi su {2}. Quando lo spazio finirà sospenderò i caricamenti senza perdere nulla, ma conviene liberare spazio o aumentare il piano.', this.label, formatBytes(left), formatBytes(s.total));
			if (this.hub.alerts.show(this.alertKey('low'), msg, { cooldownMs: 3 * 24 * HOUR })) this.addLog('warn', msg);
		}
		return true;
	}

	private enterQuota(report: SyncReport) {
		const now = Date.now();
		const first = !this.quota;
		this.quotaCheckAt = now;
		if (first) this.quota = { since: now, reason: report.quota! };
		this.saveHealth();
		const s = this.space;
		const short = report.quota === 'preflight' ? this.shortBy : null;
		const tail = tx('Ho sospeso i caricamenti per non lasciare copie incomplete nel cloud: i file restano su questo dispositivo e le modifiche dagli altri dispositivi continuano ad arrivare. Libera spazio o aumenta il piano: riprendo da solo appena c’è posto.');
		const msg =
			short && s && s.used < s.total
				? tx('Su {0} restano {1} liberi, ma servono circa {2} per caricare le modifiche in attesa.', this.label, formatBytes(short.free), formatBytes(short.need)) + ' ' + tail
				: tx('Lo spazio su {0} è esaurito{1}.', this.label, s ? ` (${tx('{0} usati su {1}', formatBytes(s.used), formatBytes(s.total))})` : '') + ' ' + tail;
		this.problem = { kind: 'quota', msg, since: this.quota!.since, notified: true };
		if (first) {
			this.addLog('warn', msg + (report.quota !== 'preflight' ? ` (${report.quota})` : ''));
			this.hub.alerts.show(this.alertKey('quota'), msg, { cooldownMs: 12 * HOUR, sticky: true });
		}
	}

	private leaveQuota(announce: boolean) {
		this.quota = null;
		this.quotaProbe = false;
		this.shortBy = null;
		this.saveHealth();
		if (this.problem?.kind === 'quota') this.problem = null;
		const key = this.alertKey('quota');
		if (announce) {
			this.hub.alerts.dismiss(key);
			this.hub.alerts.reset(key);
			const msg = tx('Su {0} c’è di nuovo spazio: riprendo i caricamenti.', this.label);
			this.addLog('info', msg);
			new Notice('Ambraia: ' + msg, 8000);
		}
		this.requestSync();
	}

	/** Periodic check while the cloud is full: try uploading again once there is room. */
	async recheckQuota() {
		if (!this.quota) return;
		const s = await this.getSpace(0);
		if (s && s.total - s.used <= (await this.pendingBytes())) return;
		// enough space, or no way to know: the next cycle tries the uploads
		this.quotaProbe = true;
		this.requestSync();
	}

	private async pendingBytes(): Promise<number> {
		let n = 0;
		let i = 0;
		for (const p of this.dirty) {
			if (i++ > 2000) break;
			try {
				n += (await this.local.stat(p))?.size ?? 0;
			} catch {
				/* gone */
			}
		}
		return n;
	}

	private trackFileErrors(report: SyncReport) {
		const next = new Map<string, number>();
		for (const e of report.errors) next.set(e.path, (this.fileFails.get(e.path) ?? 0) + 1);
		this.fileFails = next;
		const stuck = [...next].filter(([, n]) => n === 3).map(([p]) => p);
		if (stuck.length) {
			const list = stuck.slice(0, 5).join(', ') + (stuck.length > 5 ? ` (+${stuck.length - 5})` : '');
			const msg = tx('Alcuni file non riescono a sincronizzarsi con {0} e verranno ritentati: {1}. I dettagli sono nel registro della sincronizzazione.', this.label, list);
			if (this.problem?.kind !== 'quota') this.problem = { kind: 'files', msg, since: Date.now(), notified: true };
			this.hub.alerts.show(this.alertKey('files'), msg, { cooldownMs: 6 * HOUR });
		}
		if (!next.size && this.problem?.kind === 'files') this.problem = null;
	}

	private loadHealth() {
		try {
			const raw: unknown = this.app.loadLocalStorage(this.sfx(HEALTH));
			const o = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { quota?: { since: number; reason: string } } | null;
			if (o?.quota?.since) {
				this.quota = o.quota;
				// look again at the first cycle: space may have been freed meanwhile
				this.quotaProbe = true;
			}
		} catch {
			/* ignore */
		}
	}

	private saveHealth() {
		try {
			this.app.saveLocalStorage(this.sfx(HEALTH), this.quota ? JSON.stringify({ quota: this.quota }) : null);
		} catch {
			/* ignore */
		}
	}

	private askMassDelete(e: MassDeleteError) {
		if (this.pendingMassDelete) return;
		this.pendingMassDelete = true;
		new MassDeleteModal(this.app, e, this.label, async (choice) => {
			this.pendingMassDelete = false;
			this.started = true;
			this.ticker = window.setInterval(() => this.tick(), 1000);
			this.plugin.registerInterval(this.ticker);
			this.running = true;
			try {
				for (const p of e.paths) this.dirty.add(p);
				await this.hub.serial(() => this.cycle(true, choice));
			} finally {
				this.running = false;
				this.emit();
			}
		}).open();
	}

	private handleReport(r: SyncReport) {
		const parts: string[] = [];
		if (r.uploaded.length) parts.push(`↑${r.uploaded.length}`);
		if (r.downloaded.length) parts.push(`↓${r.downloaded.length}`);
		if (r.deletedLocal.length + r.deletedRemote.length) parts.push(`✕${r.deletedLocal.length + r.deletedRemote.length}`);
		if (r.renamedLocal.length + r.renamedRemote.length) parts.push(`⇄${r.renamedLocal.length + r.renamedRemote.length}`);
		if (parts.length)
			this.addLog(
				'info',
				`${parts.join(' ')}  ${[...r.uploaded.map((x) => '↑ ' + x), ...r.downloaded.map((x) => '↓ ' + x), ...r.deletedLocal.map((x) => '✕ ' + x), ...r.deletedRemote.map((x) => '✕☁ ' + x), ...r.renamedLocal, ...r.renamedRemote].slice(0, 20).join(', ')}`,
			);
		for (const err of r.errors) this.addLog('error', `${err.path}: ${err.error}`);
		// one version everywhere, decided automatically: just a line in the log
		if (r.merged.length) this.addLog('info', tx('Modifiche fatte su due dispositivi unite in una sola versione: {0}', r.merged.join(', ')));
		for (const x of r.replaced) this.addLog('info', tx('"{0}" modificato negli stessi punti su due dispositivi: vale la versione più recente.', x.path));
		const cfg = r.downloaded.filter((p) => this.local.isConfigPath(p));
		if (cfg.includes(`${this.pluginDir}/data.json`)) void this.plugin.onExternalSettingsChange();
		if (cfg.some((p) => p !== `${this.pluginDir}/data.json`)) this.hub.offerReload();
	}

	// ------------------------------------------------------------ status UI

	private setStatus(s: SyncStatus, detail = '') {
		this.status = s;
		this.statusDetail = detail;
		this.emit();
	}

	get pendingCount() {
		return this.dirty.size;
	}

	statusText(): { icon: string; text: string; tip: string } {
		const pending = this.dirty.size;
		const last = this.state.lastSync ? new Date(this.state.lastSync).toLocaleTimeString() : tx('mai');
		const lock = this.t.encrypt ? ' · ' + tx('cifrato') : '';
		switch (this.status) {
			case 'off':
				return { icon: 'cloud-off', text: '', tip: tx('Sincronizzazione disattivata – clic per configurare') };
			case 'syncing':
				return { icon: 'refresh-cw', text: pending ? String(pending) : '', tip: this.statusDetail || tx('Sincronizzazione in corso…') };
			case 'offline':
				return { icon: 'wifi-off', text: pending ? String(pending) : '', tip: this.statusDetail || tx('Offline') };
			case 'error':
				return { icon: 'alert-triangle', text: '', tip: tx('Errore: {0}', this.statusDetail) };
			case 'auth':
				return { icon: 'key-round', text: '', tip: this.statusDetail || tx('Ricollega {0}', this.label) };
			case 'locked':
				return { icon: 'lock', text: '', tip: tx('Dati cifrati: inserisci la chiave principale per sbloccare') };
			case 'paused':
				return { icon: 'pause-circle', text: '', tip: this.statusDetail || tx('In pausa') };
			case 'full':
				return { icon: 'hard-drive', text: pending ? String(pending) : '', tip: tx('{0} è pieno: {1} modifiche in attesa di caricamento. I file dagli altri dispositivi continuano ad arrivare.', this.label, pending) };
			default:
				return pending
					? { icon: 'cloud-upload', text: String(pending), tip: tx('{0} modifiche in coda', pending) }
					: { icon: 'cloud', text: '', tip: tx('Sincronizzato con {0}{1} · ultimo controllo {2}', this.label, lock, last) };
		}
	}

	async pause() {
		this.t.enabled = false;
		await this.plugin.saveSettings();
		this.stop('paused');
	}

	private resetStateMemory() {
		this.state = emptyState(this.stateKey);
		this.dirty.clear();
	}

	/** Forget the link with the cloud folder (files are NOT deleted anywhere). */
	async resetState() {
		this.stop('off');
		this.resetStateMemory();
		this.inner = null;
		this.secure = null;
		await this.saveStateNow();
	}

	async disconnect() {
		await this.leaveRegistry();
		await this.resetState();
		await this.saveCredentials(null);
		this.forgetKey();
		this.t.enabled = false;
		await this.plugin.saveSettings();
		this.emit();
	}

	/** Removes everything this device stored for the service (state file, credentials, key). */
	async destroy() {
		this.stop('off');
		await this.idle();
		await this.leaveRegistry();
		try {
			await this.saveCredentials(null);
		} catch {
			/* ignore */
		}
		this.forgetKey();
		// keys of the device list stay only while the service is used on this device
		for (const k of ['ambraia-circle', 'ambraia-circle-trust', 'ambraia-circle-cert', 'ambraia-circle-owner']) {
			try {
				if (this.secret(this.sfx(k))) this.setSecret(this.sfx(k), '');
			} catch {
				/* keychain unavailable */
			}
		}
		this.registryCache = null;
		if (this.isFolderProvider) this.app.saveLocalStorage(this.sfx(LOCAL_BASE), null);
		this.quota = null;
		this.saveHealth();
		for (const p of [this.statePath, this.legacyStatePath]) {
			try {
				if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
			} catch {
				/* ignore */
			}
		}
	}

	/** Resolves when no cycle is running (used by tests and before risky operations). */
	async idle() {
		while (this.running) await new Promise((r) => window.setTimeout(r, 5));
	}

	get isMobile() {
		return Platform.isMobile;
	}
}

/** Default cloud directory: "Ambraia/<vault name>". */
export const defaultFolder = (vault: string) => `Ambraia/${cleanPath(vault.replace(/[\\/:*?"<>|]/g, '_')) || 'Vault'}`;

/** Signing key of this device (one per device and vault, kept in the keychain). */
const signCache = new WeakMap<App, Promise<SignKeys>>();
export function deviceSignKeys(app: App): Promise<SignKeys> {
	let p = signCache.get(app);
	if (!p) {
		p = loadSignKeys(app);
		signCache.set(app, p);
	}
	return p;
}

async function loadSignKeys(app: App): Promise<SignKeys> {
	const ID = 'ambraia-device-sign';
	try {
		const raw = app.secretStorage.getSecret(ID);
		if (raw) {
			const k = JSON.parse(raw) as SignKeys;
			if (k?.pub && k.jwk) return k;
		}
	} catch {
		/* new key below */
	}
	const k = await newSignKeys();
	try {
		app.secretStorage.setSecret(ID, JSON.stringify(k));
	} catch {
		/* keychain unavailable: the key lives for this session */
	}
	return k;
}
