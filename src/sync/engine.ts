import { CONFLICT_COPY } from './tidy';
import { md5, BaseStore } from './types';
import { decodeText, isMergeable, merge2, merge3 } from './merge';
import {
	BaseEntry,
	LocalEntry,
	LocalFS,
	RemoteAPI,
	RemoteChange,
	RemoteFile,
	SyncReport,
	SyncState,
	emptyReport,
	HttpError,
} from './types';

/** Transport failure or server-side outage (status = last 5xx seen). Retried automatically. */
export class NetworkError extends Error {
	constructor(message?: string, public status?: number) {
		super(message);
	}
}
/** The service throttles us (429, daily limits): wait waitMs before trying again. */
export class LimitError extends NetworkError {
	constructor(message: string, public waitMs: number) {
		super(message);
	}
}
/** No space left on the cloud account (plan downgraded, quota exceeded…). */
export class QuotaError extends Error {}
/** The service answered with something that does not look like its API (changed API, proxy, captive portal). */
export class UnexpectedResponseError extends Error {
	constructor(what: string) {
		super(`Unexpected response from the service: ${what}`);
	}
}
/** No space left on this device: every local write would fail. */
export class LocalSpaceError extends Error {}
/** ENOSPC / EDQUOT (desktop) or a browser storage quota (mobile). */
export const isNoSpace = (e: unknown) => {
	const o = e as { code?: string; name?: string; message?: string } | null;
	return !!o && (o.code === 'ENOSPC' || o.code === 'EDQUOT' || o.name === 'QuotaExceededError' || /\bENOSPC\b|\bEDQUOT\b|no space left on device|disk quota exceeded|QuotaExceededError/i.test(String(o.message ?? '')));
};
export class AuthError extends Error {}
export class RootMissingError extends Error {}
/** A file failed authentication/integrity checks: never retried in a loop. */
export class IntegrityError extends Error {}
export class MassDeleteError extends Error {
	constructor(public count: number, public paths: string[]) {
		super(`Mass deletion blocked (${count} items)`);
	}
}

export interface EngineOptions {
	maxFileSize: number;
	allowMassDelete?: boolean;
	/** 'restore' turns every planned deletion into a restore (user said "no" to a mass deletion). */
	massDeleteMode?: 'block' | 'allow' | 'restore';
	massDeleteThreshold?: number;
	now?: () => Date;
	log?: (msg: string) => void;
	/** Word used in conflict copies, e.g. "conflict". */
	conflictLabel?: string;
	/** The cloud is full: keep downloading and deleting, hold uploads back. */
	noUploads?: boolean;
	/** Pre-flight check before uploading `bytes`: false = not enough free space on the cloud. */
	canUpload?: (bytes: number) => Promise<boolean>;
	/**
	 * 'merge' (default for the app): one version only — edits are combined, or the newer one wins
	 * the newer one wins (no extra copies). 'copy': both versions kept as "(conflict …)" files.
	 */
	conflictMode?: 'merge' | 'copy';
	/** Last-synced text of notes, needed to merge (without it the newer version wins). */
	bases?: BaseStore;
}

const enc = (s: string) => new TextEncoder().encode(s).buffer;
const MAX_BASE = 1024 * 1024;

const isUpload = (a: { kind: string }) => a.kind === 'upload-new' || a.kind === 'upload-update' || a.kind === 'conflict';

/** Names that could escape the vault or that no file system accepts. */
// eslint-disable-next-line no-control-regex -- control characters are not valid in file names
export const unsafeName = (n: string) => !n || n === '.' || n === '..' || /[/\\\u0000-\u001f]/.test(n);

export const parentOf = (p: string) => {
	const i = p.lastIndexOf('/');
	return i < 0 ? '' : p.slice(0, i);
};
export const nameOf = (p: string) => {
	const i = p.lastIndexOf('/');
	return i < 0 ? p : p.slice(i + 1);
};
const depth = (p: string) => (p === '' ? 0 : p.split('/').length);
const isUnder = (p: string, folder: string) => p === folder || p.startsWith(folder + '/');

interface LocalInfo {
	entry: LocalEntry;
	md5?: string;
}

type Action =
	| { kind: 'mkdir-remote'; path: string }
	| { kind: 'mkdir-local'; path: string; remote: RemoteFile }
	| { kind: 'link'; path: string; remote: RemoteFile; local: LocalInfo }
	| { kind: 'upload-new'; path: string; local: LocalInfo }
	| { kind: 'upload-update'; path: string; id: string; local: LocalInfo }
	| { kind: 'download'; path: string; remote: RemoteFile; local: LocalInfo | null }
	| { kind: 'delete-remote'; path: string; id: string; isFolder: boolean }
	| { kind: 'delete-local'; path: string; local: LocalInfo; isFolder: boolean }
	| { kind: 'conflict'; path: string; remote: RemoteFile; local: LocalInfo }
	| { kind: 'drop-base'; path: string }
	| { kind: 'touch-base'; path: string; local: LocalInfo };

/**
 * Three-way (local / remote / last-synced base) reconciliation engine.
 * Pure logic: all I/O goes through LocalFS and RemoteAPI.
 */
export class SyncEngine {
	private idToPath = new Map<string, string>();
	private pathToIds = new Map<string, string[]>();
	private report: SyncReport = emptyReport();

	constructor(
		public state: SyncState,
		private local: LocalFS,
		private remote: RemoteAPI,
		private opts: EngineOptions,
	) {}

	private log(msg: string) {
		this.opts.log?.(msg);
	}

	// ---------------------------------------------------------------- index

	private rebuildIndex() {
		this.idToPath.clear();
		this.pathToIds.clear();
		const { remote, rootId } = this.state;
		const memo = new Map<string, string | null>();
		const resolve = (id: string, guard: number): string | null => {
			if (id === rootId) return '';
			if (memo.has(id)) return memo.get(id)!;
			const f = remote[id];
			if (!f || !f.parentId || guard > 256 || unsafeName(f.name)) return null;
			const pp = resolve(f.parentId, guard + 1);
			const res = pp === null ? null : pp === '' ? f.name : `${pp}/${f.name}`;
			memo.set(id, res);
			return res;
		};
		for (const id of Object.keys(remote)) {
			if (id === rootId) continue;
			const p = resolve(id, 0);
			if (p === null || p === '') continue;
			this.idToPath.set(id, p);
			const arr = this.pathToIds.get(p);
			if (arr) arr.push(id);
			else this.pathToIds.set(p, [id]);
		}
	}

	private addRemote(f: RemoteFile, path: string) {
		const old = this.idToPath.get(f.id);
		if (old !== undefined) {
			const arr = (this.pathToIds.get(old) ?? []).filter((x) => x !== f.id);
			if (arr.length) this.pathToIds.set(old, arr);
			else this.pathToIds.delete(old);
		}
		this.state.remote[f.id] = f;
		this.idToPath.set(f.id, path);
		const arr = this.pathToIds.get(path);
		if (arr) {
			if (!arr.includes(f.id)) arr.push(f.id);
		} else this.pathToIds.set(path, [f.id]);
	}

	private removeRemote(id: string) {
		const p = this.idToPath.get(id);
		delete this.state.remote[id];
		if (p !== undefined) {
			const arr = (this.pathToIds.get(p) ?? []).filter((x) => x !== id);
			if (arr.length) this.pathToIds.set(p, arr);
			else this.pathToIds.delete(p);
			this.idToPath.delete(id);
		}
	}

	/** The canonical remote file at a path (duplicates are resolved deterministically). */
	private remoteAt(path: string): RemoteFile | null {
		const ids = this.pathToIds.get(path);
		if (!ids || !ids.length) return null;
		if (ids.length === 1) return this.state.remote[ids[0]] ?? null;
		const b = this.state.base[path];
		if (b && ids.includes(b.id)) return this.state.remote[b.id];
		return this.sortCanonical(ids.map((i) => this.state.remote[i]))[0];
	}

	private sortCanonical(files: RemoteFile[]) {
		return [...files].sort((a, b) => {
			const ca = a.createdTime ?? '';
			const cb = b.createdTime ?? '';
			if (ca !== cb) return ca < cb ? -1 : 1;
			return a.id < b.id ? -1 : 1;
		});
	}

	private remoteChildren(folderId: string): RemoteFile[] {
		return Object.values(this.state.remote).filter((f) => f.parentId === folderId);
	}

	private moveBase(from: string, to: string) {
		const base = this.state.base;
		const moves: [string, BaseEntry][] = [];
		for (const k of Object.keys(base)) {
			if (isUnder(k, from)) {
				moves.push([to + k.slice(from.length), base[k]]);
				delete base[k];
			}
		}
		for (const [k, v] of moves) base[k] = v;
	}

	conflictPath(path: string, taken: (p: string) => boolean): string {
		const now = (this.opts.now?.() ?? new Date());
		const pad = (n: number) => String(n).padStart(2, '0');
		const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
		const dir = parentOf(path);
		const name = nameOf(path);
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : '';
		for (let i = 1; i < 1000; i++) {
			const suffix = i === 1 ? '' : ` ${i}`;
			const candidate = `${stem} (${this.opts.conflictLabel ?? 'conflict'} ${stamp}${suffix})${ext}`;
			const full = dir ? `${dir}/${candidate}` : candidate;
			if (!taken(full)) return full;
		}
		return `${path}.${Date.now()}.conflict`;
	}

	private wantsBase(path: string, size: number) {
		return !!this.opts.bases && size <= MAX_BASE && isMergeable(path);
	}

	/** Stores the synced text of a note: the common ancestor of a future merge. */
	private async remember(path: string, data: ArrayBuffer, hash: string) {
		if (!this.wantsBase(path, data.byteLength)) return;
		const t = decodeText(data);
		if (t === null) return;
		try {
			await this.opts.bases!.put(hash, t);
		} catch {
			/* only an optimisation */
		}
	}

	private async baseText(md5?: string): Promise<string | null> {
		if (!md5 || !this.opts.bases) return null;
		try {
			return await this.opts.bases.get(md5);
		} catch {
			return null;
		}
	}

	/**
	 * Both devices changed the file: produce ONE version, in the cloud and here.
	 * Notes: different parts edited → both edits kept; same lines edited → newer side wins there,
	 * and the other version is discarded (one version only, everywhere).
	 * Other files: the newer version wins.
	 */
	private async mergeConflict(a: Extract<Action, { kind: 'conflict' }>) {
		const base = this.state.base;
		const remoteData = await this.remote.download(a.remote.id);
		const remoteHash = md5(remoteData);
		if (a.remote.hash && a.remote.hash !== remoteHash) {
			this.report.retry.push(a.path);
			return;
		}
		const localData = await this.local.read(a.path);
		const localHash = md5(localData);
		if (remoteHash === localHash) {
			const st = await this.local.stat(a.path);
			base[a.path] = { id: a.remote.id, isFolder: false, md5: localHash, rev: a.remote.rev, mtime: st?.mtime, size: st?.size };
			await this.remember(a.path, localData, localHash);
			return;
		}
		const B = base[a.path];
		const remoteTime = Date.parse(a.remote.modifiedTime ?? '');
		const localNewer = !(remoteTime > a.local.entry.mtime);
		let result: ArrayBuffer | null = null;
		let clean = false;
		if (isMergeable(a.path)) {
			const lt = decodeText(localData);
			const rt = decodeText(remoteData);
			if (lt !== null && rt !== null) {
				if (!B) {
					// created on both devices at once: nothing in common to lose, keep both
					const m = localNewer ? merge2(rt, lt) : merge2(lt, rt);
					if (m !== null) {
						result = enc(m);
						clean = true;
					}
				} else {
					const bt = await this.baseText(B.md5);
					const m = bt === null ? null : merge3(bt, lt, rt, localNewer);
					if (m) {
						result = enc(m.text);
						clean = m.clean;
					}
				}
			}
		}
		if (!result) result = localNewer ? localData : remoteData;
		if (!(await this.localStillMatches(a.path, a.local))) {
			this.report.retry.push(a.path); // the user is typing: next cycle
			return;
		}
		const hash = md5(result);
		if (hash !== localHash) {
			// local first: if the upload fails, the next cycle merges again from here (nothing lost)
			await this.local.write(a.path, result);
		}
		let rev = a.remote.rev;
		let id = a.remote.id;
		if (hash !== remoteHash) {
			const f = await this.remote.update(a.remote.id, result, a.remote);
			if (f.id !== a.remote.id) this.removeRemote(a.remote.id);
			this.addRemote({ ...a.remote, ...f }, a.path);
			rev = f.rev;
			id = f.id;
		}
		const st = await this.local.stat(a.path);
		base[a.path] = { id, isFolder: false, md5: hash, rev, mtime: st?.mtime, size: st?.size };
		await this.remember(a.path, result, hash);
		if (clean) this.report.merged.push(a.path);
		else this.report.replaced.push({ path: a.path, kept: '' });
	}

	/** Same path created on two devices at once: one file in the cloud, with both contents. */
	private async mergeDuplicate(p: string, canonical: RemoteFile, dup: RemoteFile) {
		const cd = await this.remote.download(canonical.id);
		const dd = await this.remote.download(dup.id);
		const dupNewer = Date.parse(dup.modifiedTime ?? '') > Date.parse(canonical.modifiedTime ?? '');
		let result: ArrayBuffer | null = null;
		if (isMergeable(p)) {
			const ct = decodeText(cd);
			const dt = decodeText(dd);
			const m = ct !== null && dt !== null ? (dupNewer ? merge2(ct, dt) : merge2(dt, ct)) : null;
			if (m !== null) result = enc(m);
		}
		let replaced = false;
		if (!result) {
			result = dupNewer ? dd : cd;
			replaced = true;
		}
		if (md5(result) !== md5(cd)) {
			const f = await this.remote.update(canonical.id, result, canonical);
			this.state.remote[canonical.id] = { ...canonical, ...f };
		}
		await this.remote.trash(dup.id);
		delete this.state.remote[dup.id];
		if (replaced) this.report.replaced.push({ path: p, kept: '' });
		else this.report.merged.push(p);
	}

	private async siblings(path: string): Promise<string[]> {
		const dir = parentOf(path);
		try {
			return dir ? await this.local.children(dir) : (await this.local.list()).map((e) => e.path).filter((p) => !p.includes('/'));
		} catch {
			return [];
		}
	}

	/** A conflict copy of `path` next to it that already holds content with this hash. */
	private async existingConflictCopy(path: string, hash: string): Promise<string | null> {
		const name = nameOf(path);
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : '';
		const prefix = `${stem} (${this.opts.conflictLabel ?? 'conflict'} `;
		for (const k of await this.siblings(path)) {
			const n = nameOf(k);
			if (!n.startsWith(prefix) || !n.endsWith(ext)) continue;
			try {
				const st = await this.local.stat(k);
				if (!st || st.isFolder) continue;
				if (md5(await this.local.read(k)) === hash) return k;
			} catch {
				/* unreadable: ignore */
			}
		}
		return null;
	}

	// ----------------------------------------------------------------- main

	async run(dirty: Set<string>, full = false): Promise<SyncReport> {
		this.report = emptyReport();
		const candidates = new Set<string>(dirty);

		// 1. Initialise remote index
		if (!this.state.rootId || this.state.pageToken === null || this.state.pageToken === undefined) {
			await this.fullRemoteRefresh();
			full = true;
		}
		this.rebuildIndex();

		// 2. Local renames recorded while editing (keeps remote file ids/history)
		await this.applyPendingRenames(candidates);

		// 3. Remote changes since last cycle (change feed or snapshot diff)
		const before = new Map(this.idToPath);
		let changes: { changes: RemoteChange[]; newToken: string };
		try {
			changes = await this.remoteChanges(full);
		} catch (e) {
			if (e instanceof HttpError && (e.status === 410 || e.status === 404 || e.status === 400) && this.state.tokenKind === 'feed') {
				this.log('Change token expired, full remote refresh');
				await this.fullRemoteRefresh();
				this.rebuildIndex();
				full = true;
				changes = { changes: [], newToken: this.state.pageToken! };
			} else throw e;
		}
		let rootGone = false;
		for (const c of changes.changes) {
			const f = c.file;
			if (c.fileId === this.state.rootId) {
				if (c.removed || !f) rootGone = true;
				else this.state.remote[c.fileId] = f;
				continue;
			}
			if (c.removed || !f) delete this.state.remote[c.fileId];
			else this.state.remote[c.fileId] = f;
		}
		if (rootGone) throw new RootMissingError('root-gone');
		if (changes.changes.length) this.rebuildIndex();
		const after = this.idToPath;
		for (const id of new Set([...before.keys(), ...after.keys()])) {
			const a = before.get(id);
			const b = after.get(id);
			if (a !== b) {
				if (a) candidates.add(a);
				if (b) candidates.add(b);
			}
		}
		for (const c of changes.changes) {
			const p = after.get(c.fileId) ?? before.get(c.fileId);
			if (p) candidates.add(p);
		}

		// 4. Remote renames / moves -> rename locally
		await this.applyRemoteRenames(candidates);

		// 5. Remote duplicates (same path created on two devices at once)
		await this.resolveDuplicates(candidates);

		// 6. Collect candidate paths
		let localList: Map<string, LocalEntry> | null = null;
		if (full) {
			localList = new Map((await this.local.list()).map((e) => [e.path, e]));
			for (const p of localList.keys()) candidates.add(p);
			for (const p of Object.keys(this.state.base)) candidates.add(p);
			for (const p of this.pathToIds.keys()) candidates.add(p);
		}
		// a deleted/changed folder implies its known descendants
		for (const p of [...candidates]) {
			const b = this.state.base[p];
			if (b?.isFolder) {
				for (const k of Object.keys(this.state.base)) if (k.startsWith(p + '/')) candidates.add(k);
			}
		}
		candidates.delete('');

		// 7. Plan
		const actions: Action[] = [];
		for (const p of candidates) {
			if (this.local.isIgnored(p)) continue;
			try {
				const entry = localList ? localList.get(p) ?? null : await this.local.stat(p);
				const act = await this.plan(p, entry, dirty.has(p) || !full);
				if (act) actions.push(...act);
			} catch (e) {
				if (e instanceof NetworkError || e instanceof AuthError) throw e;
				this.report.errors.push({ path: p, error: String((e as Error)?.message ?? e) });
				this.report.retry.push(p);
			}
		}

		if (this.opts.massDeleteMode === 'restore') {
			for (let i = 0; i < actions.length; i++) {
				const a = actions[i];
				if (a.kind === 'delete-remote') {
					const r = this.remoteAt(a.path);
					delete this.state.base[a.path];
					if (r) actions[i] = r.isFolder ? { kind: 'mkdir-local', path: a.path, remote: r } : { kind: 'download', path: a.path, remote: r, local: null };
				} else if (a.kind === 'delete-local') {
					delete this.state.base[a.path];
					actions[i] = a.isFolder ? { kind: 'mkdir-remote', path: a.path } : { kind: 'upload-new', path: a.path, local: a.local };
				}
			}
		}

		// 8. Safety net against accidental mass deletion
		// old "(conflict …)" copies are disposable: removing them never trips the guard
		const deletions = actions.filter((a) => (a.kind === 'delete-local' || a.kind === 'delete-remote') && !CONFLICT_COPY.test(a.path));
		const threshold = this.opts.massDeleteThreshold ?? 25;
		const baseSize = Object.keys(this.state.base).length;
		// every synced file about to disappear locally at once: an empty / broken listing looks exactly like this
		const baseFiles = Object.entries(this.state.base).filter(([p, b]) => !b.isFolder && !CONFLICT_COPY.test(p)).length;
		const localDeletes = deletions.filter((d) => d.kind === 'delete-local' && !d.isFolder).length;
		const wipe = localDeletes >= 3 && localDeletes >= baseFiles;
		if (!this.opts.allowMassDelete && ((deletions.length > threshold && deletions.length > baseSize * 0.3) || wipe)) {
			throw new MassDeleteError(deletions.length, deletions.map((d) => d.path));
		}

		// 9. Execute: folder creations (shallow first) -> files -> deletions (deep first)
		const order = (a: Action): number => {
			if (a.kind === 'mkdir-remote' || a.kind === 'mkdir-local') return 0;
			if (a.kind === 'delete-local' || a.kind === 'delete-remote') return 2;
			return 1;
		};
		actions.sort((a, b) => {
			const o = order(a) - order(b);
			if (o) return o;
			if (order(a) === 2) return depth(b.path) - depth(a.path);
			return depth(a.path) - depth(b.path);
		});
		let held = !!this.opts.noUploads;
		if (!held && this.opts.canUpload) {
			let bytes = 0;
			for (const a of actions) {
				if (a.kind === 'upload-new' || a.kind === 'conflict') bytes += a.local.entry.size;
				else if (a.kind === 'upload-update') bytes += Math.max(0, a.local.entry.size - (this.state.remote[a.id]?.size ?? 0));
			}
			if (bytes > 0 && !(await this.opts.canUpload(bytes))) {
				held = true;
				this.report.quota = 'preflight';
			}
		}
		for (const a of actions) {
			if (held && isUpload(a)) {
				this.report.heldBack.push(a.path);
				this.report.retry.push(a.path);
				continue;
			}
			try {
				await this.execute(a);
			} catch (e) {
				if (e instanceof NetworkError || e instanceof AuthError) throw e;
				if (e instanceof QuotaError) {
					// the cloud is full: stop uploading, keep receiving what the other devices send
					held = true;
					this.report.quota = e.message || 'quota';
					this.report.heldBack.push(a.path);
					this.report.retry.push(a.path);
					continue;
				}
				if (isNoSpace(e)) throw new LocalSpaceError(String((e as Error)?.message ?? e));
				if (e instanceof HttpError && e.status === 404) {
					// remote object disappeared: forget it, retry next cycle
					const id = (a as { id?: string }).id ?? (a as { remote?: RemoteFile }).remote?.id;
					if (id) this.removeRemote(id);
				}
				this.report.errors.push({ path: a.path, error: String((e as Error)?.message ?? e) });
				if (!(e instanceof IntegrityError)) this.report.retry.push(a.path);
			}
		}

		this.state.pageToken = changes.newToken || this.state.pageToken;
		this.state.lastSync = Date.now();
		return this.report;
	}

	/** Changes since the stored token: native feed, or a diff of a full listing. */
	private async remoteChanges(full: boolean): Promise<{ changes: RemoteChange[]; newToken: string }> {
		const feed = this.remote.changes;
		if (feed && this.state.tokenKind === 'feed') {
			const r = await feed.list(this.state.pageToken!);
			if (!r || !Array.isArray(r.changes)) throw new UnexpectedResponseError('change list is not a list');
			for (const c of r.changes) {
				if (typeof c?.fileId !== 'string' || !c.fileId) throw new UnexpectedResponseError('change without id');
				if (c.file) this.checked(c.file);
			}
			return r;
		}
		let token = this.state.pageToken ?? '';
		let changed = true;
		const probe = this.remote.probe;
		if (probe && this.state.tokenKind === 'probe' && token) {
			const r = await probe.changed(token);
			changed = r.changed;
			token = r.token;
		} else if (feed || probe) {
			// capability changed since the last run: start over with the right token kind
			token = feed ? await feed.start() : await probe!.start();
			this.state.tokenKind = feed ? 'feed' : 'probe';
		}
		if (!changed && !full) return { changes: [], newToken: token };
		let all: RemoteFile[];
		try {
			all = await this.remote.listAll(this.state.rootId!);
		} catch (e) {
			// a listing that fails because the folder vanished must never look like "everything was deleted"
			if (e instanceof HttpError && [404, 409, 410].includes(e.status)) {
				const root = await this.remote.findRoot();
				if (!root || root.id !== this.state.rootId) throw new RootMissingError('root-gone');
			}
			throw e;
		}
		if (!Array.isArray(all)) throw new UnexpectedResponseError('listing is not a list');
		for (const f of all) this.checked(f);
		return { changes: diffSnapshot(this.state.remote, all, this.state.rootId!), newToken: token };
	}

	/** Upstream API changes or broken proxies must fail loudly, never look like an empty/renamed folder. */
	private checked<T extends RemoteFile | null>(f: T): T {
		if (f && (typeof f.id !== 'string' || !f.id || /undefined|null/.test(f.id) || typeof f.name !== 'string')) throw new UnexpectedResponseError('item without id or name');
		return f;
	}

	private async fullRemoteRefresh() {
		let root: RemoteFile | null = this.checked(await this.remote.findRoot());
		if (this.state.rootId && (!root || root.id !== this.state.rootId) && Object.keys(this.state.base).length) {
			throw new RootMissingError('root-missing');
		}
		if (!root) root = await this.remote.createRoot();
		const feed = this.remote.changes;
		const token = feed ? await feed.start() : this.remote.probe ? await this.remote.probe.start() : '';
		this.state.tokenKind = feed ? 'feed' : this.remote.probe ? 'probe' : undefined;
		const all = await this.remote.listAll(root.id);
		if (!Array.isArray(all)) throw new UnexpectedResponseError('listing is not a list');
		for (const f of all) this.checked(f);
		const remote: Record<string, RemoteFile> = {};
		remote[root.id] = root;
		for (const f of all) if (f.id !== root.id) remote[f.id] = f;
		this.state.rootId = root.id;
		this.state.remote = remote;
		this.state.pageToken = token;
	}

	private async applyPendingRenames(candidates: Set<string>) {
		const pending = this.state.pendingRenames;
		if (!pending.length) return;
		this.state.pendingRenames = [];
		for (let i = 0; i < pending.length; i++) {
			const r = pending[i];
			candidates.add(r.to);
			const b = this.state.base[r.from];
			if (!b) continue; // never synced (or self-induced rename): handled as plain create
			candidates.add(r.from);
			if (this.state.base[r.to] || this.local.isIgnored(r.to)) {
				continue;
			}
			const rf = this.state.remote[b.id];
			if (!rf) {
				// remote copy vanished: forget base so the new path uploads fresh
				for (const k of Object.keys(this.state.base)) if (isUnder(k, r.from)) delete this.state.base[k];
				continue;
			}
			try {
				const parentId = await this.ensureRemoteFolder(parentOf(r.to));
				const moved = await this.remote.move(b.id, nameOf(r.to), parentId, rf.parentId);
				this.state.remote[b.id] = { ...rf, ...moved };
				this.moveBase(r.from, r.to);
				this.rebuildIndex();
				for (const k of Object.keys(this.state.base)) if (isUnder(k, r.to)) candidates.add(k);
				this.report.renamedRemote.push(`${r.from} → ${r.to}`);
			} catch (e) {
				if (e instanceof NetworkError || e instanceof AuthError) {
					this.state.pendingRenames = [...pending.slice(i), ...this.state.pendingRenames];
					throw e;
				}
				if (e instanceof HttpError && e.status === 404) {
					this.removeRemote(b.id);
					// the remote copy was deleted elsewhere: the new local path is uploaded as a fresh file
					for (const k of Object.keys(this.state.base)) if (isUnder(k, r.from)) delete this.state.base[k];
					continue;
				}
				this.report.errors.push({ path: r.to, error: String((e as Error)?.message ?? e) });
			}
		}
	}

	private async applyRemoteRenames(candidates: Set<string>) {
		const moves: { from: string; to: string; id: string }[] = [];
		for (const [p, b] of Object.entries(this.state.base)) {
			const ap = this.idToPath.get(b.id);
			if (ap !== undefined && ap !== p) moves.push({ from: p, to: ap, id: b.id });
		}
		moves.sort((a, b) => depth(a.from) - depth(b.from));
		for (const m of moves) {
			const b = this.state.base[m.from];
			if (!b || b.id !== m.id) continue; // already moved with its parent folder
			if (this.local.isIgnored(m.to) || this.local.isIgnored(m.from)) continue;
			const src = await this.local.stat(m.from);
			const dst = await this.local.stat(m.to);
			if (!src || dst || this.state.base[m.to]) continue; // fall back to content reconciliation
			try {
				const parent = parentOf(m.to);
				if (parent && !(await this.local.stat(parent))) await this.local.mkdir(parent);
				await this.local.rename(m.from, m.to);
				this.moveBase(m.from, m.to);
				this.ensureBaseAncestors(m.to);
				candidates.add(m.to);
				this.report.renamedLocal.push(`${m.from} → ${m.to}`);
			} catch (e) {
				this.report.errors.push({ path: m.to, error: String((e as Error)?.message ?? e) });
			}
		}
	}

	private async resolveDuplicates(candidates: Set<string>) {
		const dups = [...this.pathToIds.entries()].filter(([, ids]) => ids.length > 1);
		if (!dups.length) return;
		dups.sort((a, b) => depth(a[0]) - depth(b[0]));
		let changed = false;
		for (const [p] of dups) {
			const ids = this.pathToIds.get(p);
			if (!ids || ids.length < 2) continue;
			const canonical = this.remoteAt(p)!;
			for (const id of [...ids]) {
				if (id === canonical.id) continue;
				const dup = this.state.remote[id];
				if (!dup) continue;
				try {
					if (dup.isFolder && canonical.isFolder) {
						for (const child of this.remoteChildren(dup.id)) {
							const moved = await this.remote.move(child.id, child.name, canonical.id, dup.id);
							this.state.remote[child.id] = { ...child, ...moved, parentId: canonical.id };
						}
						await this.remote.trash(dup.id);
						delete this.state.remote[dup.id];
					} else if (!dup.isFolder && !canonical.isFolder && (await this.sameContent(dup, canonical))) {
						await this.remote.trash(dup.id);
						delete this.state.remote[dup.id];
					} else if (this.opts.conflictMode === 'merge' && !dup.isFolder && !canonical.isFolder) {
						await this.mergeDuplicate(p, canonical, dup);
					} else {
						const newPath = this.conflictPath(p, (x) => this.pathToIds.has(x));
						const moved = await this.remote.move(dup.id, nameOf(newPath), dup.parentId!, dup.parentId);
						this.state.remote[dup.id] = { ...dup, ...moved };
						candidates.add(newPath);
						this.report.conflicts.push(newPath);
					}
					changed = true;
					candidates.add(p);
				} catch (e) {
					if (e instanceof NetworkError || e instanceof AuthError) throw e;
					this.report.errors.push({ path: p, error: String((e as Error)?.message ?? e) });
				}
			}
			if (changed) this.rebuildIndex();
		}
		if (changed) {
			this.rebuildIndex();
			for (const p of this.pathToIds.keys()) {
				if (dups.some(([d]) => isUnder(p, d))) candidates.add(p);
			}
		}
	}

	private async sameContent(a: RemoteFile, b: RemoteFile): Promise<boolean> {
		if (a.hash && b.hash) return a.hash === b.hash;
		if (a.size !== undefined && b.size !== undefined && a.size !== b.size) return false;
		return md5(await this.remote.download(a.id)) === md5(await this.remote.download(b.id));
	}

	private ensureBaseAncestors(path: string) {
		let p = parentOf(path);
		while (p) {
			if (!this.state.base[p]) {
				const rf = this.remoteAt(p);
				if (rf?.isFolder) this.state.base[p] = { id: rf.id, isFolder: true };
			}
			p = parentOf(p);
		}
	}

	private async ensureRemoteFolder(path: string): Promise<string> {
		if (path === '') return this.state.rootId!;
		const existing = this.remoteAt(path);
		if (existing?.isFolder) {
			if (!this.state.base[path]) this.state.base[path] = { id: existing.id, isFolder: true };
			return existing.id;
		}
		const parentId = await this.ensureRemoteFolder(parentOf(path));
		let f: RemoteFile;
		try {
			f = await this.remote.createFolder(nameOf(path), parentId);
		} catch (e) {
			// Another device created the same folder and we have not seen it yet: adopt it.
			if (!(e instanceof HttpError && e.status === 409)) throw e;
			const found = await this.remote.findChild(parentId, nameOf(path));
			if (!found?.isFolder) throw e;
			f = found;
		}
		this.addRemote(f, path);
		this.state.base[path] = { id: f.id, isFolder: true };
		return f.id;
	}

	private async hashLocal(entry: LocalEntry, force: boolean): Promise<LocalInfo> {
		if (entry.isFolder) return { entry };
		const b = this.state.base[entry.path];
		if (!force && b && !b.isFolder && b.md5 && b.mtime === entry.mtime && b.size === entry.size) {
			return { entry, md5: b.md5 };
		}
		const data = await this.local.read(entry.path);
		return { entry, md5: md5(data) };
	}

	private async plan(p: string, entry: LocalEntry | null, force: boolean): Promise<Action[] | null> {
		const B = this.state.base[p] ?? null;
		let R = this.remoteAt(p);
		if (entry && !entry.isFolder && entry.size > this.opts.maxFileSize) {
			this.log(`Skipping large file ${p}`);
			return null;
		}
		if (R && !R.isFolder && (R.size ?? 0) > this.opts.maxFileSize && !entry) return null;

		// File <-> folder type clash: keep the local item under a conflict name
		if (entry && R && entry.isFolder !== R.isFolder) {
			const np = this.conflictPath(p, (x) => this.pathToIds.has(x));
			await this.local.rename(p, np);
			delete this.state.base[p];
			this.report.conflicts.push(np);
			this.report.retry.push(np);
			return R.isFolder
				? [{ kind: 'mkdir-local', path: p, remote: R }]
				: [{ kind: 'download', path: p, remote: R, local: null }];
		}

		const isFolder = entry?.isFolder ?? R?.isFolder ?? B?.isFolder ?? false;
		if (isFolder) {
			if (!B) {
				if (entry && !R) return [{ kind: 'mkdir-remote', path: p }];
				if (!entry && R) return [{ kind: 'mkdir-local', path: p, remote: R }];
				if (entry && R) return [{ kind: 'link', path: p, remote: R, local: { entry } }];
				return null;
			}
			if (entry && R) {
				if (B.id !== R.id) this.state.base[p] = { id: R.id, isFolder: true };
				return null;
			}
			if (entry && !R) {
				// Deleted on Drive: remove locally (only if it becomes empty) — checked at execution
				return [{ kind: 'delete-local', path: p, local: { entry }, isFolder: true }];
			}
			if (!entry && R) return [{ kind: 'delete-remote', path: p, id: R.id, isFolder: true }];
			return [{ kind: 'drop-base', path: p }];
		}

		const L = entry ? await this.hashLocal(entry, force) : null;
		if (!B) {
			if (L && !R) return [{ kind: 'upload-new', path: p, local: L }];
			if (!L && R) return [{ kind: 'download', path: p, remote: R, local: null }];
			if (L && R) {
				// unknown remote hash: the conflict step downloads and links identical copies
				if (R.hash && L.md5 === R.hash) return [{ kind: 'link', path: p, remote: R, local: L }];
				return [{ kind: 'conflict', path: p, remote: R, local: L }];
			}
			return null;
		}
		const localChanged = !L || L.md5 !== B.md5;
		const remoteChanged = !R || R.id !== B.id || R.rev !== B.rev;
		if (!localChanged && !remoteChanged) {
			if (L && (B.mtime !== L.entry.mtime || B.size !== L.entry.size)) return [{ kind: 'touch-base', path: p, local: L }];
			return null;
		}
		if (localChanged && !remoteChanged) {
			if (L) return [{ kind: 'upload-update', path: p, id: B.id, local: L }];
			return [{ kind: 'delete-remote', path: p, id: B.id, isFolder: false }];
		}
		if (!localChanged && remoteChanged) {
			if (R) return [{ kind: 'download', path: p, remote: R, local: L }];
			return [{ kind: 'delete-local', path: p, local: L, isFolder: false }];
		}
		// both changed
		if (!L && !R) return [{ kind: 'drop-base', path: p }];
		if (L && !R) {
			delete this.state.base[p];
			return [{ kind: 'upload-new', path: p, local: L }];
		}
		if (!L && R) return [{ kind: 'download', path: p, remote: R, local: null }];
		if (R!.hash && L!.md5 === R!.hash) return [{ kind: 'link', path: p, remote: R!, local: L! }];
		return [{ kind: 'conflict', path: p, remote: R!, local: L! }];
	}

	/** Re-checks that a local file did not change since planning (user may be typing). */
	private async localStillMatches(p: string, expected: LocalInfo | null): Promise<boolean> {
		const now = await this.local.stat(p);
		if (!expected) return !now;
		if (!now) return false;
		if (now.isFolder || expected.entry.isFolder) return now.isFolder === expected.entry.isFolder;
		if (now.mtime === expected.entry.mtime && now.size === expected.entry.size) return true;
		const data = await this.local.read(p);
		return md5(data) === expected.md5;
	}

	private async execute(a: Action) {
		const base = this.state.base;
		switch (a.kind) {
			case 'mkdir-remote': {
				await this.ensureRemoteFolder(a.path);
				this.report.uploaded.push(a.path + '/');
				return;
			}
			case 'mkdir-local': {
				if (!(await this.local.stat(a.path))) await this.local.mkdir(a.path);
				base[a.path] = { id: a.remote.id, isFolder: true };
				this.ensureBaseAncestors(a.path);
				this.report.downloaded.push(a.path + '/');
				return;
			}
			case 'link': {
				base[a.path] = a.remote.isFolder
					? { id: a.remote.id, isFolder: true }
					: { id: a.remote.id, isFolder: false, md5: a.local.md5, rev: a.remote.rev, mtime: a.local.entry.mtime, size: a.local.entry.size };
				if (!a.remote.isFolder && a.local.md5 && this.wantsBase(a.path, a.local.entry.size)) {
					try {
						await this.remember(a.path, await this.local.read(a.path), a.local.md5);
					} catch {
						/* only an optimisation */
					}
				}
				return;
			}
			case 'touch-base': {
				const b = base[a.path];
				if (b) {
					b.mtime = a.local.entry.mtime;
					b.size = a.local.entry.size;
				}
				return;
			}
			case 'drop-base': {
				delete base[a.path];
				return;
			}
			case 'upload-new': {
				const parentId = await this.ensureRemoteFolder(parentOf(a.path));
				const data = await this.local.read(a.path);
				const hash = md5(data);
				// another device may have created the same path meanwhile
				const existing = this.remoteAt(a.path);
				let f: RemoteFile;
				if (existing && !existing.isFolder && existing.hash === hash) f = existing;
				else if (existing) {
					// appeared meanwhile: next cycle compares both versions (never overwrite blindly)
					this.report.retry.push(a.path);
					return;
				} else f = await this.remote.upload(nameOf(a.path), parentId, data);
				this.addRemote(f, a.path);
				const st = await this.local.stat(a.path);
				base[a.path] = { id: f.id, isFolder: false, md5: hash, rev: f.rev, mtime: st?.mtime ?? a.local.entry.mtime, size: st?.size ?? data.byteLength };
				if (st && (st.mtime !== a.local.entry.mtime || st.size !== a.local.entry.size)) base[a.path].mtime = -1; // force re-hash
				await this.remember(a.path, data, hash);
				this.report.uploaded.push(a.path);
				return;
			}
			case 'upload-update': {
				const data = await this.local.read(a.path);
				const hash = md5(data);
				const prev = this.state.remote[a.id];
				const f = await this.remote.update(a.id, data, prev);
				if (f.id !== a.id) this.removeRemote(a.id); // some backends replace the file object
				this.addRemote({ ...prev, ...f }, a.path);
				const st = await this.local.stat(a.path);
				base[a.path] = { id: f.id, isFolder: false, md5: hash, rev: f.rev, mtime: st?.mtime, size: st?.size };
				if (st && (st.mtime !== a.local.entry.mtime || st.size !== a.local.entry.size)) base[a.path].mtime = -1;
				await this.remember(a.path, data, hash);
				this.report.uploaded.push(a.path);
				return;
			}
			case 'download': {
				if (!(await this.localStillMatches(a.path, a.local))) {
					this.report.retry.push(a.path);
					return;
				}
				const data = await this.remote.download(a.remote.id);
				const hash = md5(data);
				if (a.remote.hash && a.remote.hash !== hash) {
					// corrupted transfer or file changed while downloading: never write it
					this.report.retry.push(a.path);
					return;
				}
				// set base before writing so the resulting modify event is a no-op
				const had = base[a.path];
				base[a.path] = { id: a.remote.id, isFolder: false, md5: hash, rev: a.remote.rev };
				try {
					await this.local.write(a.path, data);
				} catch (e) {
					// never leave a base entry for a file that was not written: it would look deleted locally
					if (had) base[a.path] = had;
					else delete base[a.path];
					throw e;
				}
				const st = await this.local.stat(a.path);
				base[a.path].mtime = st?.mtime;
				base[a.path].size = st?.size;
				this.ensureBaseAncestors(a.path);
				await this.remember(a.path, data, hash);
				this.report.downloaded.push(a.path);
				return;
			}
			case 'delete-remote': {
				if (a.isFolder) {
					// keep the folder if Drive still contains items we don't know about
					if (this.remoteChildren(a.id).length > 0) {
						if (!(await this.local.stat(a.path))) await this.local.mkdir(a.path);
						this.report.retry.push(a.path);
						return;
					}
				}
				await this.remote.trash(a.id);
				this.removeRemote(a.id);
				delete base[a.path];
				this.report.deletedRemote.push(a.path);
				return;
			}
			case 'delete-local': {
				if (a.isFolder) {
					const kids = await this.local.children(a.path);
					if (kids.length > 0) {
						// local content survived: re-create the folder on Drive
						delete base[a.path];
						await this.ensureRemoteFolder(a.path);
						return;
					}
				} else if (!(await this.localStillMatches(a.path, a.local))) {
					this.report.retry.push(a.path);
					return;
				}
				delete base[a.path];
				await this.local.remove(a.path);
				this.report.deletedLocal.push(a.path);
				return;
			}
			case 'conflict': {
				if (this.opts.conflictMode === 'merge') return this.mergeConflict(a);
				// Local version keeps the original name; the Drive version is saved next to it.
				const data = await this.remote.download(a.remote.id);
				const remoteHash = md5(data);
				const localData = await this.local.read(a.path);
				const localHash = md5(localData);
				if (remoteHash === localHash) {
					const st = await this.local.stat(a.path);
					base[a.path] = { id: a.remote.id, isFolder: false, md5: localHash, rev: a.remote.rev, mtime: st?.mtime, size: st?.size };
					return;
				}
				// a previous attempt may have saved this very version already (e.g. the upload after it failed)
				let cp = await this.existingConflictCopy(a.path, remoteHash);
				if (!cp) {
					// never overwrite a local file that is not synced yet (e.g. an earlier copy)
					const here = new Set(await this.siblings(a.path));
					cp = this.conflictPath(a.path, (x) => this.pathToIds.has(x) || !!base[x] || here.has(x));
					await this.local.write(cp, data);
				}
				try {
					if (!base[cp]) {
						const parentId = await this.ensureRemoteFolder(parentOf(cp));
						const cf = await this.remote.upload(nameOf(cp), parentId, data);
						this.addRemote(cf, cp);
						const cst = await this.local.stat(cp);
						base[cp] = { id: cf.id, isFolder: false, md5: remoteHash, rev: cf.rev, mtime: cst?.mtime, size: cst?.size };
					}
				} catch (e) {
					if (e instanceof NetworkError || e instanceof AuthError || e instanceof QuotaError) throw e;
					this.report.retry.push(cp);
				}
				const f = await this.remote.update(a.remote.id, localData, a.remote);
				if (f.id !== a.remote.id) this.removeRemote(a.remote.id);
				this.addRemote({ ...a.remote, ...f }, a.path);
				const st = await this.local.stat(a.path);
				base[a.path] = { id: f.id, isFolder: false, md5: localHash, rev: f.rev, mtime: st?.mtime, size: st?.size };
				this.report.conflicts.push(cp);
				return;
			}
		}
	}
}

/** Turns two full listings into a change list (for backends without a change feed). */
export function diffSnapshot(prev: Record<string, RemoteFile>, now: RemoteFile[], rootId: string): RemoteChange[] {
	const out: RemoteChange[] = [];
	const seen = new Set<string>([rootId]);
	for (const f of now) {
		seen.add(f.id);
		const o = prev[f.id];
		if (!o || o.name !== f.name || o.parentId !== f.parentId || o.rev !== f.rev || o.isFolder !== f.isFolder || o.size !== f.size) {
			out.push({ fileId: f.id, removed: false, file: f });
		}
	}
	for (const id of Object.keys(prev)) if (!seen.has(id)) out.push({ fileId: id, removed: true });
	return out;
}
