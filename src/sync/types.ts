export interface LocalEntry {
	path: string;
	isFolder: boolean;
	mtime: number;
	size: number;
}

/** Abstraction over the local vault so that the sync engine can be unit-tested. */
export interface LocalFS {
	list(): Promise<LocalEntry[]>;
	stat(path: string): Promise<LocalEntry | null>;
	read(path: string): Promise<ArrayBuffer>;
	/** Writes a file, creating missing parent folders. */
	write(path: string, data: ArrayBuffer): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Moves a file/folder to the trash (never hard-deletes). */
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Direct children paths of a local folder (synced items only). */
	children(path: string): Promise<string[]>;
	isIgnored(path: string): boolean;
}

/** Content of text files at the last sync, by MD5: the common ancestor for three-way merges. */
export interface BaseStore {
	get(md5: string): Promise<string | null>;
	put(md5: string, text: string): Promise<void>;
}

export interface RemoteFile {
	id: string;
	name: string;
	parentId: string | null;
	isFolder: boolean;
	/** Opaque version tag: changes whenever the remote content changes. */
	rev?: string;
	/** MD5 of the plaintext content, only when the provider knows it (lets two copies be linked without downloading). */
	hash?: string;
	size?: number;
	modifiedTime?: string;
	createdTime?: string;
}

export interface RemoteChange {
	fileId: string;
	removed: boolean;
	file?: RemoteFile;
}

/** Native change feed (Google Drive, OneDrive delta). */
export interface ChangeFeed {
	start(): Promise<string>;
	list(token: string): Promise<{ changes: RemoteChange[]; newToken: string }>;
}

/** Cheap "did anything change?" probe used by providers that only offer full listings. */
export interface ChangeProbe {
	start(): Promise<string>;
	changed(token: string): Promise<{ changed: boolean; token: string }>;
}

/**
 * A storage backend. All ids are opaque; names are single path segments.
 * The root folder (the directory chosen by the user) is configured in the instance.
 */
export interface RemoteAPI {
	findRoot(): Promise<RemoteFile | null>;
	createRoot(): Promise<RemoteFile>;
	/** Every item below the root (root excluded). */
	listAll(rootId: string): Promise<RemoteFile[]>;
	/** Direct child lookup by name (used for the encryption key file). */
	findChild(parentId: string, name: string): Promise<RemoteFile | null>;
	readonly changes?: ChangeFeed;
	readonly probe?: ChangeProbe;
	/** Largest file the backend accepts in a single upload. */
	readonly maxFileSize?: number;
	createFolder(name: string, parentId: string): Promise<RemoteFile>;
	upload(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile>;
	/** `prev` lets backends with optimistic locking refuse to overwrite a newer version. */
	update(id: string, data: ArrayBuffer, prev?: RemoteFile): Promise<RemoteFile>;
	move(id: string, name: string, newParentId: string, oldParentId: string | null): Promise<RemoteFile>;
	trash(id: string): Promise<void>;
	/** Recursive delete of a folder, when trash() refuses non-empty folders. */
	trashTree?(id: string): Promise<void>;
	download(id: string): Promise<ArrayBuffer>;
	/** Storage used / available on the account (null = unknown or unlimited). */
	space?(): Promise<Space | null>;
	/**
	 * Vault folders already on the account next to the configured one (full paths, e.g.
	 * "Ambraia/Notes"), so that a new device joins an existing folder instead of making a twin.
	 */
	vaultFolders?(): Promise<string[]>;
}

export interface Space {
	used: number;
	total: number;
}

export interface BaseEntry {
	id: string;
	isFolder: boolean;
	/** MD5 of the local (plaintext) content at the last sync. */
	md5?: string;
	/** Remote version tag at the last sync. */
	rev?: string;
	mtime?: number;
	size?: number;
}

export interface PendingRename {
	from: string;
	to: string;
}

export interface SyncState {
	vaultKey: string;
	rootId: string | null;
	pageToken: string | null;
	/** Which kind of token pageToken is ('feed' or 'probe'). */
	tokenKind?: 'feed' | 'probe';
	/** Id of the encryption key the remote files were written with (none = plain). */
	keyKid?: string;
	remote: Record<string, RemoteFile>;
	base: Record<string, BaseEntry>;
	pendingRenames: PendingRename[];
	lastSync: number;
}

export const emptyState = (vaultKey: string): SyncState => ({
	vaultKey,
	rootId: null,
	pageToken: null,
	remote: {},
	base: {},
	pendingRenames: [],
	lastSync: 0,
});

export interface SyncReport {
	uploaded: string[];
	downloaded: string[];
	deletedLocal: string[];
	deletedRemote: string[];
	renamedLocal: string[];
	renamedRemote: string[];
	conflicts: string[];
	errors: { path: string; error: string }[];
	retry: string[];
	/** Uploads held back because the cloud is full ('preflight' = known before trying). */
	quota?: string;
	heldBack: string[];
	/** Edits from two devices combined into one version. */
	merged: string[];
	/** Same lines changed on two devices: the newer version won (no extra copy is kept). */
	replaced: { path: string; kept: string }[];
}

export const emptyReport = (): SyncReport => ({
	uploaded: [],
	downloaded: [],
	deletedLocal: [],
	deletedRemote: [],
	renamedLocal: [],
	renamedRemote: [],
	conflicts: [],
	errors: [],
	retry: [],
	heldBack: [],
	merged: [],
	replaced: [],
});

/** Upgrades a state written by older versions (Drive-only, md5 used as version). */
export function migrateState(s: SyncState): SyncState {
	for (const f of Object.values(s.remote ?? {})) {
		const o = f as RemoteFile & { md5?: string; vault?: string };
		if (o.md5 && !o.rev) o.rev = o.hash = o.md5;
		delete o.md5;
		delete o.vault;
	}
	for (const b of Object.values(s.base ?? {})) if (b.md5 && !b.rev && !b.isFolder) b.rev = b.md5;
	if (s.pageToken && !s.tokenKind) s.tokenKind = 'feed';
	return s;
}

export class HttpError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

/**
 * Compact MD5 implementation (RFC 1321) working on ArrayBuffer / Uint8Array.
 * Used to compare local files with Google Drive's `md5Checksum` without
 * downloading anything. Works on desktop and mobile (no Node APIs).
 */

const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Int32Array(64);
for (let i = 0; i < 64; i++) {
	K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
}

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push((i < 16 ? '0' : '') + i.toString(16));

export function md5(input: ArrayBuffer | Uint8Array | string): string {
	let bytes: Uint8Array;
	if (typeof input === 'string') bytes = new TextEncoder().encode(input);
	else if (input instanceof Uint8Array) bytes = input;
	else bytes = new Uint8Array(input);

	const len = bytes.length;
	const nBlocks = ((len + 8) >>> 6) + 1;
	const total = nBlocks * 64;
	const buf = new Uint8Array(total);
	buf.set(bytes);
	buf[len] = 0x80;
	const bitLenLo = (len * 8) >>> 0;
	const bitLenHi = Math.floor(len / 0x20000000) >>> 0;
	const view = new DataView(buf.buffer);
	view.setUint32(total - 8, bitLenLo, true);
	view.setUint32(total - 4, bitLenHi, true);

	let a0 = 0x67452301 | 0;
	let b0 = 0xefcdab89 | 0;
	let c0 = 0x98badcfe | 0;
	let d0 = 0x10325476 | 0;
	const M = new Int32Array(16);

	for (let off = 0; off < total; off += 64) {
		for (let j = 0; j < 16; j++) M[j] = view.getInt32(off + j * 4, true);
		let A = a0, B = b0, C = c0, D = d0;
		for (let i = 0; i < 64; i++) {
			let F: number, g: number;
			if (i < 16) { F = (B & C) | (~B & D); g = i; }
			else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
			else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
			else { F = C ^ (B | ~D); g = (7 * i) & 15; }
			F = (F + A + K[i] + M[g]) | 0;
			A = D;
			D = C;
			C = B;
			B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
		}
		a0 = (a0 + A) | 0;
		b0 = (b0 + B) | 0;
		c0 = (c0 + C) | 0;
		d0 = (d0 + D) | 0;
	}

	let out = '';
	for (const w of [a0, b0, c0, d0]) {
		out += HEX[w & 255] + HEX[(w >>> 8) & 255] + HEX[(w >>> 16) & 255] + HEX[(w >>> 24) & 255];
	}
	return out;
}
