import { ChangeProbe, HttpError, RemoteAPI, RemoteFile, Space } from '../types';
import { UnexpectedResponseError } from '../engine';
import { apiRequest, HttpFn, HttpResponse } from '../http';

const RPC = 'https://api.dropboxapi.com/2/';
const CONTENT = 'https://content.dropboxapi.com/2/';

interface Meta {
	'.tag': 'file' | 'folder' | 'deleted';
	id: string;
	name: string;
	path_lower?: string;
	path_display?: string;
	rev?: string;
	size?: number;
	server_modified?: string;
}

/** Header values must be ASCII: escape everything else as JSON \u sequences. */
const argHeader = (o: unknown) => JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const parentPath = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

/** Dropbox API v2. Works with both "App folder" and "Full Dropbox" apps. */
export class Dropbox implements RemoteAPI {
	readonly maxFileSize = 150 * 1024 * 1024;
	/** id -> display path, learnt from listings (ids are stable across renames). */
	private paths = new Map<string, string>();
	private rootId = '';
	private root: string;

	constructor(
		private http: HttpFn,
		private token: (force?: boolean) => Promise<string>,
		folder: string,
	) {
		this.root = '/' + folder;
	}

	private async call<T>(endpoint: string, arg: unknown, content?: { data?: ArrayBuffer; download?: boolean }): Promise<T | ArrayBuffer> {
		try {
			return await this.send<T>(endpoint, arg, content);
		} catch (e) {
			// Dropbox reports missing items as 409 ".../not_found": expose them as 404 like the other services.
			if (e instanceof HttpError && e.status === 409 && /not_found/.test(e.message)) throw new HttpError(404, e.message);
			throw e;
		}
	}

	private async send<T>(endpoint: string, arg: unknown, content?: { data?: ArrayBuffer; download?: boolean }): Promise<T | ArrayBuffer> {
		let res: HttpResponse;
		const opts = {
			label: 'Dropbox',
			isRateLimited: (r: HttpResponse) => r.status === 409 && /too_many_write_operations|too_many_requests/.test(r.text),
			message: (r: HttpResponse) => (r.json as { error_summary?: string })?.error_summary,
		};
		if (content) {
			res = await apiRequest(this.http, this.token, {
				url: CONTENT + endpoint,
				method: 'POST',
				headers: { 'Dropbox-API-Arg': argHeader(arg) },
				...(content.data ? { body: content.data, contentType: 'application/octet-stream' } : {}),
			}, opts);
			if (content.download) return res.arrayBuffer;
			return JSON.parse(res.text) as T;
		}
		res = await apiRequest(this.http, this.token, { url: RPC + endpoint, method: 'POST', contentType: 'application/json', body: JSON.stringify(arg) }, opts);
		return res.json as T;
	}

	private rpc<T>(endpoint: string, arg: unknown) {
		return this.call<T>(endpoint, arg) as Promise<T>;
	}

	private remember(m: Meta, parentId: string | null): RemoteFile {
		const path = m.path_display ?? '';
		if (path) this.paths.set(m.id, path);
		return {
			id: m.id,
			name: m.name,
			parentId,
			isFolder: m['.tag'] === 'folder',
			rev: m.rev,
			size: m.size,
			modifiedTime: m.server_modified,
		};
	}

	private async pathOf(id: string): Promise<string> {
		if (id === this.rootId) return this.root;
		const known = this.paths.get(id);
		if (known) return known;
		const m = await this.rpc<Meta>('files/get_metadata', { path: id });
		if (!m.path_display) throw new HttpError(404, 'Dropbox: unknown item');
		this.paths.set(id, m.path_display);
		return m.path_display;
	}

	private async meta(path: string): Promise<Meta | null> {
		try {
			const m = await this.rpc<Meta>('files/get_metadata', { path });
			if (!m || typeof m !== 'object' || !m['.tag'] || !m.id) throw new UnexpectedResponseError('Dropbox metadata');
			return m;
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) return null;
			throw e;
		}
	}

	async findRoot(): Promise<RemoteFile | null> {
		const m = await this.meta(this.root);
		if (!m || m['.tag'] !== 'folder') return null;
		this.rootId = m.id;
		return this.remember(m, null);
	}

	async vaultFolders(): Promise<string[]> {
		const parent = this.root.split('/').slice(0, -1).join('/');
		try {
			const r = await this.rpc<{ entries: Meta[] }>('files/list_folder', { path: parent, recursive: false, include_deleted: false, limit: 200 });
			return (r.entries ?? []).filter((e) => e['.tag'] === 'folder').map((e) => `${parent}/${e.name}`.replace(/^\/+/, ''));
		} catch {
			return [];
		}
	}

	async createRoot(): Promise<RemoteFile> {
		const r = await this.rpc<{ metadata: Meta }>('files/create_folder_v2', { path: this.root, autorename: false });
		this.rootId = r.metadata.id;
		return this.remember({ ...r.metadata, '.tag': 'folder' }, null);
	}

	async listAll(rootId: string): Promise<RemoteFile[]> {
		this.rootId = rootId;
		const entries: Meta[] = [];
		let r = await this.rpc<{ entries: Meta[]; cursor: string; has_more: boolean }>('files/list_folder', { path: this.root, recursive: true, include_deleted: false, limit: 2000 });
		entries.push(...r.entries);
		while (r.has_more) {
			r = await this.rpc('files/list_folder/continue', { cursor: r.cursor });
			entries.push(...r.entries);
		}
		const rootLower = this.root.toLowerCase();
		const folderIds = new Map<string, string>([[rootLower, rootId]]);
		for (const e of entries) if (e['.tag'] === 'folder' && e.path_lower) folderIds.set(e.path_lower, e.id);
		const out: RemoteFile[] = [];
		for (const e of entries) {
			if (e['.tag'] === 'deleted' || !e.path_lower || e.path_lower === rootLower) continue;
			const pid = folderIds.get(parentPath(e.path_lower));
			if (pid) out.push(this.remember(e, pid));
		}
		return out;
	}

	async findChild(parentId: string, name: string): Promise<RemoteFile | null> {
		const m = await this.meta(`${await this.pathOf(parentId)}/${name}`);
		return m ? this.remember(m, parentId) : null;
	}

	readonly probe: ChangeProbe = {
		start: async () => (await this.rpc<{ cursor: string }>('files/list_folder/get_latest_cursor', { path: this.root, recursive: true })).cursor,
		changed: async (token) => {
			let changed = false;
			let cursor = token;
			try {
				for (;;) {
					const r = await this.rpc<{ entries: Meta[]; cursor: string; has_more: boolean }>('files/list_folder/continue', { cursor });
					changed ||= r.entries.length > 0;
					cursor = r.cursor;
					if (!r.has_more) break;
				}
			} catch (e) {
				if (!(e instanceof HttpError && e.status === 409)) throw e;
				return { changed: true, token: await this.probe.start() }; // cursor reset
			}
			return { changed, token: cursor };
		},
	};

	async createFolder(name: string, parentId: string): Promise<RemoteFile> {
		const r = await this.rpc<{ metadata: Meta }>('files/create_folder_v2', { path: `${await this.pathOf(parentId)}/${name}`, autorename: false });
		return this.remember({ ...r.metadata, '.tag': 'folder' }, parentId);
	}

	async upload(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile> {
		const path = `${await this.pathOf(parentId)}/${name}`;
		const m = (await this.call<Meta>('files/upload', { path, mode: 'add', autorename: false, mute: true, strict_conflict: true }, { data })) as Meta;
		return this.remember({ ...m, '.tag': 'file' }, parentId);
	}

	async update(id: string, data: ArrayBuffer, prev?: RemoteFile): Promise<RemoteFile> {
		const path = await this.pathOf(id);
		// optimistic locking: refuses to overwrite a version we have not seen
		const mode = prev?.rev ? { '.tag': 'update', update: prev.rev } : 'overwrite';
		const m = (await this.call<Meta>('files/upload', { path, mode, autorename: false, mute: true, strict_conflict: true }, { data })) as Meta;
		return this.remember({ ...m, '.tag': 'file' }, prev?.parentId ?? null);
	}

	async move(id: string, name: string, newParentId: string): Promise<RemoteFile> {
		const from = await this.pathOf(id);
		const to = `${await this.pathOf(newParentId)}/${name}`;
		const r = await this.rpc<{ metadata: Meta }>('files/move_v2', { from_path: from, to_path: to, autorename: false });
		// descendants keep their ids but change path
		const fromLower = from.toLowerCase() + '/';
		for (const [k, v] of this.paths) if (v.toLowerCase().startsWith(fromLower)) this.paths.set(k, to + v.slice(from.length));
		const tag = r.metadata['.tag'] ?? (r.metadata.rev ? 'file' : 'folder');
		return this.remember({ ...r.metadata, '.tag': tag }, newParentId);
	}

	async trash(id: string): Promise<void> {
		await this.rpc('files/delete_v2', { path: await this.pathOf(id) });
		this.paths.delete(id);
	}

	async download(id: string): Promise<ArrayBuffer> {
		return this.call<ArrayBuffer>('files/download', { path: await this.pathOf(id) }, { download: true });
	}

	async account(): Promise<string> {
		const r = await apiRequest(this.http, this.token, { url: RPC + 'users/get_current_account', method: 'POST', contentType: 'application/json', body: 'null' }, { label: 'Dropbox' });
		const j = r.json as { email?: string; name?: { display_name?: string } };
		return j?.email ?? j?.name?.display_name ?? 'Dropbox';
	}

	/** Needs the account_info.read scope: apps without it simply get null. */
	async space(): Promise<Space | null> {
		const r = await apiRequest(this.http, this.token, { url: RPC + 'users/get_space_usage', method: 'POST', contentType: 'application/json', body: 'null' }, { label: 'Dropbox', retries: 1 });
		const j = r.json as { used?: number; allocation?: { allocated?: number; used?: number } };
		const total = Number(j?.allocation?.allocated ?? 0);
		// team spaces: the shared pool usage is in allocation.used
		const used = Math.max(Number(j?.used ?? 0), Number(j?.allocation?.used ?? 0));
		return total > 0 ? { used, total } : null;
	}
}
