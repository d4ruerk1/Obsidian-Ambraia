import { Menu, Notice, Platform, setIcon } from 'obsidian';
import type AmbraiaPlugin from '../main';
import type { NavCustomButton } from '../settings';
import { tx } from '../i18n';
import { CommandPicker, commandsOf } from './navButtons';
import { pickIcon } from './pickers';

type Shower = (this: Menu, ...a: unknown[]) => unknown;
type Vault = { getConfig?(k: string): unknown; setConfig?(k: string, v: unknown): void };

/**
 * Ribbon extras:
 * - shortcuts to any command, added from the ribbon's own right-click menu ("Add shortcut…");
 * - when the ribbon is hidden, right-clicking an empty spot of the file explorer offers to show it again.
 * Obsidian's menus are not replaced: our items are appended to the menu Obsidian is about to open.
 */
export class RibbonTools {
	private els = new Map<string, HTMLElement>();
	private pending: 'ribbon' | 'explorer' | null = null;
	private restore: (() => void) | null = null;

	constructor(private plugin: AmbraiaPlugin) {}

	load() {
		this.refresh();
		this.patchMenu();
		this.plugin.registerDomEvent(document, 'contextmenu', (e) => this.onContextMenu(e), { capture: true });
	}

	unload() {
		this.restore?.();
		this.restore = null;
		for (const el of this.els.values()) this.drop(el);
		this.els.clear();
	}

	/** Removes one button, also from the ribbon's own list (Settings → Appearance → Ribbon). */
	private drop(el: HTMLElement) {
		el.detach();
		const ribbon = (this.app.workspace as unknown as { leftRibbon?: { items?: { buttonEl?: HTMLElement }[] } }).leftRibbon;
		const items = ribbon?.items;
		if (Array.isArray(items)) {
			const i = items.findIndex((x) => x?.buttonEl === el);
			if (i >= 0) items.splice(i, 1);
		}
	}

	private get app() {
		return this.plugin.app;
	}

	/** Draws the shortcut buttons of the settings (missing commands are skipped, not deleted). */
	refresh() {
		const list = this.plugin.settings.ribbonCustom ?? [];
		for (const [id, el] of this.els) {
			if (list.some((c) => c.id === id)) continue;
			this.drop(el);
			this.els.delete(id);
		}
		for (const c of list) {
			const old = this.els.get(c.id);
			if (old) {
				setIcon(old, c.icon);
				old.setAttr('aria-label', c.label);
				continue;
			}
			const el = this.plugin.addRibbonIcon(c.icon, c.label, () => {
				if (!commandsOf(this.app).executeCommandById(c.command)) new Notice(tx('Comando non disponibile (plugin disattivato?)'));
			});
			el.addClass('ambraia-ribbon-custom');
			this.els.set(c.id, el);
		}
	}

	/** Command → icon → new ribbon button. */
	addShortcut(after?: () => void) {
		new CommandPicker(this.app, async (cmd) => {
			const icon = (await pickIcon(this.app, false, true)) || cmd.icon || 'terminal-square';
			const b: NavCustomButton = { id: `r${Date.now().toString(36)}`, icon: icon.replace(/^lucide-/, ''), command: cmd.id, label: cmd.name };
			this.plugin.settings.ribbonCustom = [...(this.plugin.settings.ribbonCustom ?? []), b];
			await this.plugin.saveSettings();
			this.refresh();
			after?.();
			new Notice(tx('Scorciatoia aggiunta alla barra multifunzione: {0}', cmd.name));
		}).open();
	}

	async removeShortcut(id: string) {
		this.plugin.settings.ribbonCustom = (this.plugin.settings.ribbonCustom ?? []).filter((c) => c.id !== id);
		await this.plugin.saveSettings();
		this.refresh();
	}

	ribbonShown(): boolean {
		return (this.app.vault as unknown as Vault).getConfig?.('showRibbon') !== false;
	}

	showRibbon() {
		const app = this.app as unknown as { updateRibbonDisplay?(): void; workspace: { leftRibbon?: { containerEl?: HTMLElement } } };
		(this.app.vault as unknown as Vault).setConfig?.('showRibbon', true);
		if (app.updateRibbonDisplay) app.updateRibbonDisplay();
		else app.workspace.leftRibbon?.containerEl?.show();
	}

	private onContextMenu(e: MouseEvent) {
		if (Platform.isMobile) return;
		const t = e.target as HTMLElement | null;
		if (!t?.closest) return;
		if (t.closest('.workspace-ribbon.mod-left')) this.pending = 'ribbon';
		else if (!this.ribbonShown() && t.closest('.nav-files-container') && !t.closest('.tree-item-self')) this.pending = 'explorer';
		else return;
		const kind = this.pending;
		const x = e.clientX;
		const y = e.clientY;
		// Obsidian opens its own menu in its handler; if it does not, ours is shown alone
		window.setTimeout(() => {
			if (this.pending !== kind) return;
			this.pending = null;
			const m = new Menu();
			this.addItems(m, kind);
			m.showAtPosition({ x, y });
		}, 0);
	}

	private addItems(m: Menu, kind: 'ribbon' | 'explorer') {
		if (kind === 'explorer') {
			m.addItem((i) => i.setTitle(tx('Mostra la barra multifunzione')).setIcon('panel-left').setSection('ambraia').onClick(() => this.showRibbon()));
			return;
		}
		m.addItem((i) => i.setTitle(tx('Aggiungi scorciatoia…')).setIcon('plus').setSection('ambraia').onClick(() => this.addShortcut()));
		const custom = this.plugin.settings.ribbonCustom ?? [];
		if (custom.length)
			m.addItem((i) => {
				i.setTitle(tx('Rimuovi scorciatoia')).setIcon('minus').setSection('ambraia');
				const sub = (i as unknown as { setSubmenu?(): Menu }).setSubmenu?.();
				if (!sub) return i.onClick(() => this.plugin.openSettings());
				for (const c of custom) sub.addItem((s) => s.setTitle(c.label).setIcon(c.icon).onClick(() => void this.removeShortcut(c.id)));
			});
	}

	/** Appends our items to the next menu Obsidian opens right after a right-click on the ribbon / explorer. */
	private patchMenu() {
		const proto = Menu.prototype as unknown as Record<'showAtMouseEvent' | 'showAtPosition', Shower>;
		const origEvent = proto.showAtMouseEvent;
		const origPos = proto.showAtPosition;
		const self = this;
		const take = (menu: Menu) => {
			const kind = self.pending;
			if (!kind) return;
			self.pending = null;
			self.addItems(menu, kind);
		};
		proto.showAtMouseEvent = function (this: Menu, ...a: unknown[]) {
			take(this);
			return origEvent.apply(this, a);
		};
		proto.showAtPosition = function (this: Menu, ...a: unknown[]) {
			take(this);
			return origPos.apply(this, a);
		};
		this.restore = () => {
			proto.showAtMouseEvent = origEvent;
			proto.showAtPosition = origPos;
		};
	}
}
