import type { App } from 'obsidian';
import type { BaseStore } from './types';

const hasStreams = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && typeof Response === 'function';

async function deflate(text: string): Promise<ArrayBuffer> {
	const stream = new Response(new TextEncoder().encode(text)).body!.pipeThrough(new CompressionStream('deflate-raw'));
	return new Response(stream).arrayBuffer();
}

async function inflate(data: ArrayBuffer): Promise<string> {
	const stream = new Response(new Uint8Array(data)).body!.pipeThrough(new DecompressionStream('deflate-raw'));
	return new Response(stream).text();
}

/**
 * Last-synced text of notes, content addressed (one small file per MD5) in the state folder.
 * Shared by all services; never synced. Used as the common ancestor of three-way merges.
 * Stored compressed (deflate, done natively by the platform) when available: about 3× smaller.
 */
export class FileBaseStore implements BaseStore {
	private known = new Set<string>();
	private lastGc = 0;

	constructor(
		private app: App,
		private dir: string,
	) {}

	private path(md5: string, packed: boolean) {
		return `${this.dir}/${md5}.${packed ? 'z' : 'txt'}`;
	}

	async get(md5: string): Promise<string | null> {
		if (!/^[0-9a-f]{32}$/.test(md5)) return null;
		const a = this.app.vault.adapter;
		try {
			if (hasStreams() && (await a.exists(this.path(md5, true)))) return await inflate(await a.readBinary(this.path(md5, true)));
		} catch {
			/* unreadable: try the plain copy */
		}
		const p = this.path(md5, false);
		if (!(await a.exists(p))) return null;
		return a.read(p);
	}

	async put(md5: string, text: string): Promise<void> {
		if (!/^[0-9a-f]{32}$/.test(md5) || this.known.has(md5)) return;
		const a = this.app.vault.adapter;
		let packed: ArrayBuffer | null = null;
		if (hasStreams()) {
			try {
				packed = await deflate(text);
			} catch {
				packed = null; // keep it plain
			}
		}
		const p = this.path(md5, !!packed);
		if (!(await a.exists(p))) {
			if (!(await a.exists(this.dir))) {
				const parent = this.dir.slice(0, this.dir.lastIndexOf('/'));
				if (parent && !(await a.exists(parent))) await a.mkdir(parent);
				await a.mkdir(this.dir);
			}
			if (packed) await a.writeBinary(p, packed);
			else await a.write(p, text);
		}
		this.known.add(md5);
	}

	/** Removes ancestors no service refers to anymore (at most once an hour). */
	async gc(keep: Set<string>, force = false) {
		if (!force && Date.now() - this.lastGc < 3600_000) return;
		this.lastGc = Date.now();
		const a = this.app.vault.adapter;
		try {
			const { files } = await a.list(this.dir);
			for (const f of files) {
				const m = /([0-9a-f]{32})\.(txt|z)$/.exec(f);
				if (m && !keep.has(m[1])) {
					await a.remove(f);
					this.known.delete(m[1]);
				}
			}
		} catch {
			/* next time */
		}
	}
}
