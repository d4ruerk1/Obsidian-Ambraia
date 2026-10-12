import type { VectorStoreData } from './retrieval';

/**
 * Compact on-disk form of the embedding index: each vector is quantised to 8 bits
 * (with its own scale) and stored as base64, about 15× smaller than JSON numbers.
 * Cosine similarity is practically unchanged by this quantisation.
 */
export interface PackedStore {
	v: 2;
	model: string;
	files: Record<string, { mtime: number; q: string[]; s: number[] }>;
}

function b64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

function unb64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function packVectors(d: VectorStoreData): PackedStore {
	const files: PackedStore['files'] = {};
	for (const [path, f] of Object.entries(d.files)) {
		const q: string[] = [];
		const sc: number[] = [];
		for (const v of f.vectors) {
			let max = 0;
			for (const x of v) max = Math.max(max, Math.abs(x));
			const scale = max / 127 || 1;
			const bytes = new Int8Array(v.length);
			for (let i = 0; i < v.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round(v[i] / scale)));
			q.push(b64(new Uint8Array(bytes.buffer)));
			sc.push(Number(scale.toPrecision(6)));
		}
		files[path] = { mtime: f.mtime, q, s: sc };
	}
	return { v: 2, model: d.model, files };
}

/** Accepts both the packed form and the plain JSON of older versions. */
export function unpackVectors(raw: unknown): VectorStoreData | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Partial<PackedStore> & Partial<VectorStoreData>;
	if (r.v !== 2) return r.files && typeof r.model === 'string' ? (r as VectorStoreData) : null;
	const files: VectorStoreData['files'] = {};
	for (const [path, f] of Object.entries(r.files ?? {})) {
		files[path] = {
			mtime: f.mtime,
			vectors: f.q.map((b, i) => {
				const bytes = new Int8Array(unb64(b).buffer);
				const scale = f.s[i] ?? 1;
				return Array.from(bytes, (x) => x * scale);
			}),
		};
	}
	return { model: r.model ?? '', files };
}
