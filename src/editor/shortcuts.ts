import { EditorSelection, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { editorInfoField, Modal, Platform } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { LineKind, stripPrefix, toggleInline, transformLines } from './textOps';
import { tx } from '../i18n';

/** Block types reachable with Mod-Shift-0…8 (Mod-Alt-0…8 on macOS). */
export const BLOCK_KEYS: [string, LineKind][] = [
	['0', 'plain'],
	['1', 'h1'],
	['2', 'h2'],
	['3', 'h3'],
	['4', 'todo'],
	['5', 'ul'],
	['6', 'ol'],
	['7', 'toggle'],
	['8', 'code'],
];

const blockLabels = (): Partial<Record<LineKind, string>> => ({
	plain: tx('Testo'),
	h1: tx('Titolo 1'),
	h2: tx('Titolo 2'),
	h3: tx('Titolo 3'),
	todo: tx('Lista di cose da fare'),
	ul: tx('Elenco puntato'),
	ol: tx('Elenco numerato'),
	toggle: tx('Elenco a scomparsa'),
	code: tx('Blocco di codice'),
});

const KIND_RE: Partial<Record<LineKind, RegExp>> = {
	h1: /^#\s/,
	h2: /^##\s/,
	h3: /^###\s/,
	todo: /^\s*[-*+]\s+\[.\]\s/,
	ul: /^\s*[-*+]\s(?!\[.\]\s)/,
	ol: /^\s*\d+[.)]\s/,
};

/** Turns the lines into a block type; applying the same type again turns them back into text. */
export function toggleBlock(text: string, kind: LineKind): string {
	const lines = text.split('\n').filter((l) => l.trim());
	const re = KIND_RE[kind];
	if (re && lines.length && lines.every((l) => re.test(l))) return transformLines(text, 'plain');
	if (kind === 'code' && /^```[^\n]*\n[\s\S]*\n```$/.test(text)) return text.replace(/^```[^\n]*\n|\n```$/g, '');
	if (kind === 'toggle' && /^> \[![^\]]+\]-/.test(text)) return text.split('\n').map((l, i) => (i === 0 ? l.replace(/^> \[![^\]]+\]-\s?/, '') : l.replace(/^>\s?/, ''))).filter((l, i) => i > 0 || l).join('\n');
	if (kind === 'plain') {
		if (/^```[^\n]*\n[\s\S]*\n```$/.test(text)) return text.replace(/^```[^\n]*\n|\n```$/g, '');
		return text
			.split('\n')
			.map((l) => (/^>\s?\[![^\]]+\][-+]?\s?/.test(l) ? l.replace(/^>\s?\[![^\]]+\][-+]?\s?/, '') : l.replace(/^>\s?/, '')))
			.map((l) => (l.trim() ? stripPrefix(l).indent + stripPrefix(l).body : l))
			.join('\n');
	}
	return transformLines(text, kind);
}

function lineSpan(view: EditorView): { from: number; to: number } {
	const s = view.state.selection.main;
	const doc = view.state.doc;
	const a = doc.lineAt(s.from);
	let b = doc.lineAt(s.to);
	if (!s.empty && s.to === b.from && b.number > a.number) b = doc.line(b.number - 1);
	return { from: a.from, to: b.to };
}

function setBlock(view: EditorView, kind: LineKind): boolean {
	const { from, to } = lineSpan(view);
	const before = view.state.sliceDoc(from, to);
	const out = toggleBlock(before, kind);
	const cursorAtEnd = view.state.selection.main.empty;
	view.dispatch({
		changes: { from, to, insert: out },
		selection: cursorAtEnd ? EditorSelection.cursor(from + out.length) : EditorSelection.range(from, from + out.length),
		userEvent: 'input.ambraia',
		scrollIntoView: true,
	});
	return true;
}

function inline(view: EditorView, open: string, close = open): boolean {
	const s = view.state.selection.main;
	const c = toggleInline(view.state.doc.toString(), s.from, s.to, open, close);
	view.dispatch({ changes: { from: c.from, to: c.to, insert: c.insert }, selection: EditorSelection.range(c.selFrom, c.selTo), userEvent: 'input.ambraia' });
	return true;
}

/** Moves the selected lines one line up (-1) or down (1). */
function moveLines(view: EditorView, dir: -1 | 1): boolean {
	const doc = view.state.doc;
	const { from, to } = lineSpan(view);
	const a = doc.lineAt(from).number;
	const b = doc.lineAt(to).number;
	if ((dir < 0 && a === 1) || (dir > 0 && b === doc.lines)) return true;
	const other = doc.line(dir < 0 ? a - 1 : b + 1);
	const block = view.state.sliceDoc(from, to);
	const s = view.state.selection.main;
	const shift = dir < 0 ? -(other.length + 1) : other.length + 1;
	const changes = dir < 0 ? { from: other.from, to, insert: block + '\n' + other.text } : { from, to: other.to, insert: other.text + '\n' + block };
	view.dispatch({ changes, selection: EditorSelection.range(s.anchor + shift, s.head + shift), userEvent: 'move.line', scrollIntoView: true });
	return true;
}

const mac = () => !!(Platform as { isMacOS?: boolean }).isMacOS;

/** Keys of the block shortcuts on this platform ("Mod-Shift" or "Mod-Alt" on macOS). */
export const blockMod = () => (mac() ? 'Mod-Alt' : 'Mod-Shift');

/** Keyboard shortcuts for the editor (can be turned off in the settings). */
export function shortcutsExtension(plugin: AmbraiaPlugin): Extension {
	const on = (fn: (v: EditorView) => boolean) => (v: EditorView) => (plugin.settings.shortcuts ? fn(v) : false);
	const bindings = [
		{ key: 'Mod-u', run: on((v) => inline(v, '<u>', '</u>')) },
		{ key: 'Mod-Shift-s', run: on((v) => inline(v, '~~')) },
		{ key: 'Mod-Shift-h', run: on((v) => inline(v, '==')) },
		{ key: 'Mod-Shift-e', run: on((v) => inline(v, '`')) },
		{
			key: 'Mod-Shift-k',
			run: on((v) => {
				const ed = plugin.app.workspace.activeEditor?.editor;
				if (!ed) return false;
				void plugin.linkPage(ed, v.state.field(editorInfoField, false)?.file ?? null);
				return true;
			}),
		},
		{ key: 'Mod-Shift-ArrowUp', run: on((v) => moveLines(v, -1)) },
		{ key: 'Mod-Shift-ArrowDown', run: on((v) => moveLines(v, 1)) },
		...BLOCK_KEYS.map(([n, kind]) => ({ key: `${blockMod()}-${n}`, run: on((v) => setBlock(v, kind)) })),
	];
	return Prec.high(keymap.of(bindings));
}

/** Readable key combination for this platform: "Mod-Shift-1" → "Ctrl + Shift + 1" or "⌘⇧1". */
export function keyLabel(combo: string): string {
	const parts = combo.split('-');
	const isMac = mac();
	const names: Record<string, [string, string]> = {
		Mod: ['⌘', 'Ctrl'],
		Shift: ['⇧', 'Shift'],
		Alt: ['⌥', 'Alt'],
		ArrowUp: ['↑', '↑'],
		ArrowDown: ['↓', '↓'],
		Enter: ['↵', 'Enter'],
	};
	const out = parts.map((p) => names[p]?.[isMac ? 0 : 1] ?? (p.length === 1 ? p.toUpperCase() : p));
	return isMac ? out.join('') : out.join(' + ');
}

/** Cheat-sheet with all the shortcuts (command "Mostra le scorciatoie da tastiera"). */
export class ShortcutsModal extends Modal {
	constructor(private plugin: AmbraiaPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass('ambraia-shortcuts-modal');
		this.setTitle(tx('Scorciatoie da tastiera'));
		const c = this.contentEl;
		c.empty();
		if (!this.plugin.settings.shortcuts) c.createDiv({ cls: 'ambraia-shortcuts-off', text: tx('Le scorciatoie sono disattivate nelle impostazioni.') });
		const groups: [string, [string, string][]][] = [
			[
				tx('Testo'),
				[
					['Mod-b', tx('Grassetto')],
					['Mod-i', tx('Corsivo')],
					['Mod-u', tx('Sottolineato')],
					['Mod-Shift-s', tx('Barrato')],
					['Mod-Shift-h', tx('Evidenzia')],
					['Mod-Shift-e', tx('Codice')],
					['Mod-Shift-k', tx('Collega una pagina o un sito')],
				],
			],
			[tx('Blocchi'), BLOCK_KEYS.map(([n, kind]) => [`${blockMod()}-${n}`, blockLabels()[kind]!] as [string, string])],
			[
				tx('Altro'),
				[
					['/', tx('Menu dei blocchi')],
					['@', tx('Menziona una pagina o una data')],
					['Mod-Shift-ArrowUp', tx('Sposta la riga in su')],
					['Mod-Shift-ArrowDown', tx('Sposta la riga in giù')],
				],
			],
		];
		const grid = c.createDiv({ cls: 'ambraia-shortcuts' });
		for (const [title, rows] of groups) {
			const g = grid.createDiv({ cls: 'ambraia-shortcuts-group' });
			g.createDiv({ cls: 'ambraia-shortcuts-title', text: title });
			for (const [k, label] of rows) {
				const r = g.createDiv({ cls: 'ambraia-shortcuts-row' });
				r.createSpan({ text: label });
				r.createEl('kbd', { text: k.length === 1 ? k : keyLabel(k) });
			}
		}
		const foot = c.createDiv({ cls: 'ambraia-shortcuts-foot' });
		const btn = foot.createEl('button', { text: tx('Personalizza i comandi') });
		btn.onclick = () => {
			this.close();
			const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): { setQuery?(q: string): void; searchComponent?: { setValue(v: string): void } } | void } }).setting;
			setting?.open();
			const tab = setting?.openTabById('hotkeys');
			if (tab && tab.searchComponent) {
				tab.searchComponent.setValue('Ambraia');
				tab.setQuery?.('Ambraia');
			}
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
