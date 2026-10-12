import { ChangeProbe, HttpError, RemoteAPI, RemoteFile, Space } from '../types';
import { AuthError, LimitError, NetworkError, QuotaError, UnexpectedResponseError } from '../engine';
import { apiRequest, HttpFn, multipart, randomId } from '../http';

interface Meta {
	name: string;
	isfolder: boolean;
	folderid?: number;
	fileid?: number;
	parentfolderid?: number;
	hash?: number | string;
	size?: number;
	modified?: string;
	created?: string;
	contents?: Meta[];
}
interface Res {
	result: number;
	error?: string;
	metadata?: Meta | Meta[];
	diffid?: number;
	entries?: unknown[];
	hosts?: string[];
	path?: string;
	email?: string;
}

const enc = encodeURIComponent;
const fid = (m: Meta) => (m.isfolder ? `d${m.folderid}` : `f${m.fileid}`);
const num = (id: string) => id.slice(1);

/** pCloud (US and EU data regions). */
export class PCloud implements RemoteAPI {
	private info = new Map<string, { parent: string; name: string }>();

	constructor(
		private http: HttpFn,
		private token: () => Promise<string>,
		/** api.pcloud.com (US) or eapi.pcloud.com (EU) */
		private host: string,
		private folder: string,
	) {}

	private async call(method: string, params: Record<string, string | number>, body?: { data: ArrayBuffer; name: string }): Promise<Res> {
		const q = Object.entries(params)
			.map(([k, v]) => `${k}=${enc(String(v))}`)
			.join('&');
		const url = `https://${this.host}/${method}${q ? '?' + q : ''}`;
		let res;
		if (body) {
			const boundary = 'obx' + randomId(12);
			const payload = multipart([{ headers: `Content-Disposition: form-data; name="file"; filename="${body.name.replace(/["\r\n]/g, '_')}"\r\nContent-Type: application/octet-stream`, body: new Uint8Array(body.data) }], boundary);
			res = await apiRequest(this.http, this.token, { url, method: 'POST', contentType: `multipart/form-data; boundary=${boundary}`, body: payload }, { label: 'pCloud' });
		} else res = await apiRequest(this.http, this.token, { url, method: 'GET' }, { label: 'pCloud' });
		const j = res.json as Res;
		if (!j || typeof j.result !== 'number') throw new NetworkError('pCloud: invalid response');
		if (j.result === 0) return j;
		const msg = `pCloud ${j.result}: ${j.error ?? ''}`;
		if ([1000, 2000, 2094, 2095, 2012].includes(j.result)) throw new AuthError(msg);
		if ([2005, 2009, 2002].includes(j.result)) throw new HttpError(404, msg);
		if ([2004, 2001].includes(j.result)) throw new HttpError(409, msg);
		if (j.result === 2008) throw new QuotaError(msg);
		if (j.result === 4000) throw new LimitError(msg, 15 * 60_000);
		if (j.result >= 4000) throw new NetworkError(msg);
		throw new HttpError(400, msg);
	}

	private toRemote(m: Meta, parentId?: string | null): RemoteFile {
		const id = fid(m);
		const parent = parentId !== undefined ? parentId : m.parentfolderid !== undefined ? `d${m.parentfolderid}` : null;
		if (parent) this.info.set(id, { parent, name: m.name });
		return {
			id,
			name: m.name,
			parentId: parent,
			isFolder: !!m.isfolder,
			rev: m.isfolder ? undefined : `${m.hash}-${m.size}`,
			size: m.isfolder ? undefined : m.size,
			modifiedTime: m.modified,
			createdTime: m.created,
		};
	}

	private meta(r: Res): Meta {
		const m = Array.isArray(r.metadata) ? r.metadata[0] : r.metadata;
		if (!m) throw new NetworkError('pCloud: missing metadata');
		if ((m.isfolder ? m.folderid : m.fileid) === undefined) throw new UnexpectedResponseError('pCloud metadata');
		return m;
	}

	async findRoot(): Promise<RemoteFile | null> {
		try {
			return this.toRemote(this.meta(await this.call('listfolder', { path: '/' + this.folder, nofiles: 1 })), null);
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) return null;
			throw e;
		}
	}

	async createRoot(): Promise<RemoteFile> {
		let parent = 0;
		let m: Meta | null = null;
		for (const name of this.folder.split('/')) {
			m = this.meta(await this.call('createfolderifnotexists', { folderid: parent, name }));
			parent = m.folderid!;
		}
		return this.toRemote(m!, null);
	}

	async listAll(rootId: string): Promise<RemoteFile[]> {
		const root = this.meta(await this.call('listfolder', { folderid: num(rootId), recursive: 1 }));
		const out: RemoteFile[] = [];
		const walk = (m: Meta) => {
			for (const c of m.contents ?? []) {
				out.push(this.toRemote(c, fid(m)));
				if (c.isfolder) walk(c);
			}
		};
		walk(root);
		return out;
	}

	async vaultFolders(): Promise<string[]> {
		const parent = this.folder.split('/').slice(0, -1).join('/');
		try {
			const m = this.meta(await this.call('listfolder', { path: '/' + parent, nofiles: 1 }));
			return (m.contents ?? []).filter((c) => c.isfolder).map((c) => (parent ? `${parent}/${c.name}` : c.name));
		} catch {
			return [];
		}
	}

	async findChild(parentId: string, name: string): Promise<RemoteFile | null> {
		const m = this.meta(await this.call('listfolder', { folderid: num(parentId) }));
		const c = (m.contents ?? []).find((x) => x.name === name);
		return c ? this.toRemote(c, parentId) : null;
	}

	readonly probe: ChangeProbe = {
		start: async () => String((await this.call('diff', { last: 0 })).diffid ?? 0),
		changed: async (token) => {
			const r = await this.call('diff', { diffid: token, limit: 1 });
			if ((r.entries?.length ?? 0) > 0) return { changed: true, token: await this.probe.start() };
			return { changed: false, token: String(r.diffid ?? token) };
		},
	};

	async createFolder(name: string, parentId: string): Promise<RemoteFile> {
		return this.toRemote(this.meta(await this.call('createfolder', { folderid: num(parentId), name })), parentId);
	}

	private async put(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile> {
		const r = await this.call('uploadfile', { folderid: num(parentId), filename: name, nopartial: 1 }, { data, name });
		return this.toRemote(this.meta(r), parentId);
	}

	upload(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile> {
		return this.put(name, parentId, data);
	}

	async update(id: string, data: ArrayBuffer): Promise<RemoteFile> {
		let i = this.info.get(id);
		if (!i) {
			const m = this.meta(await this.call('stat', { fileid: num(id) }));
			i = { parent: `d${m.parentfolderid}`, name: m.name };
		}
		// uploading over the same name creates a new revision of the same file
		return this.put(i.name, i.parent, data);
	}

	async move(id: string, name: string, newParentId: string): Promise<RemoteFile> {
		const isFolder = id.startsWith('d');
		const r = await this.call(isFolder ? 'renamefolder' : 'renamefile', { [isFolder ? 'folderid' : 'fileid']: num(id), tofolderid: num(newParentId), toname: name });
		return this.toRemote(this.meta(r), newParentId);
	}

	async trash(id: string): Promise<void> {
		// deletefolder (not recursive): the engine only removes folders it knows are empty
		if (id.startsWith('d')) await this.call('deletefolder', { folderid: num(id) });
		else await this.call('deletefile', { fileid: num(id) });
		this.info.delete(id);
	}

	async trashTree(id: string): Promise<void> {
		if (id.startsWith('d')) await this.call('deletefolderrecursive', { folderid: num(id) });
		else await this.trash(id);
	}

	async download(id: string): Promise<ArrayBuffer> {
		const r = await this.call('getfilelink', { fileid: num(id), forcedownload: 1 });
		if (!r.hosts?.length || !r.path) throw new HttpError(404, 'pCloud: no link');
		const res = await apiRequest(this.http, null, { url: `https://${r.hosts[0]}${r.path}`, method: 'GET' }, { label: 'pCloud' });
		return res.arrayBuffer;
	}

	async account(): Promise<string> {
		return (await this.call('userinfo', {})).email ?? 'pCloud';
	}

	async space(): Promise<Space | null> {
		const r = (await this.call('userinfo', {})) as Res & { quota?: number; usedquota?: number };
		return typeof r.quota === 'number' && r.quota > 0 ? { used: Number(r.usedquota ?? 0), total: r.quota } : null;
	}
}
