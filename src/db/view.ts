import { App, getAllTags, Menu, Notice, setIcon, TFile, TFolder } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { availablePath, confirm, getIconFor, prompt, renderIcon, resolveBanner, sanitizeFileName } from '../ui/util';
import { toStr, Value } from './formula';
import {
	applyQuery,
	coerceInput,
	DbConfig,
	distinctValues,
	EMPTY_GROUP,
	FormulaCtx,
	groupRows,
	guessType,
	inSource,
	isSpecial,
	NAME_COL,
	normTags,
	parseSort,
	PROP_TYPES,
	PropType,
	Row,
	VIEW_TYPES,
} from './model';
import { tx } from '../i18n';

const uiState = new Map<string, { search: string; month: number; year: number }>();

const MONTHS = [tx('Gennaio'), tx('Febbraio'), tx('Marzo'), tx('Aprile'), tx('Maggio'), tx('Giugno'), tx('Luglio'), tx('Agosto'), tx('Settembre'), tx('Ottobre'), tx('Novembre'), tx('Dicembre')];
const DAYS = [tx('Lun'), tx('Mar'), tx('Mer'), tx('Gio'), tx('Ven'), tx('Sab'), tx('Dom')];
const DND = 'application/x-ambraia-row';

function pad(n: number) {
	return String(n).padStart(2, '0');
}

export function ymd(d: Date) {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface DbHost {
	/** Path used for "this" and for excluding the host note. */
	contextPath: string;
	/** Folder for source "this". */
	contextFolder: string;
	saveConfig(cfg: DbConfig): Promise<void>;
	stateKey: string;
}

/** Renders a database (table / board / list / gallery / calendar) into a container. */
export class DbRenderer {
	private cfg: DbConfig;
	private rows: Row[] = [];
	private timer: number | null = null;
	private pendingRender = false;
	private state: { search: string; month: number; year: number };
	private bodyEl!: HTMLElement;

	constructor(
		private plugin: AmbraiaPlugin,
		private root: HTMLElement,
		cfg: DbConfig,
		private host: DbHost,
	) {
		this.cfg = cfg;
		const now = new Date();
		this.state = uiState.get(host.stateKey) ?? { search: '', month: now.getMonth(), year: now.getFullYear() };
		uiState.set(host.stateKey, this.state);
	}

	get app(): App {
		return this.plugin.app;
	}

	/** Call from the owner component on vault/metadata changes. */
	schedule() {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			if (this.root.contains(activeDocument.activeElement) && activeDocument.activeElement?.matches('input, textarea')) {
				this.pendingRender = true; // don't steal focus while editing a cell
				return;
			}
			this.render();
		}, 250);
	}

	destroy() {
		if (this.timer) window.clearTimeout(this.timer);
	}

	// ------------------------------------------------------------- data

	private sourceFolder(): string | null {
		const s = this.cfg.source.trim();
		if (s.startsWith('#')) return null;
		if (s === 'this' || s === '.' || s === '') return this.host.contextFolder;
		return s.replace(/^\/+|\/+$/g, '');
	}

	private loadRows(): Row[] {
		const s = this.cfg.source.trim();
		const tag = s.startsWith('#') ? s.slice(1).toLowerCase() : null;
		const folder = this.sourceFolder();
		const out: Row[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (f.path === this.host.contextPath) continue;
			const cache = this.app.metadataCache.getFileCache(f);
			const tags = cache ? (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, '')) : [];
			if (tag !== null) {
				if (!tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(tag + '/'))) continue;
			} else if (!inSource(f.path, folder ?? '', !!this.cfg.subfolders)) continue;
			if (this.plugin.settings.folderNotes && f.parent && !f.parent.isRoot() && f.parent.name === f.basename && f.parent.path === folder) continue;
			const fm = { ...(cache?.frontmatter ?? {}) } as Record<string, unknown>;
			delete fm.position;
			const banner = fm[this.plugin.settings.bannerKey] ?? fm.banner ?? fm.cover;
			out.push({
				path: f.path,
				name: f.basename,
				folder: f.parent?.path ?? '',
				fm,
				tags,
				ctime: f.stat.ctime,
				mtime: f.stat.mtime,
				icon: getIconFor(this.plugin, f),
				cover: typeof banner === 'string' ? banner : undefined,
			});
		}
		return out;
	}

	private typeOf(col: string): PropType {
		return this.cfg.types[col] ?? (this.cfg.formulas[col] !== undefined ? 'formula' : guessType(this.rows, col));
	}

	private async save() {
		await this.host.saveConfig(this.cfg);
	}

	private async setValue(path: string, col: string, value: unknown) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return;
		if (col.toLowerCase() === 'tags' && Array.isArray(value)) value = value.map((t) => String(t).replace(/^#/, ''));
		await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
			const key = Object.keys(fm).find((k) => k.toLowerCase() === col.toLowerCase()) ?? col;
			if (value === null || value === undefined || (Array.isArray(value) && !value.length)) delete fm[key];
			else fm[key] = value;
		});
	}

	private async newRow(preset: Record<string, unknown> = {}, open = false) {
		const name = await prompt(this.app, tx('Nuova pagina'), tx('Senza titolo'), tx('Titolo'), tx('Crea'));
		if (name === null) return;
		const s = this.cfg.source.trim();
		let folder = this.sourceFolder();
		if (folder === null) folder = this.app.fileManager.getNewFileParent(this.host.contextPath).path;
		if (folder && !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) await this.app.vault.createFolder(folder);
		const path = availablePath(this.app, folder, sanitizeFileName(name || tx('Senza titolo')), 'md');
		const f = await this.app.vault.create(path, '');
		const fm = { ...preset };
		if (s.startsWith('#')) fm.tags = [s.slice(1)];
		if (Object.keys(fm).length) {
			await this.app.fileManager.processFrontMatter(f, (x: Record<string, unknown>) => Object.assign(x, fm));
		}
		if (open) void this.app.workspace.getLeaf('tab').openFile(f);
		this.schedule();
	}

	// ------------------------------------------------------------- render

	render() {
		this.pendingRender = false;
		this.rows = this.loadRows();
		const root = this.root;
		const scrollEl = root.querySelector('.ambraia-db-body');
		const scrollLeft = scrollEl?.scrollLeft ?? 0;
		root.empty();
		root.addClass('ambraia-db');
		this.renderHead(root);
		const res = applyQuery(this.rows, this.cfg, this.state.search);
		if (res.error) root.createDiv({ cls: 'ambraia-db-error', text: res.error });
		this.bodyEl = root.createDiv(`ambraia-db-body is-${this.cfg.view}`);
		try {
			switch (this.cfg.view) {
				case 'board':
					this.renderBoard(res.rows);
					break;
				case 'list':
					this.renderList(res.rows);
					break;
				case 'gallery':
					this.renderGallery(res.rows);
					break;
				case 'calendar':
					this.renderCalendar(res.rows);
					break;
				default:
					this.renderTable(res.rows);
			}
		} catch (e) {
			this.bodyEl.createDiv({ cls: 'ambraia-db-error', text: tx('Errore di visualizzazione: ') + (e instanceof Error ? e.message : String(e)) });
			console.error(tx('Ambraia db'), e);
		}
		this.bodyEl.scrollLeft = scrollLeft;
		const foot = root.createDiv('ambraia-db-foot');
		const src = this.cfg.source.startsWith('#') ? this.cfg.source : this.sourceFolder() || 'vault';
		foot.setText(`${res.rows.length === 1 ? tx('1 pagina') : tx('{0} pagine', res.rows.length)} · ${src}`);
	}

	private renderHead(root: HTMLElement) {
		const head = root.createDiv('ambraia-db-head');
		const title = head.createDiv({ cls: 'ambraia-db-title', text: this.cfg.title || this.defaultTitle() });
		title.onclick = async () => {
			const t = await prompt(this.app, tx('Titolo del database'), this.cfg.title ?? this.defaultTitle());
			if (t === null) return;
			this.cfg.title = t.trim() || undefined;
			await this.save();
			this.render();
		};
		const bar = head.createDiv('ambraia-db-toolbar');
		const tabs = bar.createDiv('ambraia-db-tabs');
		for (const v of VIEW_TYPES) {
			const t = tabs.createDiv({ cls: 'ambraia-db-tab', attr: { 'aria-label': v.label } });
			setIcon(t.createSpan(), v.icon);
			t.createSpan({ text: v.label });
			if (v.id === this.cfg.view) t.addClass('is-active');
			t.onclick = async () => {
				if (this.cfg.view === v.id) return;
				this.cfg.view = v.id;
				if (v.id === 'board' && !this.cfg.groupBy) this.cfg.groupBy = this.guessGroupField();
				if (v.id === 'calendar' && !this.cfg.dateField) this.cfg.dateField = this.guessDateField();
				this.render();
				await this.save();
			};
		}
		bar.createDiv('ambraia-spacer');
		const search = bar.createEl('input', { type: 'search', cls: 'ambraia-db-search', attr: { placeholder: tx('Cerca…') } });
		search.value = this.state.search;
		search.addEventListener('input', () => {
			this.state.search = search.value;
			const pos = search.selectionStart;
			this.render();
			const s2 = this.root.querySelector<HTMLInputElement>('.ambraia-db-search');
			if (s2) {
				s2.focus();
				s2.setSelectionRange(pos, pos);
			}
		});
		const filterBtn = bar.createDiv({ cls: 'ambraia-db-btn' + (this.cfg.filter ? ' is-active' : ''), attr: { 'aria-label': this.cfg.filter ? tx('Filtro: {0}', this.cfg.filter) : tx('Filtra') } });
		setIcon(filterBtn, 'filter');
		filterBtn.onclick = () => this.editFilter();
		const sort = parseSort(this.cfg.sort);
		const sortBtn = bar.createDiv({ cls: 'ambraia-db-btn' + (sort ? ' is-active' : ''), attr: { 'aria-label': sort ? tx('Ordinato per {0}', sort.field) : tx('Ordina') } });
		setIcon(sortBtn, sort?.desc ? 'arrow-down-wide-narrow' : 'arrow-up-narrow-wide');
		sortBtn.onclick = (e) => this.sortMenu(e);
		const more = bar.createDiv({ cls: 'ambraia-db-btn', attr: { 'aria-label': tx('Impostazioni vista') } });
		setIcon(more, 'sliders-horizontal');
		more.onclick = (e) => this.settingsMenu(e);
		const add = bar.createEl('button', { cls: 'mod-cta ambraia-db-new', text: tx('Nuovo') });
		add.onclick = () => this.newRow({}, false);
	}

	private defaultTitle(): string {
		const s = this.cfg.source;
		if (s.startsWith('#')) return s;
		const f = this.sourceFolder();
		return f ? f.split('/').pop()! : this.app.vault.getName();
	}

	private allKeys(): string[] {
		const s = new Set<string>();
		for (const r of this.rows) for (const k of Object.keys(r.fm)) s.add(k);
		return [...s].sort();
	}

	private guessGroupField(): string {
		const cols = this.cfg.columns.filter((c) => c !== NAME_COL);
		return cols.find((c) => ['select', 'checkbox'].includes(this.typeOf(c))) ?? cols.find((c) => /stato|status/i.test(c)) ?? 'stato';
	}

	private guessDateField(): string {
		const cols = [...this.cfg.columns, ...this.allKeys()];
		return cols.find((c) => this.typeOf(c) === 'date' && !isSpecial(c)) ?? cols.find((c) => /data|date|scadenza|due/i.test(c)) ?? 'data';
	}

	private async editFilter() {
		const f = await prompt(
			this.app,
			tx('Filtro (lascia vuoto per vedere tutto)'),
			this.cfg.filter ?? '',
			tx('Es.  stato != "Fatto"   oppure   prezzo > 10 and contains(tags, "lavoro")'),
			tx('Applica'),
		);
		if (f === null) return;
		this.cfg.filter = f.trim() || undefined;
		this.render();
		await this.save();
	}

	private sortMenu(e: MouseEvent) {
		const m = new Menu();
		const sort = parseSort(this.cfg.sort);
		const cols = [...new Set([...this.cfg.columns, 'creato', 'modificato'])];
		for (const c of cols) {
			for (const desc of [false, true]) {
				m.addItem((i) =>
					i
						.setTitle(`${c} ${desc ? tx('↓ decrescente') : tx('↑ crescente')}`)
						.setChecked(!!sort && sort.field === c && sort.desc === desc)
						.onClick(async () => {
							this.cfg.sort = `${c} ${desc ? 'desc' : 'asc'}`;
							this.render();
							await this.save();
						}),
				);
			}
		}
		if (sort) {
			m.addSeparator();
			m.addItem((i) =>
				i.setTitle(tx('Rimuovi ordinamento')).setIcon('x').onClick(async () => {
					this.cfg.sort = undefined;
					this.render();
					await this.save();
				}),
			);
		}
		m.showAtMouseEvent(e);
	}

	private settingsMenu(e: MouseEvent) {
		const m = new Menu();
		m.addItem((i) =>
			i.setTitle(tx('Origine: {0}', this.cfg.source)).setIcon('folder-input').onClick(async () => {
				const v = await prompt(this.app, tx('Origine delle pagine'), this.cfg.source, tx('this = cartella di questa nota, oppure Cartella/Sotto, oppure #tag'), tx('Applica'));
				if (!v?.trim()) return;
				this.cfg.source = v.trim();
				this.render();
				await this.save();
			}),
		);
		m.addItem((i) =>
			i.setTitle(tx('Includi sottocartelle')).setChecked(!!this.cfg.subfolders).onClick(async () => {
				this.cfg.subfolders = !this.cfg.subfolders;
				this.render();
				await this.save();
			}),
		);
		m.addSeparator();
		m.addItem((i) => i.setTitle(tx('Aggiungi proprietà…')).setIcon('plus').onClick(() => this.addColumnMenu(e)));
		m.addItem((i) => i.setTitle(tx('Aggiungi formula…')).setIcon('sigma').onClick(() => this.addFormula()));
		const visible = this.cfg.columns.filter((c) => c !== NAME_COL);
		for (const c of visible) {
			m.addItem((i) =>
				i.setTitle(tx('Nascondi “{0}”', c)).setIcon('eye-off').onClick(async () => {
					this.cfg.columns = this.cfg.columns.filter((x) => x !== c);
					this.render();
					await this.save();
				}),
			);
		}
		if (this.cfg.view === 'board') {
			m.addSeparator();
			for (const c of [...new Set([...visible, ...this.allKeys()])]) {
				m.addItem((i) =>
					i
						.setTitle(tx('Raggruppa per “{0}”', c))
						.setChecked(this.cfg.groupBy === c)
						.onClick(async () => {
							this.cfg.groupBy = c;
							this.render();
							await this.save();
						}),
				);
			}
		}
		if (this.cfg.view === 'calendar') {
			m.addSeparator();
			for (const c of [...new Set([...visible, ...this.allKeys()])].filter((c) => this.typeOf(c) === 'date' || /data|date/i.test(c))) {
				m.addItem((i) =>
					i
						.setTitle(tx('Usa la data “{0}”', c))
						.setChecked(this.cfg.dateField === c)
						.onClick(async () => {
							this.cfg.dateField = c;
							this.render();
							await this.save();
						}),
				);
			}
			m.addItem((i) =>
				i.setTitle(tx('Altra proprietà data…')).setIcon('calendar-plus').onClick(async () => {
					const c = await prompt(this.app, tx('Nome della proprietà data'), this.cfg.dateField ?? 'data');
					if (!c?.trim()) return;
					this.cfg.dateField = c.trim();
					this.cfg.types[c.trim()] = 'date';
					this.render();
					await this.save();
				}),
			);
		}
		m.showAtMouseEvent(e);
	}

	private addColumnMenu(e: MouseEvent) {
		const m = new Menu();
		const shown = new Set(this.cfg.columns.map((c) => c.toLowerCase()));
		const keys = this.allKeys().filter((k) => !shown.has(k.toLowerCase()) && !['position', this.plugin.settings.iconKey, this.plugin.settings.bannerKey, 'banner_y', 'sticker'].includes(k));
		for (const k of keys.slice(0, 30)) {
			m.addItem((i) =>
				i.setTitle(k).setIcon(PROP_TYPES.find((p) => p.id === guessType(this.rows, k))?.icon ?? 'text').onClick(async () => {
					this.cfg.columns.push(k);
					this.render();
					await this.save();
				}),
			);
		}
		for (const sp of ['tags', 'creato', 'modificato', 'cartella']) {
			if (!shown.has(sp) && !keys.includes(sp))
				m.addItem((i) =>
					i.setTitle(sp).setIcon('info').onClick(async () => {
						this.cfg.columns.push(sp);
						this.render();
						await this.save();
					}),
				);
		}
		m.addSeparator();
		for (const t of PROP_TYPES.filter((p) => p.id !== 'formula')) {
			m.addItem((i) =>
				i.setTitle(tx('Nuova: {0}', t.label)).setIcon(t.icon).onClick(async () => {
					const n = await prompt(this.app, tx('Nuova proprietà ({0})', t.label), '', tx('Nome della proprietà'), tx('Aggiungi'));
					const name = n?.trim().replace(/[:#[\]{}]/g, '');
					if (!name) return;
					if (!this.cfg.columns.includes(name)) this.cfg.columns.push(name);
					this.cfg.types[name] = t.id;
					this.render();
					await this.save();
				}),
			);
		}
		m.addItem((i) => i.setTitle(tx('Nuova: Formula')).setIcon('sigma').onClick(() => this.addFormula()));
		m.showAtMouseEvent(e);
	}

	private async addFormula(existing?: string) {
		const name = existing ?? (await prompt(this.app, tx('Nome della formula'), '', tx('Es. Totale')))?.trim();
		if (!name) return;
		const f = await prompt(
			this.app,
			tx('Formula “{0}”', name),
			this.cfg.formulas[name] ?? '',
			tx('Es.  prezzo * quantità   ·   if(fatto, "✅", "⏳")   ·   dateDiff(scadenza, today(), "days")'),
			tx('Salva'),
		);
		if (f === null) return;
		if (!f.trim()) {
			delete this.cfg.formulas[name];
			delete this.cfg.types[name];
			this.cfg.columns = this.cfg.columns.filter((c) => c !== name);
		} else {
			this.cfg.formulas[name] = f.trim();
			this.cfg.types[name] = 'formula';
			if (!this.cfg.columns.includes(name)) this.cfg.columns.push(name);
		}
		this.render();
		await this.save();
	}

	private columnMenu(e: MouseEvent, col: string) {
		const m = new Menu();
		const type = this.typeOf(col);
		for (const desc of [false, true])
			m.addItem((i) =>
				i.setTitle(desc ? tx('Ordina ↓ decrescente') : tx('Ordina ↑ crescente')).setIcon(desc ? 'arrow-down-wide-narrow' : 'arrow-up-narrow-wide').onClick(async () => {
					this.cfg.sort = `${col} ${desc ? 'desc' : 'asc'}`;
					this.render();
					await this.save();
				}),
			);
		if (col === NAME_COL) return m.showAtMouseEvent(e);
		m.addSeparator();
		if (type === 'formula') m.addItem((i) => i.setTitle(tx('Modifica formula')).setIcon('sigma').onClick(() => this.addFormula(col)));
		else if (!isSpecial(col)) {
			for (const t of PROP_TYPES.filter((p) => p.id !== 'formula')) {
				m.addItem((i) =>
					i
						.setTitle(tx('Tipo: {0}', t.label))
						.setIcon(t.icon)
						.setChecked(type === t.id)
						.onClick(async () => {
							this.cfg.types[col] = t.id;
							this.render();
							await this.save();
						}),
				);
			}
			m.addSeparator();
			m.addItem((i) => i.setTitle(tx('Rinomina proprietà in tutte le pagine…')).setIcon('pencil').onClick(() => this.renameProperty(col)));
		}
		const idx = this.cfg.columns.indexOf(col);
		if (idx > 1)
			m.addItem((i) =>
				i.setTitle(tx('Sposta a sinistra')).setIcon('arrow-left').onClick(async () => {
					this.cfg.columns.splice(idx, 1);
					this.cfg.columns.splice(idx - 1, 0, col);
					this.render();
					await this.save();
				}),
			);
		if (idx >= 0 && idx < this.cfg.columns.length - 1)
			m.addItem((i) =>
				i.setTitle(tx('Sposta a destra')).setIcon('arrow-right').onClick(async () => {
					this.cfg.columns.splice(idx, 1);
					this.cfg.columns.splice(idx + 1, 0, col);
					this.render();
					await this.save();
				}),
			);
		m.addItem((i) =>
			i.setTitle(tx('Nascondi colonna')).setIcon('eye-off').onClick(async () => {
				this.cfg.columns = this.cfg.columns.filter((c) => c !== col);
				this.render();
				await this.save();
			}),
		);
		if (!isSpecial(col) && type !== 'formula')
			m.addItem((i) =>
				i.setTitle(tx('Elimina proprietà da tutte le pagine')).setIcon('trash-2').setWarning(true).onClick(async () => {
					const rows = this.rows.filter((r) => Object.keys(r.fm).some((k) => k.toLowerCase() === col.toLowerCase()));
					if (!(await confirm(this.app, tx('Eliminare la proprietà?'), tx('“{0}” verrà rimossa da {1} pagine.', col, rows.length), tx('Elimina'), true))) return;
					for (const r of rows) await this.setValue(r.path, col, null);
					this.cfg.columns = this.cfg.columns.filter((c) => c !== col);
					delete this.cfg.types[col];
					await this.save();
					this.schedule();
				}),
			);
		m.showAtMouseEvent(e);
	}

	private async renameProperty(col: string) {
		const n = (await prompt(this.app, tx('Rinomina “{0}”', col), col, '', tx('Rinomina')))?.trim();
		if (!n || n === col) return;
		let count = 0;
		for (const r of this.rows) {
			const f = this.app.vault.getAbstractFileByPath(r.path);
			if (!(f instanceof TFile)) continue;
			const key = Object.keys(r.fm).find((k) => k.toLowerCase() === col.toLowerCase());
			if (!key) continue;
			await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				if (!(key in fm)) return;
				fm[n] = fm[key];
				delete fm[key];
			});
			count++;
		}
		this.cfg.columns = this.cfg.columns.map((c) => (c === col ? n : c));
		if (this.cfg.types[col]) {
			this.cfg.types[n] = this.cfg.types[col];
			delete this.cfg.types[col];
		}
		if (this.cfg.groupBy === col) this.cfg.groupBy = n;
		if (this.cfg.dateField === col) this.cfg.dateField = n;
		await this.save();
		new Notice(tx('Proprietà rinominata in {0} pagine', count));
		this.schedule();
	}

	private rowMenu(e: MouseEvent, r: Row) {
		const f = this.app.vault.getAbstractFileByPath(r.path);
		if (!(f instanceof TFile)) return;
		const m = new Menu();
		m.addItem((i) => i.setTitle(tx('Apri')).setIcon('file').onClick(() => this.app.workspace.getLeaf(false).openFile(f)));
		m.addItem((i) => i.setTitle(tx('Apri a lato')).setIcon('separator-vertical').onClick(() => this.app.workspace.getLeaf('split').openFile(f)));
		m.addItem((i) =>
			i.setTitle(tx('Rinomina')).setIcon('pencil').onClick(async () => {
				const n = await prompt(this.app, tx('Rinomina pagina'), f.basename, '', tx('Rinomina'));
				if (!n || n === f.basename) return;
				const dest = (f.parent && !f.parent.isRoot() ? f.parent.path + '/' : '') + sanitizeFileName(n) + '.md';
				if (this.app.vault.getAbstractFileByPath(dest)) return new Notice(tx('Esiste già una pagina con questo nome'));
				await this.app.fileManager.renameFile(f, dest);
			}),
		);
		m.addItem((i) =>
			i.setTitle(tx('Duplica')).setIcon('copy').onClick(async () => {
				await this.app.vault.copy(f, availablePath(this.app, f.parent?.path ?? '', f.basename + tx(' (copia)'), 'md'));
			}),
		);
		m.addSeparator();
		m.addItem((i) =>
			i.setTitle(tx('Elimina')).setIcon('trash-2').setWarning(true).onClick(async () => {
				if (await confirm(this.app, tx('Eliminare la pagina?'), tx('“{0}” verrà spostata nel cestino.', f.basename), tx('Elimina'), true)) await this.app.fileManager.trashFile(f);
			}),
		);
		m.showAtMouseEvent(e);
	}

	// ------------------------------------------------------------- cells

	private openRow(r: Row, e?: MouseEvent) {
		const f = this.app.vault.getAbstractFileByPath(r.path);
		if (f instanceof TFile) void this.app.workspace.getLeaf(e && (e.metaKey || e.ctrlKey) ? 'tab' : false).openFile(f);
	}

	private nameCell(el: HTMLElement, r: Row) {
		el.addClass('ambraia-db-name');
		const ic = el.createSpan('ambraia-db-row-icon');
		if (r.icon) renderIcon(this.app, ic, r.icon, r.path);
		else setIcon(ic, 'file-text');
		const a = el.createEl('a', { text: r.name, cls: 'internal-link', href: '#' });
		a.onclick = (e) => {
			e.preventDefault();
			this.openRow(r, e);
		};
		a.addEventListener('mouseover', (e) => {
			this.app.workspace.trigger('hover-link', { event: e, source: 'ambraia', hoverParent: this.root, targetEl: a, linktext: r.path, sourcePath: this.host.contextPath });
		});
		const open = el.createSpan({ cls: 'ambraia-db-open', text: 'APRI' });
		open.onclick = (e) => {
			e.stopPropagation();
			const f = this.app.vault.getAbstractFileByPath(r.path);
			if (f instanceof TFile) void this.app.workspace.getLeaf('split').openFile(f);
		};
	}

	private valueView(el: HTMLElement, r: Row, col: string, type: PropType, v: Value) {
		if (v === null || v === '' || (Array.isArray(v) && !v.length)) {
			el.addClass('is-empty');
			return;
		}
		switch (type) {
			case 'checkbox': {
				const cb = el.createEl('input', { type: 'checkbox' });
				cb.checked = v === true || v === 'true';
				cb.disabled = true;
				return;
			}
			case 'select':
			case 'tags': {
				const arr = Array.isArray(v) ? v : [v];
				for (const x of arr) el.createSpan({ cls: `ambraia-pill ${pillColor(toStr(x))}`, text: toStr(x) });
				return;
			}
			case 'url': {
				const s = toStr(v);
				const a = el.createEl('a', { text: s.replace(/^https?:\/\/(www\.)?/, ''), href: s, cls: 'external-link' });
				a.onclick = (e) => e.stopPropagation();
				return;
			}
			case 'link': {
				const arr = Array.isArray(v) ? v : [v];
				for (const x of arr) {
					const s = toStr(x);
					const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(s);
					const target = m ? m[1] : s;
					const a = el.createEl('a', { cls: 'internal-link ambraia-db-rel', text: m?.[2] ?? target.split('/').pop() ?? target, href: '#' });
					a.onclick = (e) => {
						e.preventDefault();
						e.stopPropagation();
						void this.app.workspace.openLinkText(target, r.path, e.metaKey || e.ctrlKey);
					};
				}
				return;
			}
			case 'date': {
				const s = toStr(v);
				const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
				el.setText(d ? `${Number(d[3])} ${MONTHS[Number(d[2]) - 1]?.slice(0, 3).toLowerCase()} ${d[1]}${s.length > 10 ? s.slice(10).replace('T', ' ').slice(0, 6) : ''}` : s);
				return;
			}
			case 'number':
				el.addClass('is-number');
				el.setText(typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 6 }) : toStr(v));
				return;
			default:
				el.setText(toStr(v));
				void col;
		}
	}

	/** Render an editable cell. */
	private cell(el: HTMLElement, r: Row, col: string, ctx: FormulaCtx) {
		const type = this.typeOf(col);
		const v = ctx.value(r, col);
		el.addClass('ambraia-db-cell', `is-${type}`);
		const readOnly = type === 'formula' || isSpecial(col);
		if (type === 'checkbox' && !readOnly) {
			const cb = el.createEl('input', { type: 'checkbox' });
			cb.checked = v === true || v === 'true';
			cb.onclick = (e) => e.stopPropagation();
			cb.onchange = () => this.setValue(r.path, col, cb.checked);
			return;
		}
		this.valueView(el, r, col, type, v);
		if (readOnly) {
			el.addClass('is-readonly');
			return;
		}
		el.onclick = (e) => {
			if ((e.target as HTMLElement).closest('a')) return;
			this.editCell(el, r, col, type, v, e);
		};
	}

	private editCell(el: HTMLElement, r: Row, col: string, type: PropType, v: Value, e: MouseEvent) {
		if (type === 'select' || (type === 'tags' && false)) {
			const m = new Menu();
			const opts = distinctValues(this.rows, col);
			for (const o of opts) m.addItem((i) => i.setTitle(o).setChecked(toStr(v) === o).onClick(() => this.setValue(r.path, col, o)));
			if (opts.length) m.addSeparator();
			m.addItem((i) =>
				i.setTitle(tx('Nuova opzione…')).setIcon('plus').onClick(async () => {
					const n = await prompt(this.app, tx('Nuova opzione per “{0}”', col), '', '', tx('Aggiungi'));
					if (n?.trim()) await this.setValue(r.path, col, n.trim());
				}),
			);
			if (v !== null && v !== '') m.addItem((i) => i.setTitle(tx('Svuota')).setIcon('x').onClick(() => this.setValue(r.path, col, null)));
			m.showAtMouseEvent(e);
			return;
		}
		if (type === 'tags') {
			const m = new Menu();
			const cur = normTags(v);
			const opts = [...new Set([...distinctValues(this.rows, col), ...cur])];
			for (const o of opts)
				m.addItem((i) =>
					i
						.setTitle(o)
						.setChecked(cur.includes(o))
						.onClick(() => this.setValue(r.path, col, cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o])),
				);
			if (opts.length) m.addSeparator();
			m.addItem((i) =>
				i.setTitle(tx('Nuova etichetta…')).setIcon('plus').onClick(async () => {
					const n = await prompt(this.app, tx('Aggiungi a “{0}”', col), '', tx('Separa più valori con la virgola'), tx('Aggiungi'));
					if (n?.trim()) await this.setValue(r.path, col, [...new Set([...cur, ...(coerceInput('tags', n) as string[])])]);
				}),
			);
			m.showAtMouseEvent(e);
			return;
		}
		el.empty();
		el.addClass('is-editing');
		const input = el.createEl('input', { cls: 'ambraia-db-input' });
		if (type === 'date') {
			const s = toStr(v);
			const hasTime = /\d{2}:\d{2}/.test(s);
			input.type = hasTime ? 'datetime-local' : 'date';
			input.value = hasTime ? s.replace(' ', 'T').slice(0, 16) : s.slice(0, 10);
		} else if (type === 'number') {
			input.type = 'text';
			input.inputMode = 'decimal';
			input.value = toStr(v);
		} else if (type === 'link') {
			input.value = (Array.isArray(v) ? v : v === null ? [] : [v]).map((x) => toStr(x).replace(/^\[\[|\]\]$/g, '')).join(', ');
			input.placeholder = tx('Nomi delle pagine separati da virgola');
		} else input.value = toStr(v);
		let done = false;
		const commit = async (save: boolean) => {
			if (done) return;
			done = true;
			if (save) {
				const raw = input.value;
				const val = type === 'date' ? (raw ? raw.replace('T', ' ') : null) : coerceInput(type, raw);
				const before = JSON.stringify(v ?? null);
				if (JSON.stringify(val ?? null) !== before) await this.setValue(r.path, col, val);
			}
			this.render();
		};
		input.onkeydown = (ev) => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				void commit(true);
			} else if (ev.key === 'Escape') {
				ev.preventDefault();
				void commit(false);
			}
		};
		input.onblur = () => commit(true);
		input.onclick = (ev) => ev.stopPropagation();
		input.focus();
		if (type !== 'date') input.select();
	}

	// ------------------------------------------------------------- views

	private renderTable(rows: Row[]) {
		const ctx = new FormulaCtx(this.cfg);
		const table = this.bodyEl.createEl('table', { cls: 'ambraia-db-table' });
		const thead = table.createEl('thead').createEl('tr');
		const sort = parseSort(this.cfg.sort);
		for (const col of this.cfg.columns) {
			const th = thead.createEl('th');
			const type = col === NAME_COL ? 'text' : this.typeOf(col);
			setIcon(th.createSpan('ambraia-db-th-icon'), col === NAME_COL ? 'type' : PROP_TYPES.find((p) => p.id === type)?.icon ?? 'text');
			th.createSpan({ text: col === NAME_COL ? tx('Nome') : col });
			if (sort?.field === col) setIcon(th.createSpan('ambraia-db-th-sort'), sort.desc ? 'arrow-down' : 'arrow-up');
			th.onclick = (e) => this.columnMenu(e, col);
			const w = this.cfg.widths?.[col];
			if (w) th.style.width = `${w}px`;
			this.resizer(th, col);
		}
		const plus = thead.createEl('th', { cls: 'ambraia-db-th-add', attr: { 'aria-label': tx('Aggiungi proprietà') } });
		setIcon(plus, 'plus');
		plus.onclick = (e) => this.addColumnMenu(e);
		const tbody = table.createEl('tbody');
		for (const r of rows) {
			const tr = tbody.createEl('tr');
			tr.oncontextmenu = (e) => {
				e.preventDefault();
				this.rowMenu(e, r);
			};
			for (const col of this.cfg.columns) {
				const td = tr.createEl('td');
				if (col === NAME_COL) this.nameCell(td, r);
				else this.cell(td, r, col, ctx);
			}
			tr.createEl('td', { cls: 'ambraia-db-td-add' });
		}
		const add = tbody.createEl('tr', { cls: 'ambraia-db-add-row' }).createEl('td', { attr: { colspan: String(this.cfg.columns.length + 1) } });
		setIcon(add.createSpan(), 'plus');
		add.createSpan({ text: tx(' Nuovo') });
		add.onclick = () => this.newRow();
		// calculations row: numeric sums
		const numCols = this.cfg.columns.filter((c) => c !== NAME_COL && (this.typeOf(c) === 'number' || (this.typeOf(c) === 'formula' && rows.some((r) => typeof ctx.value(r, c) === 'number'))));
		if (numCols.length && rows.length) {
			const tf = table.createEl('tfoot').createEl('tr');
			for (const col of this.cfg.columns) {
				const td = tf.createEl('td');
				if (col === NAME_COL) td.setText(tx('Conteggio {0}', rows.length));
				else if (numCols.includes(col)) {
					const nums = rows.map((r) => ctx.value(r, col)).filter((x): x is number => typeof x === 'number');
					const sum = nums.reduce((a, b) => a + b, 0);
					td.setText(tx('Somma {0}', sum.toLocaleString(undefined, { maximumFractionDigits: 2 })));
					td.setAttr('aria-label', tx('Media {0}', (nums.length ? sum / nums.length : 0).toLocaleString(undefined, { maximumFractionDigits: 2 })));
				}
			}
			tf.createEl('td');
		}
	}

	private resizer(th: HTMLElement, col: string) {
		const h = th.createDiv('ambraia-db-resize');
		h.onclick = (e) => e.stopPropagation();
		h.onpointerdown = (e) => {
			e.preventDefault();
			e.stopPropagation();
			const startX = e.clientX;
			const startW = th.offsetWidth;
			h.setPointerCapture(e.pointerId);
			const move = (ev: PointerEvent) => (th.style.width = `${Math.max(60, startW + ev.clientX - startX)}px`);
			const up = () => {
				h.removeEventListener('pointermove', move);
				h.removeEventListener('pointerup', up);
				this.cfg.widths = { ...(this.cfg.widths ?? {}), [col]: th.offsetWidth };
				void this.save();
			};
			h.addEventListener('pointermove', move);
			h.addEventListener('pointerup', up);
		};
	}

	private cardProps(card: HTMLElement, r: Row, ctx: FormulaCtx, skip: string[]) {
		const cols = this.cfg.columns.filter((c) => c !== NAME_COL && !skip.includes(c));
		for (const c of cols) {
			const v = ctx.value(r, c);
			if (v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
			const p = card.createDiv('ambraia-card-prop');
			this.valueView(p, r, c, this.typeOf(c), v);
			p.setAttr('aria-label', c);
		}
	}

	private card(parent: HTMLElement, r: Row, ctx: FormulaCtx, skip: string[], cover = false): HTMLElement {
		const card = parent.createDiv('ambraia-card');
		if (cover) {
			const cv = card.createDiv('ambraia-card-cover');
			const bg = resolveBanner(this.app, r.cover, r.path) ?? this.firstImage(r);
			if (bg?.kind === 'img') cv.createEl('img', { attr: { src: bg.src, loading: 'lazy' } });
			else if (bg?.kind === 'css') cv.style.background = bg.value;
			else {
				cv.addClass('is-empty');
				if (r.icon) renderIcon(this.app, cv.createDiv('ambraia-card-cover-icon'), r.icon, r.path);
			}
		}
		const t = card.createDiv('ambraia-card-title');
		if (r.icon && !cover) renderIcon(this.app, t.createSpan('ambraia-db-row-icon'), r.icon, r.path);
		t.createSpan({ text: r.name });
		this.cardProps(card, r, ctx, skip);
		card.onclick = (e) => this.openRow(r, e);
		card.oncontextmenu = (e) => {
			e.preventDefault();
			this.rowMenu(e, r);
		};
		card.draggable = true;
		card.addEventListener('dragstart', (e) => {
			e.dataTransfer?.setData(DND, r.path);
			card.addClass('is-dragging');
		});
		card.addEventListener('dragend', () => card.removeClass('is-dragging'));
		return card;
	}

	private firstImage(r: Row) {
		const f = this.app.vault.getAbstractFileByPath(r.path);
		if (!(f instanceof TFile)) return null;
		const emb = this.app.metadataCache.getFileCache(f)?.embeds?.find((x) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(x.link));
		return emb ? resolveBanner(this.app, `[[${emb.link}]]`, r.path) : null;
	}

	private dropZone(el: HTMLElement, onDrop: (path: string) => void | Promise<void>) {
		el.addEventListener('dragover', (e) => {
			if (!e.dataTransfer?.types.includes(DND)) return;
			e.preventDefault();
			el.addClass('is-drop-target');
		});
		el.addEventListener('dragleave', (e) => {
			if (!el.contains(e.relatedTarget as Node)) el.removeClass('is-drop-target');
		});
		el.addEventListener('drop', (e) => {
			el.removeClass('is-drop-target');
			const p = e.dataTransfer?.getData(DND);
			if (!p) return;
			e.preventDefault();
			void onDrop(p);
		});
	}

	private renderBoard(rows: Row[]) {
		const field = this.cfg.groupBy || this.guessGroupField();
		const ctx = new FormulaCtx(this.cfg);
		const type = this.typeOf(field);
		const groups = groupRows(rows, this.cfg, field);
		const keys = type === 'checkbox' ? ['false', 'true'] : [...new Set([...distinctValues(this.rows, field), ...groups.keys()])].filter((k) => k !== EMPTY_GROUP);
		const order = [EMPTY_GROUP, ...keys];
		const board = this.bodyEl.createDiv('ambraia-board');
		const editable = type !== 'formula' && !isSpecial(field);
		for (const k of order) {
			const list = groups.get(k) ?? [];
			if (k === EMPTY_GROUP && !list.length && keys.length) continue;
			const col = board.createDiv('ambraia-board-col');
			const head = col.createDiv('ambraia-board-head');
			const label = k === EMPTY_GROUP ? tx('Nessun {0}', field) : type === 'checkbox' ? (k === 'true' ? tx('✅ Sì') : tx('⬜ No')) : k;
			head.createSpan({ cls: `ambraia-pill ${k === EMPTY_GROUP ? '' : pillColor(k)}`, text: label });
			head.createSpan({ cls: 'ambraia-board-count', text: String(list.length) });
			const cards = col.createDiv('ambraia-board-cards');
			for (const r of list) this.card(cards, r, ctx, [field]);
			if (editable) {
				const add = col.createDiv({ cls: 'ambraia-board-add', text: tx('+ Nuovo') });
				add.onclick = () => this.newRow(k === EMPTY_GROUP ? {} : { [field]: this.groupValue(type, k) });
				this.dropZone(col, async (path) => {
					const r = this.rows.find((x) => x.path === path);
					if (!r) return;
					if (type === 'tags') {
						// move: replace the dragged-from value with the new one
						const cur = normTags(r.fm[field] ?? Object.entries(r.fm).find(([kk]) => kk.toLowerCase() === field.toLowerCase())?.[1]);
						const next = k === EMPTY_GROUP ? [] : [...new Set([...cur.filter((x) => !keys.includes(x)), k])];
						await this.setValue(path, field, next);
					} else await this.setValue(path, field, k === EMPTY_GROUP ? null : this.groupValue(type, k));
				});
			}
		}
		if (editable && type !== 'checkbox') {
			const addCol = board.createDiv('ambraia-board-col is-add');
			addCol.createDiv({ cls: 'ambraia-board-add', text: tx('+ Nuovo gruppo') });
			addCol.onclick = async () => {
				const n = await prompt(this.app, tx('Nuovo gruppo ({0})', field), '', tx('Es. Da fare, In corso, Fatto'), tx('Crea'));
				if (n?.trim()) await this.newRow({ [field]: n.trim() });
			};
		}
	}

	private groupValue(type: PropType, k: string): unknown {
		if (type === 'checkbox') return k === 'true';
		if (type === 'number') return Number(k);
		if (type === 'tags') return [k];
		return k;
	}

	private renderList(rows: Row[]) {
		const ctx = new FormulaCtx(this.cfg);
		const list = this.bodyEl.createDiv('ambraia-list');
		for (const r of rows) {
			const it = list.createDiv('ambraia-list-item');
			this.nameCell(it.createDiv('ambraia-list-name'), r);
			const props = it.createDiv('ambraia-list-props');
			this.cardProps(props, r, ctx, []);
			it.oncontextmenu = (e) => {
				e.preventDefault();
				this.rowMenu(e, r);
			};
		}
		const add = list.createDiv({ cls: 'ambraia-list-item ambraia-db-add-row', text: tx('+ Nuovo') });
		add.onclick = () => this.newRow();
	}

	private renderGallery(rows: Row[]) {
		const ctx = new FormulaCtx(this.cfg);
		const g = this.bodyEl.createDiv('ambraia-gallery');
		for (const r of rows) this.card(g, r, ctx, [], true);
		const add = g.createDiv('ambraia-card is-add');
		add.createDiv({ text: tx('+ Nuovo') });
		add.onclick = () => this.newRow();
	}

	private renderCalendar(rows: Row[]) {
		const field = this.cfg.dateField || this.guessDateField();
		const ctx = new FormulaCtx(this.cfg);
		const st = this.state;
		const head = this.bodyEl.createDiv('ambraia-cal-head');
		const prev = head.createDiv({ cls: 'ambraia-db-btn', attr: { 'aria-label': tx('Mese precedente') } });
		setIcon(prev, 'chevron-left');
		head.createDiv({ cls: 'ambraia-cal-title', text: `${MONTHS[st.month]} ${st.year}` });
		const next = head.createDiv({ cls: 'ambraia-db-btn', attr: { 'aria-label': tx('Mese successivo') } });
		setIcon(next, 'chevron-right');
		const today = head.createEl('button', { text: tx('Oggi') });
		head.createDiv({ cls: 'ambraia-cal-field', text: tx('per “{0}”', field) });
		const go = (delta: number) => {
			const d = new Date(st.year, st.month + delta, 1);
			st.month = d.getMonth();
			st.year = d.getFullYear();
			this.render();
		};
		prev.onclick = () => go(-1);
		next.onclick = () => go(1);
		today.onclick = () => {
			const n = new Date();
			st.month = n.getMonth();
			st.year = n.getFullYear();
			this.render();
		};
		const byDay = new Map<string, Row[]>();
		const undated: Row[] = [];
		for (const r of rows) {
			const v = ctx.value(r, field);
			const s = v instanceof Date ? ymd(v) : toStr(Array.isArray(v) ? v[0] ?? null : v);
			const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
			if (!m) {
				undated.push(r);
				continue;
			}
			if (!byDay.has(m[1])) byDay.set(m[1], []);
			byDay.get(m[1])!.push(r);
		}
		const grid = this.bodyEl.createDiv('ambraia-cal-grid');
		for (const d of DAYS) grid.createDiv({ cls: 'ambraia-cal-dow', text: d });
		const first = new Date(st.year, st.month, 1);
		const offset = (first.getDay() + 6) % 7; // Monday first
		const start = new Date(st.year, st.month, 1 - offset);
		const todayStr = ymd(new Date());
		const editable = this.typeOf(field) !== 'formula' && !isSpecial(field);
		for (let i = 0; i < 42; i++) {
			const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
			if (i >= 35 && d.getMonth() !== st.month) break;
			const key = ymd(d);
			const cellEl = grid.createDiv('ambraia-cal-day');
			if (d.getMonth() !== st.month) cellEl.addClass('is-other');
			if (key === todayStr) cellEl.addClass('is-today');
			const top = cellEl.createDiv('ambraia-cal-daynum');
			top.createSpan({ text: String(d.getDate()) });
			if (editable) {
				const add = top.createSpan({ cls: 'ambraia-cal-add', text: '+' });
				add.setAttr('aria-label', tx('Nuova pagina in questo giorno'));
				add.onclick = (e) => {
					e.stopPropagation();
					void this.newRow({ [field]: key });
				};
				this.dropZone(cellEl, async (path) => {
					const r = this.rows.find((x) => x.path === path);
					const old = r ? toStr(rawValueSafe(ctx, r, field)) : '';
					const time = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}.*)$/.exec(old)?.[1] ?? '';
					await this.setValue(path, field, key + time);
				});
			}
			for (const r of byDay.get(key) ?? []) {
				const ev = cellEl.createDiv('ambraia-cal-event');
				if (r.icon) renderIcon(this.app, ev.createSpan('ambraia-db-row-icon'), r.icon, r.path);
				ev.createSpan({ text: r.name });
				ev.onclick = (e) => this.openRow(r, e);
				ev.oncontextmenu = (e) => {
					e.preventDefault();
					this.rowMenu(e, r);
				};
				ev.draggable = editable;
				ev.addEventListener('dragstart', (e) => e.dataTransfer?.setData(DND, r.path));
			}
		}
		if (undated.length) {
			const u = this.bodyEl.createDiv('ambraia-cal-undated');
			u.createDiv({ cls: 'ambraia-panel-label', text: tx('Senza data ({0}) – trascinali su un giorno', undated.length) });
			const wrap = u.createDiv('ambraia-cal-undated-list');
			for (const r of undated.slice(0, 50)) {
				const ev = wrap.createDiv('ambraia-cal-event');
				ev.createSpan({ text: r.name });
				ev.onclick = (e) => this.openRow(r, e);
				ev.draggable = editable;
				ev.addEventListener('dragstart', (e) => e.dataTransfer?.setData(DND, r.path));
			}
		}
	}
}

function rawValueSafe(ctx: FormulaCtx, r: Row, col: string): Value {
	try {
		return ctx.value(r, col);
	} catch {
		return null;
	}
}

const PILL_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

/** Stable colour per option value (like select options). */
export function pillColor(v: string): string {
	let h = 0;
	for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0;
	return `ob-bg-${PILL_COLORS[h % PILL_COLORS.length]}`;
}
