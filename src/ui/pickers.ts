import { App, getIconIds, Modal, normalizePath, Notice, requestUrl, setIcon, TFile } from 'obsidian';
import { EMOJIS, randomEmoji, searchEmoji } from './emoji';
import { GRADIENTS } from './util';
import { CoverPhoto, PHOTO_CATEGORIES } from './gallery';
import { tx } from '../i18n';

/** Icon picker: emoji tab + Lucide icon tab + remove. */
export class IconPicker extends Modal {
	private tab: 'emoji' | 'icons' = 'emoji';
	private query = '';
	private grid!: HTMLElement;
	constructor(app: App, private onPick: (icon: string | null) => void, private hasIcon = true, private lucideOnly = false) {
		super(app);
		if (lucideOnly) this.tab = 'icons';
	}
	onOpen() {
		this.modalEl.addClass('ambraia-picker');
		const top = this.contentEl.createDiv('ambraia-picker-tabs');
		const tabs: [typeof this.tab, string][] = this.lucideOnly
			? [['icons', tx('Icone')]]
			: [
					['emoji', tx('Emoji')],
					['icons', tx('Icone')],
				];
		const tabEls: HTMLElement[] = [];
		for (const [id, label] of tabs) {
			const t = top.createDiv({ cls: 'ambraia-tab', text: label });
			if (id === this.tab) t.addClass('is-active');
			t.onclick = () => {
				this.tab = id;
				tabEls.forEach((e) => e.removeClass('is-active'));
				t.addClass('is-active');
				this.renderGrid();
			};
			tabEls.push(t);
		}
		top.createDiv('ambraia-spacer');
		if (!this.lucideOnly) {
			const rnd = top.createDiv({ cls: 'ambraia-tab', text: tx('Casuale') });
			rnd.onclick = () => this.pick(randomEmoji());
		}
		if (this.hasIcon) {
			const rm = top.createDiv({ cls: 'ambraia-tab', text: tx('Rimuovi') });
			rm.onclick = () => this.pick(null);
		}
		const input = this.contentEl.createEl('input', { type: 'search', cls: 'ambraia-picker-search', attr: { placeholder: tx('Cerca… (anche in italiano)') } });
		input.addEventListener('input', () => {
			this.query = input.value;
			this.renderGrid();
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				const first = this.grid.querySelector<HTMLElement>('.ambraia-picker-item');
				first?.click();
			}
		});
		this.grid = this.contentEl.createDiv('ambraia-picker-grid');
		this.renderGrid();
		window.setTimeout(() => input.focus(), 10);
	}
	private pick(v: string | null) {
		this.onPick(v);
		this.close();
	}
	private renderGrid() {
		this.grid.empty();
		this.grid.toggleClass('is-icons', this.tab === 'icons');
		if (this.tab === 'emoji') {
			const items = searchEmoji(this.query).slice(0, 600);
			if (!items.length && this.query.trim()) {
				// allow typing/pasting an arbitrary emoji or character
				const q = this.query.trim();
				const b = this.grid.createDiv({ cls: 'ambraia-picker-item', text: q });
				b.onclick = () => this.pick(q);
			}
			for (const e of items) {
				const b = this.grid.createDiv({ cls: 'ambraia-picker-item', text: e.char, attr: { 'aria-label': e.keywords.split(' ')[0] ?? '' } });
				b.onclick = () => this.pick(e.char);
			}
		} else {
			const q = this.query.trim().toLowerCase().replace(/\s+/g, '-');
			const ids = getIconIds()
				.filter((id) => id.startsWith('lucide-') && (!q || id.includes(q)))
				.slice(0, 400);
			for (const id of ids) {
				const b = this.grid.createDiv({ cls: 'ambraia-picker-item', attr: { 'aria-label': id.slice(7) } });
				setIcon(b, id);
				b.onclick = () => this.pick(id);
			}
			if (!ids.length) this.grid.createDiv({ cls: 'ambraia-empty', text: tx('Nessuna icona trovata') });
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

export function pickIcon(app: App, hasIcon = true, lucideOnly = false): Promise<string | null | undefined> {
	return new Promise((res) => {
		let picked = false;
		const m = new IconPicker(
			app,
			(v) => {
				picked = true;
				res(v);
			},
			hasIcon,
			lucideOnly,
		);
		const close = m.onClose.bind(m);
		m.onClose = () => {
			close();
			if (!picked) res(undefined);
		};
		m.open();
	});
}

const PHOTO_LABELS: Record<string, () => string> = {
	nature: () => tx('Natura'),
	water: () => tx('Acqua e mare'),
	sky: () => tx('Cielo e montagne'),
	flowers: () => tx('Fiori e piante'),
	seasons: () => tx('Stagioni'),
	city: () => tx('Città e architettura'),
	writing: () => tx('Scrivania e lavoro'),
	abstract: () => tx('Texture e astratti'),
	art: () => tx('Arte e colore'),
	food: () => tx('Cibo e caffè'),
};

/** Cover picker: colours (gradients), photos, upload, link. */
export class BannerPicker extends Modal {
	private tab: 'gallery' | 'link' | 'upload' = 'gallery';
	private body!: HTMLElement;
	constructor(app: App, private sourcePath: string, private onPick: (v: string | null) => void, private hasBanner = true, private optimize = true) {
		super(app);
	}
	onOpen() {
		this.modalEl.addClass('ambraia-picker', 'ambraia-banner-picker');
		const top = this.contentEl.createDiv('ambraia-picker-tabs');
		const tabs: [typeof this.tab, string][] = [
			['gallery', tx('Galleria')],
			['upload', tx('Carica')],
			['link', tx('Link')],
		];
		const els: HTMLElement[] = [];
		for (const [id, label] of tabs) {
			const t = top.createDiv({ cls: 'ambraia-tab', text: label });
			if (id === this.tab) t.addClass('is-active');
			t.onclick = () => {
				this.tab = id;
				els.forEach((e) => e.removeClass('is-active'));
				t.addClass('is-active');
				this.render();
			};
			els.push(t);
		}
		top.createDiv('ambraia-spacer');
		if (this.hasBanner) {
			const rm = top.createDiv({ cls: 'ambraia-tab', text: tx('Rimuovi') });
			rm.onclick = () => this.pick(null);
		}
		this.body = this.contentEl.createDiv('ambraia-picker-body');
		this.render();
	}
	private pick(v: string | null) {
		this.onPick(v);
		this.close();
	}
	private render() {
		const b = this.body;
		b.empty();
		if (this.tab === 'gallery') {
			b.createDiv({ cls: 'ambraia-picker-label', text: tx('Colori') });
			const g = b.createDiv('ambraia-cover-grid');
			GRADIENTS.forEach((css, i) => {
				const c = g.createDiv({ cls: 'ambraia-cover-swatch', attr: { role: 'button', tabindex: '0' } });
				c.setCssStyles({ background: css });
				c.onclick = () => this.pick(`gradient:${i}`);
			});
			for (const cat of PHOTO_CATEGORIES) {
				b.createDiv({ cls: 'ambraia-picker-label', text: PHOTO_LABELS[cat.id]?.() ?? cat.label });
				const grid = b.createDiv('ambraia-cover-grid is-photos');
				for (const p of cat.photos) {
					const c = grid.createDiv({ cls: 'ambraia-cover-swatch is-photo', attr: { role: 'button', tabindex: '0', 'aria-label': tx('Foto di {0} (Unsplash)', p.author) } });
					c.setCssStyles({ backgroundImage: `url("${p.thumb}")` });
					c.onclick = () => void this.pickPhoto(p, c);
				}
			}
			b.createDiv({ cls: 'ambraia-picker-note', text: tx('Foto con licenza Unsplash, scaricate da picsum.photos solo quando ne scegli una e salvate tra gli allegati della nota.') });
		} else if (this.tab === 'link') {
			const input = b.createEl('input', { type: 'url', cls: 'ambraia-picker-search', attr: { placeholder: tx('Incolla il link di un’immagine (https://…)') } });
			const btn = b.createEl('button', { text: tx('Usa questo link'), cls: 'mod-cta' });
			const go = () => {
				const v = input.value.trim();
				if (!/^https?:\/\//i.test(v)) return new Notice(tx('Inserisci un link che inizia con https://'));
				this.pick(v);
			};
			btn.onclick = go;
			input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
			window.setTimeout(() => input.focus(), 10);
		} else {
			const drop = b.createDiv({ cls: 'ambraia-dropzone', text: tx('Trascina qui un’immagine oppure clicca per sceglierla') });
			const file = b.createEl('input', { type: 'file', attr: { accept: 'image/*', style: 'display:none' } });
			drop.onclick = () => file.click();
			const upload = async (f: File | undefined | null) => {
				if (!f) return;
				try {
					const saved = await saveAttachment(this.app, f, this.sourcePath, this.optimize);
					this.pick(this.linkTo(saved));
				} catch (e) {
					new Notice(tx('Caricamento non riuscito: ') + (e instanceof Error ? e.message : String(e)));
				}
			};
			file.onchange = () => upload(file.files?.[0]);
			drop.addEventListener('dragover', (e) => {
				e.preventDefault();
				drop.addClass('is-over');
			});
			drop.addEventListener('dragleave', () => drop.removeClass('is-over'));
			drop.addEventListener('drop', (e) => {
				e.preventDefault();
				drop.removeClass('is-over');
				void upload(e.dataTransfer?.files?.[0]);
			});
		}
	}
	/** Downloads the chosen photo once (cover-<id>.webp in the attachments) and links it. */
	private async pickPhoto(p: CoverPhoto, el: HTMLElement) {
		const name = `cover-${p.id}`;
		const existing = this.app.vault.getFiles().find((f) => f.basename === name && /^(webp|jpe?g)$/.test(f.extension));
		if (existing) return this.pick(this.linkTo(existing));
		el.addClass('is-loading');
		try {
			const r = await requestUrl({ url: `https://picsum.photos/id/${p.id}/1800/600.webp`, throw: false });
			if (r.status !== 200 || !r.arrayBuffer.byteLength || r.arrayBuffer.byteLength > 8_000_000) throw new Error(`HTTP ${r.status}`);
			const type = (r.headers['content-type'] || r.headers['Content-Type'] || '').toLowerCase();
			const ext = type.includes('webp') ? 'webp' : 'jpg';
			if (!/^image\//.test(type || 'image/')) throw new Error(tx('risposta non valida'));
			const fm = this.app.fileManager as unknown as { getAvailablePathForAttachment(name: string, src: string): Promise<string> };
			const path = normalizePath(await fm.getAvailablePathForAttachment(`${name}.${ext}`, this.sourcePath));
			const f = await this.app.vault.createBinary(path, r.arrayBuffer);
			this.pick(this.linkTo(f));
		} catch (e) {
			el.removeClass('is-loading');
			new Notice(tx('Impossibile scaricare la foto: ') + (e instanceof Error ? e.message : String(e)));
		}
	}

	private linkTo(f: TFile): string {
		return `[[${this.app.metadataCache.fileToLinktext(f, this.sourcePath, false)}]]`;
	}
	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Makes a picked/pasted image lighter when it is worth it: large photos are scaled down to 2400 px
 * and re-encoded as WebP, entirely on the device. Keeps the original when it would not shrink.
 */
export async function optimizeImage(f: Blob, name: string): Promise<{ data: ArrayBuffer; ext: string }> {
	const raw = await f.arrayBuffer();
	const ext = (name.split('.').pop() || 'png').toLowerCase();
	if (!/^(png|jpe?g|webp|bmp)$/.test(ext) || raw.byteLength < 200_000 || typeof createImageBitmap !== 'function') return { data: raw, ext };
	try {
		const bmp = await createImageBitmap(f);
		const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
		const c = createEl('canvas');
		c.width = Math.max(1, Math.round(bmp.width * scale));
		c.height = Math.max(1, Math.round(bmp.height * scale));
		c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
		bmp.close?.();
		const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', ext === 'png' ? 0.92 : 0.85));
		if (!blob || blob.type !== 'image/webp' || blob.size > raw.byteLength * 0.85) return { data: raw, ext };
		return { data: await blob.arrayBuffer(), ext: 'webp' };
	} catch {
		return { data: raw, ext };
	}
}

export async function saveAttachment(app: App, f: File, sourcePath: string, optimize = false): Promise<TFile> {
	const base = f.name.replace(/\.[^.]+$/, '') || tx('immagine');
	const { data, ext } = optimize ? await optimizeImage(f, f.name || 'image.png') : { data: await f.arrayBuffer(), ext: (f.name.split('.').pop() || 'png').toLowerCase() };
	const fm = app.fileManager as unknown as { getAvailablePathForAttachment(name: string, src: string): Promise<string> };
	const path = normalizePath(await fm.getAvailablePathForAttachment(`${base}.${ext}`, sourcePath));
	return app.vault.createBinary(path, data);
}

export function pickBanner(app: App, sourcePath: string, hasBanner: boolean, optimize = true): Promise<string | null | undefined> {
	return new Promise((res) => {
		let picked = false;
		const m = new BannerPicker(
			app,
			sourcePath,
			(v) => {
				picked = true;
				res(v);
			},
			hasBanner,
			optimize,
		);
		const close = m.onClose.bind(m);
		m.onClose = () => {
			close();
			if (!picked) res(undefined);
		};
		m.open();
	});
}

export { EMOJIS };
