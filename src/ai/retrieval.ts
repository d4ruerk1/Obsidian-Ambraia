import type { App, TFile } from 'obsidian';
import { tx } from '../i18n';

// ---------------------------------------------------------------- text utils

const STOP = new Set(
	(
		'il lo la i gli le un uno una di a da in con su per tra fra e o ma se che chi cui non come dove quando perche perché è e sono era ' +
		'del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle ' +
		'mi ti si ci vi ne questo questa questi queste quello quella quelli quelle mio mia tuo tua suo sua nostro vostro loro anche piu più molto ' +
		'the a an of to in on for and or but is are was were be been it this that these those with as at by from what which who how why when where ' +
		'do does did can could should would will my your our their me you we they he she his her its about into than then so not no yes'
	).split(/\s+/),
);

export function fold(s: string): string {
	return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Light stemming that works acceptably for Italian and English. */
function stem(w: string): string {
	if (w.length <= 4) return w;
	return w.replace(/(azioni|azione|mente|ments?|ings?|edly|ed|es|i|e|a|o|s)$/, '') || w;
}

export function tokenize(s: string): string[] {
	const out: string[] = [];
	for (const raw of fold(s).split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length < 2 || STOP.has(raw)) continue;
		out.push(stem(raw));
	}
	return out;
}

export interface Chunk {
	path: string;
	title: string;
	heading: string;
	text: string;
	/** Character offset in the file (for opening at the right place). */
	offset: number;
}

/** Splits a note into ~maxLen character chunks, preferring heading and paragraph boundaries. */
export function chunkNote(path: string, content: string, maxLen = 1200): Chunk[] {
	const title = path.split('/').pop()!.replace(/\.md$/i, '');
	let body = content;
	let base = 0;
	const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
	const fmText = fm ? fm[0].replace(/^---|---$/gm, '').trim() : '';
	if (fm) {
		body = content.slice(fm[0].length);
		base = fm[0].length;
	}
	const chunks: Chunk[] = [];
	const sections: { heading: string; text: string; offset: number }[] = [];
	const re = /^#{1,6}\s+(.+)$/gm;
	let last = 0;
	let heading = '';
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) {
		if (m.index > last) sections.push({ heading, text: body.slice(last, m.index), offset: base + last });
		heading = m[1].trim();
		last = m.index;
	}
	sections.push({ heading, text: body.slice(last), offset: base + last });
	for (const s of sections) {
		if (!s.text.trim()) continue;
		if (s.text.length <= maxLen) {
			chunks.push({ path, title, heading: s.heading, text: s.text.trim(), offset: s.offset });
			continue;
		}
		let cur = '';
		let curOff = s.offset;
		let pos = s.offset;
		for (const para of s.text.split(/(\n\s*\n)/)) {
			if (cur.length + para.length > maxLen && cur.trim()) {
				chunks.push({ path, title, heading: s.heading, text: cur.trim(), offset: curOff });
				cur = '';
				curOff = pos;
			}
			if (para.length > maxLen) {
				for (let i = 0; i < para.length; i += maxLen) {
					chunks.push({ path, title, heading: s.heading, text: para.slice(i, i + maxLen).trim(), offset: pos + i });
				}
				curOff = pos + para.length;
			} else cur += para;
			pos += para.length;
		}
		if (cur.trim()) chunks.push({ path, title, heading: s.heading, text: cur.trim(), offset: curOff });
	}
	if (!chunks.length) chunks.push({ path, title, heading: '', text: fmText || title, offset: 0 });
	else if (fmText) chunks[0] = { ...chunks[0], text: fmText + '\n' + chunks[0].text };
	return chunks.filter((c) => c.text);
}

// ---------------------------------------------------------------- BM25

interface IndexedChunk extends Chunk {
	tf: Map<string, number>;
	len: number;
	titleTokens: Set<string>;
}

export interface Hit {
	chunk: Chunk;
	score: number;
}

/** Keyword index (BM25) over note chunks. Works offline with any model. */
export class LexicalIndex {
	private files = new Map<string, { mtime: number; chunks: IndexedChunk[] }>();
	private df = new Map<string, number>();
	private totalLen = 0;
	private count = 0;

	get size() {
		return this.count;
	}

	has(path: string, mtime: number) {
		return this.files.get(path)?.mtime === mtime;
	}

	paths() {
		return [...this.files.keys()];
	}

	set(path: string, mtime: number, content: string) {
		this.remove(path);
		const chunks = chunkNote(path, content).map((c) => {
			const toks = tokenize(c.title + ' ' + c.heading + ' ' + c.text);
			const tf = new Map<string, number>();
			for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
			return { ...c, tf, len: toks.length, titleTokens: new Set(tokenize(c.title + ' ' + c.heading)) };
		});
		for (const c of chunks) {
			for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
			this.totalLen += c.len;
			this.count++;
		}
		this.files.set(path, { mtime, chunks });
	}

	remove(path: string) {
		const old = this.files.get(path);
		if (!old) return;
		for (const c of old.chunks) {
			for (const t of c.tf.keys()) {
				const n = (this.df.get(t) ?? 1) - 1;
				if (n <= 0) this.df.delete(t);
				else this.df.set(t, n);
			}
			this.totalLen -= c.len;
			this.count--;
		}
		this.files.delete(path);
	}

	chunksOf(path: string): Chunk[] {
		return this.files.get(path)?.chunks ?? [];
	}

	search(query: string, k = 8, exclude?: Set<string>): Hit[] {
		const q = [...new Set(tokenize(query))];
		if (!q.length || !this.count) return [];
		const avg = this.totalLen / this.count || 1;
		const k1 = 1.4;
		const b = 0.75;
		const hits: Hit[] = [];
		for (const [path, f] of this.files) {
			if (exclude?.has(path)) continue;
			for (const c of f.chunks) {
				let s = 0;
				for (const t of q) {
					const tf = c.tf.get(t);
					if (!tf) continue;
					const df = this.df.get(t) ?? 0;
					const idf = Math.log(1 + (this.count - df + 0.5) / (df + 0.5));
					s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.len) / avg)));
					if (c.titleTokens.has(t)) s += idf * 0.8;
				}
				if (s > 0) hits.push({ chunk: c, score: s });
			}
		}
		return hits.sort((a, b2) => b2.score - a.score).slice(0, k);
	}
}

// ---------------------------------------------------------------- vectors

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface VectorStoreData {
	model: string;
	files: Record<string, { mtime: number; vectors: number[][] }>;
}

/** Combines keyword and (optional) semantic scores. */
export function mergeHits(lexical: Hit[], semantic: Hit[], k: number): Hit[] {
	const key = (h: Hit) => `${h.chunk.path}#${h.chunk.offset}`;
	const maxL = Math.max(1e-9, ...lexical.map((h) => h.score));
	const out = new Map<string, Hit>();
	for (const h of lexical) out.set(key(h), { chunk: h.chunk, score: 0.4 * (h.score / maxL) });
	for (const h of semantic) {
		const prev = out.get(key(h));
		const s = 0.6 * Math.max(0, h.score);
		if (prev) prev.score += s;
		else out.set(key(h), { chunk: h.chunk, score: s });
	}
	return [...out.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

// ---------------------------------------------------------------- vault index

export interface IndexOptions {
	exclude: string[];
}

export function isExcluded(path: string, exclude: string[]): boolean {
	return exclude.some((e) => {
		const p = e.trim().replace(/^\/+|\/+$/g, '');
		return p && (path === p || path.startsWith(p + '/'));
	});
}

/** Keeps a keyword index of the vault in sync lazily (only files that changed are re-read). */
export class VaultIndex {
	lex = new LexicalIndex();
	private dirty = true;
	constructor(
		private app: App,
		private opts: () => IndexOptions,
	) {}

	markDirty() {
		this.dirty = true;
	}

	remove(path: string) {
		this.lex.remove(path);
	}

	files(): TFile[] {
		const ex = this.opts().exclude;
		return this.app.vault.getMarkdownFiles().filter((f) => !isExcluded(f.path, ex));
	}

	async refresh(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		const files = this.files();
		const keep = new Set(files.map((f) => f.path));
		for (const p of this.lex.paths()) if (!keep.has(p)) this.lex.remove(p);
		for (const f of files) {
			if (this.lex.has(f.path, f.stat.mtime)) continue;
			try {
				this.lex.set(f.path, f.stat.mtime, await this.app.vault.cachedRead(f));
			} catch {
				/* unreadable file */
			}
		}
	}

	async search(query: string, k = 8, exclude?: Set<string>): Promise<Hit[]> {
		await this.refresh();
		return this.lex.search(query, k, exclude);
	}
}

/** Formats retrieved chunks as context for the model. */
export function formatContext(hits: Hit[], maxChars = 12000): string {
	let out = '';
	for (const h of hits) {
		const c = h.chunk;
		const block = tx('<nota percorso="{0}"{1}>\n{2}\n</nota>\n\n', c.path, c.heading ? tx(' sezione="{0}"', c.heading.replace(/"/g, "'")) : '', c.text);
		if (out.length + block.length > maxChars) break;
		out += block;
	}
	return out.trim();
}
