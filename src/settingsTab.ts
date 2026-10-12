import { App, Menu, Notice, PluginSettingTab, setIcon, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import { formatBytes } from './sync/health';
import type AmbraiaPlugin from './main';
import { LogModal, SyncManager } from './sync/manager';
import { EncryptionModal, PairModal, SetupMode, SetupModal } from './sync/setupModal';
import { DeviceEntry, deviceId, deviceName, NotAllowedError, setDeviceName } from './sync/devices';
import { helpButton } from './sync/help';
import { ALG_NAMES } from './sync/crypto';
import { cleanPath } from './sync/http';
import { isDesktopFs } from './sync/providers/localFolder';
import { LANGS, setLanguage } from './i18n';
import { confirm, destructive, prompt } from './ui/util';
import { MODE_LABELS } from './ai/manager';
import { modelLabel, PRESETS, preset } from './ai/providers';
import { ShortcutsModal } from './editor/shortcuts';
import { tx } from './i18n';
import { CommandPicker, commandsOf, NATIVE_NAV, navLabel } from './ui/navButtons';
import { pickIcon } from './ui/pickers';
import { brandBadge } from './ui/brands';
import { PROVIDERS } from './sync/providers';
import { DEFAULT_SETTINGS } from './settings';
import { KEY_WARNING, riskConfirm } from './safety';

type BoolKey = { [K in keyof AmbraiaPlugin['settings']]-?: AmbraiaPlugin['settings'][K] extends boolean ? K : never }[keyof AmbraiaPlugin['settings']];

export const REPO_URL = 'https://github.com/d4ruerk1/Obsidian-Ambraia';
export const DONATE_URL = 'https://ko-fi.com/d4ruerk1';

/** A Setting with a segmented control (a few options, all visible) instead of a dropdown. */
export function segmented<T extends string>(parent: HTMLElement, name: string, desc: string, options: [T, string][], value: T, onChange: (v: T) => void | Promise<void>): Setting {
	const st = new Setting(parent).setName(name);
	if (desc) st.setDesc(desc);
	const seg = st.controlEl.createDiv({ cls: 'ambraia-seg', attr: { role: 'radiogroup', 'aria-label': name } });
	for (const [v, label] of options) {
		const b = seg.createEl('button', { text: label, attr: { role: 'radio', 'aria-checked': String(v === value), 'data-value': v } });
		if (v === value) b.addClass('is-active');
		b.onclick = async () => {
			seg.querySelectorAll('button').forEach((x) => {
				x.toggleClass('is-active', x === b);
				x.setAttr('aria-checked', String(x === b));
			});
			await onChange(v);
		};
	}
	return st;
}

/** Collapsible "Avanzate" box at the end of a section. */
function advanced(parent: HTMLElement, label = tx('Avanzate')): HTMLElement {
	const d = parent.createEl('details', { cls: 'ambraia-settings-adv' });
	d.createEl('summary', { text: label });
	return d.createDiv('ambraia-settings-adv-body');
}

function group(parent: HTMLElement, title?: string, desc?: string): HTMLElement {
	const g = parent.createDiv('ambraia-set-group');
	if (title) g.createDiv({ cls: 'ambraia-set-group-title', text: title });
	if (desc) g.createDiv({ cls: 'ambraia-set-group-desc', text: desc });
	return g;
}

/** (?) next to a group title. */
function groupHelp(g: HTMLElement, title: string, lines: string[]) {
	const t = g.querySelector<HTMLElement>('.ambraia-set-group-title');
	if (t) helpButton(t, title, lines);
}

/** The sections of the settings, shown as tabs in a floating bar at the top. */
export type SectionId = 'general' | 'editor' | 'sync' | 'share' | 'ai' | 'calendar';
export const SECTION_IDS: SectionId[] = ['general', 'editor', 'sync', 'share', 'ai', 'calendar'];

export class AmbraiaSettingTab extends PluginSettingTab {
	private statusLine: HTMLElement | null = null;
	private subscribed = false;
	private navOpen = false;
	/** Section shown in the page: the first one every time the settings are opened. */
	private section: SectionId = 'general';
	private bodyEl: HTMLElement | null = null;
	private tabsEl: HTMLElement | null = null;
	/** Re-draws the section currently open (the tab bar stays where it is). */
	private redraw: () => void = () => this.renderSection();

	constructor(
		app: App,
		private plugin: AmbraiaPlugin,
	) {
		super(app, plugin);
	}

	private get s() {
		return this.plugin.settings;
	}

	private async save(refresh = false) {
		await this.plugin.saveSettings();
		if (refresh) this.plugin.refreshDecorations();
	}

	private toggle(parent: HTMLElement, name: string, desc: string, key: BoolKey, after?: (v: boolean) => void | Promise<void>): Setting {
		return new Setting(parent)
			.setName(name)
			.setDesc(desc)
			.addToggle((t) =>
				t.setValue(this.s[key]).onChange(async (v) => {
					(this.s[key]) = v;
					await this.save(true);
					await after?.(v);
				}),
			);
	}

	/**
	 * Empty on purpose: with no declarative definitions Obsidian calls display(), which draws
	 * the sections as horizontal tabs (first one already open) instead of a vertical list of pages.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [];
	}

	private sections(): { id: SectionId; icon: string; name: string; desc: string; draw: (el: HTMLElement) => void }[] {
		return [
			{ id: 'general', icon: 'sliders-horizontal', name: tx('Generale'), desc: tx('Lingua, tema, icone, copertine ed esplora file.'), draw: (el) => this.general(el) },
			{ id: 'editor', icon: 'pencil', name: tx('Editor'), desc: tx('Menu “/” e “@”, formattazione, proprietà e immagini.'), draw: (el) => this.editor(el) },
			{ id: 'sync', icon: 'refresh-cw', name: tx('Sincronizzazione'), desc: tx('Servizi cloud, cifratura end-to-end e dispositivi.'), draw: (el) => this.syncTab(el) },
			{ id: 'share', icon: 'share-2', name: tx('Condivisione'), desc: tx('Link per far leggere una nota a chi non usa il tuo vault.'), draw: (el) => renderShareSettings(el, this.plugin, this.redraw) },
			{ id: 'ai', icon: 'sparkles', name: tx('AI'), desc: tx('Assistente AI facoltativo, modelli e privacy.'), draw: (el) => renderAiSettings(el, this.plugin, this.redraw) },
			{ id: 'calendar', icon: 'calendar-days', name: tx('Calendario'), desc: tx('Note del giorno, diario e attività con scadenza.'), draw: (el) => renderCalendarSettings(el, this.plugin, this.redraw) },
		];
	}

	/** Floating tab bar + the open section + the credits row. */
	display(): void {
		if (!this.subscribed) {
			this.subscribed = true;
			this.plugin.sync.onChange(() => this.updateStatus());
		}
		const el = this.containerEl;
		el.empty();
		el.addClass('ambraia-settings', 'ambraia-settings-tabbed');
		const bar = el.createDiv({ cls: 'ambraia-set-tabs-wrap' });
		const tabs = (this.tabsEl = bar.createDiv({ cls: 'ambraia-set-tabs', attr: { role: 'tablist', 'aria-label': 'Ambraia' } }));
		const list = this.sections();
		for (const sec of list) {
			const b = tabs.createEl('button', {
				cls: 'ambraia-set-tab',
				attr: { role: 'tab', id: `ambraia-tab-${sec.id}`, 'data-section': sec.id, 'aria-controls': 'ambraia-set-panel', title: sec.desc },
			});
			setIcon(b.createSpan({ cls: 'ambraia-set-tab-icon' }), sec.icon);
			b.createSpan({ cls: 'ambraia-set-tab-label', text: sec.name });
			if (sec.id === 'sync') b.createSpan({ cls: 'ambraia-set-tab-dot' });
			b.onclick = () => this.openSection(sec.id);
			b.addEventListener('keydown', (ev: KeyboardEvent) => {
				const i = SECTION_IDS.indexOf(sec.id);
				const rtl = el.closest('.ambraia-rtl') !== null;
				let next = -1;
				if (ev.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = (i + 1) % list.length;
				else if (ev.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = (i - 1 + list.length) % list.length;
				else if (ev.key === 'Home') next = 0;
				else if (ev.key === 'End') next = list.length - 1;
				if (next < 0) return;
				ev.preventDefault();
				this.openSection(SECTION_IDS[next]);
				(tabs.querySelector(`[data-section="${SECTION_IDS[next]}"]`) as HTMLElement | null)?.focus();
			});
		}
		this.glider = tabs.createDiv({ cls: 'ambraia-set-tabs-glider', attr: { 'aria-hidden': 'true' } });
		// follows the bar when the window, the font or the language change its size
		this.gliderObserver?.disconnect();
		if (typeof ResizeObserver !== 'undefined') {
			this.gliderObserver = new ResizeObserver(() => this.placeGlider(true));
			this.gliderObserver.observe(tabs);
		}
		this.dragTabs(tabs);
		this.bodyEl = el.createDiv({ cls: 'ambraia-set-panel', attr: { id: 'ambraia-set-panel', role: 'tabpanel' } });
		this.footer(el);
		this.renderSection();
	}

	private glider: HTMLElement | null = null;

	/** Moves the glass indicator under the active tab (animated by CSS). */
	private gliderObserver: ResizeObserver | null = null;

	private placeGlider(instant = false) {
		const g = this.glider;
		const tab = this.tabsEl?.querySelector<HTMLElement>('.ambraia-set-tab.is-active');
		if (!g || !tab) return;
		// not laid out yet (settings still opening): hidden until a real size is known
		g.style.opacity = tab.offsetWidth ? '' : '0';
		if (!tab.offsetWidth) return;
		g.toggleClass('is-instant', instant || !g.style.width || g.style.width === '0px');
		g.style.width = `${tab.offsetWidth}px`;
		g.style.transform = `translateX(${tab.offsetLeft}px)`;
		// the bar may scroll sideways on phones: keep the active tab in view
		tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
	}

	/**
	 * Press and slide across the bar: the glass drop follows the finger / pointer, stretching a little,
	 * and settles on the tab where it is released.
	 */
	private dragTabs(tabs: HTMLElement) {
		let start = -1;
		let moved = false;
		let pid = -1;
		const tabAt = (x: number) => {
			let best: HTMLElement | null = null;
			let dist = Infinity;
			tabs.querySelectorAll<HTMLElement>('.ambraia-set-tab').forEach((b) => {
				const r = b.getBoundingClientRect();
				const d = Math.abs(r.left + r.width / 2 - x);
				if (d < dist) {
					dist = d;
					best = b;
				}
			});
			return best as HTMLElement | null;
		};
		tabs.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button !== 0 || !(e.target as HTMLElement).closest('.ambraia-set-tab')) return;
			start = e.clientX;
			moved = false;
			pid = e.pointerId;
		});
		tabs.addEventListener('pointermove', (e: PointerEvent) => {
			const g = this.glider;
			if (start < 0 || e.pointerId !== pid || !g) return;
			if (!moved && Math.abs(e.clientX - start) < 6) return;
			if (!moved) {
				moved = true;
				tabs.setPointerCapture?.(pid);
				tabs.addClass('is-dragging');
			}
			const box = tabs.getBoundingClientRect();
			const w = g.offsetWidth;
			const x = Math.max(4, Math.min(tabs.scrollWidth - w - 4, e.clientX - box.left + tabs.scrollLeft - w / 2));
			g.style.transform = `translateX(${x}px)`;
			const over = tabAt(e.clientX);
			tabs.querySelectorAll<HTMLElement>('.ambraia-set-tab').forEach((b) => b.toggleClass('is-hover', b === over));
		});
		const end = (e: PointerEvent) => {
			if (start < 0 || e.pointerId !== pid) return;
			start = -1;
			if (!moved) return;
			tabs.removeClass('is-dragging');
			tabs.querySelectorAll('.is-hover').forEach((b) => b.removeClass('is-hover'));
			const id = tabAt(e.clientX)?.dataset.section as SectionId | undefined;
			// the click that follows a slide must not open the tab where the slide started
			const stop = (ev: Event) => {
				ev.stopPropagation();
				ev.preventDefault();
			};
			tabs.addEventListener('click', stop, { capture: true, once: true });
			window.setTimeout(() => tabs.removeEventListener('click', stop, { capture: true }), 50);
			if (id && id !== this.section) this.openSection(id);
			else this.placeGlider();
		};
		tabs.addEventListener('pointerup', end);
		tabs.addEventListener('pointercancel', end);
	}

	/** Opens one section (tab) of the settings. */
	openSection(id: SectionId) {
		if (!SECTION_IDS.includes(id)) id = 'general';
		const changed = id !== this.section;
		this.section = id;
		if (!this.bodyEl) return this.display();
		this.renderSection();
		if (changed) this.containerEl.scrollTop = 0;
	}

	get currentSection(): SectionId {
		return this.section;
	}

	private renderSection() {
		const body = this.bodyEl;
		if (!body) return;
		const sec = this.sections().find((x) => x.id === this.section) ?? this.sections()[0];
		this.targetDots.clear();
		this.statusLine = null;
		body.empty();
		body.setAttr('aria-labelledby', `ambraia-tab-${sec.id}`);
		body.dataset.section = sec.id;
		this.tabsEl?.querySelectorAll<HTMLElement>('.ambraia-set-tab').forEach((b) => {
			const on = b.dataset.section === sec.id;
			b.toggleClass('is-active', on);
			b.setAttr('aria-selected', String(on));
			b.setAttr('tabindex', on ? '0' : '-1');
		});
		sec.draw(body);
		this.updateStatus();
		// measured after layout (the tab labels may change width with the language)
		window.requestAnimationFrame(() => this.placeGlider());
	}

	/** Credits: name and version on the left, links in the middle, the optional donation on the right. */
	private footer(parent: HTMLElement) {
		const f = parent.createDiv('ambraia-set-footer');
		const brand = f.createDiv('ambraia-set-footer-brand');
		setIcon(brand.createSpan('ambraia-set-footer-logo'), 'gem');
		const who = brand.createDiv('ambraia-set-footer-who');
		who.createDiv({ cls: 'ambraia-set-footer-name', text: `Ambraia ${this.plugin.manifest.version}` });
		who.createDiv({ cls: 'ambraia-set-footer-by', text: tx('di {0} · licenza MIT', this.plugin.manifest.author || 'd4ruerk1') });
		const links = f.createDiv('ambraia-set-footer-links');
		const link = (icon: string, text: string, href: string) => {
			const a = links.createEl('a', { cls: 'ambraia-set-footer-link', href, attr: { target: '_blank', rel: 'noopener' } });
			setIcon(a.createSpan(), icon);
			a.createSpan({ text });
		};
		link('github', 'GitHub', REPO_URL);
		link('shield-check', tx('Privacy'), REPO_URL + '#privacy');
		link('scale', tx('Note legali'), REPO_URL + '/blob/main/THIRD_PARTY_NOTICES.md');
		const donate = f.createEl('a', { cls: 'ambraia-donate', href: DONATE_URL, attr: { target: '_blank', rel: 'noopener', 'aria-label': tx('Facoltativo: Ambraia resta gratuito e completo.') } });
		setIcon(donate.createSpan({ cls: 'ambraia-donate-icon' }), 'coffee');
		donate.createSpan({ text: tx('Sostieni su Ko-fi') });
	}

	// ------------------------------------------------------------------ Generale

	private general(el: HTMLElement) {
		const look = group(el);
		new Setting(look)
			.setName(tx('Lingua'))
			.setDesc(tx('“Automatica” usa la lingua di Obsidian.'))
			.addDropdown((d) => {
				d.addOption('auto', tx('Automatica'));
				for (const [k, v] of Object.entries(LANGS)) d.addOption(k, v);
				d.setValue(this.s.language || 'auto').onChange(async (v) => {
					this.s.language = v;
					setLanguage(v);
					await this.save();
					this.display();
				});
			});
		this.toggle(look, tx('Tema Ambraia'), tx('Tipografia, colori, spaziature, tabelle e callout curati, in chiaro e in scuro.'), 'notionTheme');
		segmented(
			look,
			tx('Carattere'),
			'',
			[
				['standard', tx('Standard')],
				['serif', tx('Serif')],
				['mono', tx('Mono')],
				['obsidian', tx('Tema')],
			],
			this.s.font,
			async (v) => {
				this.s.font = v;
				await this.save();
			},
		);
		segmented(
			look,
			tx('Larghezza della pagina'),
			'',
			[
				['normal', tx('Normale')],
				['wide', tx('Larga')],
				['full', tx('Piena')],
			],
			this.s.contentWidth,
			async (v) => {
				this.s.contentWidth = v;
				await this.save();
			},
		);

		this.toggle(look, tx('Nuova Interfaccia'), tx('Rinnova l’aspetto di Obsidian: barre laterali morbide, schede e menu arrotondati, selezioni discrete e più spazio alla pagina. Disattivala per tornare all’aspetto originale.'), 'minimalUI');

		const pages = group(el, tx('Pagine'));
		this.toggle(pages, tx('Icona e copertina'), tx('Ogni pagina può avere un’icona e una copertina. L’icona è la stessa nell’esplora file, nei link e nel calendario.'), 'showHeader');
		this.toggle(pages, tx('Un’icona per ogni nota'), tx('Le note senza icona ne ricevono una scelta in base al nome. Puoi sempre cambiarla.'), 'autoIcons');
		this.toggle(pages, tx('Note delle cartelle'), tx('Una cartella diventa una pagina: “Progetti/Progetti.md” si apre cliccando la cartella.'), 'folderNotes');
		this.toggle(pages, tx('Nascondi le proprietà nelle note'), tx('Le proprietà restano nel file e si modificano dal pannello “Proprietà del file”. Le impostazioni di Obsidian non vengono cambiate.'), 'hideProperties');
		this.toggle(pages, tx('Menu della nota essenziale'), tx('Il menu ⋯ in alto a destra mostra solo le azioni più usate (apri, rinomina, sposta, segnalibro, cerca, esporta in PDF, cronologia, elimina).'), 'compactNoteMenu');

		this.explorerGroup(el);

		this.ribbonGroup(el);

		const adv = advanced(el);
		this.toggle(adv, tx('Icone nell’esplora file'), '', 'explorerIcons');
		new Setting(adv).setName(tx('Altezza della copertina')).addSlider((s) =>
			s
				.setLimits(120, 360, 10)
				.setValue(this.s.bannerHeight)
				.onChange(async (v) => {
					this.s.bannerHeight = v;
					await this.save(true);
				}),
		);
		new Setting(adv)
			.setName(tx('Proprietà di icona e copertina'))
			.setDesc(tx('Nomi delle proprietà nel frontmatter (vengono letti anche “sticker” e “banner”).'))
			.addText((t) =>
				t.setValue(this.s.iconKey).onChange(async (v) => {
					this.s.iconKey = v.trim() || 'icon';
					await this.save(true);
				}),
			)
			.addText((t) =>
				t.setValue(this.s.bannerKey).onChange(async (v) => {
					this.s.bannerKey = v.trim() || 'banner';
					await this.save(true);
				}),
			);

		new Setting(el)
			.setName(tx('Ripristina le impostazioni predefinite'))
			.setDesc(tx('Riporta ogni opzione al valore iniziale. Servizi cloud, preferiti, icone e viste salvate restano come sono.'))
			.addButton((b) =>
				b.setButtonText(tx('Ripristina…')).onClick(async () => {
					if (!(await confirm(this.app, tx('Ripristinare le impostazioni predefinite?'), tx('Servizi cloud, preferiti, spazi, icone e viste salvate restano come sono.'), tx('Ripristina')))) return;
					await this.plugin.resetSettings();
					setLanguage(this.s.language || 'auto');
					this.display();
				}),
			)
			.settingEl.addClass('ambraia-set-reset');
	}

	/** Shortcut buttons of the left ribbon (also added with a right-click on the ribbon). */
	private ribbonGroup(el: HTMLElement) {
		const g = group(el, tx('Barra multifunzione'), tx('Aggiungi pulsanti per i comandi che usi spesso. Puoi farlo anche con il tasto destro sulla barra a sinistra.'));
		const list = this.s.ribbonCustom ?? [];
		for (const c of list) {
			const exists = !!commandsOf(this.app).commands[c.command];
			const st = new Setting(g).setName(c.label).setDesc(exists ? '' : tx('Comando non disponibile (plugin disattivato?)'));
			st.settingEl.addClass('ambraia-nav-row');
			const ic = createSpan('ambraia-nav-row-icon');
			setIcon(ic, c.icon);
			st.nameEl.prepend(ic);
			st.addExtraButton((b) =>
				b.setIcon('image').setTooltip(tx('Cambia icona')).onClick(async () => {
					const icon = await pickIcon(this.app, false, true);
					if (!icon) return;
					c.icon = icon.replace(/^lucide-/, '');
					await this.save();
					this.plugin.ribbon.refresh();
					this.redraw();
				}),
			).addExtraButton((b) =>
				b.setIcon('trash-2').setTooltip(tx('Rimuovi')).onClick(async () => {
					await this.plugin.ribbon.removeShortcut(c.id);
					this.redraw();
				}),
			);
		}
		new Setting(g)
			.setName(list.length ? '' : tx('Nessuna scorciatoia'))
			.addButton((b) =>
				b.setButtonText(tx('Aggiungi scorciatoia…')).onClick(() => this.plugin.ribbon.addShortcut(() => this.redraw())),
			);
	}

	/** Toolbar of Obsidian's file explorer: native buttons on/off, buttons that run commands. */
	private explorerGroup(el: HTMLElement) {
		const g = group(el, tx('Esplora file'), tx('Personalizza i pulsanti in cima all’esplora file. I pulsanti di Obsidian vengono solo nascosti, mai eliminati.'));
		const refresh = async () => {
			await this.save();
			this.plugin.explorer.refreshNav();
		};
		this.toggle(g, tx('Menu “Nuova nota”'), tx('Il pulsante Nuova nota offre: nota, lavagna, nota giornaliera o una pagina dalla galleria modelli.'), 'newNoteMenu');
		const details = g.createEl('details', { cls: 'ambraia-settings-adv ambraia-nav-details' });
		details.open = this.navOpen;
		details.addEventListener('toggle', () => (this.navOpen = details.open));
		details.createEl('summary', { text: tx('Pulsanti dell’esplora file') });
		const list = details.createDiv('ambraia-nav-list');
		const row = (icon: string, name: string, desc: string) => {
			const st = new Setting(list).setName(name).setDesc(desc);
			st.settingEl.addClass('ambraia-nav-row');
			const ic = createSpan('ambraia-nav-row-icon');
			setIcon(ic, icon.replace(/^lucide-/, ''));
			st.nameEl.prepend(ic);
			return st;
		};
		for (const n of NATIVE_NAV) {
			const replacement = this.s.navCustom.find((c) => c.replaces === n.id);
			row(n.icon, n.label(), replacement ? tx('Sostituito da “{0}”', navLabel(replacement)) : tx('Pulsante di Obsidian'))
				.addExtraButton((b) =>
					b.setIcon('replace').setTooltip(tx('Sostituisci con un comando')).onClick(() => this.addNavButton(n.id)),
				)
				.addToggle((t) =>
					t.setValue(!this.s.navHidden.includes(n.id) && !replacement).onChange(async (v) => {
						this.s.navHidden = this.s.navHidden.filter((x) => x !== n.id);
						if (!v) this.s.navHidden.push(n.id);
						else this.s.navCustom = this.s.navCustom.filter((c) => c.replaces !== n.id);
						await refresh();
						this.redraw();
					}),
				);
		}
		for (const c of this.s.navCustom) {
			const exists = c.command === 'ambraia:daily-today' || !!commandsOf(this.app).commands[c.command];
			row(c.icon, navLabel(c), exists ? tx('Comando: {0}', commandsOf(this.app).commands[c.command]?.name ?? navLabel(c)) : tx('Comando non disponibile (plugin disattivato?)'))
				.addExtraButton((b) =>
					b.setIcon('image').setTooltip(tx('Cambia icona')).onClick(async () => {
						const icon = await pickIcon(this.app, false, true);
						if (!icon) return;
						c.icon = icon.replace(/^lucide-/, '');
						await refresh();
						this.redraw();
					}),
				)
				.addExtraButton((b) =>
					b.setIcon('trash-2').setTooltip(tx('Rimuovi')).onClick(async () => {
						this.s.navCustom = this.s.navCustom.filter((x) => x !== c);
						await refresh();
						this.redraw();
					}),
				);
		}
		new Setting(list)
			.addButton((b) => b.setButtonText(tx('Aggiungi pulsante…')).onClick(() => this.addNavButton()))
			.addButton((b) =>
				b.setButtonText(tx('Ripristina')).onClick(async () => {
					this.s.navHidden = [];
					this.s.navCustom = [{ id: 'today', icon: 'calendar-check', command: 'ambraia:daily-today', label: 'Nota di oggi' }];
					await refresh();
					this.redraw();
				}),
			);
	}

	/** Command → icon → new toolbar button (optionally in place of a native one). */
	private addNavButton(replaces?: string) {
		new CommandPicker(this.app, async (cmd) => {
			const icon = (await pickIcon(this.app, false, true)) || cmd.icon || 'circle';
			this.s.navCustom = this.s.navCustom.filter((c) => !replaces || c.replaces !== replaces);
			this.s.navCustom.push({ id: Date.now().toString(36), icon: icon.replace(/^lucide-/, ''), command: cmd.id, label: cmd.name, replaces });
			if (replaces) this.s.navHidden = this.s.navHidden.filter((x) => x !== replaces);
			await this.save();
			this.plugin.explorer.refreshNav();
			this.redraw();
		}).open();
	}

	// ------------------------------------------------------------------ Editor

	private editor(el: HTMLElement) {
		const g = group(el);
		this.toggle(g, tx('Menu “/”'), tx('Digita / per inserire titoli, liste, callout, tabelle, database, immagini…'), 'slashMenu');
		this.toggle(g, tx('Menzioni “@”'), tx('Digita @ per collegare una pagina o una data, o per crearne una nuova.'), 'mentions');
		this.toggle(g, tx('Barra di formattazione'), tx('Compare quando selezioni del testo o un’immagine.'), 'selectionToolbar');
		this.toggle(g, tx('Icone nei link'), tx('I link alle pagine mostrano la loro icona. Clic sull’icona per toglierla da un singolo link.'), 'linkIcons');
		const sc = this.toggle(g, tx('Scorciatoie da tastiera'), tx('Ctrl/Cmd + U sottolinea, Ctrl/Cmd + Shift + K collega una pagina, Ctrl/Cmd + Shift + numero cambia il tipo di blocco.'), 'shortcuts');
		sc.addExtraButton((b) => b.setIcon('keyboard').setTooltip(tx('Mostra le scorciatoie')).onClick(() => new ShortcutsModal(this.plugin).open()));

		const n = group(el, tx('Note'));
		new Setting(n)
			.setName(tx('Proprietà'))
			.setDesc(tx('Mai mostrate dentro le note, né compatte né estese: restano nel file e si modificano dal pannello laterale “Proprietà del file”.'))
			.addButton((b) =>
				b.setButtonText(tx('Apri il pannello')).onClick(() => {
					const cmds = (this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands;
					if (!cmds?.executeCommandById('properties:open-local')) new Notice(tx('Attiva il plugin core “Proprietà” di Obsidian per usare il pannello.'));
				}),
			);
		this.toggle(n, tx('Ottimizza le immagini'), tx('Le immagini grandi aggiunte con Ambraia vengono ridotte e salvate in WebP: occupano molto meno spazio.'), 'optimizeImages');

		const adv = advanced(el);
		new Setting(adv)
			.setName(tx('Carattere del menu dei blocchi'))
			.addText((t) => {
				t.setValue(this.s.slashTrigger).onChange(async (v) => {
					this.s.slashTrigger = v.trim().slice(0, 2) || '/';
					await this.save();
				});
				t.inputEl.size = 3;
			});
		this.toggle(adv, tx('Barra delle immagini'), tx('Clic su un’immagine: dimensione, allineamento, didascalia, sostituisci, elimina.'), 'imageToolbar');
	}

	// ------------------------------------------------------------------ Sync

	private syncTab(el: HTMLElement) {
		const sync = this.plugin.sync;
		const openSetup = (m?: SyncManager, mode: SetupMode = 'new') => {
			const modal = new SetupModal(this.app, this.plugin, m, mode);
			const close = modal.onClose.bind(modal);
			modal.onClose = () => {
				close();
				this.redraw();
			};
			modal.open();
		};

		// status of the whole sync, with the main action at hand (same card as the other tabs)
		const top = group(el);
		top.addClass('ambraia-set-status-card');
		const st = new Setting(top);
		this.statusLine = st.nameEl.createDiv('ambraia-settings-status');
		st.settingEl.addClass('ambraia-set-status-row');
		helpButton(st.nameEl, tx('Come funziona la sincronizzazione'), [
			tx('Le note vanno direttamente dal dispositivo al tuo cloud: nessun server di Ambraia in mezzo.'),
			tx('Le modifiche partono dopo circa un secondo e arrivano dagli altri dispositivi entro pochi secondi.'),
			tx('Con la cifratura end-to-end il servizio cloud vede solo file illeggibili.'),
			tx('Gli altri dispositivi si collegano con un codice di 8 caratteri e la tua approvazione.'),
		]);
		if (sync.connected) st.addButton((b) => b.setButtonText(tx('Sincronizza ora')).onClick(() => void sync.syncNow()));
		this.updateStatus();
		if (!sync.managers.length) {
			const start = new Setting(top)
				.setName(tx('Collega un servizio cloud'))
				.setDesc(tx('Con cifratura end-to-end. Se hai già Ambraia su un altro dispositivo basta un codice.'))
				.addButton((b) => b.setButtonText(tx('Configura')).setCta().onClick(() => openSetup()));
			const strip = start.descEl.createDiv('ambraia-brand-strip');
			for (const p of PROVIDERS) brandBadge(strip, p.id, p.name, p.color).setAttr('title', p.name);
		}

		if (sync.managers.length) {
			const list = group(el, tx('Servizi cloud'));
			groupHelp(list, tx('Servizi cloud'), [
				tx('Puoi usare più servizi insieme: ogni modifica viene inviata a tutti.'),
				tx('Il pallino indica lo stato: verde sincronizzato, arancione in pausa o bloccato, rosso da sistemare.'),
				tx('L’interruttore mette in pausa solo questo servizio, su questo dispositivo.'),
			]);
			list.addClass('ambraia-target-list');
			for (const m of sync.managers) this.renderTarget(list, m, (mode) => openSetup(m, mode));
			const add = new Setting(list)
				.setName(tx('Aggiungi un servizio'))
				.addButton((b) => b.setButtonText(tx('Aggiungi')).onClick(() => openSetup()));
			add.settingEl.addClass('ambraia-target-add');
		}

		const keys = ['syncConfigSettings', 'syncConfigAppearance', 'syncConfigPlugins'] as const;
		const g = group(el, tx('Cosa sincronizzare'));
		const what = new Setting(g).setName(tx('Anche impostazioni, temi e plugin')).setDesc(tx('Note, allegati e cartelle sono sempre sincronizzati.'));
		helpButton(what.nameEl, tx('Cosa viene sincronizzato'), [
			tx('Sempre: tutte le note, gli allegati e le cartelle del vault.'),
			tx('Impostazioni: scorciatoie, editor, aspetto e plugin core della cartella {0}.', this.app.vault.configDir),
			tx('Plugin: elenco, codice e impostazioni dei plugin della community. I plugin solo-desktop restano spenti sui telefoni.'),
			tx('Mai: layout delle finestre di ogni dispositivo (workspace), cache, cestino, e le credenziali (restano nell’archivio sicuro di ogni dispositivo).'),
			tx('Quando arrivano impostazioni o plugin da un altro dispositivo, Ambraia chiede di ricaricare Obsidian.'),
		]);
		what.addToggle((t) =>
			t.setValue(keys.every((k) => this.s[k])).onChange(async (v) => {
				for (const k of keys) this.s[k] = v;
				await this.save();
				sync.settingsChanged();
				this.redraw();
			}),
		);
		const sub = (name: string, key: (typeof keys)[number]) =>
			this.toggle(g, name, '', key, () => sync.settingsChanged()).settingEl.addClass('ambraia-sub-setting');
		sub(tx('Impostazioni di Obsidian'), 'syncConfigSettings');
		sub(tx('Temi e snippet CSS'), 'syncConfigAppearance');
		sub(tx('Plugin della community'), 'syncConfigPlugins');

		const adv = advanced(el);
		this.toggle(adv, tx('Icona nella barra di stato'), tx('Lo stato della sincronizzazione in basso a destra.'), 'syncStatusBar', () => sync.settingsChanged());
		this.toggle(adv, tx('Notifiche di sistema per i problemi'), tx('Se un servizio smette di funzionare o finisce lo spazio mentre Obsidian è in background.'), 'notifySystem', () => sync.settingsChanged());
		new Setting(adv)
			.setName(tx('File e cartelle da escludere'))
			.setDesc(tx('Uno per riga. Supporta * e ** (es. Archivio/**, *.mp4).'))
			.addTextArea((t) => {
				t.setValue(this.s.ignorePatterns).onChange(async (v) => {
					this.s.ignorePatterns = v;
					await this.save();
					sync.settingsChanged();
				});
				t.inputEl.rows = 3;
			});
		new Setting(adv).setName(tx('Registro attività')).addButton((b) => b.setButtonText(tx('Apri')).onClick(() => new LogModal(this.app, sync).open()));
	}

	private updateStatus() {
		const sync = this.plugin.sync;
		const tabDot = this.tabsEl?.querySelector<HTMLElement>('[data-section="sync"] .ambraia-set-tab-dot');
		if (tabDot) {
			tabDot.dataset.status = sync.connected ? sync.status : 'off';
			const warn = sync.status === 'error' || sync.status === 'auth';
			tabDot.toggleClass('is-warning', warn);
			tabDot.setAttr('aria-label', sync.connected ? sync.statusText().tip : tx('Non collegato'));
		}
		const el = this.statusLine;
		if (!el) return;
		const { tip } = sync.statusText();
		el.empty();
		el.dataset.status = sync.status;
		el.createSpan({ cls: 'ambraia-settings-dot' });
		el.createSpan({ text: sync.connected ? (sync.managers.length > 1 ? tx('{0} servizi collegati', sync.managers.filter((m) => m.connected).length) : tip) : tx('Non collegato') });
		for (const [m, dot] of this.targetDots) {
			dot.dataset.status = m.status;
			dot.setAttr('aria-label', m.statusText().tip);
		}
	}

	private targetDots = new Map<SyncManager, HTMLElement>();

	/** One cloud service: status and switch, then devices, encryption and (folded) advanced tools. */
	private renderTarget(el: HTMLElement, m: SyncManager, openSetup: (mode: SetupMode) => void) {
		const t = m.t;
		const sync = this.plugin.sync;
		const card = el.createDiv({ cls: 'ambraia-target' });
		const meta = PROVIDERS.find((p) => p.id === m.provider);
		card.style.setProperty('--ambraia-provider', meta?.color ?? 'var(--interactive-accent)');
		const head = new Setting(card).setName(m.label);
		head.settingEl.addClass('ambraia-target-head');
		head.settingEl.prepend(brandBadge(createDiv(), m.provider, meta?.name ?? m.label, meta?.color ?? '', 'ambraia-target-mark'));
		if (m.connected) {
			const chips = head.descEl.createDiv('ambraia-target-chips');
			const chip = (icon: string, text: string, cls = '') => {
				const c = chips.createSpan({ cls: `ambraia-chip ${cls}`.trim() });
				setIcon(c.createSpan('ambraia-chip-icon'), icon);
				c.createSpan({ text });
			};
			chip('folder', m.folder);
			chip(t.encrypt ? 'lock' : 'lock-open', t.encrypt ? tx('Cifrato') : tx('Non cifrato'), t.encrypt ? 'mod-ok' : 'mod-warn');
		} else head.setDesc(tx('Da collegare su questo dispositivo'));
		const dot = head.nameEl.createSpan({ cls: 'ambraia-settings-dot ambraia-target-dot' });
		head.nameEl.prepend(dot);
		this.targetDots.set(m, dot);
		dot.dataset.status = m.status;
		dot.setAttr('aria-label', m.statusText().tip);
		const removeService = async () => {
			if (t.encrypt) {
				const r = await riskConfirm(this.app, {
					title: tx('Rimuovere {0}?', m.label),
					intro: tx('La sincronizzazione con questo servizio si ferma su questo dispositivo e le sue credenziali vengono rimosse. I file non vengono cancellati né qui né nel cloud.'),
					risks: [KEY_WARNING(), tx('Per ricollegare questa cartella cifrata, qui o su un altro dispositivo, servirà la chiave principale.')],
					checks: [tx('Ho salvato la chiave principale e capisco i rischi.')],
					cta: tx('Rimuovi'),
				});
				if (!r.ok) return;
			} else if (!(await confirm(this.app, tx('Rimuovere {0}?', m.label), tx('La sincronizzazione con questo servizio si ferma su questo dispositivo e le sue credenziali vengono rimosse. I file non vengono cancellati né qui né nel cloud.'), tx('Rimuovi'), true))) return;
			await sync.remove(m);
			this.redraw();
		};
		if (!m.connected) {
			if (m.isFolderProvider && !isDesktopFs()) head.setDesc(tx('Solo su computer'));
			else head.addButton((b) => b.setButtonText(tx('Collega')).setCta().onClick(() => openSetup('pair')));
			head.addExtraButton((b) => b.setIcon('trash-2').setTooltip(tx('Rimuovi servizio')).onClick(() => void removeService()));
			return;
		}
		head.addExtraButton((b) => b.setIcon('refresh-cw').setTooltip(tx('Sincronizza ora')).onClick(() => m.syncNow(true)));
		head.addToggle((tg) =>
			tg.setTooltip(tx('Sincronizzazione attiva')).setValue(t.enabled).onChange(async (v) => {
				t.enabled = v;
				await this.save();
				m.settingsChanged();
			}),
		);

		// ----- what needs attention, with the action that solves it
		const alert = (icon: string, text: string, action: string, run: () => void) => {
			const row = card.createDiv({ cls: 'ambraia-target-alert' });
			setIcon(row.createSpan({ cls: 'ambraia-target-alert-icon' }), icon);
			row.createSpan({ cls: 'ambraia-target-alert-text', text });
			const b = row.createEl('button', { cls: 'mod-cta', text: action });
			b.onclick = run;
		};
		if (m.status === 'auth') alert('key-round', m.statusDetail || tx('L’accesso a {0} è scaduto o è stato revocato.', m.providerName), tx('Accedi di nuovo'), () => openSetup('reauth'));
		else if (m.status === 'locked') alert('lock', tx('Dati cifrati: inserisci la chiave principale per sbloccarli su questo dispositivo.'), tx('Sblocca'), () => m.openUnlock());
		const health = card.createDiv({ cls: 'ambraia-target-health' });
		const paint = () => {
			health.empty();
			if (m.problem) health.createDiv({ cls: 'ambraia-target-problem', text: m.problem.msg });
			else if (m.status === 'error' && m.statusDetail) health.createDiv({ cls: 'ambraia-target-problem', text: m.statusDetail });
			const sp = m.space;
			if (sp) {
				const free = Math.max(0, sp.total - sp.used);
				const low = free < sp.total * 0.05;
				health.createDiv({ cls: low ? 'ambraia-target-space mod-low' : 'ambraia-target-space', text: tx('Spazio nel cloud: {0} liberi su {1}', formatBytes(free), formatBytes(sp.total)) });
			}
		};
		paint();
		if (m.started) void m.getSpace().then(() => health.isConnected !== false && paint());

		// ----- devices
		this.renderDevices(card, m);

		// ----- encryption
		const enc = new Setting(card).setName(tx('Cifratura end-to-end'));
		enc.settingEl.addClass('ambraia-target-row');
		helpButton(enc.nameEl, tx('Cifratura end-to-end'), [
			tx('Con la cifratura attiva i file (e, se vuoi, i loro nomi) vengono cifrati sul dispositivo: il servizio cloud non può leggerli.'),
			tx('Scegli una chiave principale lunga o generala con il dado: va inserita una volta su ogni dispositivo.'),
			tx('La chiave non viene mai inviata e non si può recuperare: conservala in un gestore di password.'),
			tx('Con più servizi puoi usare la stessa chiave principale per tutti oppure una chiave dedicata per ciascuno.'),
		]);
		const modal = (mode: 'enable' | 'change' | 'recreate' | 'join') => new EncryptionModal(this.app, this.plugin, m, mode, () => this.redraw()).open();
		if (!t.encrypt) {
			enc.setDesc(tx('Disattivata: il servizio cloud può leggere i file.'));
			enc.addButton((b) => b.setButtonText(tx('Attiva')).onClick(() => modal('enable')));
		} else {
			const shut = m.status === 'locked';
			enc.setDesc(shut ? tx('Attiva · bloccata su questo dispositivo') : tx('Attiva · {0}', ALG_NAMES[t.alg]));
			if (!shut) enc.addButton((b) => b.setButtonText(tx('Cambia chiave principale')).onClick(() => modal('change')));
		}

		// ----- everything else, folded
		const more = advanced(card, tx('Avanzate'));
		if (t.encrypt) {
			const kw = more.createDiv('ambraia-key-reminder is-inline');
			setIcon(kw.createSpan('ambraia-key-ack-icon'), 'key-round');
			kw.createSpan({ text: KEY_WARNING() });
			new Setting(more)
				.setName(tx('Ricorda la chiave su questo dispositivo'))
				.setDesc(tx('Conservata nel portachiavi protetto del sistema. Se disattivi, verrà chiesta a ogni avvio.'))
				.addToggle((x) =>
					x.setValue(t.remember).onChange(async (v) => {
						t.remember = v;
						await this.save();
						if (!v) m.forgetKey();
					}),
				);
			const others = sync.managers.filter((x) => x !== m && x.t.encrypt);
			if (others.length) {
				const peers = sync.sharedPeers(m);
				const km = new Setting(more)
					.setName(tx('Chiave principale'))
					.setDesc(t.sharedKey ? tx('Condivisa con {0}', peers.map((p) => p.label).join(', ') || '—') : tx('Dedicata a questo servizio'))
					.addDropdown((d) =>
						d
							.addOption('shared', tx('Uguale per tutti i servizi'))
							.addOption('own', tx('Dedicata'))
							.setValue(t.sharedKey ? 'shared' : 'own')
							.onChange(async (v) => {
								if (v === 'own') {
									t.sharedKey = false;
									await this.save();
									new Notice(tx('Chiave dedicata: ora puoi cambiarla con "Cambia chiave principale" senza toccare gli altri servizi.'), 8000);
									this.redraw();
								} else if (!peers.length) {
									t.sharedKey = true;
									await this.save();
									this.redraw();
								} else {
									d.setValue('own');
									modal('join');
								}
							}),
					);
				helpButton(km.nameEl, tx('Chiave condivisa o dedicata'), [
					tx('Chiave condivisa: la stessa chiave principale sblocca tutti i servizi con un solo inserimento, e cambiandola cambia ovunque.'),
					tx('Chiave dedicata: il servizio ha una chiave sua. Utile per separare un cloud di cui ti fidi meno o che condividi con altri.'),
					tx('In entrambi i casi ogni cartella nel cloud ha un proprio file della chiave: i dati di un servizio non permettono di leggere quelli degli altri senza la chiave.'),
				]);
			}
			const encAdv = new Setting(more).setName(tx('Cifratura')).setDesc(tx('“Ricrea” serve solo se hai perso la chiave principale.'));
			encAdv.addButton((b) =>
				b.setButtonText(tx('Disattiva')).onClick(async () => {
					if (!(await confirm(this.app, tx('Disattivare la cifratura?'), tx('I file vengono ricaricati in chiaro e la copia cifrata va nel cestino del cloud. Gli altri dispositivi andranno messi in pari dalle loro impostazioni.'), tx('Disattiva'), true))) return;
					try {
						await m.reformat(null);
					} catch (e) {
						new Notice(tx('Errore: {0}', (e as Error).message));
					}
					this.redraw();
				}),
			);
			encAdv.addButton((b) => destructive(b.setButtonText(tx('Ricrea'))).onClick(() => modal('recreate')));
			if (m.status === 'error')
				encAdv.addButton((b) =>
					b.setButtonText(tx('Disattiva solo qui')).onClick(async () => {
						await m.turnOffEncryptionHere();
						this.redraw();
					}),
				);
		}
		let folder = m.folder;
		const folderRow = new Setting(more)
			.setName(tx('Cartella nel cloud'))
			.setDesc(tx('Uguale su tutti i dispositivi. Se la cambi, il vault viene sincronizzato con la nuova cartella e la vecchia resta com’è.'))
			.addText((x) => x.setValue(folder).onChange((v) => (folder = v)))
			.addExtraButton((b) =>
				b
					.setIcon('check')
					.setTooltip(tx('Applica'))
					.onClick(async () => {
						const f = cleanPath(folder);
						if (!f || f === m.folder) return;
						if (!(await confirm(this.app, tx('Usare la cartella "{0}"?', f), tx('Ambraia confronta i file locali con quelli della nuova cartella. Nessun file viene cancellato.')))) return;
						t.folder = f;
						t.encrypt = false;
						await this.save();
						await m.resetState();
						m.settingsChanged();
						this.redraw();
					}),
			);
		if (m.isFolderProvider)
			new Setting(more)
				.setName(tx('Cartella dell’app {0}', m.providerName))
				.setDesc(m.localBase || tx('Non impostata su questo dispositivo'))
				.addButton((b) => b.setButtonText(tx('Cambia')).onClick(() => openSetup('reauth')));
		else
			new Setting(more)
				.setName(tx('Account'))
				.setDesc(tx('Accedi di nuovo se l’accesso è stato revocato o se vuoi usare un’altra app (Client ID). Cartella, cifratura e impostazioni restano invariate.'))
				.addButton((b) => b.setButtonText(tx('Accedi di nuovo')).onClick(() => openSetup('reauth')));
		new Setting(more)
			.setName(tx('Strumenti'))
			.addButton((b) => b.setButtonText(tx('Registro attività')).onClick(() => new LogModal(this.app, m).open()))
			.addButton((b) =>
				b.setButtonText(tx('Riallinea da zero')).onClick(async () => {
					if (!(await confirm(this.app, tx('Riallineare la sincronizzazione?'), tx('Ambraia dimentica lo stato salvato e confronta di nuovo tutti i file con il cloud. Nessun file viene cancellato; eventuali differenze diventano copie "(conflitto)".')))) return;
					await m.resetState();
					m.settingsChanged();
				}),
			);
		new Setting(more)
			.setName(tx('Rimuovi servizio'))
			.setDesc(tx('Smette di sincronizzare con {0} su questo dispositivo. Nessun file viene cancellato.', m.providerName))
			.addButton((b) => destructive(b.setButtonText(tx('Rimuovi'))).onClick(() => void removeService()));
	}

	/** Devices linked to the same cloud folder: invitations, remote disconnect / erase. All devices are equal. */
	private renderDevices(card: HTMLElement, m: SyncManager) {
		const box = card.createDiv({ cls: 'ambraia-devices' });
		const headRow = new Setting(box).setName(tx('Dispositivi'));
		headRow.settingEl.addClass('ambraia-target-row');
		helpButton(headRow.nameEl, tx('Dispositivi collegati'), [
			tx('Tutti i dispositivi collegati sono uguali: da ognuno puoi collegarne di nuovi e scegliere quali togliere dalla sincronizzazione, anche il primo.'),
			tx('Per collegare un dispositivo: “Collega un dispositivo”, poi sull’altro scegli il servizio, accedi e inserisci il codice di 8 caratteri (vale 5 minuti). Infine approvi qui, controllando che il codice di verifica sia lo stesso.'),
			tx('Ogni dispositivo è presentato da quello che lo ha approvato e ogni rimozione è firmata: un dispositivo rimosso non può rientrare senza un nuovo codice.'),
			tx('L’elenco è cifrato end-to-end e salvato con nomi anonimi: il servizio cloud non vede nomi né numero dei dispositivi.'),
		]);
		headRow.addButton((b) => b.setButtonText(tx('Collega un dispositivo')).setCta().onClick(() => new PairModal(this.app, m).open()));
		const inviteBtn = headRow.controlEl.querySelector('button');
		const list = box.createDiv({ cls: 'ambraia-device-list' });
		list.createDiv({ cls: 'ambraia-device-empty', text: tx('Carico l’elenco…') });
		const me = deviceId(this.app);
		const ago = (ts: number) => {
			const d = Date.now() - ts;
			if (d < 2 * 60_000) return tx('attivo ora');
			if (d < 3600_000) return tx('{0} min fa', Math.round(d / 60_000));
			if (d < 86400_000) return tx('{0} h fa', Math.round(d / 3600_000));
			return new Date(ts).toLocaleDateString();
		};
		const load = async () => {
			let entries: DeviceEntry[] | null = null;
			let reg = null;
			try {
				reg = await m.registry();
				if (reg) {
					await m.beat(true);
					entries = await reg.list(me);
				}
			} catch {
				entries = null;
			}
			if (!list.isConnected) return;
			list.empty();
			inviteBtn?.show();
			if (!reg) {
				list.createDiv({ cls: 'ambraia-device-empty', text: m.t.encrypt ? tx('Sblocca la cifratura per vedere i dispositivi.') : tx('Elenco non disponibile: controlla la connessione.') });
				return;
			}
			if (reg.outsider) {
				inviteBtn?.hide();
				list.createDiv({ cls: 'ambraia-device-empty', text: tx('Questo dispositivo non è nell’elenco: la cartella è già usata da altri dispositivi. Per entrarci rimuovi il servizio qui, poi su un dispositivo già collegato premi “Collega un dispositivo” e qui scegli Configura → “Ho già Ambraia su un altro dispositivo”.') });
				return;
			}
			if (!entries) {
				list.createDiv({ cls: 'ambraia-device-empty', text: tx('Elenco non disponibile: controlla la connessione.') });
				return;
			}
			if (!entries.some((e) => e.info.id === me)) entries.unshift({ info: { id: me, name: deviceName(this.app), platform: '', version: this.plugin.manifest.version, firstSeen: Date.now(), lastSeen: Date.now() }, pending: null, trusted: true });
			const registry = reg;
			const from = () => ({ id: me, name: deviceName(this.app) });
			const act = async (fn: () => Promise<unknown>) => {
				try {
					await fn();
				} catch (err) {
					new Notice(err instanceof NotAllowedError ? tx('Questo dispositivo non può farlo: è stato rimosso dall’elenco o non è ancora stato approvato.') : tx('Errore: {0}', (err as Error).message));
				}
				void load();
			};
			for (const e of entries) {
				const self = e.info.id === me;
				const row = list.createDiv({ cls: 'ambraia-device' + (self ? ' is-self' : '') });
				const icon = row.createDiv({ cls: 'ambraia-device-icon' });
				setIcon(icon, /iphone|android(?! tablet)/i.test(e.info.platform) ? 'smartphone' : /ipad|tablet/i.test(e.info.platform) ? 'tablet' : 'monitor');
				const txt = row.createDiv({ cls: 'ambraia-device-text' });
				const nm = txt.createDiv({ cls: 'ambraia-device-name', text: e.info.name + (self ? ` (${tx('questo dispositivo')})` : '') });
				if (!e.trusted && !self) nm.createSpan({ cls: 'ambraia-role-chip is-unverified', text: tx('Non verificato'), attr: { title: tx('Nessun dispositivo dell’elenco lo ha approvato (o usa una versione precedente). Se non lo riconosci, rimuovilo.') } });
				const meta = [e.info.platform, self ? tx('attivo ora') : ago(e.info.lastSeen)].filter(Boolean).join(' · ');
				const pend = e.pending === 'wipe' ? tx('in attesa: scollega ed elimina i dati') : e.pending === 'disconnect' ? tx('in attesa: scollega') : '';
				txt.createDiv({ cls: 'ambraia-device-meta' + (pend ? ' mod-warning' : ''), text: pend || meta });
				if (!self) {
					// one-click removal: the most common action, visible without opening the menu
					const rm = row.createEl('button', { cls: 'clickable-icon ambraia-device-remove', attr: { 'aria-label': e.pending ? tx('Annulla la richiesta') : tx('Togli dalla sincronizzazione') } });
					setIcon(rm, e.pending ? 'undo-2' : 'user-minus');
					rm.onclick = async () => {
						if (e.pending) return act(() => registry.cancel(e.info.id, from()));
						if (!(await confirm(this.app, tx('Togliere “{0}” dalla sincronizzazione?', e.info.name), tx('Alla prossima connessione quel dispositivo smette di sincronizzare con {0} e cancella il proprio accesso. Le sue note locali restano.', m.providerName), tx('Scollega'), true))) return;
						await act(() => registry.send(e.info.id, 'disconnect', from()));
					};
				}
				const more = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tx('Azioni') } });
				setIcon(more, 'more-horizontal');
				more.onclick = (ev) => {
					const menu = new Menu();
					if (self) {
						menu.addItem((i) =>
							i
								.setTitle(tx('Rinomina questo dispositivo'))
								.setIcon('pencil')
								.onClick(async () => {
									const n = await prompt(this.app, tx('Nome di questo dispositivo'), deviceName(this.app), '', tx('Salva'));
									if (n === null) return;
									setDeviceName(this.app, n);
									void m.beat(true).then(load);
								}),
						);
						menu.addItem((i) =>
							i
								.setTitle(tx('Scollega questo dispositivo'))
								.setIcon('unlink')
								.onClick(async () => {
									if (!(await confirm(this.app, tx('Scollegare questo dispositivo?'), tx('Smette di sincronizzare con {0} su questo dispositivo. Nessun file viene cancellato.', m.providerName), tx('Scollega'), true))) return;
									await this.plugin.sync.remove(m);
									this.display();
								}),
						);
						menu.showAtMouseEvent(ev);
						return;
					}
					if (e.pending) {
						menu.addItem((i) => i.setTitle(tx('Annulla la richiesta')).setIcon('undo-2').onClick(() => act(() => registry.cancel(e.info.id, from()))));
						menu.addItem((i) => i.setTitle(tx('Togli dall’elenco')).setIcon('x').onClick(() => act(() => registry.forget(e.info.id))));
					} else {
						menu.addItem((i) =>
							i
								.setTitle(tx('Scollega'))
								.setIcon('unlink')
								.onClick(async () => {
									if (!(await confirm(this.app, tx('Scollegare “{0}”?', e.info.name), tx('Alla prossima connessione quel dispositivo smette di sincronizzare con {0} e cancella il proprio accesso. Le sue note locali restano.', m.providerName), tx('Scollega'), true))) return;
									await act(() => registry.send(e.info.id, 'disconnect', from()));
								}),
						);
						menu.addItem((i) => {
							i.setTitle(tx('Scollega ed elimina i dati'))
								.setIcon('trash-2')
								.onClick(async () => {
									const r = await riskConfirm(this.app, {
										title: tx('Scollegare ed eliminare i dati di “{0}”?', e.info.name),
										intro: tx('Alla prossima connessione quel dispositivo interrompe ogni sincronizzazione, cancella i propri accessi e chiavi ed elimina tutte le note di questo vault salvate su di esso. Le note nel cloud e sugli altri dispositivi restano.'),
										risks: [
											tx('Le modifiche fatte su quel dispositivo e non ancora sincronizzate andranno perse.'),
											tx('Funziona solo se il dispositivo si collega di nuovo a internet con Ambraia attivo. Per un dispositivo perso o rubato revoca anche l’accesso dell’app dal tuo account {0} e cambia la chiave principale.', m.providerName),
											tx('Se su quel dispositivo il vault è sincronizzato anche con altri sistemi (es. iCloud, Obsidian Sync), l’eliminazione potrebbe propagarsi tramite quei sistemi.'),
										],
										checks: [tx('Ho capito: le note di quel dispositivo verranno eliminate.')],
										cta: tx('Scollega ed elimina'),
									});
									if (!r.ok) return;
									await act(() => registry.send(e.info.id, 'wipe', from()));
								});
							(i as unknown as { setWarning?(v: boolean): void }).setWarning?.(true);
						});
						if (Date.now() - e.info.lastSeen > 30 * 86400_000) menu.addItem((i) => i.setTitle(tx('Togli dall’elenco')).setIcon('x').onClick(() => act(() => registry.forget(e.info.id))));
					}
					menu.showAtMouseEvent(ev);
				};
			}
			if (entries.length > 1) {
				const foot = list.createDiv({ cls: 'ambraia-device-note' });
				foot.setText(tx('Scollegare un dispositivo ha effetto quando si connette. Per revocare subito l’accesso usa anche la pagina di sicurezza del tuo account {0}.', m.providerName));
			}
		};
		if (m.connected) void load();
		else {
			list.empty();
			list.createDiv({ cls: 'ambraia-device-empty', text: tx('Collega il servizio per vedere i dispositivi.') });
		}
	}

	hide() {
		this.gliderObserver?.disconnect();
		this.gliderObserver = null;
		this.statusLine = null;
		this.targetDots.clear();
		this.bodyEl = null;
		this.tabsEl = null;
		// next time the settings open, the first section is shown again
		this.section = 'general';
	}
}

/** “AI” tab. `redraw` re-renders the whole settings tab. */
export function renderAiSettings(el: HTMLElement, plugin: AmbraiaPlugin, redraw: () => void) {
	const s = plugin.settings;
	const ai = plugin.ai;
	const save = async () => {
		await plugin.saveSettings();
		plugin.refreshAiViews();
	};
	const toggle = (parent: HTMLElement, name: string, desc: string, key: 'aiWebAccess' | 'aiMemory' | 'aiAutosave' | 'aiEnabled' | 'aiMarkOutput', again = false) =>
		new Setting(parent)
			.setName(name)
			.setDesc(desc)
			.addToggle((t) =>
				t.setValue(s[key]).onChange(async (v) => {
					s[key] = v;
					await save();
					if (again) redraw();
				}),
			);
	const folder = (parent: HTMLElement, name: string, key: 'aiPromptsFolder' | 'aiChatsFolder' | 'aiProjectsFolder' | 'aiMemoryFile', fallback: string) =>
		new Setting(parent).setName(name).addText((t) =>
			t
				.setPlaceholder(fallback)
				.setValue(s[key])
				.onChange(async (v) => {
					s[key] = v.trim() || fallback;
					await save();
				}),
		);

	// same status card as the Sync tab
	const main = group(el);
	main.addClass('ambraia-set-status-card');
	const head = new Setting(main);
	head.settingEl.addClass('ambraia-set-status-row');
	const st = head.nameEl.createDiv('ambraia-settings-status');
	const cur = ai.model();
	st.dataset.status = ai.ready ? 'idle' : 'off';
	st.createSpan({ cls: 'ambraia-settings-dot' });
	st.createSpan({ text: !s.aiEnabled ? tx('AI disattivata') : cur ? tx('Modello predefinito: {0}', modelLabel(cur)) : tx('Nessun modello configurato') });

	toggle(main, tx('Attiva l’AI'), tx('Chat, domande sul vault, agente e azioni sul testo selezionato. Funziona anche con modelli locali (LM Studio, Ollama).'), 'aiEnabled', true);
	if (!s.aiEnabled) return;

	new Setting(main)
		.setName(s.aiModels.length ? tx('Aggiungi un modello') : tx('Configura l’AI'))
		.setDesc(tx('Procedura guidata: LM Studio e Ollama (locali) oppure OpenAI, Claude, Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI o qualsiasi server compatibile OpenAI.'))
		.addButton((b) =>
			b
				.setButtonText(s.aiModels.length ? tx('Aggiungi') : tx('Configura'))
				.setCta()
				.onClick(async () => {
					const { AiSetupModal } = await import('./ai/setupModal');
					const m = new AiSetupModal(plugin);
					const close = m.onClose.bind(m);
					m.onClose = () => {
						close();
						redraw();
					};
					m.open();
				}),
		);

	if (s.aiModels.length) {
		const box = group(el, tx('Modelli'), tx('I modelli locali elaborano tutto sul dispositivo; con quelli cloud il testo inviato passa dal fornitore scelto.'));
		box.addClass('ambraia-ai-settings-models');
		for (const m of s.aiModels) {
			const isDef = (cur?.id ?? '') === m.id;
			const local = preset(m.provider).local;
			const row = new Setting(box).setName(modelLabel(m));
			row.settingEl.addClass('ambraia-ai-model-row');
			brandBadge(row.nameEl, m.provider, preset(m.provider).name, 'var(--interactive-accent)', 'is-inline');
			row.nameEl.prepend(row.nameEl.lastElementChild!);
			row.setDesc([local ? tx('Locale') : tx('Cloud'), ai.baseUrlFor(m.provider, m.baseUrl), m.noTools ? tx('senza strumenti (agente → ricerca nel vault)') : ''].filter(Boolean).join(' · '));
			if (isDef) row.nameEl.createSpan({ cls: 'ambraia-badge', text: tx('Predefinito') });
			else
				row.addButton((b) =>
					b.setButtonText(tx('Rendi predefinito')).onClick(async () => {
						s.aiChatModel = m.id;
						await save();
						redraw();
					}),
				);
			row.addExtraButton((b) =>
				b
					.setIcon('activity')
					.setTooltip(tx('Prova la connessione'))
					.onClick(async () => {
						const n = new Notice(tx('Provo {0}…', m.model), 0);
						try {
							const r = await ai.test(m);
							new Notice(tx('{0} risponde: “{1}”', m.model, r.slice(0, 80)));
						} catch (e) {
							new Notice(tx('Connessione non riuscita: {0}', e instanceof Error ? e.message : String(e)), 10000);
						} finally {
							n.hide();
						}
					}),
			);
			row.addExtraButton((b) =>
				b
					.setIcon('trash-2')
					.setTooltip(tx('Rimuovi'))
					.onClick(async () => {
						if (!(await confirm(plugin.app, tx('Rimuovere il modello?'), modelLabel(m), tx('Rimuovi'), true))) return;
						await ai.removeModel(m.id);
						plugin.refreshAiViews();
						redraw();
					}),
			);
		}
	}

	const use = group(el, tx('Comportamento'));
	segmented(use, tx('Modalità predefinita della chat'), tx('Chat libera, domande sulle tue note o agente che può cercare e modificare note.'), Object.entries(MODE_LABELS) as [typeof s.aiDefaultMode, string][], s.aiDefaultMode, async (v) => {
		s.aiDefaultMode = v;
		await save();
	});
	segmented(
		use,
		tx('Modifiche dell’agente alle note'),
		tx('“Chiedi” mostra ogni modifica prima di applicarla.'),
		[
			['ask', tx('Chiedi')],
			['auto', tx('Sempre')],
			['never', tx('Mai')],
		],
		s.aiWrites,
		async (v) => {
			s.aiWrites = v;
			await save();
		},
	);
	toggle(use, tx('Salva le chat'), tx('Le conversazioni diventano note Markdown, riapribili dalla cronologia della chat.'), 'aiAutosave');
	toggle(use, tx('Memoria'), tx('L’AI ricorda preferenze e fatti importanti tra una chat e l’altra, in una nota che puoi leggere e modificare.'), 'aiMemory');

	const priv = group(el, tx('Privacy e accesso a internet'), tx('Ambraia non ha server: le richieste partono dal tuo dispositivo verso il modello scelto e, solo se lo attivi, verso i siti indicati.'));
	new Setting(priv)
		.setName(tx('Note escluse dall’AI'))
		.setDesc(tx('Una cartella o nota per riga: non vengono mai lette, inviate né indicizzate.'))
		.addTextArea((t) => {
			t.setPlaceholder('Archivio/\nprivato/');
			t.setValue(s.aiExclude).onChange(async (v) => {
				s.aiExclude = v;
				ai.index.markDirty();
				await save();
			});
			t.inputEl.rows = 3;
		});
	toggle(priv, tx('Leggi i link incollati'), tx('Pagine, PDF, video YouTube (trascrizione) e post di X vengono scaricati dal dispositivo e allegati.'), 'aiWebAccess');
	toggle(priv, tx('Segna i testi generati dall’AI'), tx('Aggiunge la proprietà “ai-generated” alle note create dall’AI e “ai-assisted” a quelle in cui inserisce o modifica testo, come richiesto dal Regolamento UE sull’IA (art. 50).'), 'aiMarkOutput');
	segmented(
		priv,
		tx('Ricerca web per l’agente'),
		tx('DuckDuckGo non richiede chiavi; SearXNG è un motore che puoi ospitare tu.'),
		[
			['off', tx('No')],
			['duckduckgo', 'DuckDuckGo'],
			['searxng', 'SearXNG'],
		],
		s.aiWebSearch,
		async (v) => {
			s.aiWebSearch = v;
			await save();
			redraw();
		},
	);
	if (s.aiWebSearch === 'searxng')
		new Setting(priv)
			.setName(tx('Indirizzo SearXNG'))
			.setDesc(tx('Es. http://localhost:8888. In settings.yml aggiungi “json” a search → formats.'))
			.addText((t) =>
				t
					.setValue(s.aiSearxngUrl)
					.onChange(async (v) => {
						s.aiSearxngUrl = v.trim();
						await save();
					}),
			)
			.settingEl.addClass('ambraia-sub-setting');

	// semantic search
	const sem = group(el, tx('Ricerca semantica'));
	const embModels = s.aiEmbedding ? `${s.aiEmbedding.model} · ${preset(s.aiEmbedding.provider).name}` : tx('non attiva (ricerca per parole chiave)');
	new Setting(sem)
		.setName(tx('Indice delle note'))
		.setDesc(tx('Modello di embedding: {0}. Si sceglie dalla configurazione guidata (es. nomic-embed-text in LM Studio/Ollama, text-embedding-3-small su OpenAI).', embModels))
		.addButton((b) =>
			b.setButtonText(tx('Ricostruisci indice')).onClick(async () => {
				b.setDisabled(true);
				b.setButtonText(tx('Indicizzo…'));
				try {
					new Notice(await ai.rebuildIndex((d, t) => {
						b.setButtonText(`${d}/${t}…`);
					}));
				} catch (e) {
					new Notice(tx('Indicizzazione non riuscita: ') + (e instanceof Error ? e.message : String(e)));
				}
				b.setDisabled(false);
				b.setButtonText(tx('Ricostruisci indice'));
			}),
		)
		.addExtraButton((b) =>
			b
				.setIcon('x')
				.setTooltip(tx('Disattiva la ricerca semantica'))
				.onClick(async () => {
					s.aiEmbedding = null;
					await ai.semantic.clear();
					await save();
					redraw();
				}),
		);

	const more = advanced(el);
	// keys & URLs for each provider in use (or all, in the details box)
	const adv = more.createDiv('ambraia-settings-keys');
	adv.createDiv({ cls: 'ambraia-set-group-title', text: tx('Chiavi API e indirizzi dei server') });
	adv.createDiv({ cls: 'ambraia-set-group-desc', text: tx('Le chiavi restano nel portachiavi di Obsidian su questo dispositivo e non vengono sincronizzate.') });
	const used = new Set(s.aiModels.map((m) => m.provider));
	const keyRow = (parent: HTMLElement, p: (typeof PRESETS)[number]) => {
		const row = new Setting(parent).setName(p.name).setDesc(p.local ? tx('Server locale') : p.needsKey ? tx('Chiave API e indirizzo (facoltativo)') : tx('Indirizzo del server'));
		if (p.needsKey || p.id === 'custom')
			row.addText((t) => {
				t.inputEl.type = 'password';
				t.inputEl.autocomplete = 'off';
				t.setPlaceholder(p.needsKey ? tx('Chiave API') : tx('Chiave (facoltativa)'))
					.setValue(ai.getKey(p.id))
					.onChange(async (v) => {
						await ai.setKey(p.id, v.trim());
					});
			});
		row.addText((t) =>
			t
				.setPlaceholder(p.baseUrl || 'http://localhost:8080/v1')
				.setValue(s.aiProviderUrls[p.id] ?? '')
				.onChange(async (v) => {
					if (v.trim()) s.aiProviderUrls[p.id] = v.trim();
					else delete s.aiProviderUrls[p.id];
					await save();
				}),
		);
	};
	for (const p of PRESETS) if (used.has(p.id)) keyRow(adv, p);
	const rest = PRESETS.filter((p) => !used.has(p.id));
	if (rest.length) {
		const d = adv.createEl('details', { cls: 'ambraia-settings-details' });
		d.createEl('summary', { text: used.size ? tx('Altri servizi') : tx('Tutti i servizi') });
		for (const p of rest) keyRow(d, p);
	}

	new Setting(more)
		.setName(tx('Istruzioni di sistema'))
		.setDesc(tx('Aggiunte a ogni conversazione (es. “Rispondi in modo sintetico”).'))
		.addTextArea((t) =>
			t.setValue(s.aiSystemPrompt).onChange(async (v) => {
				s.aiSystemPrompt = v;
				await save();
			}),
		);
	new Setting(more).setName(tx('Creatività (temperatura)')).addSlider((sl) =>
		sl
			.setLimits(0, 2, 0.1)
			.setValue(s.aiTemperature)
			.onChange(async (v) => {
				s.aiTemperature = v;
				await save();
			}),
	);
	new Setting(more)
		.setName(tx('Limite del contesto (caratteri)'))
		.setDesc(tx('Testo massimo allegato dalle note. Riducilo per modelli locali piccoli.'))
		.addText((t) => {
			t.inputEl.type = 'number';
			t.setValue(String(s.aiContextChars)).onChange(async (v) => {
				const n = Math.floor(Number(v));
				if (!Number.isFinite(n) || n < 1000) return;
				s.aiContextChars = n;
				await save();
			});
		});
	folder(more, tx('Cartella dei prompt'), 'aiPromptsFolder', 'Ambraia/Prompt').addButton((b) => b.setButtonText(tx('Nuovo prompt')).onClick(() => void plugin.createSamplePrompt()));
	folder(more, tx('Cartella delle chat'), 'aiChatsFolder', 'Ambraia/Chat');
	folder(more, tx('Cartella dei progetti'), 'aiProjectsFolder', 'Ambraia/Progetti').addButton((b) => b.setButtonText(tx('Nuovo progetto')).onClick(() => void plugin.createProject()));
	folder(more, tx('Nota della memoria'), 'aiMemoryFile', 'Ambraia/Memoria.md');
}

/** “Calendario” tab. */
export function renderShareSettings(el: HTMLElement, plugin: AmbraiaPlugin, redraw: () => void) {
	const s = plugin.settings;
	const links = group(el, tx('Link condivisi'), tx('Chi riceve il link legge la nota in una pagina web, senza Obsidian e senza account. Il contenuto è cifrato: la chiave sta nella parte del link dopo “#”, che il browser non invia a nessun server.'));
	groupHelp(links, tx('Link condivisi'), [
		tx('Il link contiene solo una chiave. Quando qualcuno lo apre, uno dei tuoi dispositivi con Obsidian aperto risponde con la versione attuale della nota, dopo aver controllato profilo, password, scadenza e numero di aperture. Puoi modificarlo o revocarlo in ogni momento.'),
		tx('Profili: con lo stesso link puoi dare accessi diversi, ognuno con la sua password. Per esempio “Modifica” con password, una sola apertura e possibilità di modificare, e “Lettura” senza password, aperture illimitate per un giorno.'),
		tx('Le modifiche fatte dal browser vengono unite riga per riga a quelle fatte nel frattempo, anche sui tuoi dispositivi offline: quando si risincronizzano tutto torna coerente.'),
		tx('I link e il loro stato viaggiano cifrati nell’elenco dispositivi: ogni dispositivo sincronizzato può rispondere e gestirli.'),
		tx('Chi legge non vede proprietà, commenti %%…%%, incorporamenti e immagini locali; chi può modificare vede il testo completo, tranne le proprietà. Condividi solo contenuti che hai il diritto di diffondere.'),
	]);
	const n = plugin.shares?.store.all().length ?? 0;
	new Setting(links)
		.setName(tx('Gestisci i link'))
		.setDesc(n ? tx('{0} link creati da questo vault.', n) : tx('Nessun link creato. Usa “Condividi con un link” dal menu di una nota.'))
		.addButton((b) =>
			b.setButtonText(tx('Apri elenco')).onClick(async () => {
				const { SharesModal } = await import('./share/ui');
				new SharesModal(plugin.shares).open();
			}),
		)
		.addButton((b) =>
			b.setButtonText(tx('Apri un link')).onClick(async () => {
				const { OpenShareModal } = await import('./share/ui');
				new OpenShareModal(plugin.app, plugin.shares).open();
			}),
		);
	new Setting(links)
		.setName(tx('Rispondi ai link condivisi'))
		.setDesc(tx('Questo dispositivo, mentre Obsidian è aperto, consegna le note dei link e riceve le modifiche. Spegnilo su un dispositivo che non vuoi usare per questo.'))
		.addToggle((t) =>
			t.setValue(s.shareServe).onChange(async (v) => {
				s.shareServe = v;
				await plugin.saveSettings();
				plugin.shares?.applyServe(true);
			}),
		);

	const adv = advanced(el);
	const url = (name: string, desc: string, key: 'shareViewerUrl' | 'shareRelayUrl') => {
		const st = new Setting(adv).setName(name).setDesc(desc);
		st.addText((t) => {
			t.setPlaceholder(DEFAULT_SETTINGS[key]).setValue(s[key]);
			t.inputEl.addEventListener('change', async () => {
				const v = t.getValue().trim() || DEFAULT_SETTINGS[key];
				if (!/^https:\/\/[^\s/]+/i.test(v)) {
					new Notice(tx('Serve un indirizzo https://'));
					t.setValue(s[key]);
					return;
				}
				s[key] = key === 'shareRelayUrl' ? v.replace(/\/+$/, '') : v;
				await plugin.saveSettings();
				plugin.shares?.applyServe(true);
			});
		});
		st.addExtraButton((b) =>
			b
				.setIcon('rotate-ccw')
				.setTooltip(tx('Ripristina'))
				.onClick(async () => {
					s[key] = DEFAULT_SETTINGS[key];
					await plugin.saveSettings();
					plugin.shares?.applyServe(true);
					redraw();
				}),
		);
	};
	url(tx('Pagina di lettura'), tx('Pagina web statica che apre i link (non riceve mai le chiavi). Vale per i link creati da ora in poi.'), 'shareViewerUrl');
	url(tx('Servizio di inoltro'), tx('Server compatibile ntfy che inoltra, cifrate, richieste e risposte dei link. Il servizio pubblico vede gli indirizzi IP e quando i link vengono usati, mai il contenuto. Vale per i link creati da ora in poi.'), 'shareRelayUrl');
}

export function renderCalendarSettings(el: HTMLElement, plugin: AmbraiaPlugin, redraw: () => void) {
	const s = plugin.settings;
	const save = async () => {
		await plugin.saveSettings();
		plugin.refreshCalendars();
	};
	const text = (parent: HTMLElement, name: string, desc: string, key: 'dailyFolder' | 'dailyFormat' | 'dailyTemplate' | 'weeklyFolder' | 'weeklyFormat' | 'weeklyTemplate' | 'calendarDateFields', ph: string) => {
		const st = new Setting(parent).setName(name).addText((t) =>
			t
				.setPlaceholder(ph)
				.setValue(s[key])
				.onChange(async (v) => {
					s[key] = v.trim();
					await save();
				}),
		);
		if (desc) st.setDesc(desc);
		st.settingEl.addClass('ambraia-sub-setting');
		return st;
	};
	const toggle = (parent: HTMLElement, name: string, desc: string, key: 'calendarUseCoreDaily' | 'calendarWeekNumbers' | 'calendarShowTasks' | 'calendarClickCreates' | 'calendarOnStart' | 'weeklyNotes', again = false) =>
		new Setting(parent)
			.setName(name)
			.setDesc(desc)
			.addToggle((t) =>
				t.setValue(s[key]).onChange(async (v) => {
					s[key] = v;
					await save();
					if (again) redraw();
				}),
			);
	const core = (plugin.app as unknown as { internalPlugins?: { getPluginById?(id: string): { enabled?: boolean } | null } }).internalPlugins?.getPluginById?.('daily-notes');

	const days = group(el, tx('Note del giorno'));
	toggle(
		days,
		tx('Usa le impostazioni di Obsidian'),
		core?.enabled ? tx('Cartella, formato e modello vengono dal plugin “Note del giorno”.') : tx('Il plugin “Note del giorno” di Obsidian è spento: valgono le impostazioni qui sotto.'),
		'calendarUseCoreDaily',
		true,
	);
	if (!s.calendarUseCoreDaily || !core?.enabled) {
		text(days, tx('Cartella'), tx('Vuota = radice del vault.'), 'dailyFolder', tx('Diario'));
		text(days, tx('Formato del nome'), tx('Formato moment.js, es. YYYY-MM-DD o YYYY/MM/YYYY-MM-DD.'), 'dailyFormat', 'YYYY-MM-DD');
		text(days, tx('Modello'), tx('Variabili: {{date}}, {{time}}, {{title}}, {{yesterday}}, {{tomorrow}}, {{date:FORMATO}}.'), 'dailyTemplate', 'Modelli/Giorno');
	}
	toggle(days, tx('Un clic crea la nota del giorno'), tx('Altrimenti un clic su un giorno vuoto mostra solo l’agenda (doppio clic per crearla).'), 'calendarClickCreates');

	const view = group(el, tx('Calendario'));
	segmented(
		view,
		tx('Primo giorno della settimana'),
		'',
		[
			['locale', tx('Automatico')],
			['monday', tx('Lunedì')],
			['sunday', tx('Domenica')],
		],
		s.calendarWeekStart,
		async (v) => {
			s.calendarWeekStart = v;
			await save();
		},
	);
	toggle(view, tx('Attività con scadenza'), tx('Le caselle “- [ ]” con 📅 2026-10-02, ⏳ o due:: compaiono nel giorno indicato.'), 'calendarShowTasks');
	toggle(view, tx('Numeri delle settimane'), '', 'calendarWeekNumbers');
	toggle(view, tx('Note della settimana'), tx('Mostra i numeri delle settimane: un clic apre o crea la nota settimanale.'), 'weeklyNotes', true);
	if (s.weeklyNotes) {
		text(view, tx('Cartella'), '', 'weeklyFolder', tx('Settimane'));
		text(view, tx('Formato del nome'), '', 'weeklyFormat', 'gggg-[W]ww');
		text(view, tx('Modello'), '', 'weeklyTemplate', 'Modelli/Settimana');
	}
	toggle(view, tx('Apri il calendario all’avvio'), '', 'calendarOnStart');

	const adv = advanced(el);
	text(adv, tx('Proprietà data delle pagine'), tx('Le note con una di queste proprietà compaiono nel calendario (separate da virgola).'), 'calendarDateFields', 'data, date, scadenza, due').settingEl.removeClass('ambraia-sub-setting');
}
