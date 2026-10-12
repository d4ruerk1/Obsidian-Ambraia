import type { ChangeFeed, RemoteAPI, RemoteChange, RemoteFile, Space } from '../types';
import { apiRequest, HttpFn, HttpRequest, HttpResponse, multipart, randomId } from '../http';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,parents,md5Checksum,size,modifiedTime,createdTime,trashed,appProperties';
/** Property names kept from 1.x so existing Drive folders stay linked. */
const VAULT_PROP = 'ambraiaVault';
const ROOT_PROP = 'ambraiaRoot';

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	parents?: string[];
	md5Checksum?: string;
	size?: string;
	modifiedTime?: string;
	createdTime?: string;
	trashed?: boolean;
	appProperties?: Record<string, string>;
}

const toRemote = (f: DriveFile): RemoteFile => ({
	id: f.id,
	name: f.name,
	parentId: f.parents?.[0] ?? null,
	isFolder: f.mimeType === FOLDER,
	rev: f.md5Checksum,
	hash: f.md5Checksum,
	size: f.size !== undefined ? Number(f.size) : undefined,
	modifiedTime: f.modifiedTime,
	createdTime: f.createdTime,
});

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const enc = encodeURIComponent;

/** Google Drive v3 with the `drive.file` scope: only sees what Ambraia created. */
export class GoogleDrive implements RemoteAPI {
	/** `key` = the chosen directory ("Ambraia/Vault"); also tags every file of this vault. */
	constructor(
		private http: HttpFn,
		private token: (force?: boolean) => Promise<string>,
		private key: string,
		private retries = 4,
	) {}

	private req(r: HttpRequest): Promise<HttpResponse> {
		return apiRequest(this.http, this.token, r, {
			label: 'Google Drive',
			retries: this.retries,
			isRateLimited: (res) => res.status === 403 && /rateLimit|userRateLimit/i.test(res.text),
			message: (res) => (res.json as { error?: { message?: string } })?.error?.message,
		});
	}

	private async json<T>(r: HttpRequest): Promise<T> {
		const res = await this.req(r);
		return (res.json ?? JSON.parse(res.text)) as T;
	}

	private async query<T>(q: string, extra = ''): Promise<T> {
		const r = await this.json<T>({ url: `${API}/files?q=${enc(q)}&spaces=drive&fields=${enc(`nextPageToken,files(${FIELDS})`)}${extra}`, method: 'GET' });
		// a listing without its list is not "empty": never let it look like deleted files
		if (!Array.isArray((r as { files?: unknown })?.files)) throw new Error('Google Drive: unexpected response to a file listing');
		return r;
	}

	private tidied = false;

	async findRoot(): Promise<RemoteFile | null> {
		const r = await this.query<{ files: DriveFile[] }>(`appProperties has { key='${ROOT_PROP}' and value='${esc(this.key)}' } and mimeType='${FOLDER}' and trashed=false`, '&pageSize=10&orderBy=createdTime');
		const files = r.files ?? [];
		if (!files.length) return null;
		// Drive allows two folders with the same name: two devices that created the folder at the
		// same moment (or an older version) leave twins. They are folded into the oldest one.
		if (files.length > 1 || !this.tidied) await this.tidy(files);
		return toRemote(files[0]);
	}

	/** Folds twin vault folders (and twin parent folders such as "Ambraia") into the oldest one. */
	private async tidy(roots: DriveFile[]) {
		this.tidied = true;
		const main = roots[0];
		for (const twin of roots.slice(1)) {
			let page: string | undefined;
			do {
				const r = await this.query<{ files: DriveFile[]; nextPageToken?: string }>(`'${esc(twin.id)}' in parents and trashed=false`, `&pageSize=1000${page ? `&pageToken=${enc(page)}` : ''}`);
				// same-named items inside are then merged by the sync engine (its usual duplicate handling)
				for (const c of r.files ?? []) await this.move(c.id, c.name, main.id, twin.id);
				page = r.nextPageToken;
			} while (page);
			await this.trash(twin.id);
			// its own parent folder ("Ambraia" created twice) goes too, when nothing else is inside
			const tp = twin.parents?.[0];
			if (tp && tp !== main.parents?.[0] && this.key.split('/').length > 1) await this.dropEmpty(tp, this.key.split('/').slice(-2, -1)[0]);
		}
		// twin parent folders ("Ambraia" created twice): move the vault folder into the oldest one
		const parentId = main.parents?.[0];
		if (!parentId || this.key.split('/').length < 2) return;
		try {
			const pname = this.key.split('/').slice(-2, -1)[0];
			const me = await this.json<DriveFile>({ url: `${API}/files/${enc(parentId)}?fields=${enc(FIELDS)}`, method: 'GET' });
			const grand = me.parents?.[0];
			if (!grand || me.name !== pname) return;
			const sib = await this.query<{ files: DriveFile[] }>(`name='${esc(pname)}' and '${esc(grand)}' in parents and mimeType='${FOLDER}' and trashed=false`, '&pageSize=10&orderBy=createdTime');
			const oldest = sib.files?.[0];
			if (!oldest || oldest.id === parentId) return;
			await this.move(main.id, main.name, oldest.id, parentId);
			main.parents = [oldest.id];
			await this.dropEmpty(parentId, pname);
		} catch {
			/* best effort: sync works anyway */
		}
	}

	/** Trashes a folder left empty by the folding (only if it has the expected name). */
	private async dropEmpty(id: string, name: string) {
		try {
			const me = await this.json<DriveFile>({ url: `${API}/files/${enc(id)}?fields=${enc(FIELDS)}`, method: 'GET' });
			if (me.name !== name) return;
			const left = await this.query<{ files: DriveFile[] }>(`'${esc(id)}' in parents and trashed=false`, '&pageSize=1');
			if (!left.files?.length) await this.trash(id);
		} catch {
			/* best effort */
		}
	}

	/** Vault folders that Ambraia created on this account (it only sees its own folders). */
	async vaultFolders(): Promise<string[]> {
		const out = new Set<string>();
		let page: string | undefined;
		try {
			do {
				const r = await this.query<{ files: DriveFile[]; nextPageToken?: string }>(`mimeType='${FOLDER}' and trashed=false`, `&pageSize=1000${page ? `&pageToken=${enc(page)}` : ''}`);
				for (const f of r.files ?? []) {
					const k = f.appProperties?.[ROOT_PROP];
					if (k) out.add(k);
				}
				page = r.nextPageToken;
			} while (page);
		} catch {
			/* only a suggestion */
		}
		return [...out];
	}

	private create(meta: object): Promise<DriveFile> {
		return this.json<DriveFile>({ url: `${API}/files?fields=${enc(FIELDS)}`, method: 'POST', contentType: 'application/json', body: JSON.stringify(meta) });
	}

	async createRoot(): Promise<RemoteFile> {
		// another device may have just created it
		const existing = await this.findRoot();
		if (existing) return existing;
		const segs = this.key.split('/');
		let parent = 'root';
		for (const name of segs.slice(0, -1)) {
			const r = await this.query<{ files: DriveFile[] }>(`name='${esc(name)}' and '${esc(parent)}' in parents and mimeType='${FOLDER}' and trashed=false`, '&pageSize=1&orderBy=createdTime');
			parent = r.files?.[0]?.id ?? (await this.create({ name, mimeType: FOLDER, parents: [parent] })).id;
		}
		const f = await this.create({ name: segs[segs.length - 1], mimeType: FOLDER, parents: [parent], description: 'Obsidian vault synced by Ambraia. Do not edit manually.', appProperties: { [ROOT_PROP]: this.key } });
		// two devices racing: whoever was second sees two roots and keeps the oldest
		return (await this.findRoot()) ?? toRemote(f);
	}

	async listAll(): Promise<RemoteFile[]> {
		const q = `appProperties has { key='${VAULT_PROP}' and value='${esc(this.key)}' } and trashed=false`;
		const out: RemoteFile[] = [];
		let page: string | undefined;
		do {
			const r = await this.query<{ files: DriveFile[]; nextPageToken?: string }>(q, `&pageSize=1000${page ? `&pageToken=${enc(page)}` : ''}`);
			for (const f of r.files ?? []) out.push(toRemote(f));
			page = r.nextPageToken;
		} while (page);
		return out;
	}

	async findChild(parentId: string, name: string): Promise<RemoteFile | null> {
		const r = await this.query<{ files: DriveFile[] }>(`name='${esc(name)}' and '${esc(parentId)}' in parents and trashed=false`, '&pageSize=1');
		return r.files?.[0] ? toRemote(r.files[0]) : null;
	}

	readonly changes: ChangeFeed = {
		start: async () => (await this.json<{ startPageToken: string }>({ url: `${API}/changes/startPageToken`, method: 'GET' })).startPageToken,
		list: async (token) => {
			const changes: RemoteChange[] = [];
			let page: string | undefined = token;
			let newToken = token;
			while (page) {
				const r: { changes?: { fileId: string; removed?: boolean; file?: DriveFile }[]; nextPageToken?: string; newStartPageToken?: string } = await this.json({
					url: `${API}/changes?pageToken=${enc(page)}&spaces=drive&pageSize=1000&includeRemoved=true&fields=${enc(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`)}`,
					method: 'GET',
				});
				for (const c of r.changes ?? []) {
					const f = c.file;
					const props = f?.appProperties ?? {};
					const mine = props[VAULT_PROP] === this.key || props[ROOT_PROP] === this.key;
					if (c.removed || !f || f.trashed || !mine) changes.push({ fileId: c.fileId, removed: true });
					else changes.push({ fileId: c.fileId, removed: false, file: toRemote(f) });
				}
				if (r.newStartPageToken) newToken = r.newStartPageToken;
				page = r.nextPageToken;
			}
			return { changes, newToken };
		},
	};

	async createFolder(name: string, parentId: string): Promise<RemoteFile> {
		return toRemote(await this.create({ name, mimeType: FOLDER, parents: [parentId], appProperties: { [VAULT_PROP]: this.key } }));
	}

	async upload(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile> {
		const boundary = 'obx' + randomId(12);
		const body = multipart(
			[
				{ headers: 'Content-Type: application/json; charset=UTF-8', body: JSON.stringify({ name, parents: [parentId], appProperties: { [VAULT_PROP]: this.key } }) },
				{ headers: 'Content-Type: application/octet-stream', body: new Uint8Array(data) },
			],
			boundary,
		);
		return toRemote(await this.json<DriveFile>({ url: `${UPLOAD}/files?uploadType=multipart&fields=${enc(FIELDS)}`, method: 'POST', contentType: `multipart/related; boundary=${boundary}`, body }));
	}

	async update(id: string, data: ArrayBuffer): Promise<RemoteFile> {
		return toRemote(await this.json<DriveFile>({ url: `${UPLOAD}/files/${enc(id)}?uploadType=media&fields=${enc(FIELDS)}`, method: 'PATCH', contentType: 'application/octet-stream', body: data }));
	}

	async move(id: string, name: string, newParentId: string, oldParentId: string | null): Promise<RemoteFile> {
		let url = `${API}/files/${enc(id)}?fields=${enc(FIELDS)}`;
		if (oldParentId !== newParentId) {
			url += `&addParents=${enc(newParentId)}`;
			if (oldParentId) url += `&removeParents=${enc(oldParentId)}`;
		}
		return toRemote(await this.json<DriveFile>({ url, method: 'PATCH', contentType: 'application/json', body: JSON.stringify({ name }) }));
	}

	async trash(id: string): Promise<void> {
		await this.req({ url: `${API}/files/${enc(id)}?fields=id`, method: 'PATCH', contentType: 'application/json', body: JSON.stringify({ trashed: true }) });
	}

	async download(id: string): Promise<ArrayBuffer> {
		return (await this.req({ url: `${API}/files/${enc(id)}?alt=media`, method: 'GET' })).arrayBuffer;
	}

	async account(): Promise<string> {
		const r = await this.json<{ user?: { emailAddress?: string; displayName?: string } }>({ url: `${API}/about?fields=user(emailAddress,displayName)`, method: 'GET' });
		return r.user?.emailAddress ?? r.user?.displayName ?? 'Google';
	}

	/** No limit = unlimited plan (Workspace pooled storage): unknown. */
	async space(): Promise<Space | null> {
		const r = await this.json<{ storageQuota?: { limit?: string; usage?: string } }>({ url: `${API}/about?fields=storageQuota`, method: 'GET' });
		const total = Number(r.storageQuota?.limit ?? 0);
		return total > 0 ? { used: Number(r.storageQuota?.usage ?? 0), total } : null;
	}
}
