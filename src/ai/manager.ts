import { ensureStateDir } from '../storage';
import { packVectors, unpackVectors } from './vectors';
import { normalizePath, Notice, Platform, requestUrl, TFile } from 'obsidian';
import { moment } from '../ui/util';
import type AmbraiaPlugin from '../main';
import { AiError, chat, ChatMsg, ChatOptions, ChatResult, embed, Endpoint, listModels, stripThinking, ToolCall, Transport } from './client';
import { AiModel, newModelId, normalizeBaseUrl, preset } from './providers';
import { chunkNote, cosine, formatContext, Hit, isExcluded, mergeHits, VaultIndex, VectorStoreData } from './retrieval';
import { buildTools, Tool, ToolContext } from './tools';
import { clip, fetchWeb, fileText, inProject, Project, readMemory } from './local';
import { tx } from '../i18n';

export type ChatMode = 'chat' | 'vault' | 'agent';

export const MODE_LABELS: Record<ChatMode, string> = {
	chat: tx('Chat'),
	vault: tx('Domande sul vault'),
	agent: tx('Agente'),
};

export interface RunEvents {
	onToken?: (t: string) => void;
	onToolStart?(id: string, label: string): void;
	onToolEnd?(id: string, ok: boolean): void;
	onNotice?(text: string): void;
	confirm?(title: string, preview: string): Promise<boolean>;
	signal?: AbortSignal;
	/** Active project: instructions, attached material and the part of the vault to search. */
	project?: Project | null;
}

export interface RunResult {
	text: string;
	sources: string[];
	aborted: boolean;
}

export const obsidianTransport: Transport = {
	request: async (req) => {
		const r = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
		return { status: r.status, text: r.text };
	},
};

const SECRET_PREFIX = 'ambraia-ai-';

/** Semantic (embedding) index stored in the state folder; never synced, survives updates. */
class SemanticIndex {
	private data: VectorStoreData | null = null;
	private saving: Promise<void> | null = null;
	busy = false;
	constructor(private ai: AiManager) {}

	private get path() {
		return `${this.ai.plugin.stateDir}/ai-index.json`;
	}

	private async load(model: string): Promise<VectorStoreData> {
		if (this.data && this.data.model === model) return this.data;
		const adapter = this.ai.plugin.app.vault.adapter;
		let d: VectorStoreData | null = null;
		try {
			if (await adapter.exists(this.path)) d = unpackVectors(JSON.parse(await adapter.read(this.path)));
		} catch {
			d = null;
		}
		this.data = d && d.model === model && d.files ? d : { model, files: {} };
		return this.data;
	}

	async save() {
		if (!this.data) return;
		const data = this.data;
		this.saving = (this.saving ?? Promise.resolve()).then(async () => {
			await ensureStateDir(this.ai.plugin.app);
			await this.ai.plugin.app.vault.adapter.write(this.path, JSON.stringify(packVectors(data)));
		});
		await this.saving;
	}

	async clear() {
		this.data = null;
		try {
			await this.ai.plugin.app.vault.adapter.remove(this.path);
		} catch {
			/* not there */
		}
	}

	count(): number {
		return this.data ? Object.keys(this.data.files).length : 0;
	}

	/** Embeds new/changed notes. Returns the number of notes processed. */
	async update(ep: Endpoint, files: TFile[], progress?: (done: number, total: number) => void): Promise<number> {
		if (this.busy) return 0;
		this.busy = true;
		try {
			const d = await this.load(ep.model);
			const keep = new Set(files.map((f) => f.path));
			for (const p of Object.keys(d.files)) if (!keep.has(p)) delete d.files[p];
			const todo = files.filter((f) => d.files[f.path]?.mtime !== f.stat.mtime);
			let done = 0;
			let sinceSave = 0;
			for (const f of todo) {
				const text = await this.ai.plugin.app.vault.cachedRead(f);
				const chunks = chunkNote(f.path, text).map((c) => `${c.title}${c.heading ? ' › ' + c.heading : ''}\n${c.text}`.slice(0, 2000));
				const vectors: number[][] = [];
				for (let i = 0; i < chunks.length; i += 16) vectors.push(...(await embed(this.ai.transport, ep, chunks.slice(i, i + 16))));
				d.files[f.path] = { mtime: f.stat.mtime, vectors };
				done++;
				progress?.(done, todo.length);
				if (++sinceSave >= 25) {
					sinceSave = 0;
					await this.save();
				}
			}
			if (todo.length || files.length !== Object.keys(d.files).length) await this.save();
			return todo.length;
		} finally {
			this.busy = false;
		}
	}

	async search(ep: Endpoint, query: string, k: number, exclude?: Set<string>): Promise<Hit[]> {
		const d = await this.load(ep.model);
		const [qv] = await embed(this.ai.transport, ep, [query]);
		const hits: Hit[] = [];
		for (const [path, f] of Object.entries(d.files)) {
			if (exclude?.has(path)) continue;
			const chunks = this.ai.index.lex.chunksOf(path);
			f.vectors.forEach((v, i) => {
				const c = chunks[i];
				if (c) hits.push({ chunk: c, score: cosine(qv, v) });
			});
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, k);
	}
}

export class AiManager {
	index: VaultIndex;
	semantic: SemanticIndex;
	transport: Transport = obsidianTransport;
	private tools: Tool[] | null = null;
	private semanticWarned = false;
	private embedTimer: number | null = null;

	constructor(public plugin: AmbraiaPlugin) {
		this.index = new VaultIndex(plugin.app, () => ({ exclude: this.excludedFolders() }));
		this.semantic = new SemanticIndex(this);
	}

	get s() {
		return this.plugin.settings;
	}

	load() {
		const { vault } = this.plugin.app;
		const dirty = () => this.index.markDirty();
		this.plugin.registerEvent(vault.on('modify', () => {
			dirty();
			// AI off (the default): no embedding work at all
			if (this.s.aiEnabled) this.scheduleEmbeddings();
		}));
		this.plugin.registerEvent(vault.on('create', dirty));
		this.plugin.registerEvent(vault.on('delete', (f) => {
			this.index.remove(f.path);
			dirty();
		}));
		this.plugin.registerEvent(vault.on('rename', (_f, old) => {
			this.index.remove(old);
			dirty();
		}));
	}

	unload() {
		if (this.embedTimer) window.clearTimeout(this.embedTimer);
	}

	excludedFolders(): string[] {
		const list = this.s.aiExclude
			.split(/[\n,]/)
			.map((x) => x.trim())
			.filter(Boolean);
		if (this.s.aiChatsFolder) list.push(this.s.aiChatsFolder);
		return list;
	}

	// ------------------------------------------------------------ keys & endpoints

	getKey(provider: string): string {
		try {
			const ss = this.plugin.app.secretStorage;
			return ss.getSecret(SECRET_PREFIX + provider) || '';
		} catch {
			return '';
		}
	}

	/** API keys live only in the OS secret storage, never in data.json. */
	async setKey(provider: string, key: string) {
		this.plugin.app.secretStorage.setSecret(SECRET_PREFIX + provider, key);
	}

	baseUrlFor(provider: string, override?: string): string {
		return normalizeBaseUrl(override || this.s.aiProviderUrls[provider] || preset(provider).baseUrl);
	}

	endpoint(m: { provider: string; model: string; baseUrl?: string }): Endpoint {
		const p = preset(m.provider);
		return { kind: p.kind, provider: p.id, baseUrl: this.baseUrlFor(p.id, m.baseUrl), apiKey: this.getKey(p.id), model: m.model };
	}

	models(): AiModel[] {
		return this.s.aiModels;
	}

	model(id?: string): AiModel | null {
		const ms = this.s.aiModels;
		return ms.find((m) => m.id === (id || this.s.aiChatModel)) ?? ms[0] ?? null;
	}

	get ready(): boolean {
		return this.s.aiEnabled && !!this.model();
	}

	async addModel(m: Omit<AiModel, 'id'>, makeDefault = true): Promise<AiModel> {
		const existing = this.s.aiModels.find((x) => x.provider === m.provider && x.model === m.model && (x.baseUrl ?? '') === (m.baseUrl ?? ''));
		const model = existing ?? { ...m, id: newModelId() };
		if (!existing) this.s.aiModels.push(model);
		if (makeDefault || !this.s.aiChatModel) this.s.aiChatModel = model.id;
		await this.plugin.saveSettings();
		return model;
	}

	async removeModel(id: string) {
		this.s.aiModels = this.s.aiModels.filter((m) => m.id !== id);
		if (this.s.aiChatModel === id) this.s.aiChatModel = this.s.aiModels[0]?.id ?? '';
		await this.plugin.saveSettings();
	}

	async listModels(provider: string, baseUrl?: string, apiKey?: string): Promise<string[]> {
		const ep = this.endpoint({ provider, model: '', baseUrl });
		if (apiKey !== undefined) ep.apiKey = apiKey;
		return listModels(this.transport, ep);
	}

	embeddingEndpoint(): Endpoint | null {
		const e = this.s.aiEmbedding;
		if (!e || !e.model) return null;
		return this.endpoint(e);
	}

	// ------------------------------------------------------------ prompting

	systemPrompt(mode: ChatMode): string {
		const lines = [
			tx('Sei Ambraia AI, l’assistente integrato in Obsidian (un’app di note in Markdown).'),
			tx('Rispondi nella lingua dell’utente, in modo chiaro e conciso, usando Markdown (titoli, elenchi, tabelle quando utili).'),
			tx('Quando citi una nota del vault usa un link wiki come [[Nome nota]].'),
			tx('Oggi è {0}. Il vault si chiama “{1}”.', moment().format(tx('dddd D MMMM YYYY, HH:mm')), this.plugin.app.vault.getName()),
		];
		if (mode === 'vault')
			lines.push(tx('Rispondi basandoti sugli estratti delle note forniti. Se le note non contengono la risposta, dillo chiaramente invece di inventare.'));
		if (mode === 'agent')
			lines.push(
				tx('Puoi usare gli strumenti per cercare, leggere, creare e modificare note. Cerca e leggi prima di rispondere a domande sulle note. Prima di modificare una nota leggila. Usa gli strumenti solo quando servono.'),
			);
		if (this.s.aiSystemPrompt.trim()) lines.push('', tx('Istruzioni dell’utente:'), this.s.aiSystemPrompt.trim());
		return lines.join('\n');
	}

	/** Memory and project material added to the system prompt (all read on the device). */
	async extraSystem(project?: Project | null): Promise<string> {
		const out: string[] = [];
		if (this.s.aiMemory) {
			const mem = await readMemory(this.plugin.app, this.s.aiMemoryFile);
			out.push(
				tx('Memoria a lungo termine (preferenze e fatti salvati in chat precedenti):\n') + (mem ? clip(mem, 4000) : '(vuota)') +
					tx('\nQuando l’utente ti chiede di ricordare qualcosa, o emerge un fatto stabile e utile su di lui, usa lo strumento update_memory.'),
			);
		}
		if (project) {
			out.push(tx('Progetto attivo: “{0}”.', project.name) + (project.instructions ? tx('\nIstruzioni del progetto:\n') + project.instructions : ''));
			const mat = await this.projectMaterial(project);
			if (mat) out.push(tx('Materiale del progetto:\n\n') + mat);
		}
		return out.join('\n\n');
	}

	/** Notes, documents and web pages listed in the project's `contesto`. */
	async projectMaterial(p: Project): Promise<string> {
		const app = this.plugin.app;
		const per = Math.max(1500, Math.floor(this.s.aiContextChars / Math.max(1, p.context.length)));
		const parts: string[] = [];
		for (const item of p.context.slice(0, 12)) {
			try {
				if (/^https?:\/\//i.test(item)) {
					if (!this.s.aiWebAccess) continue;
					const d = await fetchWeb(item);
					parts.push(tx('<pagina-web url="{0}" titolo="{1}">\n{2}\n</pagina-web>', d.url, d.title.replace(/"/g, "'"), clip(d.text, per)));
					continue;
				}
				const f = app.vault.getAbstractFileByPath(normalizePath(item)) ?? app.metadataCache.getFirstLinkpathDest(item, p.path);
				if (!(f instanceof TFile)) continue;
				parts.push(tx('<nota percorso="{0}">\n{1}\n</nota>', f.path, clip(await fileText(app, f), per)));
			} catch (e) {
				parts.push(tx('<errore elemento="{0}">{1}</errore>', item, e instanceof Error ? e.message : String(e)));
			}
		}
		return parts.join('\n\n');
	}

	private options(model: AiModel, signal?: AbortSignal, onToken?: (t: string) => void): ChatOptions {
		return {
			temperature: this.s.aiTemperature,
			maxTokens: this.s.aiMaxTokens || undefined,
			signal,
			onToken,
		};
	}

	/** Single completion (used by inline actions). */
	async complete(prompt: string, opts: { modelId?: string; signal?: AbortSignal; onToken?: (t: string) => void; system?: string } = {}): Promise<string> {
		const model = this.requireModel(opts.modelId);
		const msgs: ChatMsg[] = [
			{ role: 'system', content: opts.system ?? this.systemPrompt('chat') },
			{ role: 'user', content: prompt },
		];
		const r = await chat(this.transport, this.endpoint(model), msgs, this.options(model, opts.signal, opts.onToken));
		return stripThinking(r.text);
	}

	requireModel(id?: string): AiModel {
		const m = this.model(id);
		if (!m) throw new AiError(tx('Nessun modello AI configurato. Apri Impostazioni → Ambraia → AI e premi “Configura l’AI”.'));
		return m;
	}

	async retrieve(query: string, k = 8, exclude?: Set<string>, scope?: (path: string) => boolean): Promise<Hit[]> {
		const wide = scope ? Math.max(k * 8, 60) : Math.max(k * 2, 12);
		const keep = (h: Hit[]) => (scope ? h.filter((x) => scope(x.chunk.path)) : h);
		const lexical = keep(await this.index.search(query, wide, exclude));
		const ep = this.embeddingEndpoint();
		if (!ep) return lexical.slice(0, k);
		try {
			await this.semantic.update(ep, this.index.files());
			const sem = keep(await this.semantic.search(ep, query, wide, exclude));
			return mergeHits(lexical, sem, k);
		} catch (e) {
			if (!this.semanticWarned) {
				this.semanticWarned = true;
				new Notice(tx('Ambraia AI: ricerca semantica non disponibile, uso la ricerca per parole chiave. ') + (e instanceof Error ? e.message : ''));
			}
			return lexical.slice(0, k);
		}
	}

	scheduleEmbeddings() {
		if (!this.embeddingEndpoint()) return;
		if (this.embedTimer) window.clearTimeout(this.embedTimer);
		this.embedTimer = window.setTimeout(() => void this.runEmbeddings(), 60_000);
	}

	private async runEmbeddings() {
		this.embedTimer = null;
		const ep = this.embeddingEndpoint();
		if (!ep || Platform.isMobile) return;
		try {
			await this.semantic.update(ep, this.index.files());
		} catch {
			/* retried on next search */
		}
	}

	async rebuildIndex(progress?: (done: number, total: number) => void): Promise<string> {
		this.index.markDirty();
		await this.index.refresh();
		const ep = this.embeddingEndpoint();
		if (!ep) return tx('Indice per parole chiave aggiornato: {0} note.', this.index.files().length);
		await this.semantic.clear();
		const n = await this.semantic.update(ep, this.index.files(), progress);
		return tx('Indice semantico ricostruito: {0} note elaborate con {1}.', n, ep.model);
	}

	/** Notes related to `file` (keyword similarity + links). */
	async relevantNotes(file: TFile, k = 8): Promise<{ file: TFile; score: number; reason: string }[]> {
		const app = this.plugin.app;
		const content = await app.vault.cachedRead(file);
		const cache = app.metadataCache.getFileCache(file);
		const query = [file.basename, ...(cache?.headings ?? []).map((h) => h.heading), content.replace(/^---[\s\S]*?---/, '').slice(0, 1500)].join(' ');
		const hits = await this.retrieve(query, k * 3, new Set([file.path]));
		const scores = new Map<string, { score: number; reason: string }>();
		const max = Math.max(1e-9, ...hits.map((h) => h.score));
		for (const h of hits) {
			const prev = scores.get(h.chunk.path);
			const s = h.score / max;
			if (!prev || prev.score < s) scores.set(h.chunk.path, { score: s, reason: tx('contenuto simile') });
		}
		const links = (app.metadataCache as unknown as { resolvedLinks?: Record<string, Record<string, number>> }).resolvedLinks ?? {};
		for (const p of Object.keys(links[file.path] ?? {})) {
			const prev = scores.get(p);
			scores.set(p, { score: (prev?.score ?? 0) + 0.3, reason: prev ? tx('collegata e simile') : 'collegata' });
		}
		for (const [src, targets] of Object.entries(links)) {
			if (!targets[file.path] || src === file.path) continue;
			const prev = scores.get(src);
			scores.set(src, { score: (prev?.score ?? 0) + 0.3, reason: prev ? tx('la cita ed è simile') : tx('la cita') });
		}
		const ex = this.excludedFolders();
		return [...scores.entries()]
			.map(([p, v]) => ({ file: app.vault.getAbstractFileByPath(p), ...v }))
			.filter((x): x is { file: TFile; score: number; reason: string } => x.file instanceof TFile && x.file.extension === 'md' && !isExcluded(x.file.path, ex))
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}

	// ------------------------------------------------------------ chat / agent

	getTools(): Tool[] {
		return (this.tools ??= buildTools(this.plugin));
	}

	/**
	 * Runs one assistant turn. `history` holds the conversation (user/assistant messages, possibly with context already
	 * prepended to the last user message). Streaming tokens are reported through `ev.onToken`.
	 */
	async run(history: ChatMsg[], mode: ChatMode, ev: RunEvents = {}, modelId?: string): Promise<RunResult> {
		const model = this.requireModel(modelId);
		const ep = this.endpoint(model);
		const sources = new Set<string>();
		const lastUser = [...history].reverse().find((m) => m.role === 'user');
		let effective: ChatMode = mode;
		if (mode === 'agent' && model.noTools) {
			effective = 'vault';
			ev.onNotice?.(tx('Questo modello non supporta gli strumenti: uso la ricerca nel vault.'));
		}

		const project = ev.project ?? null;
		const scope = project && (project.folders.length || project.tags.length) ? (p: string) => inProject(this.plugin.app, project, p) : undefined;
		const extra = await this.extraSystem(project);
		const msgs: ChatMsg[] = [{ role: 'system', content: this.systemPrompt(effective) + (extra ? '\n\n' + extra : '') }, ...history];
		if (effective === 'vault' && lastUser) {
			const hits = await this.retrieve(lastUser.content, this.s.aiVaultTopK, undefined, scope);
			for (const h of hits) sources.add(h.chunk.path);
			const ctx = formatContext(hits, this.s.aiContextChars);
			msgs.splice(msgs.length - 1, 0, {
				role: 'system',
				content: ctx ? tx('Estratti pertinenti dalle note dell’utente:\n\n{0}', ctx) : tx('Nessuna nota pertinente trovata nel vault.'),
			});
		}

		const opts = this.options(model, ev.signal, ev.onToken);
		const isAbort = (e: unknown) => (e instanceof AiError && e.status === -1) || !!ev.signal?.aborted;
		if (effective !== 'agent') {
			try {
				const r = await chat(this.transport, ep, msgs, opts);
				return { text: r.text, sources: [...sources], aborted: r.finish === 'aborted' || !!ev.signal?.aborted };
			} catch (e) {
				if (isAbort(e)) return { text: '', sources: [...sources], aborted: true };
				throw e;
			}
		}

		const tools = this.getTools();
		const touched = new Set<string>();
		const ctx: ToolContext = {
			plugin: this.plugin,
			touched,
			scope,
			confirm: async (title, preview) => {
				if (this.s.aiWrites === 'never') return false;
				if (this.s.aiWrites === 'auto') return true;
				return ev.confirm ? ev.confirm(title, preview) : false;
			},
		};
		const usable = tools.filter((t) => !(t.writes && this.s.aiWrites === 'never') && (!t.available || t.available(this.plugin)));
		const defs = usable.map((t) => t.def);
		let text = '';
		for (let round = 0; round < 10; round++) {
			const all = () => [...new Set([...sources, ...touched])];
			if (ev.signal?.aborted) return { text, sources: all(), aborted: true };
			let r: ChatResult;
			try {
				r = await chat(this.transport, ep, msgs, { ...opts, tools: model.noTools ? undefined : defs });
			} catch (e) {
				if (isAbort(e)) return { text, sources: all(), aborted: true };
				throw e;
			}
			text += r.text;
			if (r.toolsDropped) {
				model.noTools = true;
				await this.plugin.saveSettings();
				if (!r.text.trim()) ev.onNotice?.(tx('Il modello non supporta gli strumenti.'));
			}
			if (!r.toolCalls.length || r.finish === 'aborted' || ev.signal?.aborted) {
				return { text, sources: [...new Set([...sources, ...touched])], aborted: r.finish === 'aborted' || !!ev.signal?.aborted };
			}
			msgs.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls });
			for (const call of r.toolCalls) {
				msgs.push({ role: 'tool', toolCallId: call.id, name: call.name, content: await this.runTool(call, usable, ctx, ev) });
			}
			if (r.text && !r.text.endsWith('\n')) {
				text += '\n\n';
				ev.onToken?.('\n\n');
			}
		}
		return { text: text + tx('\n\n_(interrotto: troppi passaggi)_'), sources: [...new Set([...sources, ...touched])], aborted: false };
	}

	private async runTool(call: ToolCall, tools: Tool[], ctx: ToolContext, ev: RunEvents): Promise<string> {
		const tool = tools.find((t) => t.def.name === call.name);
		let args: Record<string, unknown> = {};
		try {
			args = call.args.trim() ? (JSON.parse(call.args) as Record<string, unknown>) : {};
		} catch {
			ev.onToolStart?.(call.id, tx('Strumento “{0}” con argomenti non validi', call.name));
			ev.onToolEnd?.(call.id, false);
			return tx('Errore: argomenti JSON non validi.');
		}
		if (!tool) {
			ev.onToolStart?.(call.id, tx('Strumento sconosciuto “{0}”', call.name));
			ev.onToolEnd?.(call.id, false);
			return tx('Errore: lo strumento {0} non esiste.', call.name);
		}
		ev.onToolStart?.(call.id, tool.describe(args));
		try {
			const out = await tool.run(args, ctx);
			ev.onToolEnd?.(call.id, !/^(Errore|Nota non trovata|L’utente ha rifiutato)/.test(out));
			return out;
		} catch (e) {
			ev.onToolEnd?.(call.id, false);
			return tx('Errore: ') + (e instanceof Error ? e.message : String(e));
		}
	}

	/** Quick connectivity test: returns the model's answer. */
	async test(m: { provider: string; model: string; baseUrl?: string }, apiKey?: string): Promise<string> {
		const ep = this.endpoint(m);
		if (apiKey !== undefined) ep.apiKey = apiKey;
		const r = await chat(this.transport, ep, [{ role: 'user', content: tx('Rispondi solo con la parola: OK') }], { maxTokens: 400 });
		return stripThinking(r.text) || tx('(risposta vuota)');
	}
}
