import type { ChangeFeed, RemoteAPI, RemoteChange, RemoteFile } from './types';
import { Cipher, KEYFILE, Keyfile, parseKeyfile } from './crypto';

export type EncryptionProblem = 'remote-encrypted' | 'keyfile-missing' | 'keyfile-changed';
export class EncryptionStateError extends Error {
	constructor(public kind: EncryptionProblem) {
		super(kind);
	}
}

/**
 * Layer between the sync engine and a storage backend.
 * - with a Cipher: encrypts contents (and optionally names) end-to-end;
 * - always: watches the key file, so a device can never mix encrypted and plain data.
 */
export class SecureRemote implements RemoteAPI {
	private rootId: string | null = null;

	constructor(
		readonly inner: RemoteAPI,
		private cipher: Cipher | null,
		/** Version of the key file this device unlocked (undefined when plain). */
		private keyRev?: string,
	) {}

	/** Tells the wrapper where the key file lives before the first listing. */
	bind(rootId: string, keyId: string | null) {
		this.rootId = rootId;
		this.keyId = keyId;
	}

	get maxFileSize() {
		return this.inner.maxFileSize ? this.inner.maxFileSize - 128 : undefined;
	}

	get probe() {
		return this.inner.probe;
	}

	space() {
		return this.inner.space ? this.inner.space() : Promise.resolve(null);
	}

	private isKeyfile(f: RemoteFile | undefined) {
		return !!f && !f.isFolder && f.parentId === this.rootId && f.name === KEYFILE;
	}

	private checkKeyfile(f: RemoteFile | null) {
		if (!this.cipher) {
			if (f) throw new EncryptionStateError('remote-encrypted');
			return;
		}
		if (!f) throw new EncryptionStateError('keyfile-missing');
		if (this.keyRev && f.rev && f.rev !== this.keyRev) throw new EncryptionStateError('keyfile-changed');
	}

	private async open(f: RemoteFile): Promise<RemoteFile | null> {
		if (!this.cipher) return f;
		const name = await this.cipher.decName(f.name);
		if (name === null) return null;
		return { ...f, name, hash: undefined };
	}

	async findRoot() {
		const r = await this.inner.findRoot();
		if (r) this.rootId = r.id;
		return r;
	}

	async createRoot() {
		const r = await this.inner.createRoot();
		this.rootId = r.id;
		return r;
	}

	async listAll(rootId: string): Promise<RemoteFile[]> {
		this.rootId = rootId;
		const all = await this.inner.listAll(rootId);
		this.checkKeyfile(all.find((f) => this.isKeyfile(f)) ?? null);
		const out: RemoteFile[] = [];
		for (const f of all) {
			if (this.isKeyfile(f)) continue;
			const o = await this.open(f);
			if (o) out.push(o);
		}
		return out;
	}

	async findChild(parentId: string, name: string) {
		const enc = this.cipher ? await this.cipher.encName(name) : name;
		const f = await this.inner.findChild(parentId, enc);
		return f ? this.open(f) : null;
	}

	get changes(): ChangeFeed | undefined {
		const feed = this.inner.changes;
		if (!feed) return undefined;
		return {
			start: () => feed.start(),
			list: async (token) => {
				const r = await feed.list(token);
				const out: RemoteChange[] = [];
				for (const c of r.changes) {
					if (this.isKeyfile(c.file) || (c.removed && c.fileId === this.keyId)) {
						this.checkKeyfile(c.removed ? null : c.file!);
						continue;
					}
					if (c.removed || !c.file) {
						out.push(c);
						continue;
					}
					if (c.fileId === this.rootId) {
						out.push(c);
						continue;
					}
					const o = await this.open(c.file);
					out.push(o ? { ...c, file: o } : { fileId: c.fileId, removed: true });
				}
				return { changes: out, newToken: r.newToken };
			},
		};
	}

	/** Id of the key file, learnt when it was read. */
	keyId: string | null = null;

	async createFolder(name: string, parentId: string) {
		const r = await this.inner.createFolder(this.cipher ? await this.cipher.encName(name) : name, parentId);
		return { ...r, name };
	}

	async upload(name: string, parentId: string, data: ArrayBuffer) {
		if (!this.cipher) return this.inner.upload(name, parentId, data);
		const r = await this.inner.upload(await this.cipher.encName(name), parentId, await this.cipher.encrypt(data));
		return { ...r, name, hash: undefined };
	}

	async update(id: string, data: ArrayBuffer, prev?: RemoteFile) {
		if (!this.cipher) return this.inner.update(id, data, prev);
		const r = await this.inner.update(id, await this.cipher.encrypt(data), prev);
		return { ...r, name: prev?.name ?? (await this.cipher.decName(r.name)) ?? r.name, hash: undefined };
	}

	async move(id: string, name: string, newParentId: string, oldParentId: string | null) {
		const r = await this.inner.move(id, this.cipher ? await this.cipher.encName(name) : name, newParentId, oldParentId);
		return { ...r, name, ...(this.cipher ? { hash: undefined } : {}) };
	}

	trash(id: string) {
		return this.inner.trash(id);
	}

	async download(id: string) {
		const d = await this.inner.download(id);
		return this.cipher ? this.cipher.decrypt(d) : d;
	}
}

export async function readKeyfile(remote: RemoteAPI, rootId: string): Promise<{ file: RemoteFile; keyfile: Keyfile } | null> {
	const f = await remote.findChild(rootId, KEYFILE);
	if (!f || f.isFolder) return null;
	return { file: f, keyfile: parseKeyfile(await remote.download(f.id)) };
}

export async function writeKeyfile(remote: RemoteAPI, rootId: string, k: Keyfile, existing?: RemoteFile | null): Promise<RemoteFile> {
	const data = new TextEncoder().encode(JSON.stringify(k, null, 1)).buffer;
	return existing ? remote.update(existing.id, data, existing) : remote.upload(KEYFILE, rootId, data);
}
