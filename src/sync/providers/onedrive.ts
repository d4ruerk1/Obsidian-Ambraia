import { ChangeFeed, ChangeProbe, HttpError, RemoteAPI, RemoteChange, RemoteFile, Space } from '../types';
import { UnexpectedResponseError } from '../engine';
import { apiRequest, HttpFn, HttpRequest, HttpResponse } from '../http';

const API = 'https://graph.microsoft.com/v1.0/me/drive';
const SELECT = '$select=id,name,parentReference,file,folder,size,cTag,eTag,lastModifiedDateTime,createdDateTime,deleted';
const SIMPLE_MAX = 4 * 1024 * 1024;
const CHUNK = 320 * 1024 * 32; // multiple of 320 KiB, as required by Graph

interface Item {
	id: string;
	name?: string;
	parentReference?: { id?: string };
	file?: object;
	folder?: object;
	size?: number;
	cTag?: string;
	eTag?: string;
	lastModifiedDateTime?: string;
	createdDateTime?: string;
	deleted?: object;
}
interface Page {
	value?: Item[];
	'@odata.nextLink'?: string;
	'@odata.deltaLink'?: string;
}

const enc = encodeURIComponent;
const encPath = (p: string) => p.split('/').map(enc).join('/');

/** Microsoft OneDrive (personal and work/school) through Microsoft Graph. */
export class OneDrive implements RemoteAPI {
	private etags = new Map<string, string>();
	/** Delta queries on a sub-folder are not available on OneDrive for work/school. */
	private folderDelta: boolean | null = null;
	private rootId = '';

	constructor(
		private http: HttpFn,
		private token: (force?: boolean) => Promise<string>,
		private folder: string,
	) {}

	private req(r: HttpRequest, auth = true): Promise<HttpResponse> {
		return apiRequest(this.http, auth ? this.token : null, r, {
			label: 'OneDrive',
			message: (res) => (res.json as { error?: { message?: string } })?.error?.message,
		});
	}

	private async get<T>(url: string): Promise<T> {
		return (await this.req({ url, method: 'GET' })).json as T;
	}

	private toRemote(i: Item): RemoteFile {
		if (i.eTag) this.etags.set(i.id, i.eTag);
		const isFolder = !!i.folder;
		return {
			id: i.id,
			name: i.name ?? '',
			parentId: i.parentReference?.id ?? null,
			isFolder,
			rev: isFolder ? undefined : i.cTag,
			size: isFolder ? undefined : i.size,
			modifiedTime: i.lastModifiedDateTime,
			createdTime: i.createdDateTime,
		};
	}

	private async item(path: string): Promise<Item | null> {
		try {
			const i = await this.get<Item>(`${API}/root:/${encPath(path)}?${SELECT}`);
			if (!i || typeof i !== 'object' || !i.id) throw new UnexpectedResponseError('OneDrive item');
			return i;
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) return null;
			throw e;
		}
	}

	async findRoot(): Promise<RemoteFile | null> {
		const i = await this.item(this.folder);
		if (!i || !i.folder) return null;
		this.rootId = i.id;
		return this.toRemote(i);
	}

	async vaultFolders(): Promise<string[]> {
		const parent = this.folder.split('/').slice(0, -1).join('/');
		try {
			const r = await this.get<{ value?: Item[] }>(parent ? `${API}/root:/${encPath(parent)}:/children?$top=200&$select=id,name,folder` : `${API}/root/children?$top=200&$select=id,name,folder`);
			return (r.value ?? []).filter((i) => i.folder && i.name).map((i) => (parent ? `${parent}/${i.name}` : i.name!));
		} catch {
			return [];
		}
	}

	private async mkdir(parentId: string, name: string): Promise<Item> {
		const url = parentId ? `${API}/items/${enc(parentId)}/children` : `${API}/root/children`;
		const res = await this.req({ url, method: 'POST', contentType: 'application/json', body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) });
		return res.json as Item;
	}

	async createRoot(): Promise<RemoteFile> {
		let parent = '';
		let path = '';
		let last: Item | null = null;
		for (const seg of this.folder.split('/')) {
			path = path ? `${path}/${seg}` : seg;
			last = (await this.item(path)) ?? (await this.mkdir(parent, seg));
			parent = last.id;
		}
		this.rootId = last!.id;
		return this.toRemote(last!);
	}

	private async pages(url: string): Promise<{ items: Item[]; delta?: string }> {
		const items: Item[] = [];
		let next: string | undefined = url;
		let delta: string | undefined;
		while (next) {
			const p: Page = await this.get<Page>(next);
			if (!Array.isArray(p?.value)) throw new Error('OneDrive: unexpected response to a file listing');
			items.push(...p.value);
			next = p['@odata.nextLink'];
			delta = p['@odata.deltaLink'] ?? delta;
		}
		return { items, delta };
	}

	async listAll(rootId: string): Promise<RemoteFile[]> {
		this.rootId = rootId;
		if (this.folderDelta !== false) {
			try {
				const { items } = await this.pages(`${API}/items/${enc(rootId)}/delta?${SELECT}`);
				this.folderDelta = true;
				return items.filter((i) => i.id !== rootId && !i.deleted).map((i) => this.toRemote(i));
			} catch (e) {
				if (!(e instanceof HttpError) || e.status >= 500 || e.status === 404) throw e;
				this.folderDelta = false;
			}
		}
		// work/school accounts: walk the tree
		const out: RemoteFile[] = [];
		const queue = [rootId];
		while (queue.length) {
			const id = queue.shift()!;
			const { items } = await this.pages(`${API}/items/${enc(id)}/children?${SELECT}&$top=999`);
			for (const i of items) {
				const f = this.toRemote({ ...i, parentReference: { id } });
				out.push(f);
				if (f.isFolder) queue.push(i.id);
			}
		}
		return out;
	}

	async findChild(parentId: string, name: string): Promise<RemoteFile | null> {
		try {
			return this.toRemote(await this.get<Item>(`${API}/items/${enc(parentId)}:/${enc(name)}?${SELECT}`));
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) return null;
			throw e;
		}
	}

	private readonly feed: ChangeFeed = {
		start: async () => {
			try {
				const { delta } = await this.pages(`${API}/items/${enc(this.rootId)}/delta?token=latest`);
				this.folderDelta = true;
				return delta ?? '';
			} catch (e) {
				if (!(e instanceof HttpError) || e.status >= 500 || e.status === 404) throw e;
				this.folderDelta = false;
				return '';
			}
		},
		list: async (token) => {
			if (!token) throw new HttpError(410, 'OneDrive: no delta token');
			const { items, delta } = await this.pages(token);
			const changes: RemoteChange[] = items.map((i) =>
				i.deleted ? { fileId: i.id, removed: true } : { fileId: i.id, removed: false, file: this.toRemote(i) },
			);
			return { changes, newToken: delta ?? token };
		},
	};

	get changes(): ChangeFeed | undefined {
		return this.folderDelta === false ? undefined : this.feed;
	}

	/** Used when folder delta is unavailable: drive-wide "anything changed?" check. */
	readonly probe: ChangeProbe = {
		start: async () => (await this.pages(`${API}/root/delta?token=latest`)).delta ?? '',
		changed: async (token) => {
			if (!token) return { changed: true, token: await this.probe.start() };
			const p = await this.get<Page>(token);
			if ((p.value?.length ?? 0) > 0 || p['@odata.nextLink']) return { changed: true, token: await this.probe.start() };
			return { changed: false, token: p['@odata.deltaLink'] ?? token };
		},
	};

	async createFolder(name: string, parentId: string): Promise<RemoteFile> {
		return this.toRemote(await this.mkdir(parentId, name));
	}

	private async put(target: string, data: ArrayBuffer, conflict: 'fail' | 'replace', ifMatch?: string): Promise<Item> {
		const headers: Record<string, string> = ifMatch ? { 'If-Match': ifMatch } : {};
		if (data.byteLength <= SIMPLE_MAX) {
			const res = await this.req({ url: `${API}/${target}/content?@microsoft.graph.conflictBehavior=${conflict}`, method: 'PUT', headers, contentType: 'application/octet-stream', body: data });
			return res.json as Item;
		}
		const s = await this.req({
			url: `${API}/${target}/createUploadSession`,
			method: 'POST',
			headers,
			contentType: 'application/json',
			body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': conflict } }),
		});
		const uploadUrl = (s.json as { uploadUrl: string }).uploadUrl;
		let res: HttpResponse | null = null;
		for (let o = 0; o < data.byteLength; o += CHUNK) {
			const end = Math.min(o + CHUNK, data.byteLength);
			// the upload URL is pre-authenticated: never send the bearer token to it
			res = await this.req({ url: uploadUrl, method: 'PUT', headers: { 'Content-Range': `bytes ${o}-${end - 1}/${data.byteLength}` }, contentType: 'application/octet-stream', body: data.slice(o, end) }, false);
		}
		return res!.json as Item;
	}

	async upload(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile> {
		return this.toRemote(await this.put(`items/${enc(parentId)}:/${enc(name)}:`, data, 'fail'));
	}

	async update(id: string, data: ArrayBuffer): Promise<RemoteFile> {
		return this.toRemote(await this.put(`items/${enc(id)}`, data, 'replace', this.etags.get(id)));
	}

	async move(id: string, name: string, newParentId: string): Promise<RemoteFile> {
		const res = await this.req({
			url: `${API}/items/${enc(id)}?@microsoft.graph.conflictBehavior=fail`,
			method: 'PATCH',
			contentType: 'application/json',
			body: JSON.stringify({ name, parentReference: { id: newParentId } }),
		});
		return this.toRemote(res.json as Item);
	}

	async trash(id: string): Promise<void> {
		await this.req({ url: `${API}/items/${enc(id)}`, method: 'DELETE' });
		this.etags.delete(id);
	}

	async download(id: string): Promise<ArrayBuffer> {
		const i = await this.get<{ '@microsoft.graph.downloadUrl'?: string }>(`${API}/items/${enc(id)}?$select=id,@microsoft.graph.downloadUrl`);
		const url = i['@microsoft.graph.downloadUrl'];
		if (!url) throw new HttpError(404, 'OneDrive: no download URL');
		return (await this.req({ url, method: 'GET' }, false)).arrayBuffer;
	}

	async account(): Promise<string> {
		const d = await this.get<{ owner?: { user?: { displayName?: string; email?: string } } }>(`${API}?$select=owner`);
		return d.owner?.user?.email ?? d.owner?.user?.displayName ?? 'OneDrive';
	}

	async space(): Promise<Space | null> {
		const d = await this.get<{ quota?: { total?: number; used?: number; remaining?: number; state?: string } }>(`${API}?$select=quota`);
		const q = d.quota;
		const total = Number(q?.total ?? 0);
		if (!(total > 0)) return null;
		const used = q?.remaining !== undefined ? total - Number(q.remaining) : Number(q?.used ?? 0);
		return { used: q?.state === 'exceeded' ? Math.max(used, total) : used, total };
	}
}
