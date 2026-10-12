import { MarkdownView, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { pickBanner, pickIcon } from './pickers';
import { randomEmoji } from './emoji';
import { dropEmptyFrontmatter, getIconFor, GRADIENTS, renderIcon, resolveBanner, setIconFor } from './util';
import { tx } from '../i18n';

interface HeaderData {
	icon: string;
	banner: unknown;
	bannerY: number;
}

/**
 * Page header: cover image + page icon above the inline title,
 * in both editing (live preview / source) and reading mode.
 */
export class PageHeaders {
	constructor(private plugin: AmbraiaPlugin) {}

	get app() {
		return this.plugin.app;
	}

	load() {
		const p = this.plugin;
		const refresh = () => this.refreshAll();
		p.registerEvent(this.app.workspace.on('layout-change', refresh));
		p.registerEvent(this.app.workspace.on('file-open', refresh));
		p.registerEvent(this.app.workspace.on('active-leaf-change', refresh));
		p.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				this.app.workspace.iterateAllLeaves((leaf) => {
					if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) this.apply(leaf);
				});
			}),
		);
		// cheap safety net: Obsidian occasionally re-creates the header DOM (mode switch, reflow)
		p.registerInterval(
			window.setInterval(() => {
				// nothing to do while Obsidian is in the background or the header is off
				if (document.hidden || !this.plugin.settings.showHeader) return;
				const leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
				if (leaf) this.apply(leaf);
			}, 2500),
		);
		this.app.workspace.onLayoutReady(refresh);
	}

	unload() {
		document.querySelectorAll('.ambraia-header').forEach((e) => e.remove());
	}

	refreshAll() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) this.apply(leaf);
		});
	}

	private data(file: TFile): HeaderData {
		const s = this.plugin.settings;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		// the same icon shown in the file explorer (one icon per page)
		const icon = getIconFor(this.plugin, file);
		const banner: unknown = fm[s.bannerKey] ?? fm.banner ?? fm.cover ?? null;
		const y = Number(fm.banner_y ?? fm['banner-y'] ?? 50);
		return { icon, banner, bannerY: Number.isFinite(y) ? Math.min(100, Math.max(0, y <= 1 && y > 0 ? y * 100 : y)) : 50 };
	}

	private anchors(view: MarkdownView): { parent: HTMLElement; before: Element | null }[] {
		const out: { parent: HTMLElement; before: Element | null }[] = [];
		const sizer = view.contentEl.querySelector<HTMLElement>('.markdown-source-view .cm-sizer');
		if (sizer) {
			const t = sizer.querySelector(':scope > .inline-title') ?? sizer.querySelector(':scope > .metadata-container') ?? sizer.querySelector(':scope > .cm-contentContainer');
			out.push({ parent: sizer, before: t });
		}
		const prev = view.contentEl.querySelector<HTMLElement>('.markdown-reading-view .markdown-preview-sizer');
		if (prev) {
			const mh = prev.querySelector<HTMLElement>(':scope > .mod-header');
			if (mh) out.push({ parent: mh, before: mh.firstElementChild });
			else out.push({ parent: prev, before: prev.firstElementChild });
		}
		return out;
	}

	apply(leaf: WorkspaceLeaf) {
		const view = leaf.view as MarkdownView;
		const file = view.file;
		const enabled = this.plugin.settings.showHeader && !!file;
		if (!enabled) {
			view.contentEl.querySelectorAll('.ambraia-header').forEach((e) => e.remove());
			return;
		}
		const d = this.data(file);
		const sig = JSON.stringify([file.path, d, this.plugin.settings.bannerHeight]);
		for (const a of this.anchors(view)) {
			let h = a.parent.querySelector<HTMLElement>(':scope > .ambraia-header');
			if (h && h.dataset.sig === sig && (a.before ? h.nextElementSibling === a.before || h === a.before : true)) continue;
			if (h?.hasClass('is-repositioning')) continue;
			h?.remove();
			h = createDiv('ambraia-header');
			h.dataset.sig = sig;
			if (a.before && a.before.parentElement === a.parent) a.parent.insertBefore(h, a.before);
			else a.parent.prepend(h);
			this.render(h, file, d);
		}
	}

	private render(h: HTMLElement, file: TFile, d: HeaderData) {
		const bg = resolveBanner(this.app, d.banner, file.path);
		h.toggleClass('has-banner', !!bg);
		h.toggleClass('has-icon', !!d.icon);
		if (bg) {
			const b = h.createDiv('ambraia-banner');
			b.style.height = `${this.plugin.settings.bannerHeight}px`;
			if (bg.kind === 'css') b.style.background = bg.value;
			else {
				const img = b.createEl('img', { attr: { src: bg.src, alt: '', draggable: 'false' } });
				img.style.objectPosition = `center ${d.bannerY}%`;
				img.onerror = () => {
					b.addClass('is-broken');
					b.dataset.msg = tx('Immagine di copertina non trovata');
				};
			}
			const ctr = b.createDiv('ambraia-banner-controls');
			const btn = (text: string, fn: () => void | Promise<void>) => {
				const x = ctr.createEl('button', { text });
				x.onclick = (e) => {
					e.preventDefault();
					e.stopPropagation();
					void fn();
				};
			};
			btn(tx('Cambia copertina'), () => this.chooseBanner(file, true));
			if (bg.kind === 'img') btn(tx('Riposiziona'), () => this.reposition(h, b, file, d.bannerY));
			btn(tx('Rimuovi'), () => this.setBanner(file, null));
		}
		const row = h.createDiv('ambraia-header-row');
		if (d.icon) {
			const ic = row.createDiv({ cls: 'ambraia-page-icon', attr: { 'aria-label': tx('Cambia icona') } });
			renderIcon(this.app, ic, d.icon, file.path);
			ic.onclick = (e) => {
				e.preventDefault();
				void this.chooseIcon(file, true);
			};
			ic.oncontextmenu = (e) => {
				e.preventDefault();
				const m = new Menu();
				m.addItem((i) => i.setTitle(tx('Cambia icona')).setIcon('smile').onClick(() => this.chooseIcon(file, true)));
				m.addItem((i) => i.setTitle(tx('Icona casuale')).setIcon('shuffle').onClick(() => this.setIcon(file, randomEmoji())));
				m.addItem((i) => i.setTitle(tx('Rimuovi icona')).setIcon('trash').onClick(() => this.setIcon(file, null)));
				m.showAtMouseEvent(e);
			};
		}
		const actions = h.createDiv('ambraia-header-actions');
		const action = (icon: string, text: string) => {
			const a = actions.createDiv({ cls: 'ambraia-header-action' });
			setIcon(a.createSpan('ambraia-header-action-icon'), icon);
			a.createSpan({ text });
			return a;
		};
		if (!d.icon) {
			const a = action('smile-plus', tx('Aggiungi icona'));
			a.onclick = (e) => {
				e.preventDefault();
				void this.chooseIcon(file, false);
			};
		}
		if (!bg) {
			const a = action('image-plus', tx('Aggiungi copertina'));
			a.onclick = (e) => {
				e.preventDefault();
				// one click = random gradient, change it later
				void this.setBanner(file, `gradient:${Math.floor(Math.random() * GRADIENTS.length)}`);
			};
			a.oncontextmenu = (e) => {
				e.preventDefault();
				void this.chooseBanner(file, false);
			};
		}
	}

	async chooseIcon(file: TFile, has: boolean) {
		const v = await pickIcon(this.app, has);
		if (v === undefined) return;
		await this.setIcon(file, v);
	}

	async chooseBanner(file: TFile, has: boolean) {
		const v = await pickBanner(this.app, file.path, has, this.plugin.settings.optimizeImages);
		if (v === undefined) return;
		await this.setBanner(file, v);
	}

	async setIcon(file: TFile, v: string | null) {
		await setIconFor(this.plugin, file, v);
	}

	async setBanner(file: TFile, v: string | null) {
		const key = this.plugin.settings.bannerKey;
		let empty = false;
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const k of [key, 'banner', 'cover', 'banner_y', 'banner-y']) delete fm[k];
			if (v) fm[key] = v;
			empty = Object.keys(fm).length === 0;
		});
		if (empty) await dropEmptyFrontmatter(this.app, file);
	}

	private reposition(h: HTMLElement, b: HTMLElement, file: TFile, start: number) {
		const img = b.querySelector('img');
		if (!img) return;
		h.addClass('is-repositioning');
		b.addClass('is-repositioning');
		const hint = b.createDiv({ cls: 'ambraia-banner-hint', text: tx('Trascina l’immagine per riposizionarla') });
		const ctr = b.querySelector<HTMLElement>('.ambraia-banner-controls')!;
		ctr.empty();
		let y = start;
		let dragging = false;
		let lastY = 0;
		const down = (e: PointerEvent) => {
			if ((e.target as HTMLElement).closest('button')) return;
			dragging = true;
			lastY = e.clientY;
			b.setPointerCapture(e.pointerId);
			e.preventDefault();
		};
		const move = (e: PointerEvent) => {
			if (!dragging) return;
			const dy = e.clientY - lastY;
			lastY = e.clientY;
			const ratio = img.naturalHeight && img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.6;
			const extra = Math.max(20, b.clientWidth * ratio - b.clientHeight);
			y = Math.min(100, Math.max(0, y - (dy / extra) * 100));
			img.style.objectPosition = `center ${y}%`;
		};
		const up = () => (dragging = false);
		b.addEventListener('pointerdown', down);
		b.addEventListener('pointermove', move);
		b.addEventListener('pointerup', up);
		const finish = async (save: boolean) => {
			b.removeEventListener('pointerdown', down);
			b.removeEventListener('pointermove', move);
			b.removeEventListener('pointerup', up);
			hint.remove();
			h.removeClass('is-repositioning');
			if (save) {
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					delete fm['banner-y'];
					// 50 (centre) is the default: not written, the note stays smaller
					if (Math.round(y) === 50) delete fm.banner_y;
					else fm.banner_y = Math.round(y);
				});
				new Notice(tx('Posizione della copertina salvata'));
			}
			h.dataset.sig = '';
			this.refreshAll();
		};
		const save = ctr.createEl('button', { text: tx('Salva posizione'), cls: 'mod-cta' });
		save.onclick = (e) => {
			e.stopPropagation();
			void finish(true);
		};
		const cancel = ctr.createEl('button', { text: tx('Annulla') });
		cancel.onclick = (e) => {
			e.stopPropagation();
			void finish(false);
		};
	}
}
