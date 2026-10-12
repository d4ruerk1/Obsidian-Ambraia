import type { Menu } from 'obsidian';

/**
 * The note menu (⋯ in the top right corner) lists ~30 actions. With "essential note menu" on,
 * Ambraia hides the ones that are rarely used or duplicated elsewhere, keeping:
 * open/split, reading view, rename, move, bookmark, find, export to PDF, version history,
 * the actions of other plugins, and delete.
 * Items are recognised by section and icon (never by their translated title), so this works in
 * every language; anything unknown is kept. Uses Obsidian's internal menu list defensively.
 */
const HIDDEN_SECTIONS = new Set(['info.copy', 'view.linked', 'system']);
/** [section, icon] pairs hidden from the menu ("*" = any section). */
const HIDDEN_ITEMS: [string, string][] = [
	['pane', 'lucide-link'], // link / unlink tab
	['pane', 'links-coming-in'], // backlinks in document
	['pane', 'lucide-pin'], // pin (also on the tab)
	['pane', 'lucide-code-2'], // source mode (Ctrl/Cmd+E and the status bar)
	['open', 'lucide-separator-horizontal'], // split down (split right stays)
	['open', 'lucide-picture-in-picture'], // move to new window
	['action', 'lucide-git-merge'], // merge entire file with
	['action', 'lucide-plus-circle'], // add file property (properties are hidden in notes)
	['action', 'lucide-files'], // make a copy
	['view', 'lucide-text-initial'], // inline title
	['view', 'lucide-list-ordered'], // line numbers
	['view', 'lucide-ruler'], // readable line length
	['view', 'lucide-monitor'], // start presentation
	['view', 'lucide-folder-open'], // reveal file in navigation
];

interface InternalItem {
	section?: string;
	iconEl?: HTMLElement;
	dom?: HTMLElement;
}

function iconOf(item: InternalItem): string {
	const svg = item.iconEl?.querySelector('svg');
	const cls = svg?.getAttribute('class') ?? '';
	return cls.split(/\s+/).find((c) => c && c !== 'svg-icon') ?? '';
}

export function isHiddenItem(section: string, icon: string): boolean {
	if (HIDDEN_SECTIONS.has(section)) return true;
	return HIDDEN_ITEMS.some(([s, i]) => (s === '*' || s === section) && i === icon);
}

/** Removes the non-essential entries right before the menu is shown. */
export function compactNoteMenu(menu: Menu) {
	const m = menu as unknown as { items?: InternalItem[]; showAtPosition: Menu['showAtPosition'] };
	if (!Array.isArray(m.items) || (m as { __ambraiaCompact?: boolean }).__ambraiaCompact) return;
	(m as { __ambraiaCompact?: boolean }).__ambraiaCompact = true;
	const show = m.showAtPosition;
	m.showAtPosition = function (this: unknown, ...args: Parameters<Menu['showAtPosition']>) {
		try {
			if (Array.isArray(m.items)) m.items = m.items.filter((it) => !it || typeof it !== 'object' || !('section' in it) || !isHiddenItem(String(it.section ?? ''), iconOf(it)));
		} catch {
			/* menu internals changed: show the full menu */
		}
		return show.apply(menu, args);
	};
}

const CLIPBOARD_ICONS = new Set(['lucide-scissors', 'lucide-copy', 'lucide-clipboard-paste', 'lucide-clipboard-type', 'lucide-clipboard', 'lucide-clipboard-copy', 'lucide-text-select']);

/**
 * Editor right-click menu: spelling suggestions stay on top, then Cut / Copy / Paste, then
 * Obsidian's link, format and insert entries, and Ambraia's own entries last.
 * Only the order changes; unknown internals leave the menu as it is.
 */
export function orderEditorMenu(menu: Menu) {
	const m = menu as unknown as { items?: InternalItem[]; sections?: string[]; showAtPosition: Menu['showAtPosition']; __ambraiaOrder?: boolean };
	if (!Array.isArray(m.items) || m.__ambraiaOrder) return;
	m.__ambraiaOrder = true;
	const show = m.showAtPosition;
	m.showAtPosition = function (this: unknown, ...args: Parameters<Menu['showAtPosition']>) {
		try {
			const items = (m.items ?? []).filter((it) => it && typeof it === 'object');
			const clip = new Set(items.filter((it) => CLIPBOARD_ICONS.has(iconOf(it))).map((it) => String(it.section ?? '')));
			const rank = (sec: string) => (/spell|correct/.test(sec) ? 0 : clip.has(sec) ? 1 : sec === 'ambraia' ? 3 : 2);
			if (clip.size && Array.isArray(m.items)) {
				const all = m.items;
				m.items = all.map((it, i) => ({ it, i })).sort((a, b) => rank(String(a.it?.section ?? '')) - rank(String(b.it?.section ?? '')) || a.i - b.i).map((x) => x.it);
				if (Array.isArray(m.sections)) {
					const secs = m.sections;
					m.sections = secs.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
				}
			}
		} catch {
			/* menu internals changed: keep Obsidian's order */
		}
		return show.apply(menu, args);
	};
}
