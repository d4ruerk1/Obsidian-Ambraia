import { App, Component, Editor, FuzzySuggestModal, MarkdownRenderer, Menu, Modal, Notice, setIcon, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type AmbraiaPlugin from '../main';
import type { ChatMsg } from './client';
import { splitThinking, stripThinking } from './client';
import { AiAction, BUILTIN_ACTIONS, expandTemplate, LANGUAGES, loadCustomPrompts, translateAction } from './prompts';
import { prompt } from '../ui/util';
import { tx } from '../i18n';
import { markAiContent } from './marking';

/** Where an AI result goes. Works for CodeMirror views (toolbar) and Obsidian editors (commands). */
export interface EditTarget {
	/** Text the action works on ('' = the whole note, result can only be inserted). */
	text: string;
	/** Result can only be copied (reading view). */
	readonly?: boolean;
	replace(next: string): boolean;
	insertBelow(next: string): boolean;
}

/** Finds `text` near the original position; returns its current offset or -1 if it moved or changed. */
function locate(doc: string, text: string, from: number): number {
	if (doc.slice(from, from + text.length) === text) return from;
	const first = doc.indexOf(text);
	if (first < 0 || doc.indexOf(text, first + 1) >= 0) return -1;
	return first;
}

export function cmTarget(view: EditorView, from: number, to: number): EditTarget {
	const text = view.state.sliceDoc(from, to);
	const insertAt = (pos: number, next: string) => {
		const line = view.state.doc.lineAt(pos);
		view.dispatch({ changes: { from: line.to, insert: '\n\n' + next }, selection: { anchor: line.to + 2 + next.length } });
	};
	return {
		text,
		replace(next) {
			const at = locate(view.state.doc.toString(), text, from);
			if (at < 0 || !text) return false;
			view.dispatch({ changes: { from: at, to: at + text.length, insert: next }, selection: { anchor: at, head: at + next.length } });
			return true;
		},
		insertBelow(next) {
			const at = text ? locate(view.state.doc.toString(), text, from) : Math.min(to, view.state.doc.length);
			if (at < 0) return false;
			insertAt(text ? at + text.length : at, next);
			return true;
		},
	};
}

export function readonlyTarget(text: string): EditTarget {
	return { text, readonly: true, replace: () => false, insertBelow: () => false };
}

export function editorTarget(editor: Editor): EditTarget {
	const text = editor.getSelection();
	const from = editor.posToOffset(editor.getCursor('from'));
	const to = editor.posToOffset(editor.getCursor('to'));
	return {
		text,
		replace(next) {
			const at = locate(editor.getValue(), text, from);
			if (at < 0 || !text) return false;
			editor.replaceRange(next, editor.offsetToPos(at), editor.offsetToPos(at + text.length));
			return true;
		},
		insertBelow(next) {
			const at = text ? locate(editor.getValue(), text, from) : to;
			if (at < 0) return false;
			if (!text) {
				const cur = editor.offsetToPos(at);
				if (!editor.getLine(cur.line).trim()) {
					editor.replaceRange(next, { line: cur.line, ch: 0 }, { line: cur.line, ch: editor.getLine(cur.line).length });
					return true;
				}
			}
			const end = editor.offsetToPos(text ? at + text.length : at);
			const lineEnd = { line: end.line, ch: editor.getLine(end.line).length };
			editor.replaceRange('\n\n' + next, lineEnd);
			return true;
		},
	};
}

/** All quick actions: built-in, translations, custom prompts from the prompts folder. */
export async function allActions(plugin: AmbraiaPlugin): Promise<AiAction[]> {
	const custom = await loadCustomPrompts(plugin.app, plugin.settings.aiPromptsFolder);
	return [...BUILTIN_ACTIONS, ...LANGUAGES.map(translateAction), ...custom];
}

export const FREE_ACTION: AiAction = { id: 'free', title: tx('Chiedi all’AI…'), icon: 'message-square', group: 'genera', replace: true, prompt: '' };

class ActionPicker extends FuzzySuggestModal<AiAction> {
	constructor(
		app: App,
		private actions: AiAction[],
		private done: (a: AiAction | null) => void,
	) {
		super(app);
		this.setPlaceholder(tx('Scegli un’azione AI o un prompt personalizzato…'));
	}
	private picked = false;
	getItems() {
		return this.actions;
	}
	getItemText(a: AiAction) {
		const g = a.group === 'personalizzato' ? tx(' · prompt') : a.group === 'traduci' ? tx(' · traduzione') : '';
		return a.title + g;
	}
	onChooseItem(a: AiAction) {
		this.picked = true;
		this.done(a);
	}
	onClose() {
		super.onClose();
		// onChooseItem runs after onClose in Obsidian: defer the "cancelled" signal
		window.setTimeout(() => {
			if (!this.picked) this.done(null);
		}, 0);
	}
}

export function pickAction(plugin: AmbraiaPlugin, onlyCustom = false): Promise<AiAction | null> {
	return allActions(plugin).then(
		(all) =>
			new Promise((resolve) => {
				const list = onlyCustom ? all.filter((a) => a.group === 'personalizzato') : [FREE_ACTION, ...all];
				if (onlyCustom && !list.length) {
					new Notice(tx('Nessun prompt personalizzato in “{0}”. Creane uno dalle impostazioni AI.', plugin.settings.aiPromptsFolder));
					return resolve(null);
				}
				let settled = false;
				new ActionPicker(plugin.app, list, (a) => {
					if (settled) return;
					settled = true;
					resolve(a);
				}).open();
			}),
	);
}

/** Entry point used by the toolbar, slash menu and commands. */
export async function runAiAction(plugin: AmbraiaPlugin, action: AiAction, target: EditTarget, file: TFile | null) {
	if (!plugin.ai.ready) {
		plugin.openAiSetup();
		return;
	}
	if (action.id === 'free') {
		const ask = await prompt(plugin.app, tx('Chiedi all’AI'), '', target.text ? tx('Cosa vuoi fare con il testo selezionato?') : tx('Scrivi una richiesta…'), tx('Invia'), true);
		if (!ask?.trim()) return;
		action = { ...FREE_ACTION, prompt: target.text ? `${ask.trim()}\n\n{}` : ask.trim(), replace: !!target.text };
	}
	new AiActionModal(plugin, action, target, file).open();
}

/** Streams the result of an action, then lets the user replace, insert, copy, refine or retry. */
export class AiActionModal extends Modal {
	private history: ChatMsg[] = [];
	private result = '';
	private abort: AbortController | null = null;
	private outEl!: HTMLElement;
	private barEl!: HTMLElement;
	private refineEl!: HTMLTextAreaElement;
	private md: Component | null = null;

	constructor(
		private plugin: AmbraiaPlugin,
		private action: AiAction,
		private target: EditTarget,
		private file: TFile | null,
	) {
		super(plugin.app);
	}

	async onOpen() {
		this.modalEl.addClass('ambraia-ai-inline');
		this.titleEl.setText(this.action.title);
		const c = this.contentEl;
		c.empty();
		if (this.target.text) {
			const src = c.createEl('details', { cls: 'ambraia-ai-inline-src' });
			src.createEl('summary', { text: tx('Testo selezionato') });
			src.createDiv({ cls: 'ambraia-ai-inline-srctext', text: this.target.text });
		}
		this.outEl = c.createDiv('ambraia-ai-inline-out markdown-rendered');
		const refine = c.createDiv('ambraia-ai-inline-refine');
		this.refineEl = refine.createEl('textarea', { attr: { rows: '1', placeholder: tx('Chiedi una modifica (es. “più formale”, “in 3 punti”)… e premi Invio') } });
		this.refineEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.refine();
			}
		});
		this.barEl = c.createDiv('ambraia-ai-inline-bar');
		const first = await expandTemplate(this.app, this.action.prompt, this.target.text, this.file);
		this.history = [{ role: 'user', content: first }];
		await this.generate();
	}

	onClose() {
		this.abort?.abort();
		this.md?.unload();
		this.contentEl.empty();
	}

	private async refine() {
		const v = this.refineEl.value.trim();
		if (!v || this.abort) return;
		this.refineEl.value = '';
		this.history.push({ role: 'assistant', content: this.result }, { role: 'user', content: tx('{0}\n\nRispondi di nuovo SOLO con il testo risultante completo.', v) });
		await this.generate();
	}

	private async retry() {
		if (this.abort) return;
		await this.generate();
	}

	private render(text: string, final: boolean) {
		const { thinking, answer } = splitThinking(text);
		this.outEl.empty();
		if (thinking && !final) this.outEl.createDiv({ cls: 'ambraia-ai-thinking-live', text: tx('Sto ragionando…') });
		if (!final) {
			this.outEl.createDiv({ cls: 'ambraia-ai-stream', text: answer || (thinking ? '' : '…') });
			return;
		}
		this.md?.unload();
		this.md = new Component();
		this.md.load();
		void MarkdownRenderer.render(this.app, answer || tx('_(risposta vuota)_'), this.outEl, this.file?.path ?? '', this.md);
	}

	private async generate() {
		this.abort = new AbortController();
		this.drawBar(true);
		let text = '';
		this.render('', false);
		let last = 0;
		try {
			const r = await this.plugin.ai.run(
				this.history,
				'chat',
				{
					signal: this.abort.signal,
					onToken: (t) => {
						text += t;
						const now = Date.now();
						if (now - last > 60) {
							last = now;
							this.render(text, false);
						}
					},
				},
				this.action.model ? this.plugin.ai.models().find((m) => m.model === this.action.model || m.id === this.action.model)?.id : undefined,
			);
			this.result = stripThinking(r.text || text);
			this.render(this.result, true);
		} catch (e) {
			this.outEl.empty();
			this.outEl.createDiv({ cls: 'ambraia-ai-error', text: e instanceof Error ? e.message : String(e) });
			this.result = '';
		} finally {
			this.abort = null;
			this.drawBar(false);
		}
	}

	private button(label: string, icon: string, onClick: () => void, cta = false) {
		const b = this.barEl.createEl('button', { cls: cta ? 'mod-cta' : '' });
		const i = b.createSpan('ambraia-ai-btn-icon');
		setIcon(i, icon);
		b.createSpan({ text: label });
		b.onclick = onClick;
		return b;
	}

	private drawBar(busy: boolean) {
		this.barEl.empty();
		this.refineEl.disabled = busy;
		if (busy) {
			this.button(tx('Interrompi'), 'square', () => this.abort?.abort());
			return;
		}
		const has = !!this.result.trim();
		const done = (ok: boolean) => {
			if (ok) void markAiContent(this.plugin.app, this.file, this.plugin.settings.aiMarkOutput);
			if (ok) this.close();
			else new Notice(tx('Il testo è cambiato nel frattempo: copia il risultato o riprova.'));
		};
		const ro = !!this.target.readonly;
		if (has && this.target.text && !ro) this.button(tx('Sostituisci'), 'replace', () => done(this.target.replace(this.result)), this.action.replace);
		if (has && !ro) this.button(this.target.text ? tx('Inserisci sotto') : tx('Inserisci'), 'between-horizontal-end', () => done(this.target.insertBelow(this.result)), !this.action.replace || !this.target.text);
		if (has)
			this.button(tx('Copia'), 'copy', () => {
				void navigator.clipboard?.writeText(this.result);
				new Notice(tx('Copiato.'));
			});
		this.button(tx('Riprova'), 'rotate-ccw', () => void this.retry());
		if (has)
			this.button(tx('Apri in chat'), 'messages-square', () => {
				void this.plugin.continueInChat(this.history, this.result);
				this.close();
			});
		this.button(tx('Annulla'), 'x', () => this.close());
	}
}

/** The “AI” dropdown of the selection toolbars. */
export function showAiMenu(plugin: AmbraiaPlugin, e: MouseEvent, target: EditTarget, file: TFile | null, before?: () => void) {
	if (!plugin.ai.ready) {
		before?.();
		plugin.openAiSetup();
		return;
	}
	const m = new Menu();
	const run = (a: AiAction) => () => {
		before?.();
		void runAiAction(plugin, a, target, file);
	};
	m.addItem((i) => i.setTitle(FREE_ACTION.title).setIcon(FREE_ACTION.icon).onClick(run(FREE_ACTION)));
	m.addSeparator();
	const ids = target.readonly ? ['explain', 'summarize'] : ['improve', 'fix', 'shorter', 'longer', 'summarize', 'explain', 'bullets', 'tasks'];
	for (const id of ids) {
		const a = BUILTIN_ACTIONS.find((x) => x.id === id);
		if (a) m.addItem((i) => i.setTitle(a.title).setIcon(a.icon).onClick(run(a)));
	}
	m.addItem((i) => i.setTitle(target.readonly ? tx('Traduci in italiano') : tx('Traduci in inglese')).setIcon('languages').onClick(run(translateAction(target.readonly ? tx('Italiano') : tx('Inglese')))));
	m.addSeparator();
	m.addItem((i) =>
		i
			.setTitle(tx('Altre azioni e prompt personalizzati…'))
			.setIcon('wand-2')
			.onClick(async () => {
				before?.();
				const a = await pickAction(plugin);
				if (a) await runAiAction(plugin, a, target, file);
			}),
	);
	m.addItem((i) =>
		i
			.setTitle(tx('Aggiungi alla chat'))
			.setIcon('message-square-plus')
			.onClick(() => {
				before?.();
				void plugin.addSelectionToChat(target.text, file?.basename ?? 'nota');
			}),
	);
	m.showAtMouseEvent(e);
}
