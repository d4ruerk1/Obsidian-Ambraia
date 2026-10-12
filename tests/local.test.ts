// @vitest-environment jsdom
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeApp, installDomShim } from './app-fake';
import { fetchWeb, fileText, htmlToText, inProject, jsonAt, listProjects, parseProject, remember, setNet, unzip, webSearch, youtubeId, Net, NetRes } from '../src/ai/local';
import { chatToMarkdown, markdownToChat } from '../src/ai/chatView';
import type { HttpReq, Transport } from '../src/ai/client';

installDomShim();

const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
});

/** Builds a real ZIP archive (deflate) like Word/PowerPoint/Excel do. */
function zip(files: Record<string, string>, store = false): ArrayBuffer {
	const enc = new TextEncoder();
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let off = 0;
	for (const [name, text] of Object.entries(files)) {
		const raw = Buffer.from(enc.encode(text));
		const data = store ? raw : deflateRawSync(raw);
		const n = Buffer.from(name);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(store ? 0 : 8, 8);
		lh.writeUInt32LE(data.length, 18);
		lh.writeUInt32LE(raw.length, 22);
		lh.writeUInt16LE(n.length, 26);
		locals.push(lh, n, data);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(store ? 0 : 8, 10);
		ch.writeUInt32LE(data.length, 20);
		ch.writeUInt32LE(raw.length, 24);
		ch.writeUInt16LE(n.length, 28);
		ch.writeUInt32LE(off, 42);
		central.push(ch, n);
		off += 30 + n.length + data.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(off, 16);
	const all = Buffer.concat([...locals, cd, end]);
	return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

/** Fake network: routes by URL substring. */
function fakeNet(routes: Record<string, Partial<NetRes> | ((url: string, init?: any) => Partial<NetRes>)>) {
	const calls: { url: string; init?: any }[] = [];
	const n: Net = async (url, init) => {
		calls.push({ url, init });
		const key = Object.keys(routes).find((k) => url.includes(k));
		if (!key) return { status: 404, text: 'not found', headers: {} };
		const r = routes[key];
		const v = typeof r === 'function' ? r(url, init) : r;
		return { status: 200, text: '', headers: {}, ...v };
	};
	setNet(n);
	return calls;
}
afterEach(() => {
	(globalThis as any).__pdfjs = undefined;
});

function fakePdf(pages: string[][]) {
	(globalThis as any).__pdfjs = {
		getDocument: () => ({
			promise: Promise.resolve({
				numPages: pages.length,
				getPage: async (i: number) => ({ getTextContent: async () => ({ items: pages[i - 1].map((str) => ({ str, hasEOL: true })) }) }),
				destroy: () => undefined,
			}),
		}),
	};
}

describe('documents (local extraction)', () => {
	it('reads stored and deflated ZIP entries', async () => {
		for (const store of [true, false]) {
			const m = await unzip(zip({ 'a.txt': 'ciao àèì', 'b/c.xml': '<x/>' }, store), (n) => n === 'a.txt');
			expect([...m.keys()]).toEqual(['a.txt']);
			expect(m.get('a.txt')).toBe('ciao àèì');
		}
		await expect(unzip(new ArrayBuffer(40), () => true)).rejects.toThrow(/danneggiato/);
	});

	it('extracts Word, PowerPoint, Excel, OpenDocument, EPUB, canvas and PDF text', async () => {
		const app = new FakeApp();
		const bin = async (path: string, buf: ArrayBuffer) => app.vault.createBinary(path, buf);
		await bin('d.docx', zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Primo</w:t></w:r><w:r><w:tab/><w:t>paragrafo &amp; co</w:t></w:r></w:p><w:p><w:r><w:t>Secondo</w:t></w:r></w:p></w:body></w:document>' }));
		await bin('s.pptx', zip({ 'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Due</a:t></a:r></a:p></p:sld>', 'ppt/slides/slide10.xml': '<a:p><a:t>Dieci</a:t></a:p>', 'ppt/slides/slide1.xml': '<a:p><a:t>Uno</a:t></a:p>' }));
		await bin('x.xlsx', zip({
			'xl/sharedStrings.xml': '<sst><si><t>Nome</t></si><si><t>Mario</t></si></sst>',
			'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Età</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
		}));
		await bin('o.odt', zip({ 'content.xml': '<office:text><text:h>Titolo</text:h><text:p>Testo<text:line-break/>a capo</text:p></office:text>' }));
		await bin('l.epub', zip({ 'OEBPS/ch2.xhtml': '<html><body><p>Capitolo due</p></body></html>', 'OEBPS/ch1.xhtml': '<html><body><h1>Inizio</h1></body></html>' }));
		await app.vault.create('m.canvas', JSON.stringify({ nodes: [{ type: 'text', text: 'Idea centrale' }, { type: 'file', file: 'Nota.md' }, { type: 'link', url: 'https://ex.it' }] }));
		await bin('p.pdf', new ArrayBuffer(8));
		fakePdf([['Ciao', 'mondo'], ['Seconda']]);
		const t = async (p: string) => fileText(app as any, app.vault.getAbstractFileByPath(p) as any);
		expect(await t('d.docx')).toBe('Primo\tparagrafo & co\nSecondo'.replace('\t', ' '));
		const ppt = await t('s.pptx');
		expect(ppt.indexOf('Uno')).toBeLessThan(ppt.indexOf('Due'));
		expect(ppt.indexOf('Due')).toBeLessThan(ppt.indexOf('Dieci'));
		expect(await t('x.xlsx')).toContain('Nome | Età\nMario | 42');
		expect(await t('o.odt')).toBe('Titolo\nTesto\na capo');
		const ep = await t('l.epub');
		expect(ep.indexOf('Inizio')).toBeLessThan(ep.indexOf('Capitolo due'));
		expect(await t('m.canvas')).toBe('Idea centrale\n\n[[Nota.md]]\n\nhttps://ex.it');
		expect(await t('p.pdf')).toBe('[Pagina 1]\nCiao\nmondo\n\n[Pagina 2]\nSeconda');
	});

	it('says when a document has no extractable text', async () => {
		const app = new FakeApp();
		await app.vault.createBinary('scan.pdf', new ArrayBuffer(8));
		fakePdf([['']]);
		expect(await fileText(app as any, app.vault.getAbstractFileByPath('scan.pdf') as any)).toMatch(/nessun testo estraibile/);
	});
});

describe('web (local fetch)', () => {
	it('turns HTML into readable Markdown-like text', () => {
		const h = htmlToText('<html><head><title>T</title><script>evil()</script></head><body><nav>menu</nav><article><h2>Sezione</h2><p>Uno <b>due</b></p><ul><li>a</li><li>b</li></ul></article><footer>f</footer></body></html>');
		expect(h.title).toBe('T');
		expect(h.text).toBe('## Sezione\n\nUno due\n\n- a\n- b');
	});

	it('recognises YouTube links and parses JSON inside a page', () => {
		for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=3', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ'])
			expect(youtubeId(u)).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://example.com/watch?v=1')).toBeNull();
		const s = 'x = {"a":"}{\\"]","b":[1,{"c":2}]}; rest';
		expect(jsonAt(s, 4)).toEqual({ a: '}{"]', b: [1, { c: 2 }] });
	});

	it('reads a YouTube transcript from public captions', async () => {
		const player = { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en', languageCode: 'en' }, { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=it', languageCode: 'it', kind: 'asr' }] };
		const calls = fakeNet({
			'watch?v=': { text: `<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"Lezione","author":"Prof"},"captions":{"playerCaptionsTracklistRenderer":${JSON.stringify(player)}}};</script>` },
			timedtext: { text: JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'Ciao' }] }, { tStartMs: 5000, segs: [{ utf8: 'a tutti' }] }, { tStartMs: 65000, segs: [{ utf8: 'dopo un minuto' }] }] }) },
		});
		const d = await fetchWeb('https://youtu.be/abcdefghijk');
		expect(d.kind).toBe('youtube');
		expect(d.title).toBe('Lezione – Prof');
		expect(d.text).toContain('[0:00] Ciao a tutti');
		expect(d.text).toContain('[1:05] dopo un minuto');
		expect(d.text).toContain('(it, automatica)');
		expect(calls[1].url).toContain('lang=it');
		expect(calls[1].url).toContain('fmt=json3');
	});

	it('explains when a video has no captions', async () => {
		fakeNet({ 'watch?v=': { text: '<html>nothing</html>' } });
		await expect(fetchWeb('https://www.youtube.com/watch?v=zzzzzzzzzzz')).rejects.toThrow(/sottotitoli/);
	});

	it('reads X posts, web pages and online PDFs; caches pages; reports HTTP errors', async () => {
		fakePdf([['Contenuto PDF']]);
		const calls = fakeNet({
			'publish.twitter.com': { text: JSON.stringify({ author_name: 'Ada', html: '<blockquote><p>Ciao dal post</p></blockquote>' }) },
			'esempio.it/pagina': { text: '<html><head><title>Pagina</title></head><body><main><p>Testo utile</p></main></body></html>', headers: { 'content-type': 'text/html' } },
			'esempio.it/doc.pdf': { arrayBuffer: new ArrayBuffer(4), headers: { 'content-type': 'application/pdf' } },
			'esempio.it/errore': { status: 500 },
		});
		const x = await fetchWeb('https://x.com/ada/status/123');
		expect(x.title).toBe('Post di Ada');
		expect(x.text).toBe('Ciao dal post');
		const p = await fetchWeb('https://esempio.it/pagina).');
		expect(p.title).toBe('Pagina');
		expect(p.text).toBe('Testo utile');
		await fetchWeb('https://esempio.it/pagina');
		expect(calls.filter((c) => c.url.includes('pagina'))).toHaveLength(1);
		const pdf = await fetchWeb('esempio.it/doc.pdf');
		expect(pdf.kind).toBe('pdf');
		expect(pdf.text).toContain('Contenuto PDF');
		await expect(fetchWeb('https://esempio.it/errore')).rejects.toThrow(/HTTP 500/);
	});

	it('searches DuckDuckGo (no key) and SearXNG; refuses when off', async () => {
		const ddg = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fit.wikipedia.org%2Fwiki%2FRoma&amp;rut=x">Roma - <b>Wikipedia</b></a><a class="result__snippet" href="#">Capitale d&#39;Italia</a></div>
		<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads">Pubblicità</a><a class="result__snippet">ad</a></div>`;
		const calls = fakeNet({ 'html.duckduckgo.com': { text: ddg }, 'localhost:8888/search': { text: JSON.stringify({ results: [{ title: 'R', url: 'https://r.it', content: 'c' }] }) } });
		const hits = await webSearch({ aiWebSearch: 'duckduckgo', aiSearxngUrl: '' }, 'roma');
		expect(hits).toEqual([{ title: 'Roma - Wikipedia', url: 'https://it.wikipedia.org/wiki/Roma', snippet: "Capitale d'Italia" }]);
		expect(calls[0].init.method).toBe('POST');
		expect(await webSearch({ aiWebSearch: 'searxng', aiSearxngUrl: 'http://localhost:8888/' }, 'roma')).toEqual([{ title: 'R', url: 'https://r.it', snippet: 'c' }]);
		expect(calls[1].url).toBe('http://localhost:8888/search?format=json&q=roma');
		await expect(webSearch({ aiWebSearch: 'off', aiSearxngUrl: '' }, 'x')).rejects.toThrow(/disattivata/);
		await expect(webSearch({ aiWebSearch: 'searxng', aiSearxngUrl: '' }, 'x')).rejects.toThrow(/SearXNG/);
	});
});

describe('memory and projects', () => {
	it('remember() creates the memory note and appends dated lines', async () => {
		const app = new FakeApp();
		await remember(app as any, 'Ambraia/Memoria.md', 'Preferisce risposte brevi\n', '2026-10-02');
		await remember(app as any, 'Ambraia/Memoria.md', 'Lavora a Roma', '2026-10-03');
		const md = String(app.vault.data.get('Ambraia/Memoria.md'));
		expect(md).toContain('- Preferisce risposte brevi _(2026-10-02)_\n- Lavora a Roma _(2026-10-03)_\n');
	});

	it('parses project notes and scopes them by folder and tag', async () => {
		const app = new FakeApp();
		await app.vault.create('Ambraia/Progetti/Tesi.md', '---\ncartelle: [Università/]\ntag: "#tesi, lettura"\ncontesto: ["[[Brief]]", "https://ex.it"]\nmodello: qwen3\nmodalita: vault\n---\nSei il mio relatore.');
		await app.vault.create('Università/Cap1.md', 'uno');
		await app.vault.create('Altro/Libro.md', '---\ntags: [lettura/saggi]\n---\nlibro');
		await app.vault.create('Altro/Spesa.md', 'latte #casa');
		const [p] = await listProjects(app as any, 'Ambraia/Progetti');
		expect(p).toMatchObject({ name: 'Tesi', folders: ['Università'], tags: ['tesi', 'lettura'], context: ['Brief', 'https://ex.it'], model: 'qwen3', mode: 'vault', instructions: 'Sei il mio relatore.' });
		expect(inProject(app as any, p, 'Università/Cap1.md')).toBe(true);
		expect(inProject(app as any, p, 'Altro/Libro.md')).toBe(true);
		expect(inProject(app as any, p, 'Altro/Spesa.md')).toBe(false);
		expect(inProject(app as any, parseProject('x.md', 'solo istruzioni'), 'Altro/Spesa.md')).toBe(true);
	});

	it('chat notes keep project and web links', () => {
		const md = chatToMarkdown(
			[
				{ role: 'user', content: 'x', display: 'leggi', context: ['Note/A.md', 'Doc/b.pdf', 'https://ex.it/p'] },
				{ role: 'assistant', content: 'fatto' },
			],
			{ mode: 'chat', model: 'm', created: '2026-10-02 10:00', project: 'Ambraia/Progetti/Tesi.md' },
		);
		const back = markdownToChat(md);
		expect(back.project).toBe('Ambraia/Progetti/Tesi.md');
		expect(back.entries[0].context).toEqual(['Note/A.md', 'Doc/b.pdf', 'https://ex.it/p']);
	});
});

function queued(...answers: object[]) {
	const reqs: HttpReq[] = [];
	const t: Transport = {
		async request(req) {
			reqs.push(req);
			const a = answers.shift();
			if (!a) throw new Error('no more answers');
			return { status: 200, text: JSON.stringify(a) };
		},
	};
	return { t, bodies: () => reqs.map((r) => JSON.parse(r.body ?? 'null')) };
}
const say = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const call = (name: string, args: object) => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'c' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });

async function setup() {
	document.body.innerHTML = '';
	const app = new FakeApp();
	await app.vault.create('Lavoro/Budget.md', 'Il budget del progetto è di 5000 euro.');
	await app.vault.create('Casa/Budget casa.md', 'Il budget per la casa è di 300 euro.');
	const plugin = new AmbraiaPlugin(app, manifest);
	await plugin.onload();
	await app.workspace.fireLayoutReady();
	plugin.settings.aiEnabled = true;
	await plugin.ai.addModel({ provider: 'lmstudio', model: 'qwen3' });
	return { app, plugin };
}

describe('AI with local Plus features', () => {
	it('offers web tools only when enabled', async () => {
		const { plugin } = await setup();
		const q = queued(say('ok'));
		plugin.ai.transport = q.t;
		await plugin.ai.run([{ role: 'user', content: 'ciao' }], 'agent');
		let names = q.bodies()[0].tools.map((t: any) => t.function.name);
		expect(names).toContain('read_web_page');
		expect(names).not.toContain('web_search');
		expect(names).not.toContain('update_memory');
		plugin.settings.aiWebSearch = 'duckduckgo';
		plugin.settings.aiMemory = true;
		plugin.settings.aiWebAccess = false;
		const q2 = queued(say('ok'));
		plugin.ai.transport = q2.t;
		await plugin.ai.run([{ role: 'user', content: 'ciao' }], 'agent');
		names = q2.bodies()[0].tools.map((t: any) => t.function.name);
		expect(names).toEqual(expect.arrayContaining(['web_search', 'update_memory']));
		expect(names).not.toContain('read_web_page');
	});

	it('memory is injected and updated without confirmation', async () => {
		const { app, plugin } = await setup();
		plugin.settings.aiMemory = true;
		await app.vault.create('Ambraia/Memoria.md', '- Si chiama Errolhan');
		const q = queued(call('update_memory', { fact: 'Preferisce il tu' }), say('Ricordato.'));
		plugin.ai.transport = q.t;
		const r = await plugin.ai.run([{ role: 'user', content: 'ricorda che preferisco il tu' }], 'agent', { confirm: async () => false });
		expect(r.text).toBe('Ricordato.');
		expect(q.bodies()[0].messages[0].content).toContain('Si chiama Errolhan');
		expect(String(app.vault.data.get('Ambraia/Memoria.md'))).toContain('Preferisce il tu');
	});

	it('a project adds instructions and material and limits the vault search', async () => {
		const { app, plugin } = await setup();
		await app.vault.create('Lavoro/Brief.md', 'Cliente: ACME.');
		await app.vault.create('Ambraia/Progetti/Lavoro.md', '---\ncartelle: [Lavoro]\ncontesto: ["[[Brief]]"]\n---\nRispondi come un consulente.');
		const [project] = await listProjects(app as any, 'Ambraia/Progetti');
		const q = queued(say('5000 euro'));
		plugin.ai.transport = q.t;
		const r = await plugin.ai.run([{ role: 'user', content: 'qual è il budget?' }], 'vault', { project });
		const sys = q.bodies()[0].messages[0].content;
		expect(sys).toContain('Rispondi come un consulente.');
		expect(sys).toContain('Cliente: ACME.');
		expect(r.sources).toContain('Lavoro/Budget.md');
		expect(r.sources).not.toContain('Casa/Budget casa.md');
	});

	it('agent reads documents and web pages through tools', async () => {
		const { app, plugin } = await setup();
		await app.vault.createBinary('Doc/offerta.docx', zip({ 'word/document.xml': '<w:p><w:t>Prezzo 99</w:t></w:p>' }));
		fakeNet({ 'ex.it': { text: '<html><body><p>Notizia del giorno</p></body></html>', headers: { 'content-type': 'text/html' } } });
		const q = queued(call('read_note', { path: 'Doc/offerta.docx' }), call('read_web_page', { url: 'https://ex.it/n' }), say('fatto'));
		plugin.ai.transport = q.t;
		await plugin.ai.run([{ role: 'user', content: 'leggi' }], 'agent');
		const msgs = q.bodies()[2].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
		expect(msgs[0]).toContain('Prezzo 99');
		expect(msgs[1]).toContain('Notizia del giorno');
	});

	it('chat attaches pasted links and linked documents', async () => {
		const { app, plugin } = await setup();
		await app.vault.createBinary('Doc/slide.pptx', zip({ 'ppt/slides/slide1.xml': '<a:p><a:t>Obiettivi 2027</a:t></a:p>' }));
		fakeNet({ 'ex.it': { text: '<html><body><p>Articolo</p></body></html>', headers: { 'content-type': 'text/html' } } });
		const v: any = await plugin.activateAiChat();
		v.includeActive = false;
		const q = queued(say('ok'));
		plugin.ai.transport = q.t;
		await v.send('riassumi https://ex.it/a e [[slide.pptx]]');
		const last = q.bodies()[0].messages.at(-1).content;
		expect(last).toContain('Articolo');
		expect(last).toContain('Obiettivi 2027');
		expect(v.entries[0].context).toEqual(['Doc/slide.pptx', 'https://ex.it/a']);
	});

	it('state lives in the plugin folder (removed with it); a legacy settings backup is adopted', async () => {
		const app = new FakeApp();
		await app.vault.adapter.write('.obsidian/plugins/ambraia/sync-state.json', '{"files":{}}');
		await app.vault.adapter.write('.obsidian/ambraia/settings.json', JSON.stringify({ aiChatsFolder: 'Vecchie/Chat', pinned: ['A.md'] }));
		const plugin = new AmbraiaPlugin(app, manifest);
		plugin.data = null;
		await plugin.onload();
		// state files move into the plugin's own state folder
		expect(await app.vault.adapter.exists('.obsidian/plugins/ambraia/sync-state.json')).toBe(false);
		expect(await app.vault.adapter.exists('.obsidian/plugins/ambraia/state/sync-state.json')).toBe(true);
		// the backup left outside the plugin folder by 1.0 is restored once
		expect(plugin.settings.aiChatsFolder).toBe('Vecchie/Chat');
		expect(plugin.settings.pinned).toEqual(['A.md']);
		await plugin.saveSettings();
		// only what differs from the defaults is saved, and no copy is left outside the plugin folder
		expect(Object.keys(plugin.data).sort()).toEqual(['aiChatsFolder', 'pinned']);
		expect(await app.vault.adapter.exists('.obsidian/plugins/ambraia/state/settings.json')).toBe(false);
	});

});
