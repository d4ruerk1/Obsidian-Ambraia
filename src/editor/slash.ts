import { insertTemplate, TemplatePicker } from '../templates';
import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, Notice, setIcon, TFile } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { pickIcon, saveAttachment } from '../ui/pickers';
import { availablePath, prompt, sanitizeFileName } from '../ui/util';
import { editorTarget, FREE_ACTION, pickAction, runAiAction } from '../ai/inline';
import { BUILTIN_ACTIONS } from '../ai/prompts';
import { dailyConfig } from '../calendar/dates';
import { moment as m } from '../ui/util';
import { tx } from '../i18n';

interface SlashItem {
	id: string;
	title: string;
	desc: string;
	icon: string;
	group: string;
	keys: string;
	run: (ed: Editor, ctx: { file: TFile | null; line: number }) => void | Promise<void>;
}

const nowFmt = (f: string): string => m().format(f);

export function normalize(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();
}

const BLOCK_PREFIX = /^(\s*)(#{1,6}\s+|[-*+]\s+\[.\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/;

/** Replace the block prefix of a line (heading, list marker, quote) with a new one. */
export function setLinePrefix(line: string, prefix: string): string {
	const m = BLOCK_PREFIX.exec(line)!;
	return m[1] + prefix + line.slice(m[0].length);
}

/** Returns the slash-query if the text before the cursor ends with "/query". */
export function matchSlash(before: string, trigger: string): { start: number; query: string } | null {
	if (!trigger) return null;
	const idx = before.lastIndexOf(trigger);
	if (idx < 0) return null;
	const prev = idx === 0 ? '' : before[idx - 1];
	if (prev && !/[\s([{>]/.test(prev)) return null; // avoid URLs, paths, dates (a/b, 1/2)
	const q = before.slice(idx + trigger.length);
	if (q.length > 24 || /^\s/.test(q) || /\s{2}/.test(q)) return null;
	if (!/^[\p{L}\p{N} ]*$/u.test(q)) return null;
	return { start: idx, query: q };
}

/** True if the position is inside a fenced code block or an inline `code` span. */
export function inCode(editor: Editor, line: number, ch: number): boolean {
	let inside = false;
	const from = Math.max(0, line - 600);
	for (let i = from; i < line; i++) if (/^\s*(```|~~~)/.test(editor.getLine(i))) inside = !inside;
	if (/`[^`]*$/.test(editor.getLine(line).slice(0, ch).replace(/`[^`]*`/g, ''))) return true;
	return inside;
}

export class SlashSuggest extends EditorSuggest<SlashItem> {
	private items: SlashItem[];

	constructor(private plugin: AmbraiaPlugin) {
		super(plugin.app);
		this.items = this.buildItems();
		this.limit = 60;
		this.setInstructions([
			{ command: '↑↓', purpose: 'scegli' },
			{ command: '↵', purpose: 'inserisci' },
			{ command: 'esc', purpose: 'chiudi' },
		]);
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		if (!this.plugin.settings.slashMenu) return null;
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const m = matchSlash(before, this.plugin.settings.slashTrigger || '/');
		if (!m) return null;
		if (this.inCodeBlock(editor, cursor.line)) return null;
		return { start: { line: cursor.line, ch: m.start }, end: cursor, query: m.query };
	}

	private inCodeBlock(editor: Editor, line: number): boolean {
		return inCode(editor, line, editor.getCursor().ch);
	}

	getSuggestions(ctx: EditorSuggestContext): SlashItem[] {
		const q = normalize(ctx.query.trim());
		const list = this.plugin.settings.aiEnabled ? this.items : this.items.filter((i) => i.group !== 'AI');
		if (!q) return list;
		const scored: [number, SlashItem][] = [];
		for (const it of list) {
			const t = normalize(it.title);
			const k = normalize(it.keys);
			let s = -1;
			if (t.startsWith(q)) s = 0;
			else if (t.split(/\s+/).some((w) => w.startsWith(q))) s = 1;
			else if (k.split(/\s+/).some((w) => w.startsWith(q))) s = 2;
			else if (t.includes(q) || k.includes(q)) s = 3;
			if (s >= 0) scored.push([s, it]);
		}
		return scored.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
	}

	renderSuggestion(it: SlashItem, el: HTMLElement) {
		el.addClass('ambraia-slash-item');
		const ic = el.createDiv('ambraia-slash-icon');
		setIcon(ic, it.icon);
		const txt = el.createDiv('ambraia-slash-text');
		txt.createDiv({ cls: 'ambraia-slash-title', text: it.title });
		txt.createDiv({ cls: 'ambraia-slash-desc', text: it.desc });
	}

	selectSuggestion(it: SlashItem) {
		const ctx = this.context;
		if (!ctx) return;
		const ed = ctx.editor;
		ed.replaceRange('', ctx.start, ctx.end);
		ed.setCursor(ctx.start);
		this.close();
		try {
			const r = it.run(ed, { file: ctx.file, line: ctx.start.line });
			if (r instanceof Promise) r.catch((e) => new Notice(tx('Ambraia: ') + (e instanceof Error ? e.message : String(e))));
		} catch (e) {
			new Notice(tx('Ambraia: ') + (e instanceof Error ? e.message : String(e)));
		}
		ed.focus();
	}

	private buildItems(): SlashItem[] {
		const items: SlashItem[] = [];
		const add = (group: string, id: string, title: string, desc: string, icon: string, keys: string, run: SlashItem['run']) =>
			items.push({ group, id, title, desc, icon, keys, run });

		const prefix = (p: string) => (ed: Editor, c: { line: number }) => {
			const line = ed.getLine(c.line);
			const next = setLinePrefix(line, p);
			ed.setLine(c.line, next);
			ed.setCursor({ line: c.line, ch: next.length });
		};
		const tableBlock = () => {
			const t = tx('| Colonna 1 | Colonna 2 | Colonna 3 |') + '\n| --- | --- | --- |\n|  |  |  |\n';
			return block(t, t.length - 9); // cursor in the first empty cell
		};
		const block = (text: string, cursorOffsetFromStart?: number) => (ed: Editor) => {
			const cur = ed.getCursor();
			const line = ed.getLine(cur.line);
			const needNl = line.trim().length > 0;
			const ins = (needNl ? '\n' : '') + text;
			const start = needNl ? { line: cur.line, ch: line.length } : { line: cur.line, ch: 0 };
			ed.replaceRange(ins, start, needNl ? start : { line: cur.line, ch: line.length });
			const off = ed.posToOffset(start) + (needNl ? 1 : 0) + (cursorOffsetFromStart ?? text.length);
			ed.setCursor(ed.offsetToPos(off));
		};
		const inline = (text: string, back = 0) => (ed: Editor) => {
			const cur = ed.getCursor();
			ed.replaceRange(text, cur);
			ed.setCursor(ed.offsetToPos(ed.posToOffset(cur) + text.length - back));
		};

		add(tx('Blocchi base'), 'text', tx('Testo'), tx('Inizia a scrivere testo semplice'), 'pilcrow', tx('paragrafo text plain normale'), prefix(''));
		add(tx('Blocchi base'), 'h1', tx('Titolo 1'), tx('Titolo di sezione grande'), 'heading-1', tx('h1 heading intestazione'), prefix('# '));
		add(tx('Blocchi base'), 'h2', tx('Titolo 2'), tx('Titolo di sezione medio'), 'heading-2', tx('h2 heading intestazione'), prefix('## '));
		add(tx('Blocchi base'), 'h3', tx('Titolo 3'), tx('Titolo di sezione piccolo'), 'heading-3', tx('h3 heading intestazione'), prefix('### '));
		add(tx('Blocchi base'), 'ul', tx('Elenco puntato'), tx('Crea un semplice elenco puntato'), 'list', tx('bullet lista ul punti'), prefix('- '));
		add(tx('Blocchi base'), 'ol', tx('Elenco numerato'), tx('Crea un elenco con numerazione'), 'list-ordered', tx('numbered lista ol numeri'), prefix('1. '));
		add(tx('Blocchi base'), 'todo', tx('Lista di cose da fare'), tx('Tieni traccia delle attività'), 'check-square', tx('todo task checkbox attivita compiti'), prefix('- [ ] '));
		add(tx('Blocchi base'), 'toggle', tx('Elenco a scomparsa'), tx('Contenuto che si apre e si chiude'), 'chevron-right-square', tx('toggle fold comprimi espandi'), (ed) => {
			const title = tx('Titolo');
			block(`> [!note]- ${title}\n> `, 11)(ed);
			const c = ed.getCursor();
			ed.setSelection(c, { line: c.line, ch: c.ch + title.length });
		});
		add(tx('Blocchi base'), 'quote', tx('Citazione'), tx('Inserisci una citazione'), 'quote', tx('quote blockquote citazione'), prefix('> '));
		add(tx('Blocchi base'), 'divider', tx('Divisore'), tx('Separa visivamente i blocchi'), 'minus', tx('divider hr linea separatore'), block('---\n'));
		const callouts: [string, string, string, string][] = [
			['note', tx('Callout'), tx('Fai risaltare il testo'), 'message-square'],
			['tip', tx('Callout suggerimento'), tx('Un consiglio utile'), 'lightbulb'],
			['info', tx('Callout informazione'), tx('Nota informativa'), 'info'],
			['warning', tx('Callout attenzione'), tx('Avviso importante'), 'alert-triangle'],
			['danger', tx('Callout pericolo'), tx('Errore o pericolo'), 'zap'],
			['success', tx('Callout completato'), tx('Qualcosa è andato bene'), 'check-circle'],
			['question', tx('Callout domanda'), tx('Domanda o FAQ'), 'help-circle'],
		];
		for (const [t, title, desc, icon] of callouts) add(tx('Blocchi base'), 'callout-' + t, title, desc, icon, tx('callout box riquadro ') + t, block(`> [!${t}]\n> `));
		add(tx('Blocchi base'), 'code', tx('Codice'), tx('Blocco di codice'), 'code-2', tx('code snippet programma'), block('```\n\n```', 4));
		add(tx('Blocchi base'), 'table', tx('Tabella'), tx('Tabella semplice in Markdown'), 'table-2', tx('table griglia'), tableBlock());
		add(tx('Blocchi base'), 'math', tx('Equazione'), tx('Formula matematica LaTeX'), 'sigma', tx('math latex equation formula'), block('$$\n\n$$', 3));
		add(tx('Blocchi base'), 'mermaid', tx('Diagramma'), tx('Diagramma di flusso Mermaid'), 'git-fork', tx('mermaid diagram flowchart grafico'), block(tx('```mermaid\nflowchart LR\n  A[Inizio] --> B[Fine]\n```\n')));

		add(tx('Database'), 'db-table', tx('Database: tabella'), tx('Tabella delle pagine di questa cartella'), 'table', tx('database db tabella table'), this.db('table'));
		add(tx('Database'), 'db-board', tx('Database: bacheca'), tx('Bacheca kanban raggruppata per stato'), 'kanban-square', tx('database db board kanban bacheca'), this.db('board'));
		add(tx('Database'), 'db-gallery', tx('Database: galleria'), tx('Schede con copertina'), 'layout-grid', tx('database db galleria gallery card'), this.db('gallery'));
		add(tx('Database'), 'db-calendar', tx('Database: calendario'), tx('Pagine sul calendario per data'), 'calendar', tx('database db calendario calendar'), this.db('calendar'));
		add(tx('Database'), 'db-list', tx('Database: elenco'), tx('Elenco compatto di pagine'), 'list', tx('database db elenco list'), this.db('list'));

		add(tx('Pagine'), 'page', tx('Sottopagina'), tx('Crea una nuova pagina collegata'), 'file-plus', tx('page pagina nuova subpage'), async (ed, c) => {
			const name = await prompt(this.app, tx('Nuova sottopagina'), '', tx('Titolo della pagina'), tx('Crea'));
			if (!name) return;
			const folder = c.file?.parent?.path ?? '';
			const path = availablePath(this.app, folder, sanitizeFileName(name), 'md');
			const f = await this.app.vault.create(path, '');
			const link = this.app.fileManager.generateMarkdownLink(f, c.file?.path ?? '');
			ed.replaceRange(link, ed.getCursor());
		});
		add(tx('Pagine'), 'template', tx('Modello'), tx('Inserisci un modello pronto (riunione, progetto, diario…)'), 'layout-template', tx('template modello schema riunione progetto diario'), () => {
			new TemplatePicker(this.plugin, (t) => void insertTemplate(this.plugin, t), true).open();
		});
		add(tx('Pagine'), 'link', tx('Link a pagina'), tx('Collega un’altra pagina'), 'link', tx('link collegamento wikilink'), inline('[[]]', 2));
		add(tx('Pagine'), 'embed', tx('Incorpora pagina'), tx('Mostra il contenuto di un’altra nota'), 'file-symlink', tx('embed incorpora transclusione'), inline('![[]]', 2));
		add(tx('Pagine'), 'toc', tx('Indice'), tx('Sommario dei titoli di questa pagina'), 'list-tree', tx('toc indice sommario table of contents'), (ed, c) => {
			const f = c.file;
			const hs = (f && this.app.metadataCache.getFileCache(f)?.headings) || [];
			if (!hs.length) {
				new Notice(tx('Nessun titolo nella pagina'));
				return;
			}
			const min = Math.min(...hs.map((h) => h.level));
			const text = hs.map((h) => `${'  '.repeat(h.level - min)}- [[#${h.heading.replace(/[[\]|#^]/g, ' ')}|${h.heading}]]`).join('\n') + '\n';
			block(text)(ed);
		});

		add(tx('Media'), 'image', tx('Immagine'), tx('Carica un’immagine dal computer'), 'image', tx('image immagine foto picture upload'), (ed, c) => {
			const input = createEl('input');
			input.type = 'file';
			input.accept = 'image/*';
			const pos = ed.getCursor();
			input.onchange = async () => {
				const file = input.files?.[0];
				if (!file) return;
				const saved = await saveAttachment(this.app, file, c.file?.path ?? '', this.plugin.settings.optimizeImages);
				ed.replaceRange('!' + this.app.fileManager.generateMarkdownLink(saved, c.file?.path ?? '').replace(/^!/, ''), pos);
			};
			input.click();
		});
		add(tx('Media'), 'image-link', tx('Immagine da link'), tx('Incorpora un’immagine dal web'), 'image-plus', tx('image url web link immagine'), async (ed) => {
			const pos = ed.getCursor();
			const url = await prompt(this.app, tx('Link dell’immagine'), '', 'https://…', tx('Inserisci'));
			if (url) ed.replaceRange(`![](${url.trim()})`, pos);
		});
		add(tx('Media'), 'video', tx('Video / YouTube'), tx('Incorpora un video dal web'), 'youtube', tx('video youtube vimeo embed'), async (ed) => {
			const pos = ed.getCursor();
			const url = await prompt(this.app, tx('Link del video'), '', 'https://www.youtube.com/watch?v=…', tx('Inserisci'));
			if (url) ed.replaceRange(`![](${url.trim()})`, pos);
		});
		add(tx('Media'), 'emoji', tx('Emoji'), tx('Inserisci un’emoji'), 'smile', tx('emoji faccina icona'), async (ed) => {
			const pos = ed.getCursor();
			const v = await pickIcon(this.app, false);
			if (v && !v.startsWith('lucide')) {
				ed.replaceRange(v, pos);
				ed.setCursor({ line: pos.line, ch: pos.ch + v.length });
			}
		});

		add(tx('Inline'), 'date', tx('Data di oggi'), tx('Inserisce la data odierna'), 'calendar-days', tx('data oggi today date'), (ed) => inline(nowFmt('YYYY-MM-DD'))(ed));
		add(tx('Inline'), 'datetime', tx('Data e ora'), tx('Inserisce data e ora attuali'), 'clock', tx('ora time now adesso'), (ed) => inline(nowFmt('YYYY-MM-DD HH:mm'))(ed));
		add(tx('Inline'), 'highlight', tx('Evidenziato'), tx('Testo evidenziato'), 'highlighter', tx('highlight evidenzia marker'), inline('====', 2));
		add(tx('Inline'), 'comment', tx('Commento nascosto'), tx('Visibile solo in modifica'), 'message-square-dashed', tx('comment commento nascosto'), inline('%%  %%', 3));
		add(tx('Inline'), 'footnote', tx('Nota a piè di pagina'), tx('Aggiunge una nota'), 'superscript', tx('footnote nota piede'), (ed) => {
			const text = ed.getValue();
			let n = 1;
			while (text.includes(`[^${n}]`)) n++;
			const cur = ed.getCursor();
			ed.replaceRange(`[^${n}]`, cur);
			const last = ed.lastLine();
			const end = { line: last, ch: ed.getLine(last).length };
			ed.replaceRange(`\n\n[^${n}]: `, end);
			ed.setCursor({ line: ed.lastLine(), ch: ed.getLine(ed.lastLine()).length });
		});
		add(tx('Inline'), 'tag', tx('Tag'), tx('Aggiungi un tag'), 'hash', tx('tag etichetta hashtag'), inline('#'));
		// ----- calendar links
		const dailyLink = (offset: number) => (ed: Editor) => {
			const cfg = dailyConfig(this.plugin.app, this.plugin.settings);
			const name = m().add(offset, 'day').format(cfg.format).split('/').pop();
			ed.replaceSelection(`[[${name}]]`);
		};
		add(tx('Inline'), 'link-today', tx('Link alla nota di oggi'), tx('Collega la nota del giorno'), 'calendar-check', tx('oggi today daily giorno link diario'), dailyLink(0));
		add(tx('Inline'), 'link-tomorrow', tx('Link alla nota di domani'), tx('Collega la nota di domani'), 'calendar-plus', tx('domani tomorrow daily link'), dailyLink(1));
		add(tx('Inline'), 'link-yesterday', tx('Link alla nota di ieri'), tx('Collega la nota di ieri'), 'calendar-minus', tx('ieri yesterday daily link'), dailyLink(-1));
		add(tx('Inline'), 'due', tx('Scadenza attività'), tx('Aggiunge 📅 data (compare nel calendario)'), 'calendar-clock', tx('scadenza due deadline data attivita task'), async (ed) => {
			const v = await prompt(this.plugin.app, tx('Scadenza'), m().add(1, 'day').format('YYYY-MM-DD'), 'AAAA-MM-GG', tx('Inserisci'));
			if (v && m(v.trim(), 'YYYY-MM-DD', true).isValid()) ed.replaceSelection(` 📅 ${v.trim()}`);
			else if (v) new Notice(tx('Data non valida: usa il formato AAAA-MM-GG.'));
		});

		// ----- AI
		const ai = (id: string) => (ed: Editor, c: { file: TFile | null }) => {
			const a = id === 'free' ? FREE_ACTION : BUILTIN_ACTIONS.find((x) => x.id === id)!;
			void runAiAction(this.plugin, a, editorTarget(ed), c.file);
		};
		add('AI', 'ai-ask', tx('Chiedi all’AI'), tx('Scrivi una richiesta: il risultato viene inserito qui'), 'sparkles', tx('ai ia chiedi ask assistente gpt genera scrivi'), ai('free'));
		add('AI', 'ai-continue', tx('Continua a scrivere con l’AI'), tx('L’AI prosegue il testo della pagina'), 'pen-line', tx('ai continua continue scrivi'), ai('continue'));
		add('AI', 'ai-summary', tx('Riassunto della pagina'), tx('Riassume la pagina in punti chiave'), 'list-collapse', tx('ai riassumi riassunto summary'), ai('summarize'));
		add('AI', 'ai-tasks', tx('Estrai le attività'), tx('Lista di cose da fare dalla pagina'), 'list-checks', tx('ai attivita task todo estrai'), ai('tasks'));
		add('AI', 'ai-prompt', tx('Prompt personalizzato…'), tx('Esegue un prompt dalla tua cartella dei prompt'), 'sparkle', tx('ai prompt personalizzato comando custom'), async (ed, c) => {
			if (!this.plugin.ai.ready) return this.plugin.openAiSetup();
			const a = await pickAction(this.plugin, true);
			if (a) await runAiAction(this.plugin, a, editorTarget(ed), c.file);
		});
		add('AI', 'ai-chat', tx('Apri la chat AI'), tx('Chat, domande sul vault e agente'), 'messages-square', tx('ai chat assistente agente'), () => void this.plugin.activateAiChat());
		return items;
	}

	private db(view: string) {
		return (ed: Editor) => {
			const extra = view === 'board' ? '\ngroupBy: stato\ncolumns: [stato, tags]' : view === 'calendar' ? '\ndateField: data\ncolumns: [data]' : '\ncolumns: [tags, modificato]';
			const text = '```ambraia\nsource: this\nview: ' + view + extra + '\n```\n';
			const cur = ed.getCursor();
			const line = ed.getLine(cur.line);
			const ins = (line.trim() ? '\n' : '') + text;
			ed.replaceRange(ins, { line: cur.line, ch: line.length });
			ed.setCursor({ line: cur.line + ins.split('\n').length - 1, ch: 0 });
		};
	}
}
