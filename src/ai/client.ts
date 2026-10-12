import { ApiKind, normalizeBaseUrl } from './providers';
import { tx } from '../i18n';

// ---------------------------------------------------------------- types

export interface ToolCall {
	id: string;
	name: string;
	/** Raw JSON string of the arguments. */
	args: string;
}

export interface ChatMsg {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	/** data: URLs of images (vision models). */
	images?: string[];
	toolCalls?: ToolCall[];
	toolCallId?: string;
	name?: string;
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface Endpoint {
	kind: ApiKind;
	provider: string;
	baseUrl: string;
	apiKey: string;
	model: string;
}

export interface ChatOptions {
	temperature?: number;
	maxTokens?: number;
	tools?: ToolDef[];
	signal?: AbortSignal;
	onToken?: (t: string) => void;
	/** Disable streaming (used by tests and very old servers). */
	noStream?: boolean;
}

export interface ChatResult {
	text: string;
	toolCalls: ToolCall[];
	finish: string;
	/** True if the request was retried without tools because the model rejected them. */
	toolsDropped?: boolean;
}

export interface HttpReq {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}
export interface HttpRes {
	status: number;
	text: string;
}

/**
 * How the client talks to the network. In Obsidian `request` is requestUrl (no CORS limits, no streaming)
 * and `fetch` is the browser fetch (streaming, but subject to CORS).
 */
export interface Transport {
	request(req: HttpReq): Promise<HttpRes>;
	fetch?: typeof fetch;
}

export class AiError extends Error {
	constructor(
		message: string,
		public status = 0,
		public detail = '',
	) {
		super(message);
	}
}

// ---------------------------------------------------------------- helpers

const noStreamHosts = new Set<string>();

function url(ep: Endpoint, path: string): string {
	return normalizeBaseUrl(ep.baseUrl) + path;
}

function headers(ep: Endpoint): Record<string, string> {
	const h: Record<string, string> = { 'Content-Type': 'application/json' };
	if (ep.kind === 'anthropic') {
		if (ep.apiKey) h['x-api-key'] = ep.apiKey;
		h['anthropic-version'] = '2023-06-01';
		h['anthropic-dangerous-direct-browser-access'] = 'true';
	} else if (ep.apiKey) {
		h['Authorization'] = `Bearer ${ep.apiKey}`;
	}
	if (ep.provider === 'openrouter') {
		h['HTTP-Referer'] = 'https://obsidian.md';
		h['X-Title'] = tx('Ambraia');
	}
	return h;
}

/** Loose shape of the JSON sent by OpenAI-compatible and Anthropic servers: every field is optional. */
interface WireError {
	message?: unknown;
	error?: unknown;
	detail?: unknown;
}
interface WireToolCall {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: unknown };
}
interface WireDelta {
	type?: string;
	text?: string;
	thinking?: string;
	partial_json?: string;
	content?: unknown;
	reasoning_content?: unknown;
	reasoning?: unknown;
	tool_calls?: WireToolCall[];
	stop_reason?: string;
}
interface WireBlock {
	type?: string;
	id?: string;
	name?: string;
	text?: string;
	thinking?: string;
	input?: unknown;
}
interface WireEvent {
	type?: string;
	index?: number;
	content_block?: WireBlock;
	delta?: WireDelta;
	error?: WireError | string;
	choices?: { delta?: WireDelta; message?: WireDelta; finish_reason?: string }[];
	content?: WireBlock[];
	stop_reason?: string;
}
const parseJson = <T>(text: string): T => JSON.parse(text) as T;
const errorText = (e: WireError | string): string => {
	if (typeof e === 'string') return e;
	const v = e.message ?? e.error ?? e.detail;
	return typeof v === 'string' ? v : JSON.stringify(v ?? e);
};

function errorMessage(body: string): string {
	try {
		const j = parseJson<WireEvent & WireError>(body);
		return errorText(j.error ?? j).slice(0, 500);
	} catch {
		return body.slice(0, 300);
	}
}

export function friendlyError(ep: Endpoint, status: number, body: string): AiError {
	const msg = errorMessage(body);
	let text: string;
	if (status === 401 || status === 403) text = tx('Chiave API non valida o senza permessi.');
	else if (status === 404) text = tx('Modello “{0}” o indirizzo non trovato.', ep.model);
	else if (status === 429) text = tx('Limite di richieste o credito esaurito presso il provider.');
	else if (status >= 500) text = tx('Il server dell’AI ha avuto un problema. Riprova tra poco.');
	else text = tx('Richiesta rifiutata dal provider.');
	return new AiError(`${text}${msg ? ` (${msg})` : ''}`, status, msg);
}

export function networkError(ep: Endpoint, e: unknown): AiError {
	const raw = e instanceof Error ? e.message : String(e);
	const local = /localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.\d+\.|\.local\b/.test(ep.baseUrl);
	if (local)
		return new AiError(
			tx('Server locale non raggiungibile su {0}. Avvia il server (in LM Studio: scheda Developer → Start server) e carica un modello.', normalizeBaseUrl(ep.baseUrl)),
			0,
			raw,
		);
	return new AiError(tx('Connessione non riuscita: {0}. Controlla la rete o l’indirizzo del server.', raw), 0, raw);
}

function isAbort(e: unknown): boolean {
	return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
}

function parseDataUrl(u: string): { mime: string; data: string } | null {
	const m = /^data:([^;]+);base64,(.*)$/s.exec(u);
	return m ? { mime: m[1], data: m[2] } : null;
}

// ---------------------------------------------------------------- request bodies

export function openaiBody(ep: Endpoint, msgs: ChatMsg[], o: ChatOptions, stream: boolean): Record<string, unknown> {
	const messages = msgs.map((m) => {
		if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
		if (m.role === 'assistant' && m.toolCalls?.length)
			return {
				role: 'assistant',
				content: m.content || null,
				tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })),
			};
		if (m.images?.length && m.role === 'user')
			return {
				role: 'user',
				content: [{ type: 'text', text: m.content }, ...m.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))],
			};
		return { role: m.role, content: m.content };
	});
	const body: Record<string, unknown> = { model: ep.model, messages, stream };
	if (o.temperature !== undefined) body.temperature = o.temperature;
	if (o.maxTokens) {
		if (ep.provider === 'openai') body.max_completion_tokens = o.maxTokens;
		else body.max_tokens = o.maxTokens;
	}
	if (o.tools?.length) body.tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
	return body;
}

export function anthropicBody(ep: Endpoint, msgs: ChatMsg[], o: ChatOptions, stream: boolean): Record<string, unknown> {
	const system = msgs
		.filter((m) => m.role === 'system')
		.map((m) => m.content)
		.join('\n\n');
	const out: { role: string; content: unknown[] }[] = [];
	const push = (role: 'user' | 'assistant', blocks: unknown[]) => {
		const last = out[out.length - 1];
		if (last && last.role === role) last.content.push(...blocks);
		else out.push({ role, content: blocks });
	};
	for (const m of msgs) {
		if (m.role === 'system') continue;
		if (m.role === 'tool') {
			push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]);
			continue;
		}
		const blocks: unknown[] = [];
		if (m.role === 'user')
			for (const u of m.images ?? []) {
				const d = parseDataUrl(u);
				if (d) blocks.push({ type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } });
			}
		if (m.content) blocks.push({ type: 'text', text: m.content });
		if (m.role === 'assistant')
			for (const t of m.toolCalls ?? []) {
				let input: unknown = {};
				try {
					input = JSON.parse(t.args || '{}');
				} catch {
					/* keep empty */
				}
				blocks.push({ type: 'tool_use', id: t.id, name: t.name, input });
			}
		if (!blocks.length) blocks.push({ type: 'text', text: '…' });
		push(m.role === 'assistant' ? 'assistant' : 'user', blocks);
	}
	if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '…' }] });
	const body: Record<string, unknown> = { model: ep.model, messages: out, max_tokens: o.maxTokens || 4096, stream };
	if (system) body.system = system;
	if (o.temperature !== undefined) body.temperature = Math.min(1, o.temperature);
	if (o.tools?.length) body.tools = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
	return body;
}

// ---------------------------------------------------------------- response parsing

/** Accumulates streamed / non-streamed responses of both API flavours. */
export class ResponseAccumulator {
	text = '';
	finish = '';
	private reasoning = false;
	private tools = new Map<number, ToolCall>();
	constructor(
		private kind: ApiKind,
		private onToken?: (t: string) => void,
	) {}

	private emit(t: string) {
		if (!t) return;
		this.text += t;
		this.onToken?.(t);
	}
	private reason(t: string) {
		if (!t) return;
		if (!this.reasoning) {
			this.reasoning = true;
			this.emit('<think>');
		}
		this.emit(t);
	}
	private endReason() {
		if (this.reasoning) {
			this.reasoning = false;
			this.emit('</think>\n\n');
		}
	}

	/** One streamed JSON event. */
	event(j: WireEvent) {
		if (this.kind === 'anthropic') {
			if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
				this.endReason();
				this.tools.set(j.index ?? 0, { id: j.content_block.id ?? '', name: j.content_block.name ?? '', args: '' });
			} else if (j.type === 'content_block_delta') {
				const d = j.delta ?? {};
				if (d.type === 'text_delta') {
					this.endReason();
					this.emit(d.text ?? '');
				} else if (d.type === 'thinking_delta') this.reason(d.thinking ?? '');
				else if (d.type === 'input_json_delta') {
					const t = this.tools.get(j.index ?? 0);
					if (t) t.args += d.partial_json ?? '';
				}
			} else if (j.type === 'message_delta' && j.delta?.stop_reason) this.finish = j.delta.stop_reason;
			else if (j.type === 'error') throw new AiError(j.error ? errorText(j.error) : tx('Errore del provider'), 0);
			return;
		}
		if (j.error) throw new AiError(errorText(j.error), 0);
		const c = j.choices?.[0];
		if (!c) return;
		const d: WireDelta = c.delta ?? c.message ?? {};
		const r = d.reasoning_content ?? d.reasoning;
		if (typeof r === 'string') this.reason(r);
		if (typeof d.content === 'string' && d.content) {
			this.endReason();
			this.emit(d.content);
		}
		for (const tc of d.tool_calls ?? []) {
			const idx = typeof tc.index === 'number' ? tc.index : this.tools.size;
			let t = this.tools.get(idx);
			if (!t) {
				t = { id: tc.id || `call_${idx}_${Date.now().toString(36)}`, name: '', args: '' };
				this.tools.set(idx, t);
			}
			if (tc.id) t.id = tc.id;
			if (tc.function?.name) t.name += tc.function.name;
			const a = tc.function?.arguments;
			if (typeof a === 'string') t.args += a;
			else if (a && typeof a === 'object') t.args += JSON.stringify(a);
		}
		if (c.finish_reason) this.finish = c.finish_reason;
	}

	/** A complete (non-streamed) response body. */
	full(j: WireEvent) {
		if (this.kind === 'anthropic') {
			for (const b of j.content ?? []) {
				if (b.type === 'thinking') this.reason(b.thinking ?? '');
				else if (b.type === 'text') {
					this.endReason();
					this.emit(b.text ?? '');
				} else if (b.type === 'tool_use') this.tools.set(this.tools.size, { id: b.id ?? '', name: b.name ?? '', args: JSON.stringify(b.input ?? {}) });
			}
			this.finish = j.stop_reason ?? '';
			return;
		}
		this.event(j);
	}

	result(): ChatResult {
		this.endReason();
		const toolCalls = [...this.tools.entries()]
			.sort((a, b) => a[0] - b[0])
			.map((e) => e[1])
			.filter((t) => t.name);
		return { text: this.text, toolCalls, finish: this.finish };
	}
}

/** Splits a Server-Sent-Events byte stream into `data:` payloads. */
export class SseParser {
	private buf = '';
	constructor(private onData: (data: string) => void) {}
	push(chunk: string) {
		this.buf += chunk;
		let i: number;
		while ((i = this.buf.indexOf('\n')) >= 0) {
			const line = this.buf.slice(0, i).replace(/\r$/, '');
			this.buf = this.buf.slice(i + 1);
			this.line(line);
		}
	}
	end() {
		if (this.buf) this.line(this.buf);
		this.buf = '';
	}
	private line(line: string) {
		if (!line.startsWith('data:')) return;
		const data = line.slice(5).trim();
		if (data && data !== '[DONE]') this.onData(data);
	}
}

// ---------------------------------------------------------------- chat

async function chatOnce(t: Transport, ep: Endpoint, msgs: ChatMsg[], o: ChatOptions): Promise<ChatResult> {
	const path = ep.kind === 'anthropic' ? '/messages' : '/chat/completions';
	const full = url(ep, path);
	const host = normalizeBaseUrl(ep.baseUrl);
	const build = (stream: boolean) => (ep.kind === 'anthropic' ? anthropicBody(ep, msgs, o, stream) : openaiBody(ep, msgs, o, stream));
	const acc = new ResponseAccumulator(ep.kind, o.onToken);
	const canStream = !o.noStream && !!t.fetch && !noStreamHosts.has(host);

	if (canStream) {
		let res: Response | null = null;
		try {
			res = await t.fetch!(full, { method: 'POST', headers: headers(ep), body: JSON.stringify(build(true)), signal: o.signal });
		} catch (e) {
			if (isAbort(e) || o.signal?.aborted) throw new AiError(tx('Interrotto'), -1);
			// CORS or mixed content: remember and fall back to requestUrl (no streaming)
			noStreamHosts.add(host);
		}
		if (res) {
			if (!res.ok) throw friendlyError(ep, res.status, await res.text().catch(() => ''));
			const ct = res.headers.get('content-type') ?? '';
			if (!res.body || !/event-stream|ndjson|text\/plain/.test(ct)) {
				const txt = await res.text();
				try {
					acc.full(parseJson<WireEvent>(txt));
				} catch (e) {
					if (e instanceof AiError) throw e;
					// some servers stream without the right content-type
					const p = new SseParser((d) => acc.event(parseJson<WireEvent>(d)));
					p.push(txt);
					p.end();
				}
				return acc.result();
			}
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			const p = new SseParser((d) => {
				let j: WireEvent;
				try {
					j = parseJson<WireEvent>(d);
				} catch {
					return;
				}
				acc.event(j);
			});
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					p.push(dec.decode(value, { stream: true }));
				}
				p.end();
			} catch (e) {
				if (isAbort(e) || o.signal?.aborted) {
					const r = acc.result();
					return { ...r, finish: 'aborted' };
				}
				throw e instanceof AiError ? e : networkError(ep, e);
			}
			return acc.result();
		}
	}

	let r: HttpRes;
	try {
		r = await t.request({ url: full, method: 'POST', headers: headers(ep), body: JSON.stringify(build(false)) });
	} catch (e) {
		throw networkError(ep, e);
	}
	if (o.signal?.aborted) throw new AiError(tx('Interrotto'), -1);
	if (r.status >= 400) throw friendlyError(ep, r.status, r.text);
	let j: WireEvent;
	try {
		j = parseJson<WireEvent>(r.text);
	} catch {
		throw new AiError(tx('Risposta non valida dal server: ') + r.text.slice(0, 200), r.status);
	}
	acc.full(j);
	const res = acc.result();
	return res;
}

/**
 * Sends a chat request. Automatically adapts to provider quirks: retries without temperature,
 * with max_completion_tokens, or without tools when the model rejects those parameters.
 */
export async function chat(t: Transport, ep: Endpoint, msgs: ChatMsg[], o: ChatOptions = {}): Promise<ChatResult> {
	let opts = { ...o };
	let toolsDropped = false;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const r = await chatOnce(t, ep, msgs, opts);
			return { ...r, toolsDropped };
		} catch (e) {
			if (!(e instanceof AiError) || e.status !== 400) throw e;
			const d = e.detail.toLowerCase();
			if (opts.tools?.length && /tool|function/.test(d)) {
				opts = { ...opts, tools: undefined };
				toolsDropped = true;
			} else if (opts.temperature !== undefined && /temperature/.test(d)) opts = { ...opts, temperature: undefined };
			else if (opts.maxTokens && /max_tokens|max_completion_tokens/.test(d)) opts = { ...opts, maxTokens: undefined };
			else throw e;
		}
	}
	throw new AiError(tx('Il provider ha rifiutato la richiesta.'));
}

// ---------------------------------------------------------------- models & embeddings

export async function listModels(t: Transport, ep: Endpoint): Promise<string[]> {
	let r: HttpRes;
	try {
		r = await t.request({ url: url(ep, '/models'), method: 'GET', headers: headers(ep) });
	} catch (e) {
		throw networkError(ep, e);
	}
	if (r.status >= 400) throw friendlyError(ep, r.status, r.text);
	type Model = string | { id?: unknown; name?: unknown; model?: unknown };
	let j: Model[] | { data?: Model[]; models?: Model[] };
	try {
		j = parseJson<typeof j>(r.text);
	} catch {
		throw new AiError(tx('Elenco dei modelli non valido'));
	}
	const arr: Model[] = Array.isArray(j) ? j : (j.data ?? j.models ?? []);
	const ids = arr
		.map((m) => (typeof m === 'string' ? m : (m.id ?? m.name ?? m.model ?? '')))
		.map((v) => (typeof v === 'string' ? v : String(v as number)).replace(/^models\//, ''))
		.filter(Boolean);
	return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function embed(t: Transport, ep: Endpoint, input: string[]): Promise<number[][]> {
	if (ep.kind === 'anthropic') throw new AiError(tx('Anthropic non offre modelli di embedding'));
	let r: HttpRes;
	try {
		r = await t.request({ url: url(ep, '/embeddings'), method: 'POST', headers: headers(ep), body: JSON.stringify({ model: ep.model, input }) });
	} catch (e) {
		throw networkError(ep, e);
	}
	if (r.status >= 400) throw friendlyError(ep, r.status, r.text);
	const j = parseJson<{ data?: { embedding: number[]; index?: number }[] }>(r.text);
	const data = j.data ?? [];
	const out = new Array<number[]>(input.length);
	data.forEach((d, i) => (out[d.index ?? i] = d.embedding));
	if (out.some((v) => !Array.isArray(v))) throw new AiError(tx('Risposta di embedding incompleta'));
	return out;
}

/** Removes <think> blocks (reasoning) from a model answer. */
export function stripThinking(s: string): string {
	return s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

/** Splits text into [reasoning, answer]. Handles unterminated <think> while streaming. */
export function splitThinking(s: string): { thinking: string; answer: string; open: boolean } {
	let thinking = '';
	let open = false;
	const answer = s.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, inner: string, close: string) => {
		thinking += (thinking ? '\n' : '') + inner.trim();
		if (!close) open = true;
		return '';
	});
	return { thinking, answer: answer.replace(/^\s+/, ''), open };
}

/** Rough token estimate (≈ 4 chars per token). */
export function estimateTokens(s: string): number {
	return Math.ceil(s.length / 4);
}
