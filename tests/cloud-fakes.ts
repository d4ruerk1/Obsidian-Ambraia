/**
 * In-memory emulations of the HTTP APIs of Google Drive, Dropbox, OneDrive and pCloud,
 * faithful enough to run the real provider clients against them.
 */
import type { HttpFn, HttpRequest, HttpResponse } from '../src/sync/http';
import { md5 } from '../src/sync/types';

interface Node {
	id: string;
	name: string;
	parent: string | null;
	folder: boolean;
	data?: Uint8Array;
	ver: number;
	meta: number;
	trashed: boolean;
	props?: Record<string, string>;
	time: number;
}

const te = new TextEncoder();
const td = new TextDecoder();
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const bytes = (b?: string | ArrayBuffer) => (b === undefined ? new Uint8Array() : typeof b === 'string' ? te.encode(b) : new Uint8Array(b));

export function respond(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
	const raw = body instanceof Uint8Array ? body : te.encode(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
	const text = td.decode(raw);
	return {
		status,
		headers,
		text,
		get json() {
			try {
				return JSON.parse(text);
			} catch {
				return null;
			}
		},
		arrayBuffer: buf(raw),
	};
}

/** Shared file tree with a change log. */
export class Cloud {
	nodes = new Map<string, Node>();
	log: { id: string; seq: number }[] = [];
	seq = 0;
	next = 1;
	clock = 1_700_000_000;
	requests: HttpRequest[] = [];
	constructor(public caseInsensitive = false) {
		this.nodes.set('ROOT', { id: 'ROOT', name: '', parent: null, folder: true, ver: 1, meta: 1, trashed: false, time: this.clock });
	}
	touch(id: string) {
		this.log.push({ id, seq: ++this.seq });
	}
	alive(n: Node | undefined): n is Node {
		if (!n) return false;
		for (let c: Node | undefined = n; c; c = c.parent ? this.nodes.get(c.parent) : undefined) if (c.trashed) return false;
		return true;
	}
	same(a: string, b: string) {
		return this.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
	}
	children(id: string) {
		return [...this.nodes.values()].filter((n) => n.parent === id && !n.trashed);
	}
	child(id: string, name: string) {
		return this.children(id).find((n) => this.same(n.name, name));
	}
	descendants(id: string): Node[] {
		const out: Node[] = [];
		for (const c of this.children(id)) out.push(c, ...(c.folder ? this.descendants(c.id) : []));
		return out;
	}
	path(id: string): string {
		const n = this.nodes.get(id)!;
		if (!n.parent) return '';
		return `${this.path(n.parent)}/${n.name}`;
	}
	byPath(p: string): Node | undefined {
		let cur = this.nodes.get('ROOT')!;
		for (const seg of p.split('/').filter(Boolean)) {
			const c = this.child(cur.id, seg);
			if (!c) return undefined;
			cur = c;
		}
		return cur;
	}
	add(parent: string, name: string, folder: boolean, data?: Uint8Array, props?: Record<string, string>): Node {
		const n: Node = { id: String(this.next++), name, parent, folder, data, ver: 1, meta: 1, trashed: false, props, time: ++this.clock };
		this.nodes.set(n.id, n);
		this.touch(n.id);
		return n;
	}
	mkdirp(p: string): Node {
		let cur = this.nodes.get('ROOT')!;
		for (const seg of p.split('/').filter(Boolean)) cur = this.child(cur.id, seg) ?? this.add(cur.id, seg, true);
		return cur;
	}
	write(n: Node, data: Uint8Array) {
		n.data = data;
		n.ver++;
		n.meta++;
		n.time = ++this.clock;
		this.touch(n.id);
	}
	trash(n: Node) {
		n.trashed = true;
		this.touch(n.id);
		for (const d of this.descendants(n.id)) this.touch(d.id);
	}
	move(n: Node, parent: string, name: string) {
		n.parent = parent;
		n.name = name;
		n.meta++;
		this.touch(n.id);
		for (const d of this.descendants(n.id)) this.touch(d.id);
	}
	changedSince(seq: number) {
		return [...new Set(this.log.filter((l) => l.seq > seq).map((l) => l.id))].map((id) => this.nodes.get(id)!);
	}
	/** live files below a path, relative, as text */
	files(base: string): Record<string, string> {
		const root = this.byPath(base);
		const o: Record<string, string> = {};
		if (!root) return o;
		const pre = this.path(root.id);
		for (const d of this.descendants(root.id)) if (!d.folder) o[this.path(d.id).slice(pre.length + 1)] = td.decode(d.data ?? new Uint8Array());
		return o;
	}
}

const q = (url: string) => new URL(url).searchParams;
const bearer = (r: HttpRequest) => r.headers?.Authorization === 'Bearer TOKEN';

/** Extracts the parts of a multipart body. */
function parts(body: ArrayBuffer, contentType: string): { headers: string; data: Uint8Array }[] {
	const boundary = /boundary=([^;]+)/.exec(contentType)![1];
	const raw = new Uint8Array(body);
	const s = td.decode(raw); // offsets are only valid for ASCII headers: map them on bytes
	const latin = Array.from(raw, (b) => String.fromCharCode(b)).join('');
	void s;
	const out: { headers: string; data: Uint8Array }[] = [];
	const sep = `--${boundary}`;
	let i = latin.indexOf(sep);
	while (i >= 0) {
		const start = i + sep.length;
		if (latin.startsWith('--', start)) break;
		const hEnd = latin.indexOf('\r\n\r\n', start);
		const next = latin.indexOf(`\r\n${sep}`, hEnd);
		out.push({ headers: latin.slice(start + 2, hEnd), data: raw.slice(hEnd + 4, next) });
		i = next + 2;
	}
	return out;
}

// ------------------------------------------------------------------ Dropbox

export function dropboxHttp(c: Cloud): HttpFn {
	const err = (summary: string) => respond(409, { error_summary: summary });
	const meta = (n: Node) => ({
		'.tag': n.folder ? 'folder' : 'file',
		id: 'id:' + n.id,
		name: n.name,
		path_lower: c.path(n.id).toLowerCase(),
		path_display: c.path(n.id),
		...(n.folder ? {} : { rev: `r${n.id}x${n.ver}`, size: n.data?.length ?? 0, server_modified: new Date(n.time * 1000).toISOString() }),
	});
	const resolve = (p: string) => (p.startsWith('id:') ? [c.nodes.get(p.slice(3))].find((n) => c.alive(n)) : c.byPath(p));
	const parentName = (p: string) => ({ dir: p.slice(0, p.lastIndexOf('/')), name: p.slice(p.lastIndexOf('/') + 1) });
	const cursor = (path: string, seq = c.seq) => JSON.stringify({ path, seq });
	return async (r) => {
		c.requests.push(r);
		if (!bearer(r)) return respond(401, 'no token');
		const ep = r.url.replace(/^https:\/\/(api|content)\.dropboxapi\.com\/2\//, '');
		const arg = r.headers?.['Dropbox-API-Arg'] ? JSON.parse(r.headers['Dropbox-API-Arg']) : r.body && typeof r.body === 'string' ? JSON.parse(r.body) : null;
		switch (ep) {
			case 'files/get_metadata': {
				const n = resolve(arg.path);
				return n ? respond(200, meta(n)) : err('path/not_found/');
			}
			case 'files/create_folder_v2': {
				if (resolve(arg.path)) return err('path/conflict/folder/');
				return respond(200, { metadata: meta(c.mkdirp(arg.path)) });
			}
			case 'files/list_folder': {
				const n = resolve(arg.path);
				if (!n) return err('path/not_found/');
				return respond(200, { entries: [meta(n), ...c.descendants(n.id).map(meta)], cursor: cursor(c.path(n.id)), has_more: false });
			}
			case 'files/list_folder/get_latest_cursor':
				return respond(200, { cursor: cursor(arg.path) });
			case 'files/list_folder/continue': {
				const cur = JSON.parse(arg.cursor) as { path: string; seq: number };
				const root = c.byPath(cur.path);
				if (!root) return err('reset/');
				const entries = c
					.changedSince(cur.seq)
					.filter((n) => c.path(n.id).toLowerCase().startsWith(cur.path.toLowerCase()))
					.map((n) => (c.alive(n) ? meta(n) : { '.tag': 'deleted', name: n.name, path_lower: c.path(n.id).toLowerCase() }));
				return respond(200, { entries, cursor: cursor(cur.path), has_more: false });
			}
			case 'files/upload': {
				const { dir, name } = parentName(arg.path);
				const existing = c.byPath(arg.path);
				const data = bytes(r.body);
				if (arg.mode === 'add') {
					if (existing) return err('path/conflict/file/');
					return respond(200, meta(c.add(c.mkdirp(dir).id, name, false, data)));
				}
				if (!existing) return err('path/not_found/');
				if (arg.mode?.['.tag'] === 'update' && arg.mode.update !== `r${existing.id}x${existing.ver}`) return err('path/conflict/file/');
				c.write(existing, data);
				return respond(200, meta(existing));
			}
			case 'files/move_v2': {
				const n = resolve(arg.from_path);
				if (!n) return err('from_lookup/not_found/');
				const existing = c.byPath(arg.to_path);
				if (existing && existing !== n) return err('to/conflict/');
				const { dir, name } = parentName(arg.to_path);
				c.move(n, c.mkdirp(dir).id, name);
				return respond(200, { metadata: meta(n) });
			}
			case 'files/delete_v2': {
				const n = resolve(arg.path);
				if (!n) return err('path_lookup/not_found/');
				c.trash(n);
				return respond(200, { metadata: meta(n) });
			}
			case 'files/download': {
				const n = resolve(arg.path);
				return n && !n.folder ? respond(200, n.data ?? new Uint8Array()) : err('path/not_found/');
			}
			case 'users/get_current_account':
				return respond(200, { email: 'me@dropbox.test' });
		}
		return respond(400, 'unknown endpoint ' + ep);
	};
}

// ------------------------------------------------------------------ OneDrive

export function onedriveHttp(c: Cloud): HttpFn {
	const API = 'https://graph.microsoft.com/v1.0/me/drive';
	const sessions = new Map<string, { target: string; conflict: string; chunks: Uint8Array[]; ifMatch?: string }>();
	const item = (n: Node) => ({
		id: n.id,
		name: n.name,
		parentReference: { id: n.parent ?? undefined },
		...(n.folder ? { folder: {} } : { file: {}, size: n.data?.length ?? 0, cTag: `c${n.ver}` }),
		eTag: `e${n.ver}.${n.meta}`,
		lastModifiedDateTime: new Date(n.time * 1000).toISOString(),
	});
	const err = (s: number, m: string) => respond(s, { error: { code: String(s), message: m } });
	const live = (id: string) => [c.nodes.get(id)].find((n) => c.alive(n));
	const put = (target: string, conflict: string, data: Uint8Array, ifMatch?: string) => {
		let m = /^items\/([^/:]+):\/(.+):$/.exec(target);
		if (m) {
			const parent = live(decodeURIComponent(m[1]));
			if (!parent) return err(404, 'parent');
			const name = decodeURIComponent(m[2]);
			const ex = c.child(parent.id, name);
			if (ex && conflict === 'fail') return err(409, 'nameAlreadyExists');
			if (ex) {
				c.write(ex, data);
				return respond(200, item(ex));
			}
			return respond(201, item(c.add(parent.id, name, false, data)));
		}
		m = /^items\/([^/:]+)$/.exec(target);
		const n = m && live(decodeURIComponent(m[1]));
		if (!n) return err(404, 'itemNotFound');
		if (ifMatch && ifMatch !== `e${n.ver}.${n.meta}`) return err(412, 'resourceModified');
		c.write(n, data);
		return respond(200, item(n));
	};
	return async (r) => {
		c.requests.push(r);
		const u = new URL(r.url);
		if (u.host === 'dl.fake') {
			if (r.headers?.Authorization) return err(400, 'token sent to a pre-authenticated URL');
			const n = live(u.pathname.slice(1));
			return n ? respond(200, n.data ?? new Uint8Array()) : err(404, 'gone');
		}
		if (u.host === 'up.fake') {
			if (r.headers?.Authorization) return err(400, 'token sent to a pre-authenticated URL');
			const s = sessions.get(u.pathname.slice(1))!;
			const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(r.headers!['Content-Range'])!;
			s.chunks.push(bytes(r.body));
			if (Number(range[2]) + 1 < Number(range[3])) return respond(202, { nextExpectedRanges: [`${Number(range[2]) + 1}-`] });
			const all = new Uint8Array(Number(range[3]));
			let o = 0;
			for (const ch of s.chunks) {
				all.set(ch, o);
				o += ch.length;
			}
			return put(s.target, s.conflict, all, s.ifMatch);
		}
		if (!bearer(r)) return err(401, 'InvalidAuthenticationToken');
		const path = decodeURIComponent(r.url.slice(API.length).split('?')[0]);
		const raw = r.url.slice(API.length).split('?')[0];
		const params = q(r.url);
		if (r.method === 'GET' && path === '') return respond(200, { owner: { user: { email: 'me@onedrive.test' } } });
		let m: RegExpExecArray | null;
		if (r.method === 'GET' && (m = /^\/root:\/(.+)$/.exec(path))) {
			const n = c.byPath(m[1]);
			return n ? respond(200, item(n)) : err(404, 'itemNotFound');
		}
		if (r.method === 'POST' && (m = /^\/(?:items\/([^/]+)|root)\/children$/.exec(path))) {
			const parent = m[1] ? live(m[1]) : c.nodes.get('ROOT');
			if (!parent) return err(404, 'itemNotFound');
			const b = JSON.parse(r.body as string);
			if (c.child(parent.id, b.name)) return err(409, 'nameAlreadyExists');
			return respond(201, item(c.add(parent.id, b.name, true)));
		}
		if (r.method === 'GET' && (m = /^\/(?:items\/([^/]+)|root)\/delta$/.exec(path))) {
			const base = m[1] ? live(m[1]) : c.nodes.get('ROOT');
			if (!base) return err(404, 'itemNotFound');
			const token = params.get('token');
			const link = `${API}${raw}?token=${c.seq}`;
			if (token === 'latest') return respond(200, { value: [], '@odata.deltaLink': link });
			const under = (n: Node) => {
				for (let x: Node | undefined = n; x; x = x.parent ? c.nodes.get(x.parent) : undefined) if (x.id === base.id) return true;
				return false;
			};
			const list = token === null ? [base, ...c.descendants(base.id)] : c.changedSince(Number(token)).filter(under);
			return respond(200, { value: list.map((n) => (c.alive(n) ? item(n) : { id: n.id, deleted: {} })), '@odata.deltaLink': link });
		}
		if (r.method === 'GET' && (m = /^\/items\/([^/:]+):\/(.+)$/.exec(path))) {
			const p = live(m[1]);
			const n = p && c.child(p.id, m[2]);
			return n ? respond(200, item(n)) : err(404, 'itemNotFound');
		}
		if (r.method === 'GET' && (m = /^\/items\/([^/:]+)\/children$/.exec(path))) {
			const p = live(m[1]);
			return p ? respond(200, { value: c.children(p.id).map(item) }) : err(404, 'itemNotFound');
		}
		if (r.method === 'GET' && (m = /^\/items\/([^/:]+)$/.exec(path))) {
			const n = live(m[1]);
			if (!n) return err(404, 'itemNotFound');
			return respond(200, { ...item(n), '@microsoft.graph.downloadUrl': `https://dl.fake/${n.id}` });
		}
		if (r.method === 'PUT' && (m = /^\/(.+)\/content$/.exec(raw))) {
			return put(m[1], params.get('@microsoft.graph.conflictBehavior') ?? 'replace', bytes(r.body), r.headers?.['If-Match']);
		}
		if (r.method === 'POST' && (m = /^\/(.+)\/createUploadSession$/.exec(raw))) {
			const b = JSON.parse(r.body as string);
			const id = String(sessions.size + 1);
			sessions.set(id, { target: m[1], conflict: b.item['@microsoft.graph.conflictBehavior'], chunks: [], ifMatch: r.headers?.['If-Match'] });
			return respond(200, { uploadUrl: `https://up.fake/${id}` });
		}
		if (r.method === 'PATCH' && (m = /^\/items\/([^/:]+)$/.exec(path))) {
			const n = live(m[1]);
			if (!n) return err(404, 'itemNotFound');
			const b = JSON.parse(r.body as string);
			const parent = b.parentReference?.id ?? n.parent;
			const ex = c.child(parent, b.name ?? n.name);
			if (ex && ex !== n) return err(409, 'nameAlreadyExists');
			c.move(n, parent, b.name ?? n.name);
			return respond(200, item(n));
		}
		if (r.method === 'DELETE' && (m = /^\/items\/([^/:]+)$/.exec(path))) {
			const n = live(m[1]);
			if (!n) return err(404, 'itemNotFound');
			c.trash(n);
			return respond(204, '');
		}
		return err(400, `unhandled ${r.method} ${path}`);
	};
}

// ------------------------------------------------------------------ pCloud

export function pcloudHttp(c: Cloud): HttpFn {
	const fid = (n: Node) => (n.id === 'ROOT' ? 0 : Number(n.id));
	const node = (id: string | null) => [c.nodes.get(id === '0' ? 'ROOT' : (id ?? ''))].find((n) => c.alive(n));
	const meta = (n: Node, recursive = false, files = true): object => ({
		name: n.id === 'ROOT' ? '/' : n.name,
		isfolder: n.folder,
		...(n.folder ? { folderid: fid(n) } : { fileid: fid(n), hash: n.ver * 7919 + Number(n.id), size: n.data?.length ?? 0 }),
		parentfolderid: n.parent ? fid(c.nodes.get(n.parent)!) : undefined,
		modified: new Date(n.time * 1000).toUTCString(),
		...(n.folder ? { contents: c.children(n.id).filter((x) => files || x.folder).map((x) => (recursive ? meta(x, true, files) : meta(x, false, files))) } : {}),
	});
	const ok = (o: object) => respond(200, { result: 0, ...o });
	const fail = (result: number, error: string) => respond(200, { result, error });
	return async (r) => {
		c.requests.push(r);
		const u = new URL(r.url);
		if (u.host === 'c1.pcloud.test') {
			if (r.headers?.Authorization) return respond(400, 'token sent to the download host');
			const n = node(u.pathname.slice(4));
			return n ? respond(200, n.data ?? new Uint8Array()) : respond(404, '');
		}
		if (!bearer(r)) return fail(1000, 'Log in required.');
		const p = u.searchParams;
		const method = u.pathname.slice(1);
		switch (method) {
			case 'listfolder': {
				const n = p.has('path') ? c.byPath(p.get('path')!) : node(p.get('folderid'));
				if (!n || !n.folder) return fail(2005, 'Directory does not exist.');
				return ok({ metadata: meta(n, p.get('recursive') === '1', p.get('nofiles') !== '1') });
			}
			case 'createfolderifnotexists':
			case 'createfolder': {
				const parent = node(p.get('folderid'));
				if (!parent) return fail(2005, 'Directory does not exist.');
				const ex = c.child(parent.id, p.get('name')!);
				if (ex && method === 'createfolder') return fail(2004, 'File or folder alredy exists.');
				return ok({ metadata: meta(ex ?? c.add(parent.id, p.get('name')!, true)) });
			}
			case 'diff': {
				if (p.get('last') === '0') return ok({ diffid: c.seq, entries: [] });
				const since = Number(p.get('diffid'));
				return ok({ diffid: c.seq, entries: c.changedSince(since).slice(0, Number(p.get('limit') ?? 1000)).map((n) => ({ event: 'modifyfile', metadata: meta(n) })) });
			}
			case 'uploadfile': {
				const parent = node(p.get('folderid'));
				if (!parent) return fail(2005, 'Directory does not exist.');
				const part = parts(r.body as ArrayBuffer, r.contentType!)[0];
				const name = p.get('filename')!;
				const ex = c.child(parent.id, name);
				if (ex) c.write(ex, part.data);
				const n = ex ?? c.add(parent.id, name, false, part.data);
				return ok({ metadata: [meta(n)], fileids: [fid(n)] });
			}
			case 'stat': {
				const n = node(p.get('fileid'));
				return n ? ok({ metadata: meta(n) }) : fail(2009, 'File not found.');
			}
			case 'renamefile':
			case 'renamefolder': {
				const n = node(p.get(method === 'renamefile' ? 'fileid' : 'folderid'));
				if (!n) return fail(method === 'renamefile' ? 2009 : 2005, 'not found');
				const to = node(p.get('tofolderid'))!;
				const ex = c.child(to.id, p.get('toname')!);
				if (ex && ex !== n) return fail(2004, 'File or folder alredy exists.');
				c.move(n, to.id, p.get('toname')!);
				return ok({ metadata: meta(n) });
			}
			case 'deletefile': {
				const n = node(p.get('fileid'));
				if (!n) return fail(2009, 'File not found.');
				c.trash(n);
				return ok({ metadata: meta(n) });
			}
			case 'deletefolder':
			case 'deletefolderrecursive': {
				const n = node(p.get('folderid'));
				if (!n) return fail(2005, 'Directory does not exist.');
				if (method === 'deletefolder' && c.children(n.id).length) return fail(2006, 'Folder is not empty.');
				c.trash(n);
				return ok({ metadata: meta(n) });
			}
			case 'getfilelink': {
				const n = node(p.get('fileid'));
				return n ? ok({ hosts: ['c1.pcloud.test'], path: `/dl/${n.id}` }) : fail(2009, 'File not found.');
			}
			case 'userinfo':
				return ok({ email: 'me@pcloud.test' });
		}
		return fail(2000, 'unknown method ' + method);
	};
}

// ------------------------------------------------------------------ Google Drive

export function gdriveHttp(c: Cloud): HttpFn {
	const FOLDER = 'application/vnd.google-apps.folder';
	const file = (n: Node) => ({
		id: n.id,
		name: n.name,
		mimeType: n.folder ? FOLDER : 'application/octet-stream',
		parents: n.parent ? [n.parent === 'ROOT' ? 'root' : n.parent] : [],
		...(n.folder ? {} : { md5Checksum: md5(n.data ?? new Uint8Array()), size: String(n.data?.length ?? 0) }),
		trashed: !c.alive(n),
		appProperties: n.props,
		modifiedTime: new Date(n.time * 1000).toISOString(),
	});
	const err = (s: number, m: string) => respond(s, { error: { code: s, message: m } });
	const pid = (p: string) => (p === 'root' ? 'ROOT' : p);
	const unq = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
	/** Evaluates the subset of the Drive query language used by the client. */
	const matches = (n: Node, query: string) =>
		query.split(' and ').every((clause) => {
			let m: RegExpExecArray | null;
			clause = clause.trim();
			if ((m = /^appProperties has \{ key='(\w+)'$/.exec(clause))) return true; // joined below
			if ((m = /^value='((?:[^'\\]|\\.)*)' \}$/.exec(clause))) return true;
			if (clause === 'trashed=false') return c.alive(n);
			if ((m = /^mimeType='(.+)'$/.exec(clause))) return m[1] === FOLDER ? n.folder : !n.folder;
			if ((m = /^name='((?:[^'\\]|\\.)*)'$/.exec(clause))) return n.name === unq(m[1]);
			if ((m = /^'(.+)' in parents$/.exec(clause))) return n.parent === pid(m[1]);
			throw new Error('unsupported clause ' + clause);
		}) &&
		[...query.matchAll(/appProperties has \{ key='(\w+)' and value='((?:[^'\\]|\\.)*)' \}/g)].every((m) => n.props?.[m[1]] === unq(m[2]));
	return async (r) => {
		c.requests.push(r);
		if (!bearer(r)) return err(401, 'Invalid Credentials');
		const u = new URL(r.url);
		const p = u.searchParams;
		const path = u.pathname;
		let m: RegExpExecArray | null;
		if (r.method === 'GET' && path === '/drive/v3/files') {
			const query = p.get('q')!;
			const all = [...c.nodes.values()].filter((n) => n.id !== 'ROOT' && matches(n, query));
			return respond(200, { files: all.map(file) });
		}
		if (r.method === 'POST' && path === '/drive/v3/files') {
			const b = JSON.parse(r.body as string);
			return respond(200, file(c.add(pid(b.parents[0]), b.name, b.mimeType === FOLDER, undefined, b.appProperties)));
		}
		if (r.method === 'GET' && path === '/drive/v3/changes/startPageToken') return respond(200, { startPageToken: String(c.seq) });
		if (r.method === 'GET' && path === '/drive/v3/changes') {
			const list = c.changedSince(Number(p.get('pageToken')));
			return respond(200, { changes: list.map((n) => ({ fileId: n.id, removed: false, file: file(n) })), newStartPageToken: String(c.seq) });
		}
		if (r.method === 'POST' && path === '/upload/drive/v3/files') {
			const [metaPart, dataPart] = parts(r.body as ArrayBuffer, r.contentType!);
			const b = JSON.parse(td.decode(metaPart.data));
			return respond(200, file(c.add(pid(b.parents[0]), b.name, false, dataPart.data, b.appProperties)));
		}
		if (r.method === 'PATCH' && (m = /^\/upload\/drive\/v3\/files\/(.+)$/.exec(path))) {
			const n = c.nodes.get(m[1]);
			if (!c.alive(n)) return err(404, 'File not found');
			c.write(n, bytes(r.body));
			return respond(200, file(n));
		}
		if (r.method === 'PATCH' && (m = /^\/drive\/v3\/files\/(.+)$/.exec(path))) {
			const n = c.nodes.get(m[1]);
			if (!n) return err(404, 'File not found');
			const b = JSON.parse(r.body as string);
			if (b.trashed) c.trash(n);
			else c.move(n, p.get('addParents') ? pid(p.get('addParents')!) : n.parent!, b.name ?? n.name);
			return respond(200, file(n));
		}
		if (r.method === 'GET' && (m = /^\/drive\/v3\/files\/(.+)$/.exec(path)) && p.get('alt') === 'media') {
			const n = c.nodes.get(m[1]);
			return c.alive(n) ? respond(200, n.data ?? new Uint8Array()) : err(404, 'File not found');
		}
		if (r.method === 'GET' && (m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path))) {
			const n = c.nodes.get(m[1]);
			return n ? respond(200, file(n)) : err(404, 'File not found');
		}
		if (r.method === 'GET' && path === '/drive/v3/about') return respond(200, { user: { emailAddress: 'me@gmail.test' } });
		return err(400, `unhandled ${r.method} ${path}`);
	};
}
