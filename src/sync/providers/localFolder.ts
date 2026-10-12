import { HttpError, RemoteAPI, RemoteFile, Space } from '../types';
import { isNoSpace, QuotaError, unsafeName } from '../engine';
import { randomId } from '../http';

/* Node modules are only available on desktop; this backend is desktop-only. */
type Fs = typeof import('fs').promises;
type PathMod = typeof import('path');
const node = <T,>(m: string): T => (window as unknown as { require: (m: string) => T }).require(m);

const TMP = '.ambraia-tmp-';
const TRASH = '.ambraia-trash';
/** Files other apps keep inside synced folders. */
const SKIP = /^(\.|~\$|desktop\.ini$|thumbs\.db$|icon\r$)/i;

export const isDesktopFs = () => {
	try {
		return typeof (window as unknown as { require?: unknown }).require === 'function' && !!node<Fs>('fs');
	} catch {
		return false;
	}
};

/**
 * A folder on this computer kept in sync by another app (MEGA, Proton Drive…).
 * Ids are inode based so they survive renames, like real cloud ids.
 */
export class LocalFolder implements RemoteAPI {
	private fs: Fs;
	private path: PathMod;
	private paths = new Map<string, string>(); // id -> absolute path
	private rootAbs: string;

	constructor(
		base: string,
		folder: string,
		private keepNames: string[] = [],
	) {
		this.fs = node<{ promises: Fs }>('fs').promises;
		this.path = node<PathMod>('path');
		this.rootAbs = this.path.resolve(base, ...folder.split('/'));
		this.folderPath = folder;
	}

	private folderPath: string;

	async vaultFolders(): Promise<string[]> {
		const parent = this.folderPath.split('/').slice(0, -1).join('/');
		try {
			const entries = await this.fs.readdir(this.path.dirname(this.rootAbs), { withFileTypes: true });
			return entries.filter((e) => e.isDirectory() && !SKIP.test(e.name)).map((e) => (parent ? `${parent}/${e.name}` : e.name));
		} catch {
			return [];
		}
	}

	/** Every path we touch must stay inside the chosen folder. */
	private inside(p: string) {
		const r = this.path.resolve(p);
		if (r !== this.rootAbs && !r.startsWith(this.rootAbs + this.path.sep)) throw new HttpError(400, 'Path outside the sync folder');
		return r;
	}

	private abs(id: string): string {
		const p = this.paths.get(id);
		if (!p) throw new HttpError(404, 'Unknown item (will be re-listed)');
		return p;
	}

	private child(parentId: string, name: string) {
		if (unsafeName(name)) throw new HttpError(400, 'Invalid name');
		return this.inside(this.path.join(this.abs(parentId), name));
	}

	private async info(p: string, parentId: string | null): Promise<RemoteFile> {
		const st = await this.fs.stat(p, { bigint: true });
		const ino = st.ino.toString();
		const id = ino !== '0' ? `${st.dev}-${ino}` : 'p:' + p;
		this.paths.set(id, p);
		const isFolder = st.isDirectory();
		return {
			id,
			name: this.path.basename(p),
			parentId,
			isFolder,
			rev: isFolder ? undefined : `${st.mtimeMs}-${st.size}`,
			size: isFolder ? undefined : Number(st.size),
			modifiedTime: new Date(Number(st.mtimeMs)).toISOString(),
			createdTime: new Date(Number(st.birthtimeMs)).toISOString(),
		};
	}

	private async exists(p: string) {
		try {
			await this.fs.lstat(p);
			return true;
		} catch {
			return false;
		}
	}

	async findRoot(): Promise<RemoteFile | null> {
		try {
			const f = await this.info(this.rootAbs, null);
			return f.isFolder ? f : null;
		} catch {
			return null;
		}
	}

	async createRoot(): Promise<RemoteFile> {
		await this.fs.mkdir(this.rootAbs, { recursive: true });
		return this.info(this.rootAbs, null);
	}

	async listAll(rootId: string): Promise<RemoteFile[]> {
		this.paths.set(rootId, this.rootAbs);
		const out: RemoteFile[] = [];
		const walk = async (dir: string, id: string, depth: number) => {
			if (depth > 64) return;
			const entries = await this.fs.readdir(dir, { withFileTypes: true });
			for (const e of entries) {
				if (SKIP.test(e.name) && !this.keepNames.includes(e.name)) continue;
				if (e.isSymbolicLink()) continue; // never follow links out of the folder
				if (!e.isFile() && !e.isDirectory()) continue;
				try {
					const f = await this.info(this.path.join(dir, e.name), id);
					out.push(f);
					if (f.isFolder) await walk(this.path.join(dir, e.name), f.id, depth + 1);
				} catch {
					/* vanished while listing */
				}
			}
		};
		try {
			await this.fs.stat(this.rootAbs);
		} catch {
			throw new HttpError(404, 'Sync folder not found');
		}
		await walk(this.rootAbs, rootId, 0);
		return out;
	}

	async findChild(parentId: string, name: string): Promise<RemoteFile | null> {
		const p = this.child(parentId, name);
		return (await this.exists(p)) ? this.info(p, parentId) : null;
	}

	async createFolder(name: string, parentId: string): Promise<RemoteFile> {
		const p = this.child(parentId, name);
		if (await this.exists(p)) throw new HttpError(409, 'Already exists');
		await this.fs.mkdir(p).catch((e) => {
			throw this.full(e);
		});
		return this.info(p, parentId);
	}

	/** Write to a temporary file and rename it: other apps never see half-written files. */
	private async atomicWrite(p: string, data: ArrayBuffer) {
		const tmp = this.path.join(this.path.dirname(p), TMP + randomId(6));
		try {
			await this.fs.writeFile(tmp, new Uint8Array(data));
			await this.fs.rename(tmp, p);
		} catch (e) {
			await this.fs.rm(tmp, { force: true }).catch(() => undefined);
			throw this.full(e);
		}
	}

	/** A full disk is a full "cloud" for this backend. */
	private full(e: unknown) {
		return isNoSpace(e) ? new QuotaError(`No space left on the disk of ${this.rootAbs}`) : e;
	}

	async space(): Promise<Space | null> {
		const statfs = (this.fs as unknown as { statfs?: (p: string) => Promise<{ bsize: number; blocks: number; bavail: number }> }).statfs;
		if (!statfs) return null;
		const s = await statfs.call(this.fs, this.rootAbs).catch(() => statfs.call(this.fs, this.path.dirname(this.rootAbs)));
		const total = Number(s.blocks) * Number(s.bsize);
		return total > 0 ? { used: total - Number(s.bavail) * Number(s.bsize), total } : null;
	}

	async upload(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile> {
		const p = this.child(parentId, name);
		if (await this.exists(p)) throw new HttpError(409, 'Already exists');
		await this.atomicWrite(p, data);
		return this.info(p, parentId);
	}

	async update(id: string, data: ArrayBuffer, prev?: RemoteFile): Promise<RemoteFile> {
		const p = this.abs(id);
		if (!(await this.exists(p))) throw new HttpError(404, 'Item no longer exists');
		await this.atomicWrite(p, data);
		return this.info(p, prev?.parentId ?? null);
	}

	async move(id: string, name: string, newParentId: string): Promise<RemoteFile> {
		const from = this.abs(id);
		if (!(await this.exists(from))) throw new HttpError(404, 'Item no longer exists');
		const to = this.child(newParentId, name);
		if (from.toLowerCase() !== to.toLowerCase() && (await this.exists(to))) throw new HttpError(409, 'Already exists');
		await this.fs.rename(from, to);
		for (const [k, v] of this.paths) if (v.startsWith(from + this.path.sep)) this.paths.set(k, to + v.slice(from.length));
		return this.info(to, newParentId);
	}

	async trash(id: string): Promise<void> {
		const p = this.inside(this.abs(id));
		const shell = (() => {
			try {
				return node<{ shell?: { trashItem?: (p: string) => Promise<void> } }>('electron').shell;
			} catch {
				return undefined;
			}
		})();
		if (shell?.trashItem) await shell.trashItem(p);
		else {
			const dir = this.path.join(this.rootAbs, TRASH, String(Date.now()));
			await this.fs.mkdir(dir, { recursive: true });
			await this.fs.rename(p, this.path.join(dir, this.path.basename(p)));
		}
		this.paths.delete(id);
	}

	async download(id: string): Promise<ArrayBuffer> {
		const p = this.abs(id);
		if (!(await this.exists(p))) throw new HttpError(404, 'Item no longer exists');
		const b = await this.fs.readFile(p);
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
	}
}

/** Typical install locations of the desktop apps, used to pre-fill the folder field. */
export async function suggestFolders(app: 'mega' | 'proton'): Promise<string[]> {
	if (!isDesktopFs()) return [];
	const fs = node<{ promises: Fs }>('fs').promises;
	const path = node<PathMod>('path');
	const home = node<{ homedir(): string }>('os').homedir();
	const out: string[] = [];
	const add = async (p: string) => {
		try {
			if ((await fs.stat(p)).isDirectory() && !out.includes(p)) out.push(p);
		} catch {
			/* not there */
		}
	};
	if (app === 'mega') {
		for (const p of ['MEGA', 'MEGAsync', path.join('Documents', 'MEGA'), path.join('Documents', 'MEGAsync')]) await add(path.join(home, p));
	} else {
		await add(path.join(home, 'Proton Drive'));
		for (const base of [home, path.join(home, 'Library', 'CloudStorage')]) {
			try {
				for (const n of await fs.readdir(base)) if (/^proton ?drive/i.test(n)) await add(path.join(base, n));
			} catch {
				/* ignore */
			}
		}
		// Windows: "Proton Drive\<account>\My files"
		for (const p of [...out]) {
			try {
				for (const n of await fs.readdir(p)) await add(path.join(p, n, 'My files'));
			} catch {
				/* ignore */
			}
		}
	}
	return out;
}
