// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { Menu, Modal } from 'obsidian';
import { FakeApp, installDomShim } from './app-fake';
import type { HttpReq, Transport } from '../src/ai/client';

installDomShim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const manifest = { id: 'ambraia', name: 'Ambraia', version: '1.0.0', dir: '.obsidian/plugins/ambraia' };
let AmbraiaPlugin: any;
let inline: typeof import('../src/ai/inline');
beforeAll(async () => {
	AmbraiaPlugin = (await import('../src/main')).default;
	inline = await import('../src/ai/inline');
});

function replying(fn: (req: HttpReq, body: any) => object | { status: number; body: string }) {
	const reqs: any[] = [];
	const t: Transport = {
		async request(req) {
			const body = req.body ? JSON.parse(req.body) : null;
			reqs.push({ ...req, json: body });
			const v: any = fn(req, body);
			if ('status' in v && 'body' in v) return { status: v.status, text: v.body };
			return { status: 200, text: JSON.stringify(v) };
		},
	};
	return { t, reqs };
}
const say = (text: string) => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });

async function setup(withModel = true) {
	document.body.innerHTML = '';
	Modal.opened = [];
	const app = new FakeApp();
	await app.vault.create('Note/Ricetta.md', '# Carbonara\nGuanciale e pecorino.');
	const plugin = new AmbraiaPlugin(app, manifest);
	await plugin.onload();
	await app.workspace.fireLayoutReady();
	if (withModel) {
		plugin.settings.aiEnabled = true;
		await plugin.ai.addModel({ provider: 'lmstudio', model: 'qwen3-8b' });
	}
	return { app, plugin };
}

describe('plugin wiring', () => {
	it('registers AI commands, views and keeps working without AI configured', async () => {
		const { plugin } = await setup(false);
		const ids = plugin.commands.map((c: any) => c.id);
		for (const id of ['ai-open-chat', 'ai-new-chat', 'ai-setup', 'ai-actions', 'ai-custom-prompt', 'ai-add-selection', 'ai-rebuild-index']) expect(ids).toContain(id);
		expect(plugin.views.has('ambraia-ai-chat')).toBe(true);
		expect(plugin.ai.ready).toBe(false);
	});

	it('settings tab shows the AI and calendar sections', async () => {
		const { plugin } = await setup();
		const tab = plugin.settingTabs[0];
		const { showSettingsPage } = (await import('obsidian')) as any;
		const text = showSettingsPage(tab, 'ai').textContent;
		expect(text).toMatch(/Aggiungi un modello/);
		expect(text).toContain('qwen3-8b');
		expect(text).toMatch(/Ricerca semantica/);
		expect(showSettingsPage(tab, 'calendar').textContent).toMatch(/Primo giorno della settimana/);
		plugin.settings.aiEnabled = false;
		const off = showSettingsPage(tab, 'ai').textContent;
		expect(off).toMatch(/Attiva l’AI/);
		expect(off).not.toMatch(/Ricerca semantica/);
	});

	it('saves and reloads settings with AI fields intact; bad values are repaired', async () => {
		const { app, plugin } = await setup();
		plugin.settings.aiDefaultMode = 'boh';
		plugin.settings.aiWrites = 'forse';
		await plugin.saveSettings();
		const p2 = new AmbraiaPlugin(app, manifest);
		p2.data = plugin.data;
		await p2.loadSettings();
		expect(p2.settings.aiModels).toHaveLength(1);
		expect(p2.settings.aiModels).not.toBe(plugin.settings.aiModels);
		expect(['chat', 'vault', 'agent']).toContain(p2.settings.aiDefaultMode);
		expect(['ask', 'auto', 'never']).toContain(p2.settings.aiWrites);
	});
});

describe('setup wizard', () => {
	it('LM Studio: zero typing, loads models, picks a chat model, saves and tests', async () => {
		const { plugin } = await setup(false);
		const r = replying((req) => (req.method === 'GET' ? { data: [{ id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'qwen3-8b' }] } : say('OK')));
		plugin.ai.transport = r.t;
		plugin.openAiSetup();
		const modal: any = Modal.opened[Modal.opened.length - 1];
		const el: HTMLElement = modal.contentEl;
		(el.querySelector('[data-provider="lmstudio"]') as HTMLElement).click();
		expect(el.textContent).toContain('LM Studio');
		expect(el.querySelector('ol.ambraia-ai-howto')).not.toBeNull();
		expect(el.querySelector<HTMLInputElement>('input[type="password"]')).toBeNull(); // no key for local
		[...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Verifica'))!.click();
		await sleep(5);
		expect(r.reqs[0].url).toBe('http://localhost:1234/v1/models');
		const sel = el.querySelector('.ambraia-ai-model.is-selected');
		expect(sel?.textContent).toBe('qwen3-8b');
		expect(el.querySelector('select')).not.toBeNull(); // embedding option offered
		[...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Salva'))!.click();
		await sleep(5);
		expect(el.textContent).toContain('Funziona');
		expect(plugin.ai.ready).toBe(true);
		expect(plugin.settings.aiModels[0]).toMatchObject({ provider: 'lmstudio', model: 'qwen3-8b' });
		expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('apri la chat'))).toBe(true);
	});

	it('cloud: requires a key, shows server errors, stores the key securely', async () => {
		const { app, plugin } = await setup(false);
		const r = replying((req) =>
			req.headers.Authorization === 'Bearer sk-giusta' ? (req.method === 'GET' ? { data: [{ id: 'gpt-4o-mini' }] } : say('OK')) : { status: 401, body: '{"error":{"message":"Incorrect API key"}}' },
		);
		plugin.ai.transport = r.t;
		plugin.openAiSetup('openai');
		const el: HTMLElement = (Modal.opened[Modal.opened.length - 1] as any).contentEl;
		const go = () => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Verifica'))!.click();
		go();
		await sleep(5);
		expect(el.querySelector('.ambraia-ai-error')?.textContent).toContain('chiave');
		const key = () => el.querySelector<HTMLInputElement>('input[type="password"]')!;
		key().value = 'sk-sbagliata';
		key().dispatchEvent(new Event('input'));
		go();
		await sleep(5);
		expect(el.querySelector('.ambraia-ai-error')).not.toBeNull();
		key().value = 'sk-giusta';
		key().dispatchEvent(new Event('input'));
		go();
		await sleep(5);
		[...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Salva'))!.click();
		await sleep(5);
		expect(el.textContent).toContain('Funziona');
		expect(plugin.ai.getKey('openai')).toBe('sk-giusta');
		expect(JSON.stringify(plugin.data)).not.toContain('sk-giusta');
		expect([...app.secrets.values()]).toContain('sk-giusta');
	});
});

describe('chat view', () => {
	async function openChat(plugin: any) {
		const v = await plugin.activateAiChat();
		expect(v).not.toBeNull();
		return v;
	}

	it('shows the setup call-to-action when no model is configured', async () => {
		const { plugin } = await setup(false);
		// AI off: the chat is not opened, the setup wizard is
		expect(await plugin.activateAiChat()).toBeNull();
		plugin.settings.aiEnabled = true;
		const v = await openChat(plugin);
		expect(v.contentEl.textContent).toContain('Collega un’AI');
	});

	it('sends a message with the active note as context, renders answer and sources, autosaves', async () => {
		const { app, plugin } = await setup();
		const note = app.vault.getAbstractFileByPath('Note/Ricetta.md');
		app.workspace.active = note as any;
		const r = replying(() => say('<think>vediamo</think>Serve il **guanciale**.'));
		plugin.ai.transport = r.t;
		const v = await openChat(plugin);
		v.mode = 'chat';
		const input: HTMLTextAreaElement = v.contentEl.querySelector('.ambraia-ai-input');
		input.value = 'Cosa serve?';
		input.dispatchEvent(new Event('input'));
		(v.contentEl.querySelector('.ambraia-ai-send') as HTMLElement).click();
		await sleep(20);
		const last = r.reqs[0].json.messages.at(-1);
		expect(last.role).toBe('user');
		expect(last.content).toContain('Guanciale e pecorino');
		expect(last.content).toContain('Cosa serve?');
		const list = v.contentEl.querySelector('.ambraia-ai-list');
		expect(list.querySelector('.is-user .ambraia-ai-bubble').textContent).toBe('Cosa serve?');
		expect(list.querySelector('.ambraia-ai-think')).not.toBeNull();
		expect(list.querySelector('.is-assistant .md-render').textContent).toBe('Serve il **guanciale**.');
		expect(input.value).toBe('');
		const saved = app.vault.getMarkdownFiles().find((f) => f.path.startsWith('Ambraia/Chat/'));
		expect(saved).toBeDefined();
		expect(String(app.vault.data.get(saved!.path))).toContain('Serve il **guanciale**.');
		// a second turn re-uses the same file and sends the previous turns as history
		await v.send('E poi?');
		await sleep(10);
		const msgs = r.reqs[1].json.messages;
		expect(msgs.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
		expect(msgs.find((m: any) => m.role === 'assistant').content).not.toContain('vediamo');
		expect(msgs.filter((m: any) => m.role === 'user' && m.content === '').length).toBe(0);
		expect(app.vault.getMarkdownFiles().filter((f) => f.path.startsWith('Ambraia/Chat/'))).toHaveLength(1);
	});

	it('reopens a saved chat from history', async () => {
		const { app, plugin } = await setup();
		plugin.ai.transport = replying(() => say('Risposta salvata')).t;
		const v = await openChat(plugin);
		await v.send('Prima domanda');
		await sleep(10);
		const file = app.vault.getMarkdownFiles().find((f) => f.path.startsWith('Ambraia/Chat/'))!;
		v.newChat();
		expect(v.entries).toHaveLength(0);
		await v.loadChat(file);
		expect(v.entries.map((e: any) => e.role)).toEqual(['user', 'assistant']);
		expect(v.contentEl.textContent).toContain('Risposta salvata');
	});

	it('shows a friendly error with retry when the server is down', async () => {
		const { plugin } = await setup();
		plugin.ai.transport = {
			request: async () => {
				throw new Error('ECONNREFUSED');
			},
		};
		const v = await openChat(plugin);
		await v.send('ciao');
		await sleep(10);
		const err = v.contentEl.querySelector('.is-error');
		expect(err).not.toBeNull();
		expect(err.textContent).toMatch(/LM Studio|server/i);
		expect([...err.querySelectorAll('button')].map((b: any) => b.textContent)).toContain('Riprova');
		plugin.ai.transport = replying(() => say('ora va')).t;
		[...err.querySelectorAll('button')].find((b: any) => b.textContent === 'Riprova')!.click();
		await sleep(10);
		expect(v.entries.filter((e: any) => e.error)).toHaveLength(0);
		expect(v.contentEl.textContent).toContain('ora va');
	});

	it('agent: tool steps stay visible and write confirmations work in the chat', async () => {
		const { app, plugin } = await setup();
		let n = 0;
		plugin.ai.transport = replying(() =>
			n++ === 0
				? { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'append_to_note', arguments: '{"path":"Note/Ricetta","content":"- pepe"}' } }] } }] }
				: say('Aggiunto il pepe.'),
		).t;
		const v = await openChat(plugin);
		v.mode = 'agent';
		const p = v.send('aggiungi il pepe alla ricetta');
		await sleep(10);
		const card = v.contentEl.querySelector('.ambraia-ai-confirm');
		expect(card).not.toBeNull();
		[...card.querySelectorAll('button')].find((b: any) => /Consenti/.test(b.textContent))!.click();
		await p;
		await sleep(10);
		expect(String(app.vault.data.get('Note/Ricetta.md'))).toContain('- pepe');
		expect(v.contentEl.querySelector('.ambraia-ai-tool.is-ok')).not.toBeNull();
		expect(v.contentEl.textContent).toContain('Aggiunto il pepe.');
	});

	it('custom prompts from the prompts folder appear in the actions', async () => {
		const { app, plugin } = await setup();
		await plugin.createSamplePrompt();
		await app.vault.create('Ambraia/Prompt/Tono formale.md', '---\nmostra-nel-menu: true\n---\nRiscrivi in tono formale: {}');
		const actions = await inline.allActions(plugin);
		const titles = actions.map((a: any) => a.title);
		expect(titles).toContain('Tono formale');
		expect(titles.length).toBeGreaterThan(5);
	});
});

describe('inline actions', () => {
	function fakeEditor(text: string, from: number, to: number) {
		let doc = text;
		const pos = (o: number) => {
			const before = doc.slice(0, o).split('\n');
			return { line: before.length - 1, ch: before[before.length - 1].length };
		};
		const off = (p: { line: number; ch: number }) => doc.split('\n').slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.ch;
		return {
			get doc() {
				return doc;
			},
			set doc(v: string) {
				doc = v;
			},
			getSelection: () => doc.slice(from, to),
			getCursor: (w: string) => pos(w === 'to' ? to : from),
			posToOffset: off,
			offsetToPos: pos,
			getValue: () => doc,
			getLine: (l: number) => doc.split('\n')[l] ?? '',
			replaceRange: (t: string, a: any, b?: any) => {
				const s = off(a);
				const e = b ? off(b) : s;
				doc = doc.slice(0, s) + t + doc.slice(e);
			},
		};
	}

	it('editorTarget replaces the selection even after the text moved', () => {
		const ed = fakeEditor('uno\ndue tre\nquattro', 4, 7);
		const t = inline.editorTarget(ed as any);
		expect(t.text).toBe('due');
		ed.doc = 'zero\n' + ed.doc; // the user typed above meanwhile
		expect(t.replace('DUE')).toBe(true);
		expect(ed.doc).toBe('zero\nuno\nDUE tre\nquattro');
	});

	it('editorTarget refuses to replace when the selection was edited', () => {
		const ed = fakeEditor('alpha beta', 0, 5);
		const t = inline.editorTarget(ed as any);
		ed.doc = 'ALFA beta';
		expect(t.replace('x')).toBe(false);
		expect(t.insertBelow('nuovo')).toBe(false);
	});

	it('editorTarget inserts below the selection or fills an empty line', () => {
		const ed = fakeEditor('titolo\ntesto', 0, 6);
		expect(inline.editorTarget(ed as any).insertBelow('AI')).toBe(true);
		expect(ed.doc).toBe('titolo\n\nAI\ntesto');
		const ed2 = fakeEditor('riga\n\naltro', 5, 5);
		expect(inline.editorTarget(ed2 as any).insertBelow('AI')).toBe(true);
		expect(ed2.doc).toBe('riga\nAI\naltro');
	});

	it('the action modal streams the answer and can replace the text', async () => {
		const { plugin } = await setup();
		const r = replying(() => say('Testo migliorato'));
		plugin.ai.transport = r.t;
		const ed = fakeEditor('testo brutto', 0, 12);
		const target = inline.editorTarget(ed as any);
		const action = (await inline.allActions(plugin))[0];
		await inline.runAiAction(plugin, action, target, null);
		await sleep(10);
		const modal: any = Modal.opened[Modal.opened.length - 1];
		expect(modal.contentEl.textContent).toContain('Testo migliorato');
		expect(r.reqs[0].json.messages.at(-1).content).toContain('testo brutto');
		[...modal.contentEl.querySelectorAll('button')].find((b: any) => b.textContent === 'Sostituisci')!.click();
		expect(ed.doc).toBe('Testo migliorato');
		expect(Modal.opened).not.toContain(modal);
	});

	it('read-only targets hide replace / insert', async () => {
		const { plugin } = await setup();
		plugin.ai.transport = replying(() => say('Riassunto')).t;
		const action = (await inline.allActions(plugin))[0];
		await inline.runAiAction(plugin, action, inline.readonlyTarget('testo letto'), null);
		await sleep(10);
		const modal: any = Modal.opened[Modal.opened.length - 1];
		const labels = [...modal.contentEl.querySelectorAll('button')].map((b: any) => b.textContent);
		expect(labels).toContain('Copia');
		expect(labels).not.toContain('Sostituisci');
	});

	it('opens the setup instead of failing when AI is not configured', async () => {
		const { plugin } = await setup(false);
		await inline.runAiAction(plugin, (await inline.allActions(plugin))[0], inline.readonlyTarget('x'), null);
		expect(Modal.opened.some((m: any) => m.modalEl.classList.contains('ambraia-ai-setup'))).toBe(true);
	});

	it('AI menu lists actions', async () => {
		const { plugin } = await setup();
		inline.showAiMenu(plugin, new MouseEvent('click'), inline.readonlyTarget('abc'), null);
		await sleep(5);
		expect((Menu as any).last.items.length).toBeGreaterThan(3);
	});
});

describe('slash menu', () => {
	it('hides AI items while AI is disabled and shows them once enabled', async () => {
		const { plugin } = await setup(false);
		const s = plugin.suggests[0];
		const ai = () => s.getSuggestions({ query: '' }).filter((i: any) => i.group === 'AI');
		plugin.settings.aiEnabled = false;
		expect(ai()).toHaveLength(0);
		plugin.settings.aiEnabled = true;
		expect(ai().length).toBeGreaterThan(3);
		const today = s.getSuggestions({ query: 'oggi' }).map((i: any) => i.id);
		expect(today).toContain('link-today');
	});
});
