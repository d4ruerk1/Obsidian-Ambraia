import { cmTarget, readonlyTarget, showAiMenu } from '../ai/inline';
import { EditorSelection, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField, MarkdownView, Notice } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { BarItem, buildColorPanel, FloatingBar } from '../ui/floatingBar';
import { availablePath, openExternal, prompt, sanitizeFileName } from '../ui/util';
import { Change, isWrapped, MDLINK_RE, selectionKind, setColor, stripFormatting, toggleInline, toggleTodos, transformLines, WIKILINK_RE } from './textOps';
import { PagePicker } from './mentions';
import { imageItemsForRange } from './imageTools';
import { tx } from '../i18n';

export function applyChange(view: EditorView, c: Change) {
	view.dispatch({
		changes: { from: c.from, to: c.to, insert: c.insert },
		selection: EditorSelection.range(c.selFrom, c.selTo),
		userEvent: 'input.ambraia',
	});
	view.focus();
}

function replaceSel(view: EditorView, from: number, to: number, text: string, select = true) {
	applyChange(view, { from, to, insert: text, selFrom: select ? from : from + text.length, selTo: from + text.length });
}

/** Expand a range to whole lines. */
function lineRange(view: EditorView, from: number, to: number): { from: number; to: number } {
	const doc = view.state.doc;
	const a = doc.lineAt(from);
	let b = doc.lineAt(to);
	if (to > from && to === b.from && b.number > a.number) b = doc.line(b.number - 1);
	return { from: a.from, to: b.to };
}

/** Wraps (or unwraps, if all are wrapped) the text of every non-empty line, after its block marker. */
export function wrapLines(src: string, open: string, close = open): string {
	const PRE = /^(\s*(?:#{1,6}\s+|[-*+]\s+\[.\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?)(.*?)(\s*)$/;
	const parts = src.split('\n').map((l) => PRE.exec(l)!);
	const filled = parts.filter((m) => m[2]);
	const unwrap = filled.length > 0 && filled.every((m) => m[2].length >= open.length + close.length && m[2].startsWith(open) && m[2].endsWith(close));
	return parts
		.map((m) => (!m[2] ? m[0] : m[1] + (unwrap ? m[2].slice(open.length, m[2].length - close.length) : open + m[2] + close) + m[3]))
		.join('\n');
}

export function selectionToolbar(plugin: AmbraiaPlugin): Extension {
	const app = plugin.app;
	return ViewPlugin.fromClass(
		class {
			bar = new FloatingBar('ambraia-selection-bar');
			mouseDown = false;
			timer: number | null = null;
			private onDown = (e: MouseEvent) => {
				if (e.button !== 0) return;
				this.mouseDown = true;
				this.bar.hide();
			};
			private onUp = () => {
				if (!this.mouseDown) return;
				this.mouseDown = false;
				this.schedule(10);
			};
			private onScroll = () => {
				if (this.bar.visible) this.schedule(0);
			};
			private onKey = (e: KeyboardEvent) => {
				if (e.key === 'Escape' && this.bar.visible) this.bar.hide();
			};

			constructor(readonly view: EditorView) {
				view.dom.addEventListener('mousedown', this.onDown);
				view.dom.ownerDocument.addEventListener('mouseup', this.onUp);
				view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
				view.dom.addEventListener('keydown', this.onKey);
			}

			update(u: ViewUpdate) {
				if (u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged) this.schedule(u.selectionSet && !u.docChanged ? 220 : 60);
			}

			schedule(ms: number) {
				if (this.timer) window.clearTimeout(this.timer);
				this.timer = window.setTimeout(() => this.refresh(), ms);
			}

			refresh() {
				this.timer = null;
				const v = this.view;
				const sel = v.state.selection.main;
				if (!plugin.settings.selectionToolbar || sel.empty || this.mouseDown || !v.dom.isConnected || v.state.selection.ranges.length > 1) {
					this.bar.hide();
					return;
				}
				if (!v.hasFocus && !this.bar.visible) return;
				if (!v.hasFocus && !this.bar.contains(activeDocument.activeElement)) {
					this.bar.hide();
					return;
				}
				const start = v.coordsAtPos(sel.from, 1);
				const end = v.coordsAtPos(sel.to, -1);
				if (!start || !end) {
					this.bar.hide();
					return;
				}
				const sc = v.scrollDOM.getBoundingClientRect();
				const top = Math.min(start.top, end.top);
				if (top < sc.top - 4 && end.bottom < sc.top) {
					this.bar.hide();
					return;
				}
				const multi = start.top !== end.top;
				const anchor = {
					left: multi ? v.contentDOM.getBoundingClientRect().left : start.left,
					right: multi ? Math.max(start.left, end.right) : end.right,
					top: Math.max(top, sc.top),
					bottom: Math.max(start.bottom, end.bottom),
				};
				const text = v.state.sliceDoc(sel.from, sel.to);
				const key = `${sel.from}:${sel.to}:${v.state.doc.length}`;
				this.bar.show(this.items(sel.from, sel.to, text), anchor, key);
			}

			items(from: number, to: number, text: string): BarItem[] {
				const v = this.view;
				const kind = selectionKind(text);
				const doc = v.state.doc.toString();
				const file = v.state.field(editorInfoField, false)?.file ?? null;
				const bar = this.bar;
				const wrap = (open: string, close = open) => () => applyChange(v, toggleInline(v.state.doc.toString(), from, to, open, close));
				const fmt = (icon: string, label: string, open: string, close = open): BarItem => ({
					icon,
					label,
					active: isWrapped(doc, from, to, open, close),
					onClick: wrap(open, close),
				});
				const lines = (fn: (s: string) => string) => () => {
					const r = lineRange(v, from, to);
					replaceSel(v, r.from, r.to, fn(v.state.sliceDoc(r.from, r.to)));
				};
				const color = (_e: MouseEvent, btn: HTMLElement) =>
					bar.openPanel(btn, (p, close) => buildColorPanel(p, (cls, bg) => applyChange(v, setColor(v.state.doc.toString(), from, to, cls, bg)), close));
				const link = () => {
					const label = text.trim();
					bar.hide();
					new PagePicker(plugin, /^(https?:\/\/|www\.)/i.test(label) ? '' : label, async (target, typed, url) => {
						if (url) return replaceSel(v, from, to, `[${label.replace(/[[\]]/g, '') || url}](${url.replace(/\s/g, '%20')})`, false);
						const f = target ?? (await plugin.createPageNamed(typed, file));
						if (f) replaceSel(v, from, to, plugin.linkTo(f, file?.path ?? '', label), false);
					}).open();
				};
				const extract = async () => {
					const r = lineRange(v, from, to);
					const body = v.state.sliceDoc(r.from, r.to);
					const firstLine = stripFormatting(body.split('\n').find((l) => l.trim()) ?? tx('Nuova pagina')).replace(/^[#>\-*+\d.\s[\]x]+/, '');
					const name = await prompt(app, tx('Sposta in una nuova pagina'), sanitizeFileName(firstLine).slice(0, 60), tx('Titolo della nuova pagina'), tx('Crea pagina'));
					if (!name) return;
					const f = await app.vault.create(availablePath(app, file?.parent?.path ?? '', sanitizeFileName(name), 'md'), body + '\n');
					if (v.state.sliceDoc(r.from, r.to) === body) replaceSel(v, r.from, r.to, plugin.linkTo(f, file?.path ?? ''), false);
					new Notice(tx('Creata la pagina “{0}”', f.basename));
				};
				const copy = () => {
					void navigator.clipboard.writeText(text.trim());
					new Notice(tx('Copiato'));
				};
				// AI is always the last button, and only when it is set up
				const ai: BarItem[] =
					plugin.settings.aiEnabled && plugin.ai.ready
						? ['sep', { icon: 'sparkles', text: 'AI', label: tx('Chiedi all’AI'), onClick: (e: MouseEvent) => showAiMenu(plugin, e, cmTarget(v, from, to), file, () => bar.hide()) }]
						: [];

				if (kind === 'image') {
					const start = text.length - text.trimStart().length;
					return imageItemsForRange(plugin, v, from + start, from + start + text.trim().length, bar);
				}
				if (kind === 'url') {
					const url = text.trim();
					const full = /^www\./i.test(url) ? 'https://' + url : url;
					return [
						{ icon: 'external-link', text: tx('Apri'), label: tx('Apri nel browser'), onClick: () => openExternal(full) },
						{
							icon: 'type',
							label: tx('Dai un titolo al link'),
							onClick: async () => {
								let guess = '';
								try {
									guess = decodeURIComponent(new URL(full).hostname.replace(/^www\./, ''));
								} catch {
									/* ignore */
								}
								const t = await prompt(app, tx('Titolo del link'), guess, '', tx('Applica'));
								if (t) replaceSel(v, from, to, `[${t}](${full})`);
							},
						},
						{ icon: 'copy', label: tx('Copia il link'), onClick: copy },
					];
				}
				if (kind === 'link') {
					const t = text.trim();
					const wl = WIKILINK_RE.exec(t);
					const ml = MDLINK_RE.exec(t);
					const target = wl ? wl[1] : ml![2];
					const shown = wl ? (wl[3] ?? wl[1]) : ml![1];
					const off = text.length - text.trimStart().length;
					const f0 = from + off;
					const t0 = f0 + t.length;
					return [
						{
							icon: 'arrow-up-right',
							text: tx('Apri'),
							label: tx('Apri il link'),
							onClick: () => (/^[a-z]+:\/\//i.test(target) ? openExternal(target) : app.workspace.openLinkText(decodeURI(target), file?.path ?? '', false)),
						},
						{
							icon: 'pencil',
							label: tx('Modifica il testo del link'),
							onClick: async () => {
								const n = await prompt(app, tx('Testo del link'), shown, '', tx('Applica'));
								if (n === null) return;
								const out = wl ? (n && n !== wl[1] ? `[[${wl[1]}|${n}]]` : `[[${wl[1]}]]`) : `[${n || target}](${target})`;
								replaceSel(v, f0, t0, out);
							},
						},
						{ icon: 'unlink', label: tx('Rimuovi il link'), onClick: () => replaceSel(v, f0, t0, shown) },
						'sep',
						fmt('bold', tx('Grassetto'), '**'),
						fmt('italic', tx('Corsivo'), '*'),
					];
				}
				if (kind === 'multiline' || kind === 'todo') {
					const perLine = (open: string, close = open) => () => {
						const r = lineRange(v, from, to);
						replaceSel(v, r.from, r.to, wrapLines(v.state.sliceDoc(r.from, r.to), open, close));
					};
					return [
						{ icon: 'bold', label: tx('Grassetto'), onClick: perLine('**') },
						{ icon: 'italic', label: tx('Corsivo'), onClick: perLine('*') },
						{ icon: 'strikethrough', label: tx('Barrato'), onClick: perLine('~~') },
						{ icon: 'highlighter', label: tx('Evidenzia'), onClick: perLine('==') },
						'sep',
						{ icon: 'list', label: tx('Elenco puntato'), onClick: lines((s) => transformLines(s, 'ul')) },
						kind === 'todo'
							? { icon: 'check-check', label: tx('Spunta / togli la spunta a tutte'), onClick: lines(toggleTodos) }
							: { icon: 'list-checks', label: tx('Lista di cose da fare'), onClick: lines((s) => transformLines(s, 'todo')) },
						{ icon: 'list-ordered', label: tx('Elenco numerato'), onClick: lines((s) => transformLines(s, 'ol')) },
						'sep',
						{ icon: 'file-output', label: tx('Sposta in una nuova pagina'), onClick: extract },
						...ai,
					];
				}
				// plain text
				return [
					fmt('bold', tx('Grassetto'), '**'),
					fmt('italic', tx('Corsivo'), '*'),
					fmt('underline', tx('Sottolineato'), '<u>', '</u>'),
					fmt('strikethrough', tx('Barrato'), '~~'),
					fmt('code', tx('Codice'), '`'),
					fmt('highlighter', tx('Evidenzia'), '=='),
					{ icon: 'palette', label: tx('Colore'), onClick: color },
					'sep',
					{ icon: 'link', text: tx('Link'), label: tx('Collega una pagina o un sito'), onClick: link },
					...ai,
				];
			}

			destroy() {
				if (this.timer) window.clearTimeout(this.timer);
				this.view.dom.removeEventListener('mousedown', this.onDown);
				this.view.dom.ownerDocument.removeEventListener('mouseup', this.onUp);
				this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
				this.view.dom.removeEventListener('keydown', this.onKey);
				this.bar.hide();
			}
		},
	);
}

/** Toolbar for selections in reading mode (text there is not editable directly). */
export class ReadingSelectionBar {
	bar = new FloatingBar('ambraia-selection-bar is-reading');
	private timer: number | null = null;
	constructor(private plugin: AmbraiaPlugin) {}

	load() {
		this.plugin.registerDomEvent(document, 'selectionchange', () => {
			if (this.timer) window.clearTimeout(this.timer);
			this.timer = window.setTimeout(() => this.refresh(), 250);
		});
		this.plugin.registerDomEvent(document, 'mousedown', (e) => {
			if (!this.bar.contains(e.target as Node)) this.bar.hide();
		});
	}

	unload() {
		if (this.timer) window.clearTimeout(this.timer);
		this.bar.hide();
	}

	private refresh() {
		if (!this.plugin.settings.selectionToolbar) return this.bar.hide();
		const sel = activeWindow.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) return this.bar.hide();
		const node = sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement;
		const reading = node?.closest('.markdown-reading-view');
		if (!reading) return this.bar.hide();
		const text = sel.toString();
		if (!text.trim()) return this.bar.hide();
		const rect = sel.getRangeAt(0).getBoundingClientRect();
		const app = this.plugin.app;
		const view = app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		const highlight = async () => {
			if (!file) return;
			const needle = text.trim();
			const content = await app.vault.read(file);
			const first = content.indexOf(needle);
			if (first < 0) return new Notice(tx('Il testo selezionato contiene formattazione: passa in modalità modifica per evidenziarlo.'));
			if (content.indexOf(needle, first + 1) >= 0) return new Notice(tx('Questo testo compare più volte: passa in modalità modifica per scegliere quale evidenziare.'));
			await app.vault.process(file, (c) => (c.indexOf(needle) === first ? c.slice(0, first) + '==' + needle + '==' + c.slice(first + needle.length) : c));
			this.bar.hide();
		};
		const ai = this.plugin.settings.aiEnabled && this.plugin.ai.ready;
		this.bar.show(
			[
				{ icon: 'copy', text: tx('Copia'), label: tx('Copia'), onClick: () => navigator.clipboard.writeText(text).then(() => new Notice(tx('Copiato'))) },
				{ icon: 'highlighter', text: tx('Evidenzia'), label: tx('Evidenzia nella nota'), onClick: highlight },
				{
					icon: 'pencil',
					label: tx('Modifica qui'),
					onClick: async () => {
						if (!view) return;
						await view.setState({ ...view.getState(), mode: 'source' }, { history: false });
						const ed = view.editor;
						const idx = ed.getValue().indexOf(text.trim());
						if (idx >= 0) ed.setSelection(ed.offsetToPos(idx), ed.offsetToPos(idx + text.trim().length));
						ed.focus();
					},
				},
				...(ai
					? (['sep', { icon: 'sparkles', text: 'AI', label: tx('Chiedi all’AI'), onClick: (e: MouseEvent) => showAiMenu(this.plugin, e, readonlyTarget(text), file ?? null, () => this.bar.hide()) }] as BarItem[])
					: []),
			],
			{ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
			text,
		);
	}
}
