/**
 * Local tools for the assistant: documents (PDF, Office, OpenDocument, EPUB, canvas),
 * subtitles, web pages, YouTube (official APIs only), X/Twitter posts (oEmbed), web search (official APIs only), long-term memory and
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

export const DOC_EXT = ['md', 'txt', 'csv', 'json', 'canvas', 'pdf', 'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub', 'html', 'htm', 'srt', 'vtt'];
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
	else if (ext === 'srt' || ext === 'vtt') text = subtitleText(await app.vault.cachedRead(f));
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

/** Keys and choices for the web tools (from the AI settings and the OS secret storage). */
export interface WebCtx {
	/** Google Gemini API key: the video is processed by Gemini through the official API. Age and regional service restrictions apply. */
	geminiKey?: string;
	/** YouTube Data API v3 key: title, channel, duration and description. */
	youtubeKey?: string;
	/** 'title' = only the oEmbed title, even when keys are present. */
	youtube?: 'auto' | 'title';
}

/** Gemini model used for YouTube and Google Search. Availability and billing depend on Google's current terms. */
export const GEMINI_TOOL_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest'];
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';

interface GeminiReply {
	candidates?: {
		content?: { parts?: { text?: string }[] };
		groundingMetadata?: { webSearchQueries?: string[]; searchEntryPoint?: { renderedContent?: string }; groundingChunks?: { web?: { uri?: string; title?: string } }[] };
	}[];
	error?: { message?: string };
}

/** One generateContent call on the official Gemini API (tries the next model when one is unknown). */
export async function geminiGenerate(key: string, body: Record<string, unknown>): Promise<GeminiReply> {
	let last = '';
	for (const model of GEMINI_TOOL_MODELS) {
		const r = await net(GEMINI_API + model + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
		let j: GeminiReply = {};
		try {
			j = JSON.parse(r.text) as GeminiReply;
		} catch {
			/* not JSON */
		}
		if (r.status < 400) return j;
		last = j.error?.message || `HTTP ${r.status}`;
		if (r.status !== 404) break;
	}
	throw new Error(tx('Google Gemini: {0}', last));
}

const geminiText = (j: GeminiReply) => (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();

/** ISO 8601 duration (PT1H2M3S) → 1:02:03. */
function isoDuration(d: string): string {
	const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
	if (!m) return '';
	return ts(Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0));
}

const YT_PROMPT =
	'Transcribe the speech of this video in its original language, with a [m:ss] timestamp at the start of each paragraph. ' +
	'If the video is longer than about 20 minutes, write instead a detailed summary by section, each with its [m:ss] timestamp, quoting the key sentences. ' +
	'Describe briefly anything important that is only shown on screen. Do not add comments of your own.';

/**
 * A YouTube video, only through official APIs (YouTube's terms forbid automated access to its pages,
 * so the watch page and its captions are never downloaded):
 * 1. with a Gemini key, Google Gemini watches the public video and returns transcript or summary;
 * 2. with a YouTube Data API key, title, channel, duration and description;
 * 3. otherwise the title from the public oEmbed endpoint.
 * The user can always paste the transcript or attach a subtitle file (.srt/.vtt).
 */
export async function youtubeVideo(id: string, ctx: WebCtx = {}): Promise<WebDoc> {
	const url = 'https://www.youtube.com/watch?v=' + id;
	let title = tx('Video YouTube {0}', id);
	const r = await net('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
	if (r.status < 400) {
		try {
			const j = JSON.parse(r.text) as { title?: string; author_name?: string };
			if (j.title) title = `${j.title}${j.author_name ? ' – ' + j.author_name : ''}`;
		} catch {
			/* keep the generic title */
		}
	}
	const notes: string[] = [];
	if (ctx.youtube !== 'title' && ctx.geminiKey) {
		try {
			const j = await geminiGenerate(ctx.geminiKey, { contents: [{ role: 'user', parts: [{ file_data: { file_uri: url } }, { text: YT_PROMPT }] }], generationConfig: { mediaResolution: 'MEDIA_RESOLUTION_LOW' } });
			const text = geminiText(j);
			if (text) return { url, title, text: tx('Contenuto del video ricavato da Google Gemini (può contenere errori):') + '\n\n' + text, kind: 'youtube' };
		} catch (e) {
			notes.push(e instanceof Error ? e.message : String(e));
		}
	}
	if (ctx.youtube !== 'title' && ctx.youtubeKey) {
		try {
			const d = await net(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(id)}&key=${encodeURIComponent(ctx.youtubeKey)}`);
			const j = JSON.parse(d.text) as { items?: { snippet?: { title?: string; channelTitle?: string; description?: string; publishedAt?: string }; contentDetails?: { duration?: string } }[]; error?: { message?: string } };
			const v = j.items?.[0];
			if (d.status >= 400) throw new Error(tx('YouTube Data API: {0}', j.error?.message ?? `HTTP ${d.status}`));
			if (v?.snippet) {
				const sn = v.snippet;
				title = `${sn.title ?? title}${sn.channelTitle ? ' – ' + sn.channelTitle : ''}`;
				const meta = [sn.publishedAt ? tx('Pubblicato: {0}', sn.publishedAt.slice(0, 10)) : '', v.contentDetails?.duration ? tx('Durata: {0}', isoDuration(v.contentDetails.duration)) : ''].filter(Boolean).join(' · ');
				return { url, title, text: `${meta}\n\n${tx('Descrizione:')}\n${(sn.description ?? '').trim() || '—'}\n\n${tx('(Trascrizione non disponibile tramite le API ufficiali: se serve, incollala o allega un file di sottotitoli .srt/.vtt.)')}`, kind: 'youtube' };
			}
		} catch (e) {
			notes.push(e instanceof Error ? e.message : String(e));
		}
	}
	const why = notes.length ? '\n\n' + tx('(Lettura del video non riuscita: {0})', notes.join('; ')) : '';
	return { url, title, text: tx('Video YouTube: «{0}». Ambraia legge i video solo tramite le API ufficiali: aggiungi una chiave Google Gemini (gratuita) nelle impostazioni AI per farlo “guardare” a Gemini, oppure incolla qui la trascrizione (sotto il video, «Mostra trascrizione») o allega un file di sottotitoli .srt/.vtt.', title) + why, kind: 'youtube' };
}

/** Text of a post on X/Twitter via the public oEmbed endpoint. */
async function xPost(url: string): Promise<WebDoc> {
	const r = await net('https://publish.twitter.com/oembed?omit_script=1&url=' + encodeURIComponent(url));
	if (r.status >= 400) throw new Error(tx('Post non disponibile (HTTP {0}).', r.status));
	const j = JSON.parse(r.text) as { html?: string; author_name?: string };
	return { url, title: tx('Post di {0}', j.author_name ?? 'X'), text: htmlToText(j.html ?? '').text, kind: 'x' };
}

/** Downloads a URL the user asked for and returns its readable text: YouTube → official APIs (see youtubeVideo), X → post (oEmbed), PDF/Office → document text. */
export async function fetchWeb(url: string, ctx: WebCtx = {}): Promise<WebDoc> {
	url = url.trim().replace(/[).,;:!?»”']+$/, '');
	if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
	const ck = (youtubeId(url) ? `${ctx.youtube ?? 'auto'}|${ctx.geminiKey ? 'g' : ''}${ctx.youtubeKey ? 'y' : ''}|` : '') + url;
	const c = webCache.get(ck);
	if (c && Date.now() - c.at < 15 * 60_000) return c.doc;
	let doc: WebDoc;
	const yt = youtubeId(url);
	if (yt) doc = await youtubeVideo(yt, ctx);
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
	webCache.set(ck, { at: Date.now(), doc });
	return doc;
}

export const URL_RE = /\bhttps?:\/\/[^\s<>"'`\])]+/gi;

// ------------------------------------------------------------------ web search

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}


export interface SearchOpts {
	mode: 'off' | 'auto' | 'searxng';
	searxngUrl?: string;
	/** Gemini key: in "auto" the search goes through Google Search via Gemini grounding. Age and regional service restrictions apply. */
	geminiKey?: string;
	/** Language for the free sources (Wikipedia), e.g. "it". */
	lang?: string;
}

export interface SearchResult {
	engine: 'google' | 'searxng' | 'free';
	/** Short answer written by Gemini from Google Search results. */
	answer?: string;
	hits: SearchHit[];
	/** Google Search Suggestions (HTML to show as is, as required by the Gemini API terms). */
	suggestions?: string;
	queries?: string[];
}

const stripTags = (h: string) => decodeEntities(h.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Google Search through the official Gemini API ("Grounding with Google Search"). */
async function googleSearch(key: string, query: string, limit: number): Promise<SearchResult> {
	const j = await geminiGenerate(key, {
		contents: [{ role: 'user', parts: [{ text: `Search the web and answer concisely, in the language of the query, citing the facts you find: ${query}` }] }],
		tools: [{ google_search: {} }],
	});
	const c = j.candidates?.[0];
	const g = c?.groundingMetadata;
	const hits = (g?.groundingChunks ?? [])
		.map((x) => x.web)
		.filter((w): w is { uri: string; title?: string } => !!w?.uri)
		.slice(0, limit)
		.map((w) => ({ title: w.title || w.uri, url: w.uri, snippet: '' }));
	return { engine: 'google', answer: geminiText(j), hits, suggestions: g?.searchEntryPoint?.renderedContent, queries: g?.webSearchQueries };
}

/** Free sources without keys, through their official APIs: Wikipedia (MediaWiki) and DuckDuckGo Instant Answers. */
async function freeSearch(query: string, limit: number, lang = 'en'): Promise<SearchResult> {
	const q = encodeURIComponent(query);
	const langs = [...new Set([/^[a-z]{2,3}$/.test(lang) ? lang : 'en', 'en'])];
	const [ddg, ...wikis] = await Promise.all([
		net(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1&t=ambraia`).catch(() => null),
		...langs.map((l) => net(`https://${l}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${limit}&srsearch=${q}`).then((r) => ({ l, r })).catch(() => null)),
	]);
	const hits: SearchHit[] = [];
	let answer = '';
	if (ddg && ddg.status < 400) {
		try {
			const j = JSON.parse(ddg.text) as { Heading?: string; AbstractText?: string; AbstractURL?: string; Answer?: string; Definition?: string; DefinitionURL?: string; RelatedTopics?: { Text?: string; FirstURL?: string; Topics?: { Text?: string; FirstURL?: string }[] }[] };
			answer = (j.Answer || '').toString().trim();
			if (j.AbstractText && j.AbstractURL) hits.push({ title: j.Heading || j.AbstractURL, url: j.AbstractURL, snippet: j.AbstractText });
			if (j.Definition && j.DefinitionURL) hits.push({ title: j.Heading || j.DefinitionURL, url: j.DefinitionURL, snippet: j.Definition });
			for (const t of (j.RelatedTopics ?? []).flatMap((t) => (t.Topics ? t.Topics : [t])).slice(0, 3)) if (t.Text && t.FirstURL) hits.push({ title: t.Text.split(' - ')[0].slice(0, 80), url: t.FirstURL, snippet: t.Text });
		} catch {
			/* no instant answer */
		}
	}
	for (const w of wikis) {
		if (!w || w.r.status >= 400) continue;
		try {
			const j = JSON.parse(w.r.text) as { query?: { search?: { title: string; snippet?: string }[] } };
			for (const x of j.query?.search ?? []) hits.push({ title: `${x.title} – Wikipedia`, url: `https://${w.l}.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`, snippet: stripTags(x.snippet ?? '') });
		} catch {
			/* skip */
		}
	}
	const seen = new Set<string>();
	return { engine: 'free', answer: answer || undefined, hits: hits.filter((h) => !seen.has(h.url) && seen.add(h.url)).slice(0, limit) };
}

/**
 * Web search, only through official APIs (search engines' result pages are never scraped):
 * - "auto" (default once AI is on): Google Search through Gemini when a Gemini key is set (free
 *   access), otherwise free sources without keys (DuckDuckGo Instant Answers + Wikipedia);
 * - "searxng": the JSON API of a SearXNG instance chosen by the user.
 */
export async function webSearch(o: SearchOpts, query: string, limit = 6): Promise<SearchResult> {
	if (o.mode === 'searxng') {
		const base = (o.searxngUrl ?? '').trim().replace(/\/+$/, '');
		if (!base) throw new Error(tx('Indica l’indirizzo della tua istanza SearXNG nelle impostazioni AI.'));
		const r = await net(`${base}/search?format=json&q=${encodeURIComponent(query)}`);
		if (r.status === 403) throw new Error(tx('SearXNG rifiuta il formato JSON: aggiungi "json" a search.formats in settings.yml.'));
		if (r.status >= 400) throw new Error(tx('SearXNG ha risposto con errore HTTP {0}.', r.status));
		const j = JSON.parse(r.text) as { results?: { title: string; url: string; content?: string }[] };
		return { engine: 'searxng', hits: (j.results ?? []).slice(0, limit).map((x) => ({ title: x.title, url: x.url, snippet: x.content ?? '' })) };
	}
	if (o.mode !== 'auto') throw new Error(tx('La ricerca web è disattivata nelle impostazioni AI.'));
	if (o.geminiKey) {
		try {
			const g = await googleSearch(o.geminiKey, query, limit);
			if (g.answer || g.hits.length) return g;
		} catch {
			/* quota or network: the free sources answer instead */
		}
	}
	return freeSearch(query, limit, o.lang);
}

/** Search result as text for the model. */
export function searchText(r: SearchResult): string {
	const src = r.engine === 'google' ? tx('Fonte: Ricerca Google (tramite Gemini).') : r.engine === 'free' ? tx('Fonti gratuite: DuckDuckGo Instant Answers e Wikipedia (per pagine più specifiche aggiungi una chiave Gemini o usa SearXNG).') : 'SearXNG';
	const list = r.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? '\n   ' + h.snippet : ''}`).join('\n');
	if (!r.answer && !list) return tx('Nessun risultato.');
	return [src, r.answer ? tx('Risposta: {0}', r.answer) : '', list].filter(Boolean).join('\n\n');
}

// ------------------------------------------------------------------ subtitles

/** Plain text with [m:ss] marks from an .srt or .vtt subtitle file (tags, cue numbers and repeats dropped). */
export function subtitleText(raw: string): string {
	const out: string[] = [];
	let last = -1e9;
	let prev = '';
	for (const block of raw.replace(/\r/g, '').split(/\n{2,}/)) {
		const lines = block.split('\n').filter((l) => l.trim());
		const ti = lines.findIndex((l) => /-->/.test(l));
		if (ti < 0) continue;
		const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,]\d+\s*-->/.exec(lines[ti]);
		const sec = m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
		const text = lines
			.slice(ti + 1)
			.map((l) => decodeEntities(l.replace(/<[^>]+>/g, '')).trim())
			.filter(Boolean)
			.join(' ');
		if (!text || text === prev) continue;
		prev = text;
		// a new paragraph (with its time) every 30 seconds or more
		if (sec - last >= 30) {
			out.push(`[${ts(sec)}] ${text}`);
			last = sec;
		} else out[out.length - 1] += ' ' + text;
	}
	return out.join('\n');
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
