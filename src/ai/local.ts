/**
 * Local tools for the assistant: documents (PDF, Office, OpenDocument, EPUB, canvas),
 * web pages, YouTube transcripts, X/Twitter posts, web search (DuckDuckGo or your own SearXNG), long-term memory and
 * projects. Everything runs on the device; nothing goes through a third-party relay.
 */
import { App, loadPdfJs, normalizePath, parseYaml, requestUrl, TFile, TFolder } from 'obsidian';
import type { AmbraiaSettings } from '../settings';
import { tx } from '../i18n';

// ------------------------------------------------------------------ network

export interface NetRes {
	status: number;
	text: string;
	arrayBuffer?: ArrayBuffer;
	headers: Record<string, string>;
}
export type Net = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; binary?: boolean }) => Promise<NetRes>;

/** Honest user agent: sites can see that the request comes from Ambraia on behalf of the user. */
const UA = 'Mozilla/5.0 (compatible; Ambraia/1.0; +https://github.com/d4ruerk1/Obsidian-Ambraia)';

/** requestUrl: no CORS limits, works on desktop and mobile. Tests replace it. */
export let net: Net = async (url, init = {}) => {
	const r = await requestUrl({ url, method: init.method ?? 'GET', headers: { 'User-Agent': UA, 'Accept-Language': 'it,en;q=0.8', ...init.headers }, body: init.body, throw: false });
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = String(v);
	const binary = init.binary || /pdf|octet-stream|officedocument|opendocument|epub|zip/.test(headers['content-type'] ?? '');
	return { status: r.status, text: binary ? '' : r.text, arrayBuffer: binary ? r.arrayBuffer : undefined, headers };
};
export function setNet(n: Net) {
	net = n;
}

// ------------------------------------------------------------------ helpers

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === '#') {
			const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(n) ? String.fromCodePoint(n) : m;
		}
		return ENT[e.toLowerCase()] ?? m;
	});
}

const tidy = (s: string) => s.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Text of an XML fragment: `para` closing tags become new lines. */
function xmlText(xml: string, para: RegExp): string {
	return tidy(
		decodeEntities(
			xml
				.replace(/<(w:tab|text:tab)\b[^>]*\/>/g, '\t')
				.replace(/<(w:br|a:br|text:line-break)\b[^>]*\/>/g, '\n')
				.replace(para, '\n')
				.replace(/<[^>]+>/g, ''),
		),
	);
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + tx('\n…(troncato)') : s);

// ------------------------------------------------------------------ zip (Office, OpenDocument, EPUB)

/** Minimal ZIP reader (stored + deflate) based on the platform DecompressionStream; no extra library. */
export async function unzip(buf: ArrayBuffer, want: (name: string) => boolean): Promise<Map<string, string>> {
	const v = new DataView(buf);
	const out = new Map<string, string>();
	let eocd = -1;
	for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
		if (v.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error(tx('File non valido (archivio danneggiato).'));
	const count = v.getUint16(eocd + 10, true);
	let p = v.getUint32(eocd + 16, true);
	const dec = new TextDecoder();
	for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
		const method = v.getUint16(p + 10, true);
		const size = v.getUint32(p + 20, true);
		const nameLen = v.getUint16(p + 28, true);
		const extraLen = v.getUint16(p + 30, true);
		const commentLen = v.getUint16(p + 32, true);
		const local = v.getUint32(p + 42, true);
		const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
		p += 46 + nameLen + extraLen + commentLen;
		if (!want(name)) continue;
		const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
		const data = new Uint8Array(buf, start, size);
		if (method === 0) out.set(name, dec.decode(data));
		else if (method === 8) {
			const ds = new DecompressionStream('deflate-raw');
			const stream = new Response(data).body!.pipeThrough(ds);
			out.set(name, await new Response(stream).text());
		}
	}
	return out;
}

const num = (s: string) => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0);

async function officeText(buf: ArrayBuffer, ext: string): Promise<string> {
	if (ext === 'docx') {
		const f = await unzip(buf, (n) => n === 'word/document.xml');
		return xmlText(f.get('word/document.xml') ?? '', /<\/w:p>/g);
	}
	if (ext === 'pptx') {
		const f = await unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
		return [...f.entries()]
			.sort((a, b) => num(a[0]) - num(b[0]))
			.map(([n, x]) => `## Diapositiva ${num(n)}\n${xmlText(x, /<\/a:p>/g)}`)
			.join('\n\n');
	}
	if (ext === 'xlsx') {
		const f = await unzip(buf, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
		const shared = [...(f.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1], /$^/g));
		const sheets: string[] = [];
		for (const [n, x] of [...f.entries()].filter(([k]) => k.includes('worksheets')).sort((a, b) => num(a[0]) - num(b[0]))) {
			const rows = [...x.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
				[...r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
					.map((c) => {
						const t = /\bt="(\w+)"/.exec(c[1])?.[1];
						const val = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1] ?? '';
						if (t === 's') return shared[Number(val)] ?? '';
						if (t === 'inlineStr') return xmlText(c[2] ?? '', /$^/g);
						return decodeEntities(val);
					})
					.join(' | '),
			);
			sheets.push(`## Foglio ${num(n)}\n${rows.filter((r) => r.replace(/[ |]/g, '')).join('\n')}`);
		}
		return sheets.join('\n\n');
	}
	if (ext === 'odt' || ext === 'odp' || ext === 'ods') {
		const f = await unzip(buf, (n) => n === 'content.xml');
		return xmlText(f.get('content.xml') ?? '', /<\/(text:p|text:h|table:table-row)>/g);
	}
	if (ext === 'epub') {
		const f = await unzip(buf, (n) => /\.x?html?$/i.test(n));
		return [...f.entries()]
			.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
			.map(([, x]) => htmlToText(x).text)
			.filter(Boolean)
			.join('\n\n');
	}
	return '';
}

// ------------------------------------------------------------------ PDF

/** The part of the pdf.js API used here. */
interface PdfDoc {
	numPages: number;
	getPage(i: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
	destroy?: () => Promise<void>;
}

export async function pdfText(buf: ArrayBuffer, maxPages = 300): Promise<string> {
	const pdfjs = (await loadPdfJs()) as { getDocument(o: unknown): { promise: Promise<PdfDoc> } };
	const doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
	const pages: string[] = [];
	for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
		const page = await doc.getPage(i);
		const tc = await page.getTextContent();
		let s = '';
		for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) s += (it.str ?? '') + (it.hasEOL ? '\n' : '');
		pages.push(tidy(s));
	}
	void doc.destroy?.();
	if (!pages.some((p) => p.trim())) return '';
	return pages.map((p, i) => tx('[Pagina {0}]\n{1}', i + 1, p)).join('\n\n');
}

// ------------------------------------------------------------------ vault files

export const DOC_EXT = ['md', 'txt', 'csv', 'json', 'canvas', 'pdf', 'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub', 'html', 'htm'];
export const isReadable = (f: TFile) => DOC_EXT.includes(f.extension.toLowerCase());

const fileCache = new Map<string, { mtime: number; text: string }>();

/** Plain text of any supported vault file (cached by modification time). */
export async function fileText(app: App, f: TFile): Promise<string> {
	const ext = f.extension.toLowerCase();
	if (ext === 'md' || ext === 'txt' || ext === 'csv' || ext === 'json') return app.vault.cachedRead(f);
	const hit = fileCache.get(f.path);
	if (hit && hit.mtime === f.stat.mtime) return hit.text;
	let text = '';
	if (ext === 'canvas') {
		try {
			const c = JSON.parse(await app.vault.cachedRead(f)) as { nodes?: { type: string; text?: string; file?: string; url?: string; label?: string }[] };
			text = (c.nodes ?? [])
				.map((n) => (n.type === 'text' ? n.text : n.type === 'file' ? `[[${n.file}]]` : n.type === 'link' ? n.url : n.label) ?? '')
				.filter(Boolean)
				.join('\n\n');
		} catch {
			text = '';
		}
	} else if (ext === 'html' || ext === 'htm') text = htmlToText(await app.vault.cachedRead(f)).text;
	else {
		const buf = await app.vault.readBinary(f);
		text = ext === 'pdf' ? await pdfText(buf) : await officeText(buf, ext);
	}
	if (!text.trim()) text = tx('(nessun testo estraibile: il file potrebbe essere una scansione o un’immagine)');
	fileCache.set(f.path, { mtime: f.stat.mtime, text });
	return text;
}

// ------------------------------------------------------------------ web pages

const DROP = new Set(['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'aside', 'form', 'iframe', 'button', 'template', 'select']);

/** Readable Markdown-like text of an HTML page. */
export function htmlToText(html: string): { title: string; text: string } {
	if (typeof DOMParser === 'undefined') {
		const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
		const body = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '').replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n');
		return { title, text: tidy(decodeEntities(body.replace(/<[^>]+>/g, ''))) };
	}
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const title = (doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? doc.title ?? '').trim();
	const root = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.querySelector('[role=main]') ?? doc.body;
	const out: string[] = [];
	const walk = (n: Node) => {
		if (n.nodeType === 3) {
			out.push((n.textContent ?? '').replace(/\s+/g, ' '));
			return;
		}
		if (n.nodeType !== 1) return;
		const el = n as Element;
		const tag = el.tagName.toLowerCase();
		if (DROP.has(tag) || el.getAttribute('aria-hidden') === 'true') return;
		const h = /^h([1-6])$/.exec(tag);
		if (h) out.push('\n\n' + '#'.repeat(Number(h[1])) + ' ');
		else if (tag === 'li') out.push('\n- ');
		else if (tag === 'br') out.push('\n');
		else if (/^(p|div|section|tr|table|ul|ol|blockquote|pre|figure)$/.test(tag)) out.push('\n\n');
		el.childNodes.forEach(walk);
		if (tag === 'td' || tag === 'th') out.push(' | ');
		if (h || tag === 'p') out.push('\n\n');
	};
	if (root) walk(root);
	return { title, text: tidy(out.join('')) };
}

export interface WebDoc {
	url: string;
	title: string;
	text: string;
	kind: 'pagina' | 'youtube' | 'x' | 'pdf' | 'documento';
}

const webCache = new Map<string, { at: number; doc: WebDoc }>();

export function youtubeId(url: string): string | null {
	const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(url);
	return m ? m[1] : null;
}

/** JSON value starting at `s[i]` (`{` or `[`), string-aware bracket matching. */
export function jsonAt(s: string, i: number): unknown {
	let depth = 0;
	let inStr = false;
	for (let j = i; j < s.length; j++) {
		const c = s[j];
		if (inStr) {
			if (c === '\\') j++;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === '{' || c === '[') depth++;
		else if (c === '}' || c === ']') {
			if (--depth === 0) return JSON.parse(s.slice(i, j + 1));
		}
	}
	return null;
}

const ts = (sec: number) => {
	const m = Math.floor(sec / 60);
	const h = Math.floor(m / 60);
	const ss = String(Math.floor(sec % 60)).padStart(2, '0');
	return h ? `${h}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** Transcript of a YouTube video read from its public captions (no API key). */
export async function youtubeTranscript(id: string): Promise<WebDoc> {
	const url = 'https://www.youtube.com/watch?v=' + id;
	const page = await net(url + '&hl=it');
	const html = page.text;
	const vi = html.indexOf('"videoDetails":');
	const details = (vi >= 0 ? jsonAt(html, html.indexOf('{', vi)) : null) as { title?: string; author?: string; shortDescription?: string } | null;
	const ci = html.indexOf('"captionTracks":');
	const tracks = (ci >= 0 ? jsonAt(html, html.indexOf('[', ci)) : null) as { baseUrl: string; languageCode: string; kind?: string }[] | null;
	const title = details?.title ? `${details.title}${details.author ? ' – ' + details.author : ''}` : tx('Video YouTube {0}', id);
	if (!tracks?.length) {
		const desc = details?.shortDescription ? tx('\n\nDescrizione del video:\n{0}', details.shortDescription) : '';
		if (!desc) throw new Error(tx('Questo video non ha sottotitoli disponibili (o YouTube ha bloccato la richiesta).'));
		return { url, title, text: tx('(nessuna trascrizione disponibile)') + desc, kind: 'youtube' };
	}
	const pick = tracks.find((t) => t.languageCode.startsWith('it') && t.kind !== 'asr') ?? tracks.find((t) => t.languageCode.startsWith('it')) ?? tracks.find((t) => t.kind !== 'asr') ?? tracks[0];
	const lines: string[] = [];
	const cap = await net(pick.baseUrl + (pick.baseUrl.includes('fmt=') ? '' : '&fmt=json3'));
	if (cap.text.trim().startsWith('{')) {
		const j = JSON.parse(cap.text) as { events?: { tStartMs?: number; segs?: { utf8: string }[] }[] };
		let mark = -60;
		let cur = '';
		for (const e of j.events ?? []) {
			if (!e.segs) continue;
			const t = (e.tStartMs ?? 0) / 1000;
			if (t - mark >= 30 && cur) {
				lines.push(cur.trim());
				cur = '';
			}
			if (!cur) {
				mark = t;
				cur = `[${ts(t)}] `;
			}
			cur += e.segs.map((s) => s.utf8).join('').replace(/\n/g, ' ') + ' ';
		}
		if (cur.trim()) lines.push(cur.trim());
	} else {
		for (const m of cap.text.matchAll(/<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) lines.push(`[${ts(Number(m[1]))}] ${decodeEntities(decodeEntities(m[2]))}`);
	}
	if (!lines.length) throw new Error(tx('YouTube non ha restituito la trascrizione di questo video.'));
	return { url, title, text: tx('Trascrizione ({0}{1}):\n\n{2}', pick.languageCode, pick.kind === 'asr' ? tx(', automatica') : '', lines.join('\n')), kind: 'youtube' };
}

/** Text of a post on X/Twitter via the public oEmbed endpoint. */
async function xPost(url: string): Promise<WebDoc> {
	const r = await net('https://publish.twitter.com/oembed?omit_script=1&url=' + encodeURIComponent(url));
	if (r.status >= 400) throw new Error(tx('Post non disponibile (HTTP {0}).', r.status));
	const j = JSON.parse(r.text) as { html?: string; author_name?: string };
	return { url, title: tx('Post di {0}', j.author_name ?? 'X'), text: htmlToText(j.html ?? '').text, kind: 'x' };
}

/** Downloads a URL and returns its readable text: YouTube → transcript, X → post, PDF/Office → document text. */
export async function fetchWeb(url: string): Promise<WebDoc> {
	url = url.trim().replace(/[).,;:!?»”']+$/, '');
	if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
	const c = webCache.get(url);
	if (c && Date.now() - c.at < 15 * 60_000) return c.doc;
	let doc: WebDoc;
	const yt = youtubeId(url);
	if (yt) doc = await youtubeTranscript(yt);
	else if (/^https?:\/\/(www\.|mobile\.)?(twitter|x)\.com\/[^/]+\/status\/\d+/i.test(url)) doc = await xPost(url);
	else {
		const ext = /\.(pdf|docx|pptx|xlsx|odt|odp|ods|epub)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
		const r = await net(url, { binary: !!ext });
		if (r.status >= 400) throw new Error(tx('La pagina ha risposto con errore HTTP {0}.', r.status));
		const ct = r.headers['content-type'] ?? '';
		const name = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || url);
		if (r.arrayBuffer && (ext === 'pdf' || ct.includes('pdf'))) doc = { url, title: name, text: await pdfText(r.arrayBuffer), kind: 'pdf' };
		else if (r.arrayBuffer && ext) doc = { url, title: name, text: await officeText(r.arrayBuffer, ext), kind: 'documento' };
		else if (/html|xml/.test(ct) || /^\s*</.test(r.text)) {
			const h = htmlToText(r.text);
			doc = { url, title: h.title || url, text: h.text, kind: 'pagina' };
		} else doc = { url, title: url, text: tidy(r.text), kind: 'pagina' };
	}
	if (!doc.text.trim()) throw new Error(tx('La pagina non contiene testo leggibile (potrebbe richiedere JavaScript o un accesso).'));
	webCache.set(url, { at: Date.now(), doc });
	return doc;
}

export const URL_RE = /\bhttps?:\/\/[^\s<>"'`\])]+/gi;

// ------------------------------------------------------------------ web search

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

const strip = (s: string) => tidy(decodeEntities(s.replace(/<[^>]+>/g, '')));

/** Web search without API keys: DuckDuckGo (HTML version) or a self-hosted SearXNG instance. */
export async function webSearch(s: Pick<AmbraiaSettings, 'aiWebSearch' | 'aiSearxngUrl'>, query: string, limit = 6): Promise<SearchHit[]> {
	if (s.aiWebSearch === 'searxng') {
		const base = s.aiSearxngUrl.trim().replace(/\/+$/, '');
		if (!base) throw new Error(tx('Indica l’indirizzo della tua istanza SearXNG nelle impostazioni AI.'));
		const r = await net(`${base}/search?format=json&q=${encodeURIComponent(query)}`);
		if (r.status === 403) throw new Error(tx('SearXNG rifiuta il formato JSON: aggiungi "json" a search.formats in settings.yml.'));
		if (r.status >= 400) throw new Error(tx('SearXNG ha risposto con errore HTTP {0}.', r.status));
		const j = JSON.parse(r.text) as { results?: { title: string; url: string; content?: string }[] };
		return (j.results ?? []).slice(0, limit).map((x) => ({ title: x.title, url: x.url, snippet: x.content ?? '' }));
	}
	if (s.aiWebSearch !== 'duckduckgo') throw new Error(tx('La ricerca web è disattivata nelle impostazioni AI.'));
	const r = await net('https://html.duckduckgo.com/html/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `q=${encodeURIComponent(query)}&kl=it-it`,
	});
	if (r.status >= 400 || /anomaly|captcha/i.test(r.text.slice(0, 4000))) throw new Error(tx('DuckDuckGo ha bloccato la ricerca: riprova più tardi o usa una tua istanza SearXNG.'));
	const links = [...r.text.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
	const snippets = [...r.text.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/g)].map((m) => strip(m[1]));
	const hits: SearchHit[] = [];
	links.forEach((m, i) => {
		let href = decodeEntities(m[1]);
		const ud = /[?&]uddg=([^&]+)/.exec(href);
		if (ud) href = decodeURIComponent(ud[1]);
		if (href.startsWith('//')) href = 'https:' + href;
		if (/duckduckgo\.com\/y\.js|ad_domain=/.test(href)) return;
		hits.push({ title: strip(m[2]), url: href, snippet: snippets[i] ?? '' });
	});
	return hits.slice(0, limit);
}

// ------------------------------------------------------------------ memory

export async function readMemory(app: App, path: string): Promise<string> {
	const f = app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile ? (await app.vault.cachedRead(f)).trim() : '';
}

export async function ensureFolderFor(app: App, path: string) {
	const dir = path.split('/').slice(0, -1).join('/');
	let cur = '';
	for (const part of dir ? dir.split('/') : []) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
	}
}

/** Adds a dated line to the memory note (created when missing). */
export async function remember(app: App, path: string, fact: string, date: string): Promise<TFile> {
	const p = normalizePath(path);
	const line = `- ${fact.trim().replace(/\s*\n\s*/g, ' ')} _(${date})_`;
	let f = app.vault.getAbstractFileByPath(p);
	if (!(f instanceof TFile)) {
		await ensureFolderFor(app, p);
		const created = await app.vault.create(p, `# Memoria di Ambraia AI\n\nCose da ricordare tra una chat e l’altra. Puoi modificare o cancellare liberamente.\n\n${line}\n`);
		return created;
	}
	await app.vault.process(f, (d) => d.replace(/\s*$/, '') + '\n' + line + '\n');
	return f;
}

// ------------------------------------------------------------------ projects

export interface Project {
	name: string;
	path: string;
	folders: string[];
	tags: string[];
	/** Notes, files ([[...]] or paths) and URLs always given to the model. */
	context: string[];
	model?: string;
	mode?: string;
	instructions: string;
}

const list = (v: unknown): string[] =>
	(Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
		.map((x) => String(x ?? '').trim())
		.filter(Boolean);

export function parseProject(path: string, md: string): Project {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
	let meta: Record<string, unknown> = {};
	try {
		meta = (fm ? (parseYaml(fm[1]) as Record<string, unknown>) : null) ?? {};
	} catch {
		meta = {};
	}
	const ctx = [...list(meta.contesto ?? meta.context), ...list(meta.url)];
	return {
		name: path.split('/').pop()!.replace(/\.md$/i, ''),
		path,
		folders: list(meta.cartelle ?? meta.folders).map((f) => f.replace(/^\/+|\/+$/g, '')),
		tags: list(meta.tag ?? meta.tags).map((t) => t.replace(/^#/, '').toLowerCase()),
		context: ctx.map((c) => c.replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '')),
		model: typeof meta.modello === 'string' && meta.modello.trim() ? meta.modello.trim() : undefined,
		mode: typeof meta.modalita === 'string' ? meta.modalita.trim() : undefined,
		instructions: (fm ? md.slice(fm[0].length) : md).trim(),
	};
}

export async function listProjects(app: App, folder: string): Promise<Project[]> {
	const root = app.vault.getAbstractFileByPath(normalizePath(folder));
	if (!(root instanceof TFolder)) return [];
	const out: Project[] = [];
	for (const c of root.children) if (c instanceof TFile && c.extension === 'md') out.push(parseProject(c.path, await app.vault.cachedRead(c)));
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** True if `path` belongs to the project (no folders and no tags = whole vault). */
export function inProject(app: App, p: Project, path: string): boolean {
	if (!p.folders.length && !p.tags.length) return true;
	if (p.folders.some((f) => !f || path === f || path.startsWith(f + '/'))) return true;
	if (!p.tags.length) return false;
	const f = app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) return false;
	const c = app.metadataCache.getFileCache(f);
	const tags = new Set<string>();
	for (const t of c?.tags ?? []) tags.add(t.tag.replace(/^#/, '').toLowerCase());
	for (const t of list(c?.frontmatter?.tags ?? c?.frontmatter?.tag)) tags.add(t.replace(/^#/, '').toLowerCase());
	return p.tags.some((t) => [...tags].some((x) => x === t || x.startsWith(t + '/')));
}

export const PROJECT_SAMPLE = `---
cartelle: [Lavoro]
tag: []
contesto: []
modello: ""
modalita: vault
---
Scrivi qui le istruzioni del progetto: chi sei, che tono usare, cosa sapere.

- **cartelle** e **tag** limitano la ricerca nel vault a queste note (vuoti = tutto il vault).
- **contesto**: note, file (PDF, Word, PowerPoint, Excel…) o indirizzi web sempre allegati, es. ["[[Brief]]", "Documenti/offerta.pdf", "https://esempio.it"].
- **modello**: nome del modello da usare per questo progetto (vuoto = quello scelto nella chat).
- **modalita**: chat, vault o agent.
`;
