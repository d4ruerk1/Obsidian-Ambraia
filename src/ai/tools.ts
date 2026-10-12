import { normalizePath, TFile, TFolder } from 'obsidian';
import { moment } from '../ui/util';
import type AmbraiaPlugin from '../main';
import { createPeriodic, dailyConfig, findPeriodic } from '../calendar/dates';
import type { ToolDef } from './client';
import { fetchWeb, fileText, isReadable, remember, webSearch } from './local';
import { tx } from '../i18n';
import { markAiContent } from './marking';

/** Tool arguments come from the model as JSON: read a text value without "[object Object]". */
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

export interface ToolContext {
	plugin: AmbraiaPlugin;
	/** Asks the user to approve a change. Resolves true if allowed. */
	confirm(title: string, preview: string): Promise<boolean>;
	/** Paths read or written during the run (shown as sources). */
	touched: Set<string>;
	/** Limits vault searches to the active project. */
	scope?: (path: string) => boolean;
}

export interface Tool {
	def: ToolDef;
	writes?: boolean;
	/** Offered to the model only when this returns true (e.g. web search enabled). */
	available?(plugin: AmbraiaPlugin): boolean;
	/** Short Italian description of a call, shown in the chat. */
	describe(args: Record<string, unknown>): string;
	run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const MAX_READ = 14000;

function resolveNote(plugin: AmbraiaPlugin, p: string): TFile | null {
	if (!p) return null;
	const app = plugin.app;
	const clean = p.trim().replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '');
	const direct = app.vault.getAbstractFileByPath(normalizePath(clean));
	if (direct instanceof TFile) return direct;
	const withExt = app.vault.getAbstractFileByPath(normalizePath(clean.replace(/\.md$/i, '') + '.md'));
	if (withExt instanceof TFile) return withExt;
	return app.metadataCache.getFirstLinkpathDest(clean.replace(/\.md$/i, ''), '') ?? null;
}

function obj(props: Record<string, unknown>, required: string[] = []) {
	return { type: 'object', properties: props, required };
}

async function ensureFolder(plugin: AmbraiaPlugin, path: string) {
	const app = plugin.app;
	const dir = path.split('/').slice(0, -1).join('/');
	if (!dir || app.vault.getAbstractFileByPath(dir)) return;
	let cur = '';
	for (const part of dir.split('/')) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
	}
}

function preview(s: string, n = 1200) {
	return s.length > n ? s.slice(0, n) + '\n…' : s;
}

export function buildTools(plugin: AmbraiaPlugin): Tool[] {
	const app = plugin.app;
	return [
		{
			def: {
				name: 'search_notes',
				description: tx('Cerca nel vault dell’utente le note più pertinenti a una richiesta. Restituisce percorsi ed estratti.'),
				parameters: obj({ query: { type: 'string', description: tx('Parole chiave o domanda') }, limit: { type: 'number', description: tx('Numero massimo di risultati (default 6)') } }, ['query']),
			},
			describe: (a) => tx('Cerco nel vault “{0}”', a.query ?? ''),
			run: async (a, ctx) => {
				const hits = await plugin.ai.retrieve(str(a.query), Math.min(12, Number(a.limit) || 6), undefined, ctx.scope);
				if (!hits.length) return tx('Nessuna nota trovata.');
				return hits
					.map((h) => {
						ctx.touched.add(h.chunk.path);
						return `- ${h.chunk.path}${h.chunk.heading ? ' › ' + h.chunk.heading : ''}\n  ${h.chunk.text.slice(0, 400).replace(/\n+/g, ' ')}`;
					})
					.join('\n');
			},
		},
		{
			def: {
				name: 'read_note',
				description: tx('Legge il contenuto completo di una nota o di un documento del vault (PDF, Word, PowerPoint, Excel, OpenDocument, EPUB, canvas) dato il percorso o il nome.'),
				parameters: obj({ path: { type: 'string', description: tx('Percorso (es. Cartella/Nota.md) o nome della nota') } }, ['path']),
			},
			describe: (a) => tx('Leggo “{0}”', a.path ?? ''),
			run: async (a, ctx) => {
				const f = resolveNote(plugin, str(a.path));
				if (!f) return tx('Nota non trovata: {0}', a.path);
				if (!isReadable(f)) return tx('Non so leggere i file .{0}.', f.extension);
				ctx.touched.add(f.path);
				const c = await fileText(app, f);
				return tx('Percorso: {0}\n\n{1}', f.path, c.length > MAX_READ ? c.slice(0, MAX_READ) + tx('\n…(troncato)') : c);
			},
		},
		{
			def: {
				name: 'list_notes',
				description: tx('Elenca note e sottocartelle di una cartella del vault (cartella vuota = radice).'),
				parameters: obj({ folder: { type: 'string', description: tx('Percorso della cartella') } }),
			},
			describe: (a) => tx('Guardo la cartella “{0}”', a.folder || '/'),
			run: async (a) => {
				const p = str(a.folder).replace(/^\/+|\/+$/g, '');
				const f = p ? app.vault.getAbstractFileByPath(p) : app.vault.getRoot();
				if (!(f instanceof TFolder)) return tx('Cartella non trovata: {0}', p);
				const lines = f.children
					.slice()
					.sort((x, y) => x.name.localeCompare(y.name))
					.slice(0, 300)
					.map((c) => (c instanceof TFolder ? `📁 ${c.path}/` : `📄 ${c.path}`));
				return lines.join('\n') || tx('(cartella vuota)');
			},
		},
		{
			def: {
				name: 'get_daily_note',
				description: tx('Restituisce la nota del giorno (diario) per una data. Utile per agenda, attività e resoconti.'),
				parameters: obj({ date: { type: 'string', description: tx('Data AAAA-MM-GG; vuoto = oggi') } }),
			},
			describe: (a) => tx('Apro la nota del giorno {0}', a.date || tx('di oggi')),
			run: async (a, ctx) => {
				const d = a.date ? moment(str(a.date), 'YYYY-MM-DD', true) : moment();
				if (!d.isValid()) return tx('Data non valida, usa AAAA-MM-GG.');
				const cfg = dailyConfig(app, plugin.settings);
				const f = findPeriodic(app, cfg, d);
				const tasks = await plugin.tasksOn(d.format('YYYY-MM-DD'));
				const taskText = tasks.length ? tx('\n\nAttività con scadenza in questa data:\n') + tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text} (${t.file.path})`).join('\n') : '';
				if (!f) return tx('Non esiste ancora una nota del giorno per {0}.{1}', d.format('YYYY-MM-DD'), taskText);
				ctx.touched.add(f.path);
				return tx('Percorso: {0}\n\n{1}{2}', f.path, (await app.vault.cachedRead(f)).slice(0, MAX_READ), taskText);
			},
		},
		{
			def: {
				name: 'create_note',
				description: tx('Crea una nuova nota Markdown. Usa percorsi relativi al vault, ad esempio "Progetti/Idea.md".'),
				parameters: obj({ path: { type: 'string' }, content: { type: 'string', description: tx('Contenuto Markdown') } }, ['path', 'content']),
			},
			writes: true,
			describe: (a) => tx('Creo la nota “{0}”', a.path ?? ''),
			run: async (a, ctx) => {
				let p = normalizePath(str(a.path).trim());
				if (!p) return tx('Percorso mancante.');
				if (!/\.md$/i.test(p)) p += '.md';
				if (app.vault.getAbstractFileByPath(p)) return tx('Esiste già una nota in {0}. Usa append_to_note o edit_note.', p);
				const content = str(a.content);
				if (!(await ctx.confirm(tx('Creare la nota “{0}”?', p), preview(content)))) return tx('L’utente ha rifiutato la creazione.');
				await ensureFolder(plugin, p);
				const f = await app.vault.create(p, content);
				await markAiContent(app, f, plugin.settings.aiMarkOutput, true);
				ctx.touched.add(f.path);
				return tx('Nota creata: {0}', f.path);
			},
		},
		{
			def: {
				name: 'append_to_note',
				description: tx('Aggiunge testo in fondo a una nota esistente (o alla nota del giorno se path è "oggi").'),
				parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
			},
			writes: true,
			describe: (a) => tx('Aggiungo testo a “{0}”', a.path ?? ''),
			run: async (a, ctx) => {
				const raw = str(a.path);
				let f = /^(oggi|today)$/i.test(raw.trim()) ? null : resolveNote(plugin, raw);
				const content = str(a.content);
				if (!f && /^(oggi|today)$/i.test(raw.trim())) {
					if (!(await ctx.confirm(tx('Aggiungere alla nota di oggi?'), preview(content)))) return tx('L’utente ha rifiutato la modifica.');
					f = await createPeriodic(app, dailyConfig(app, plugin.settings), moment());
				} else {
					if (!f) return tx('Nota non trovata: {0}', raw);
					if (!(await ctx.confirm(tx('Aggiungere testo a “{0}”?', f.basename), preview(content)))) return tx('L’utente ha rifiutato la modifica.');
				}
				await app.vault.process(f, (d) => d.replace(/\s*$/, '') + (d.trim() ? '\n\n' : '') + content + '\n');
				await markAiContent(app, f, plugin.settings.aiMarkOutput);
				ctx.touched.add(f.path);
				return tx('Testo aggiunto a {0}', f.path);
			},
		},
		{
			def: {
				name: 'edit_note',
				description:
					tx('Modifica una nota sostituendo un brano esatto con un nuovo testo. "find" deve comparire esattamente una volta nella nota; leggila prima con read_note.'),
				parameters: obj({ path: { type: 'string' }, find: { type: 'string', description: tx('Testo esatto da sostituire') }, replace: { type: 'string', description: tx('Nuovo testo') } }, [
					'path',
					'find',
					'replace',
				]),
			},
			writes: true,
			describe: (a) => tx('Modifico “{0}”', a.path ?? ''),
			run: async (a, ctx) => {
				const f = resolveNote(plugin, str(a.path));
				if (!f) return tx('Nota non trovata: {0}', a.path);
				const find = str(a.find);
				const rep = str(a.replace);
				const cur = await app.vault.read(f);
				if (!find) return tx('Il campo find è vuoto.');
				const first = cur.indexOf(find);
				if (first < 0) return tx('Testo da sostituire non trovato: rileggi la nota e copia il brano esatto.');
				if (cur.indexOf(find, first + 1) >= 0) return tx('Il testo compare più volte: includi più contesto in find.');
				if (!(await ctx.confirm(tx('Modificare “{0}”?', f.basename), `− ${preview(find, 600)}\n\n+ ${preview(rep, 600)}`))) return tx('L’utente ha rifiutato la modifica.');
				let ok = false;
				await app.vault.process(f, (d) => {
					const i = d.indexOf(find);
					if (i < 0 || d.indexOf(find, i + 1) >= 0) return d;
					ok = true;
					return d.slice(0, i) + rep + d.slice(i + find.length);
				});
				if (ok) await markAiContent(app, f, plugin.settings.aiMarkOutput);
				ctx.touched.add(f.path);
				return ok ? tx('Nota modificata: {0}', f.path) : tx('La nota è cambiata nel frattempo, modifica non applicata.');
			},
		},
		{
			def: {
				name: 'get_current_datetime',
				description: tx('Restituisce data, ora e giorno della settimana correnti.'),
				parameters: obj({}),
			},
			describe: () => tx('Controllo data e ora'),
			run: async () => moment().format('dddd YYYY-MM-DD HH:mm (Z)'),
		},
		{
			def: {
				name: 'read_web_page',
				description: tx('Scarica e legge una pagina web. Funziona anche con PDF online, video YouTube (restituisce la trascrizione) e post di X/Twitter.'),
				parameters: obj({ url: { type: 'string', description: tx('Indirizzo completo, es. https://…') } }, ['url']),
			},
			available: (p) => p.settings.aiWebAccess,
			describe: (a) => tx('Leggo {0}', str(a.url).replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)),
			run: async (a) => {
				const d = await fetchWeb(str(a.url));
				return `Titolo: ${d.title}\nURL: ${d.url}\n\n${d.text.length > MAX_READ ? d.text.slice(0, MAX_READ) + '\n…(troncato)' : d.text}`;
			},
		},
		{
			def: {
				name: 'web_search',
				description: tx('Cerca sul web. Restituisce titoli, indirizzi ed estratti; poi usa read_web_page per leggere i risultati utili. Cita sempre gli indirizzi usati.'),
				parameters: obj({ query: { type: 'string' }, limit: { type: 'number', description: tx('Numero di risultati (default 6)') } }, ['query']),
			},
			available: (p) => p.settings.aiWebSearch !== 'off',
			describe: (a) => tx('Cerco sul web “{0}”', a.query ?? ''),
			run: async (a) => {
				const hits = await webSearch(plugin.settings, str(a.query), Math.min(10, Number(a.limit) || 6));
				if (!hits.length) return tx('Nessun risultato.');
				return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n');
			},
		},
		{
			def: {
				name: 'update_memory',
				description: tx('Salva nella memoria a lungo termine un fatto o una preferenza stabile dell’utente, da ricordare nelle chat future. Una frase breve.'),
				parameters: obj({ fact: { type: 'string', description: tx('Cosa ricordare') } }, ['fact']),
			},
			available: (p) => p.settings.aiMemory,
			describe: () => tx('Aggiorno la memoria'),
			run: async (a, ctx) => {
				const fact = str(a.fact).trim();
				if (!fact) return tx('Niente da ricordare.');
				const f = await remember(app, plugin.settings.aiMemoryFile, fact, moment().format('YYYY-MM-DD'));
				ctx.touched.add(f.path);
				return tx('Memorizzato.');
			},
		},
	];
}

export { resolveNote };
