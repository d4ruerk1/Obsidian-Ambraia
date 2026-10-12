import { App, FuzzySuggestModal, Menu, setIcon, TFolder } from 'obsidian';
import type AmbraiaPlugin from '../main';
import type { NavCustomButton } from '../settings';
import { currentLanguage, tx } from '../i18n';
import { moment } from './util';
import { createFromTemplate, TemplatePicker } from '../templates';

/** Native buttons of the file explorer toolbar, recognised by their Lucide icon (labels are translated). */
export const NATIVE_NAV: { id: string; label: () => string; icon: string; match: RegExp }[] = [
	{ id: 'new-note', label: () => tx('Nuova nota'), icon: 'square-pen', match: /lucide-(edit|square-pen|pencil-line|file-plus)\b/ },
	{ id: 'new-folder', label: () => tx('Nuova cartella'), icon: 'folder-plus', match: /lucide-folder-plus\b/ },
	{ id: 'sort', label: () => tx('Ordinamento'), icon: 'arrow-up-narrow-wide', match: /lucide-(sort|arrow-up-narrow-wide|arrow-down-wide-narrow|arrow-up-down|arrow-down-up)/ },
	{ id: 'reveal', label: () => tx('Mostra il file attivo'), icon: 'locate-fixed', match: /lucide-(gallery-vertical|locate|crosshair|scan)/ },
	{ id: 'collapse', label: () => tx('Comprimi / espandi tutto'), icon: 'chevrons-down-up', match: /lucide-chevrons-(down-up|up-down)\b/ },
];

/** Label of a custom button: the built-in "today" button follows the interface language. */
export const navLabel = (c: NavCustomButton) => (c.command === 'ambraia:daily-today' ? tx('Nota di oggi') : c.label);

interface Commands {
	commands: Record<string, { id: string; name: string; icon?: string }>;
	executeCommandById(id: string): boolean;
}
export const commandsOf = (app: App): Commands => {
	const c = (app as unknown as { commands?: Partial<Commands> }).commands;
	return { commands: c?.commands ?? {}, executeCommandById: (id: string) => c?.executeCommandById?.(id) ?? false };
};

/** Identifies a native toolbar button; unknown ones get a position-based id. */
export function nativeId(btn: HTMLElement, index: number): string {
	const cls = Array.from(btn.querySelectorAll('svg')).map((s) => s.getAttribute('class') ?? '').join(' ');
	return NATIVE_NAV.find((n) => n.match.test(cls))?.id ?? 'native-' + index;
}

/**
 * Customises the toolbar of Obsidian's file explorer (`.nav-header .nav-buttons-container`):
 * hides native buttons, adds buttons that run any command and turns "New note" into a small menu.
 * Nothing is removed from the DOM: native buttons are only hidden, so turning the plugin off restores them.
 */
export class NavButtons {
	private bars = new Set<HTMLElement>();
	constructor(private plugin: AmbraiaPlugin) {}

	apply(container: HTMLElement) {
		const bar = container.querySelector<HTMLElement>('.nav-header .nav-buttons-container');
		if (!bar) return;
		this.bars.add(bar);
		const s = this.plugin.settings;
		if (!bar.dataset.ambraiaNav) {
			bar.dataset.ambraiaNav = '1';
			// capture phase on the container: runs before the button's own handler
			this.plugin.registerDomEvent(bar, 'click', (e) => this.onClick(e, bar), { capture: true });
		}
		const natives = Array.from(bar.children).filter((c): c is HTMLElement => c.instanceOf(HTMLElement) && !c.hasClass('ambraia-nav-custom'));
		natives.forEach((b, i) => {
			const id = b.dataset.ambraiaId || nativeId(b, i);
			b.dataset.ambraiaId = id;
			const replaced = s.navCustom.some((c) => c.replaces === id);
			b.toggleClass('ambraia-hidden', s.navHidden.includes(id) || replaced);
		});
		const sig = JSON.stringify(s.navCustom) + currentLanguage();
		if (bar.dataset.ambraiaSig === sig && bar.querySelectorAll('.ambraia-nav-custom').length === s.navCustom.length) return;
		bar.dataset.ambraiaSig = sig;
		bar.querySelectorAll('.ambraia-nav-custom').forEach((e) => e.remove());
		for (const c of s.navCustom) {
			const b = createDiv({ cls: 'clickable-icon nav-action-button ambraia-nav-custom', attr: { 'aria-label': navLabel(c) } });
			b.dataset.ambraiaCustom = c.id;
			setIcon(b, c.icon.replace(/^lucide-/, '') || 'circle');
			const anchor = c.replaces ? natives.find((n) => n.dataset.ambraiaId === c.replaces) : undefined;
			if (anchor) anchor.after(b);
			else bar.appendChild(b);
		}
	}

	private onClick(e: MouseEvent, bar: HTMLElement) {
		const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('.nav-action-button');
		if (!btn || !bar.contains(btn)) return;
		const custom = btn.dataset.ambraiaCustom;
		if (custom) {
			e.preventDefault();
			e.stopPropagation();
			const c = this.plugin.settings.navCustom.find((x) => x.id === custom);
			if (c) this.run(c);
			return;
		}
		if (btn.dataset.ambraiaId === 'new-note' && this.plugin.settings.newNoteMenu) {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.newMenu(btn, () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
		}
	}

	private run(c: NavCustomButton) {
		if (c.command === 'ambraia:daily-today') void this.plugin.openPeriodic('day', moment());
		else commandsOf(this.plugin.app).executeCommandById(c.command);
	}

	/** "New" menu: note, canvas, daily note, from template. */
	newMenu(anchor: HTMLElement, nativeNew?: () => void) {
		const app = this.plugin.app;
		const menu = new Menu();
		menu.addItem((i) =>
			i.setTitle(tx('Nuova nota')).setIcon('file-text').onClick(() => {
				if (nativeNew) {
					// the original handler creates the note where Obsidian would
					const s = this.plugin.settings;
					s.newNoteMenu = false;
					try {
						nativeNew();
					} finally {
						s.newNoteMenu = true;
					}
				} else commandsOf(app).executeCommandById('file-explorer:new-file');
			}),
		);
		const canvas = !!commandsOf(app).commands['canvas:new-file'];
		if (canvas) menu.addItem((i) => i.setTitle(tx('Lavagna')).setIcon('layout-dashboard').onClick(() => commandsOf(app).executeCommandById('canvas:new-file')));
		menu.addItem((i) => i.setTitle(tx('Nota giornaliera')).setIcon('calendar-check').onClick(() => void this.plugin.openPeriodic('day', moment())));
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle(tx('Galleria modelli…')).setIcon('layout-template').onClick(() => {
				new TemplatePicker(this.plugin, (t) => void createFromTemplate(this.plugin, t, this.parentFolder())).open();
			}),
		);
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	private parentFolder(): TFolder {
		return this.plugin.app.fileManager.getNewFileParent(this.plugin.app.workspace.getActiveFile()?.path ?? '');
	}

	unload() {
		const bars = new Set([...this.bars, ...Array.from(document.querySelectorAll<HTMLElement>('.nav-buttons-container[data-ambraia-nav]'))]);
		for (const bar of bars) {
			bar.querySelectorAll('.ambraia-nav-custom').forEach((e) => e.remove());
			bar.querySelectorAll<HTMLElement>('[data-ambraia-id]').forEach((e) => {
				e.removeClass('ambraia-hidden');
				delete e.dataset.ambraiaId;
			});
			delete bar.dataset.ambraiaSig;
			delete bar.dataset.ambraiaNav;
		}
		this.bars.clear();
	}
}

/** Picks a command from the command palette list. */
export class CommandPicker extends FuzzySuggestModal<{ id: string; name: string; icon?: string }> {
	constructor(app: App, private onPick: (c: { id: string; name: string; icon?: string }) => void | Promise<void>) {
		super(app);
		this.setPlaceholder(tx('Scegli un comando…'));
	}
	getItems() {
		return Object.values(commandsOf(this.app).commands).sort((a, b) => a.name.localeCompare(b.name));
	}
	getItemText(c: { name: string }) {
		return c.name;
	}
	onChooseItem(c: { id: string; name: string; icon?: string }) {
		void this.onPick(c);
	}
}
