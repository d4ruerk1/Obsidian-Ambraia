// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeApp, installDomShim } from './app-fake';
import {
	anthropicBody,
	chat,
	ChatMsg,
	Endpoint,
	HttpReq,
	listModels,
	openaiBody,
	ResponseAccumulator,
	SseParser,
	splitThinking,
	stripThinking,
	Transport,
} from '../src/ai/client';
import { normalizeBaseUrl, preset } from '../src/ai/providers';
import { chunkNote, LexicalIndex, mergeHits, tokenize, formatContext, isExcluded } from '../src/ai/retrieval';
import { expandTemplate } from '../src/ai/prompts';
import { chatToMarkdown, markdownToChat, ChatEntry } from '../src/ai/chatView';

installDomShim();

const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
});

const lm: Endpoint = { kind: 'openai', provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1', apiKey: '', model: 'qwen' };
const claude: Endpoint = { kind: 'anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant', model: 'claude' };

/** Transport answering requestUrl-style calls from a queue. */
function queued(...answers: (object | { status: number; body: string } | ((req: HttpReq) => object))[]) {
	const reqs: HttpReq[] = [];
	const t: Transport = {
		async request(req) {
			reqs.push(req);
			const a = answers.shift();
			if (!a) throw new Error('no more answers');
			const v = typeof a === 'function' ? a(req) : a;
			if ('status' in v && 'body' in v) return { status: (v as any).status, text: (v as any).body };
			return { status: 200, text: JSON.stringify(v) };
		},
	};
	return { t, reqs, bodies: () => reqs.map((r) => (r.body ? JSON.parse(r.body) : null)) };
}

/** fetch() returning a streamed SSE body split into odd-sized chunks. */
function sseFetch(events: object[], chunk = 7): typeof fetch {
	const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
	const bytes = new TextEncoder().encode(text);
	return (async () => {
		let i = 0;
		return {
			ok: true,
			status: 200,
			headers: { get: () => 'text/event-stream' },
			body: {
				getReader: () => ({
					read: async () => {
						if (i >= bytes.length) return { done: true, value: undefined };
						const v = bytes.slice(i, i + chunk);
						i += chunk;
						return { done: false, value: v };
					},
				}),
			},
			text: async () => text,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe('providers', () => {
	it('normalizes base URLs pasted in many shapes', () => {
		expect(normalizeBaseUrl('localhost:1234/v1/')).toBe('http://localhost:1234/v1');
		expect(normalizeBaseUrl('http://192.168.1.5:1234/v1/chat/completions')).toBe('http://192.168.1.5:1234/v1');
		expect(normalizeBaseUrl('https://api.openai.com/v1/models')).toBe('https://api.openai.com/v1');
	});
	it('has LM Studio and Ollama presets pointing at the local OpenAI-compatible servers', () => {
		expect(preset('lmstudio').baseUrl).toContain('1234');
		expect(preset('ollama').baseUrl).toContain('11434');
		expect(preset('anthropic').kind).toBe('anthropic');
		expect(preset('sconosciuto').id).toBe('custom');
	});
});

describe('AI client', () => {
	it('SSE parser handles split lines, CRLF and [DONE]', () => {
		const got: string[] = [];
		const p = new SseParser((d) => got.push(d));
		p.push('data: {"a"');
		p.push(':1}\r\n\r\nevent: x\ndata: [DONE]\n');
		p.push('data: {"b":2}');
		p.end();
		expect(got).toEqual(['{"a":1}', '{"b":2}']);
	});

	it('streams OpenAI-compatible tokens, reasoning and tool calls', async () => {
		const tokens: string[] = [];
		const t: Transport = {
			request: async () => ({ status: 500, text: '' }),
			fetch: sseFetch([
				{ choices: [{ delta: { reasoning_content: 'penso' } }] },
				{ choices: [{ delta: { content: 'Ciao' } }] },
				{ choices: [{ delta: { content: ' mondo' } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"pa' } }] } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'note', arguments: 'th":"A"}' } }] } }] },
				{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
			]),
		};
		const r = await chat(t, { ...lm, baseUrl: 'http://stream-ok:1/v1' }, [{ role: 'user', content: 'x' }], { onToken: (x) => tokens.push(x) });
		expect(splitThinking(r.text)).toEqual({ thinking: 'penso', answer: 'Ciao mondo', open: false });
		expect(stripThinking(r.text)).toBe('Ciao mondo');
		expect(tokens.join('')).toBe(r.text);
		expect(r.toolCalls).toEqual([{ id: 'c1', name: 'read_note', args: '{"path":"A"}' }]);
		expect(r.finish).toBe('tool_calls');
	});

	it('parses Anthropic streamed events', async () => {
		const t: Transport = {
			request: async () => ({ status: 500, text: '' }),
			fetch: sseFetch([
				{ type: 'message_start' },
				{ type: 'content_block_start', index: 0, content_block: { type: 'text' } },
				{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Leggo' } },
				{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'search_notes' } },
				{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
				{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ricette"}' } },
				{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
			]),
		};
		const r = await chat(t, { ...claude, baseUrl: 'https://stream-ok-anthropic/v1' }, [{ role: 'user', content: 'x' }]);
		expect(r.text).toBe('Leggo');
		expect(r.toolCalls).toEqual([{ id: 'tu1', name: 'search_notes', args: '{"query":"ricette"}' }]);
		expect(r.finish).toBe('tool_use');
	});

	it('falls back to requestUrl (no streaming) when fetch is blocked by CORS', async () => {
		let fetched = 0;
		const q = queued({ choices: [{ message: { content: 'ok 1' } }] }, { choices: [{ message: { content: 'ok 2' } }] });
		const t: Transport = {
			request: q.t.request,
			fetch: (async () => {
				fetched++;
				throw new TypeError('Failed to fetch');
			}) as unknown as typeof fetch,
		};
		const ep = { ...lm, baseUrl: 'http://cors-blocked:1234/v1' };
		expect((await chat(t, ep, [{ role: 'user', content: 'a' }])).text).toBe('ok 1');
		expect((await chat(t, ep, [{ role: 'user', content: 'b' }])).text).toBe('ok 2');
		expect(fetched).toBe(1); // remembered: no second attempt
		expect(q.bodies()[0].stream).toBe(false);
	});

	it('retries without tools / temperature when the model rejects them', async () => {
		const q = queued(
			{ status: 400, body: JSON.stringify({ error: { message: 'This model does not support tools' } }) },
			{ status: 400, body: JSON.stringify({ error: { message: 'Unsupported value: temperature' } }) },
			{ choices: [{ message: { content: 'fatto' } }] },
		);
		const r = await chat(q.t, lm, [{ role: 'user', content: 'x' }], { temperature: 0.3, tools: [{ name: 'a', description: 'b', parameters: {} }] });
		expect(r.text).toBe('fatto');
		expect(r.toolsDropped).toBe(true);
		const [b1, b2, b3] = q.bodies();
		expect(b1.tools).toBeDefined();
		expect(b2.tools).toBeUndefined();
		expect(b2.temperature).toBe(0.3);
		expect(b3.temperature).toBeUndefined();
	});

	it('gives an understandable Italian error for wrong keys and unreachable servers', async () => {
		const q = queued({ status: 401, body: JSON.stringify({ error: { message: 'Invalid API key' } }) });
		await expect(chat(q.t, { ...lm, provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, [{ role: 'user', content: 'x' }])).rejects.toThrow(/chiave|API/i);
		const down: Transport = {
			request: async () => {
				throw new Error('net::ERR_CONNECTION_REFUSED');
			},
		};
		await expect(chat(down, lm, [{ role: 'user', content: 'x' }])).rejects.toThrow(/LM Studio|server|raggiung/i);
	});

	it('lists models from OpenAI, Ollama-style and Gemini-style responses', async () => {
		const q = queued({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }, { models: [{ name: 'models/gemini-x' }] });
		expect(await listModels(q.t, lm)).toEqual(['a', 'b']);
		expect(await listModels(q.t, lm)).toEqual(['gemini-x']);
		expect(q.reqs[0].url).toBe('http://localhost:1234/v1/models');
	});

	it('builds OpenAI bodies with images, tool calls and tool results', () => {
		const msgs: ChatMsg[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'guarda', images: ['data:image/png;base64,AAAA'] },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_note', args: '' }] },
			{ role: 'tool', toolCallId: 'c1', name: 'read_note', content: 'testo' },
		];
		const b: any = openaiBody({ ...lm, provider: 'openai' }, msgs, { maxTokens: 100 }, true);
		expect(b.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
		expect(b.messages[2].tool_calls[0].function.arguments).toBe('{}');
		expect(b.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'testo' });
		expect(b.max_completion_tokens).toBe(100);
		expect(openaiBody(lm, msgs, { maxTokens: 100 }, true).max_tokens).toBe(100);
	});

	it('builds Anthropic bodies: system apart, alternating roles, tool_use / tool_result, base64 images', () => {
		const msgs: ChatMsg[] = [
			{ role: 'system', content: 'a' },
			{ role: 'system', content: 'b' },
			{ role: 'user', content: 'ciao', images: ['data:image/jpeg;base64,QUJD'] },
			{ role: 'assistant', content: 'leggo', toolCalls: [{ id: 't1', name: 'read_note', args: '{"path":"X"}' }] },
			{ role: 'tool', toolCallId: 't1', content: 'contenuto' },
			{ role: 'tool', toolCallId: 't2', content: 'altro' },
		];
		const b: any = anthropicBody(claude, msgs, { temperature: 1.5 }, false);
		expect(b.system).toBe('a\n\nb');
		expect(b.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
		expect(b.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
		expect(b.messages[1].content[1]).toEqual({ type: 'tool_use', id: 't1', name: 'read_note', input: { path: 'X' } });
		expect(b.messages[2].content).toHaveLength(2);
		expect(b.temperature).toBe(1);
		expect(b.max_tokens).toBeGreaterThan(0);
	});

	it('accumulates non-streamed Anthropic responses with thinking', () => {
		const acc = new ResponseAccumulator('anthropic');
		acc.full({ content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Risposta' }], stop_reason: 'end_turn' });
		const r = acc.result();
		expect(stripThinking(r.text)).toBe('Risposta');
		expect(splitThinking(r.text).thinking).toBe('hmm');
	});

	it('splitThinking handles <think> still open while streaming', () => {
		expect(splitThinking('<think>sto pensando')).toEqual({ thinking: 'sto pensando', answer: '', open: true });
	});
});

describe('retrieval', () => {
	it('chunks notes by heading and keeps frontmatter in the first chunk', () => {
		const c = chunkNote('Cartella/Ricette.md', '---\ntags: cucina\n---\nIntro\n# Pasta\nAcqua e sale\n## Sugo\nPomodoro');
		expect(c.map((x) => x.heading)).toEqual(['', 'Pasta', 'Sugo']);
		expect(c[0].text).toContain('tags: cucina');
		expect(c[0].title).toBe('Ricette');
		const long = chunkNote('L.md', Array.from({ length: 30 }, (_, i) => `Paragrafo ${i} ` + 'x'.repeat(100)).join('\n\n'), 500);
		expect(long.length).toBeGreaterThan(5);
		expect(long.every((x) => x.text.length <= 500)).toBe(true);
	});

	it('tokenizes Italian with accents, stop words and light stemming', () => {
		const [a, b, ...rest] = tokenize('La città e le Citta');
		expect(rest).toEqual([]);
		expect(a).toBe(b);
		expect(a.startsWith('citt')).toBe(true);
		expect(tokenize('progetti progetto')).toEqual(['progett', 'progett']);
	});

	it('BM25 ranks the relevant note first and title matches higher', () => {
		const idx = new LexicalIndex();
		idx.set('Cucina/Carbonara.md', 1, 'Guanciale, uova, pecorino e pepe. La vera carbonara.');
		idx.set('Lavoro/Riunione.md', 1, 'Verbale della riunione: budget e scadenze.');
		idx.set('Viaggi.md', 1, 'Roma: abbiamo mangiato una carbonara.');
		const hits = idx.search('ricetta carbonara pecorino', 5);
		expect(hits[0].chunk.path).toBe('Cucina/Carbonara.md');
		expect(hits.map((h) => h.chunk.path)).not.toContain('Lavoro/Riunione.md');
		idx.remove('Cucina/Carbonara.md');
		expect(idx.search('pecorino', 5)).toEqual([]);
	});

	it('merges lexical and semantic hits without duplicates', () => {
		const ch = (p: string) => ({ path: p, title: p, heading: '', text: p, offset: 0 });
		const m = mergeHits([{ chunk: ch('a'), score: 3 }, { chunk: ch('b'), score: 1 }], [{ chunk: ch('b'), score: 0.9 }, { chunk: ch('c'), score: 0.8 }], 3);
		expect(m.map((h) => h.chunk.path).sort()).toEqual(['a', 'b', 'c']);
		expect(m[0].chunk.path).toBe('b');
	});

	it('formats context within the budget and honours excluded folders', () => {
		const ch = (p: string, t: string) => ({ chunk: { path: p, title: p, heading: 'H', text: t, offset: 0 }, score: 1 });
		const out = formatContext([ch('a.md', 'x'.repeat(300)), ch('b.md', 'y'.repeat(300))], 400);
		expect(out.length).toBeLessThan(600);
		expect(out).toContain('a');
		expect(isExcluded('Privato/x.md', ['Privato'])).toBe(true);
		expect(isExcluded('Privatissimo/x.md', ['Privato'])).toBe(false);
	});
});

describe('custom prompt templates', () => {
	it('expands {}, {nota}, {[[Nota]]}, {#tag} and {data}', async () => {
		const app = new FakeApp();
		const active = await app.vault.create('Attiva.md', 'testo attivo');
		await app.vault.create('Glossario.md', 'termini');
		await app.vault.create('T1.md', 'uno #progetto');
		await app.vault.create('T2.md', 'due #progetto/sub');
		await app.vault.create('T3.md', 'tre #altro');
		const out = await expandTemplate(app as any, 'S={} N={nota} G={[[Glossario]]} X={[[Manca]]} T={#progetto} D={data}', 'SEL', active as any);
		expect(out).toContain('S=SEL');
		expect(out).toContain('N=testo attivo');
		expect(out).toContain('<nota titolo="Glossario">\ntermini');
		expect(out).toContain('(nota “Manca” non trovata)');
		expect(out).toContain('uno #progetto');
		expect(out).toContain('due #progetto/sub');
		expect(out).not.toContain('tre #altro');
		expect(out).toMatch(/D=\d{4}-\d{2}-\d{2}/);
	});
	it('appends the selection (or the note) when the template has no placeholder', async () => {
		const app = new FakeApp();
		const active = await app.vault.create('A.md', 'nota intera');
		expect(await expandTemplate(app as any, 'Riassumi', 'pezzo', active as any)).toBe('Riassumi\n\npezzo');
		expect(await expandTemplate(app as any, 'Riassumi', '', active as any)).toBe('Riassumi\n\nnota intera');
	});
});

describe('saved chats', () => {
	it('round-trips through Markdown and drops reasoning and errors', () => {
		const entries: ChatEntry[] = [
			{ role: 'user', content: 'CONTESTO + domanda', display: 'Domanda?', context: ['Cartella/Nota.md'] },
			{ role: 'assistant', content: '<think>ragiono</think>\n\nRisposta con **grassetto**\n\n> citazione', sources: ['A.md', 'B c.md'] },
			{ role: 'assistant', content: 'Errore', error: true },
			{ role: 'user', content: 'Seconda' },
		];
		const md = chatToMarkdown(entries, { mode: 'vault', model: 'qwen "3"', created: '2026-10-02' });
		expect(md).toContain('ambraia-chat: true');
		expect(md).not.toContain('ragiono');
		const back = markdownToChat(md);
		expect(back.mode).toBe('vault');
		expect(back.entries).toHaveLength(3);
		expect(back.entries[0]).toMatchObject({ role: 'user', display: 'Domanda?', context: ['Cartella/Nota.md'] });
		expect(back.entries[1].content).toBe('Risposta con **grassetto**\n\n> citazione');
		expect(back.entries[1].sources).toEqual(['A.md', 'B c.md']);
		expect(back.entries[2].content).toBe('Seconda');
	});
});

// ------------------------------------------------------------------ manager + agent

async function setupPlugin() {
	document.body.innerHTML = '';
	const app = new FakeApp();
	await app.vault.create('Ricette/Carbonara.md', '# Carbonara\nGuanciale, uova, pecorino.');
	await app.vault.create('Lavoro.md', 'Riunione lunedì sul budget.');
	const plugin = new AmbraiaPlugin(app, manifest);
	await plugin.onload();
	await app.workspace.fireLayoutReady();
	return { app, plugin };
}

async function withModel(plugin: any, provider = 'lmstudio') {
	plugin.settings.aiEnabled = true;
	await plugin.ai.addModel({ provider, model: 'qwen3' });
}

describe('AiManager', () => {
	it('is not ready until a model is configured; keys go to secret storage', async () => {
		const { app, plugin } = await setupPlugin();
		expect(plugin.ai.ready).toBe(false);
		await withModel(plugin);
		expect(plugin.ai.ready).toBe(true);
		await plugin.ai.setKey('openai', 'sk-test');
		expect(plugin.ai.getKey('openai')).toBe('sk-test');
		expect(JSON.stringify(plugin.data)).not.toContain('sk-test');
		expect([...app.secrets.values()]).toContain('sk-test');
		plugin.settings.aiProviderUrls.lmstudio = '192.168.1.20:1234/v1/';
		expect(plugin.ai.endpoint(plugin.ai.model()).baseUrl).toBe('http://192.168.1.20:1234/v1');
	});

	it('stores API keys only in the secret storage, never in data.json', async () => {
		const { plugin } = await setupPlugin();
		await plugin.ai.setKey('groq', 'gsk');
		expect(plugin.ai.getKey('groq')).toBe('gsk');
		expect(JSON.stringify(plugin.settings)).not.toContain('gsk');
	});

	it('vault mode injects matching note excerpts and returns sources', async () => {
		const { plugin } = await setupPlugin();
		await withModel(plugin);
		const q = queued({ choices: [{ message: { content: 'Serve il guanciale [[Carbonara]].' } }] });
		plugin.ai.transport = q.t;
		const r = await plugin.ai.run([{ role: 'user', content: 'cosa serve per la carbonara?' }], 'vault');
		expect(r.sources).toContain('Ricette/Carbonara.md');
		const body = q.bodies()[0];
		const ctx = body.messages.find((m: any) => m.role === 'system' && m.content.includes('Estratti'));
		expect(ctx.content).toContain('pecorino');
		expect(body.messages[body.messages.length - 1].role).toBe('user');
	});

	it('agent mode calls read_note, then answers', async () => {
		const { plugin } = await setupPlugin();
		await withModel(plugin);
		const q = queued(
			{ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_note', arguments: '{"path":"Carbonara"}' } }] }, finish_reason: 'tool_calls' }] },
			{ choices: [{ message: { content: 'Contiene guanciale.' }, finish_reason: 'stop' }] },
		);
		plugin.ai.transport = q.t;
		const tools: string[] = [];
		const r = await plugin.ai.run([{ role: 'user', content: 'leggi la carbonara' }], 'agent', { onToolStart: (_id: string, l: string) => tools.push(l) });
		expect(r.text).toContain('Contiene guanciale.');
		expect(tools).toHaveLength(1);
		expect(r.sources).toContain('Ricette/Carbonara.md');
		const second = q.bodies()[1];
		const toolMsg = second.messages.find((m: any) => m.role === 'tool');
		expect(toolMsg.content).toContain('pecorino');
		expect(q.bodies()[0].tools.map((t: any) => t.function.name)).toContain('create_note');
	});

	it('asks before writing; a refusal leaves the vault untouched', async () => {
		const { app, plugin } = await setupPlugin();
		await withModel(plugin);
		const call = { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_note', arguments: '{"path":"Nuove/Idea.md","content":"ciao"}' } }] } }] };
		const done = { choices: [{ message: { content: 'ok' } }] };
		const asked: string[] = [];

		plugin.ai.transport = queued(call, done).t;
		await plugin.ai.run([{ role: 'user', content: 'crea' }], 'agent', { confirm: async (t: string) => (asked.push(t), false) });
		expect(asked).toHaveLength(1);
		expect(app.vault.getAbstractFileByPath('Nuove/Idea.md')).toBeNull();

		plugin.ai.transport = queued(call, done).t;
		await plugin.ai.run([{ role: 'user', content: 'crea' }], 'agent', { confirm: async () => true });
		expect(app.vault.data.get('Nuove/Idea.md')).toContain('ciao');
	});

	it('aiWrites = never hides the writing tools', async () => {
		const { plugin } = await setupPlugin();
		await withModel(plugin);
		plugin.settings.aiWrites = 'never';
		const q = queued({ choices: [{ message: { content: 'ok' } }] });
		plugin.ai.transport = q.t;
		await plugin.ai.run([{ role: 'user', content: 'x' }], 'agent');
		const names = q.bodies()[0].tools.map((t: any) => t.function.name);
		expect(names).toContain('read_note');
		expect(names).not.toContain('create_note');
		expect(names).not.toContain('edit_note');
	});

	it('remembers models without tool support and degrades the agent to vault search', async () => {
		const { plugin } = await setupPlugin();
		await withModel(plugin);
		plugin.ai.transport = queued({ status: 400, body: '{"error":{"message":"tools are not supported"}}' }, { choices: [{ message: { content: 'risposta' } }] }).t;
		const r = await plugin.ai.run([{ role: 'user', content: 'x' }], 'agent');
		expect(r.text).toBe('risposta');
		expect(plugin.ai.model().noTools).toBe(true);
		const notices: string[] = [];
		const q = queued({ choices: [{ message: { content: 'ok' } }] });
		plugin.ai.transport = q.t;
		await plugin.ai.run([{ role: 'user', content: 'carbonara' }], 'agent', { onNotice: (n: string) => notices.push(n) });
		expect(notices[0]).toMatch(/strumenti/);
		expect(q.bodies()[0].tools).toBeUndefined();
	});

	it('stops looping tools after an abort', async () => {
		const { plugin } = await setupPlugin();
		await withModel(plugin);
		const ac = new AbortController();
		const call = { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_notes', arguments: '{}' } }] } }] };
		const q = queued(call, call, call);
		plugin.ai.transport = q.t;
		const r = await plugin.ai.run([{ role: 'user', content: 'x' }], 'agent', { signal: ac.signal, onToolStart: () => ac.abort() });
		expect(r.aborted).toBe(true);
		expect(q.reqs.length).toBeLessThanOrEqual(2);
	});

	it('runs a connectivity test', async () => {
		const { plugin } = await setupPlugin();
		plugin.ai.transport = queued({ choices: [{ message: { content: '<think>…</think>OK' } }] }).t;
		expect(await plugin.ai.test({ provider: 'lmstudio', model: 'x' })).toBe('OK');
	});
});
