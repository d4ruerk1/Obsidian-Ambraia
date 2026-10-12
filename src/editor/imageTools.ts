import { EditorView } from '@codemirror/view';
import { editorInfoField, MarkdownView, Menu, normalizePath, Notice, requestUrl, TFile } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { BarItem, FloatingBar } from '../ui/floatingBar';
import { confirm, openExternal, prompt, sanitizeFileName } from '../ui/util';
import { Embed, embedMatchesName, findEmbeds, formatEmbed, parseEmbed } from './textOps';
import { tx } from '../i18n';

/** A handle to one embed in a note, independent of the view mode. */
interface EmbedRef {
	sourcePath: string;
	read(): Promise<Embed | null>;
	write(next: string | null): Promise<boolean>;
}

function cmRef(view: EditorView, from: number, to: number, sourcePath: string): EmbedRef {
	let f = from;
	let t = to;
	const original = view.state.sliceDoc(from, to);
	return {
		sourcePath,
		async read() {
			return parseEmbed(view.state.sliceDoc(f, t));
		},
		async write(next) {
			const cur = view.state.sliceDoc(f, t);
			if (cur !== original && !parseEmbed(cur)) {
				new Notice(tx('La nota è cambiata, riprova.'));
				return false;
			}
			const insert = next ?? '';
			view.dispatch({ changes: { from: f, to: t, insert }, userEvent: 'input.ambraia' });
			t = f + insert.length;
			return true;
		},
	};
}

function vaultRef(plugin: AmbraiaPlugin, file: TFile, name: string, nth: number): EmbedRef {
	const app = plugin.app;
	const locate = (content: string) => findEmbeds(content).filter((x) => embedMatchesName(x.embed, name))[nth] ?? null;
	return {
		sourcePath: file.path,
		async read() {
			return locate(await app.vault.read(file))?.embed ?? null;
		},
		async write(next) {
			let ok = false;
			await app.vault.process(file, (c) => {
				const hit = locate(c);
				if (!hit) return c;
				ok = true;
				return c.slice(0, hit.from) + (next ?? '') + c.slice(hit.to);
			});
			if (!ok) new Notice(tx('Non trovo questa immagine nel testo della nota.'));
			return ok;
		},
	};
}

const SIZES: [string, number | null, string][] = [
	['S', 240, tx('Piccola')],
	['M', 440, tx('Media grandezza')],
	['L', 720, tx('Grande')],
];

function isUrl(t: string) {
	return /^[a-z]+:\/\//i.test(t);
}

export function resolveImageFile(plugin: AmbraiaPlugin, e: Embed, sourcePath: string): TFile | null {
	if (isUrl(e.target)) return null;
	let t = e.target.replace(/^<|>$/g, '');
	try {
		t = decodeURIComponent(t);
	} catch {
		/* keep raw */
	}
	return plugin.app.metadataCache.getFirstLinkpathDest(t.split('#')[0], sourcePath);
}

async function copyImage(src: string) {
	try {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		await new Promise<void>((res, rej) => {
			img.onload = () => res();
			img.onerror = () => rej(new Error(tx('immagine non caricabile')));
			img.src = src;
		});
		const c = createEl('canvas');
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		c.getContext('2d')!.drawImage(img, 0, 0);
		const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
		if (!blob) throw new Error(tx('conversione fallita'));
		await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
		new Notice(tx('Immagine copiata negli appunti'));
	} catch (e) {
		new Notice(tx('Impossibile copiare l’immagine: ') + (e instanceof Error ? e.message : String(e)));
	}
}

function buildItems(plugin: AmbraiaPlugin, ref: EmbedRef, e: Embed, after: () => void): BarItem[] {
	const app = plugin.app;
	const file = resolveImageFile(plugin, e, ref.sourcePath);
	const src = file ? app.vault.getResourcePath(file) : e.target;
	const update = async (fn: (x: Embed) => Embed) => {
		const cur = (await ref.read()) ?? e;
		if (await ref.write(formatEmbed(fn(cur)))) after();
	};
	const items: BarItem[] = [];
	for (const [label, w, tip] of SIZES) {
		items.push({ text: label, label: `${tip} (${w}px)`, active: e.width === w, cls: 'is-text', onClick: () => update((x) => ({ ...x, width: w, height: null })) });
	}
	items.push({ icon: 'maximize', label: tx('Dimensione originale'), active: !e.width, onClick: () => update((x) => ({ ...x, width: null, height: null })) });
	items.push('sep');
	for (const [a, icon, label] of [
		['left', 'align-left', tx('Allinea a sinistra')],
		['center', 'align-center', tx('Centra')],
		['right', 'align-right', tx('Allinea a destra')],
	] as const) {
		items.push({ icon, label, active: e.align === a, onClick: () => update((x) => ({ ...x, align: x.align === a ? null : a })) });
	}
	items.push('sep');
	items.push({
		icon: 'type',
		label: tx('Testo alternativo / didascalia'),
		onClick: async () => {
			const t = await prompt(app, tx('Testo alternativo'), e.alt, tx('Descrivi l’immagine'), tx('Applica'));
			if (t !== null) await update((x) => ({ ...x, alt: t.replace(/[|\]\n]/g, ' ').trim() }));
		},
	});
	items.push({
		icon: 'panel-top',
		label: tx('Usa come copertina della pagina'),
		onClick: async () => {
			const note = app.vault.getAbstractFileByPath(ref.sourcePath);
			if (!(note instanceof TFile)) return;
			const value = file ? `[[${app.metadataCache.fileToLinktext(file, note.path, false)}]]` : e.target;
			await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
				fm[plugin.settings.bannerKey] = value;
			});
			new Notice(tx('Copertina impostata'));
			after();
		},
	});
	items.push({
		icon: 'maximize-2',
		label: tx('Apri l’immagine'),
		onClick: () => {
			if (file) void app.workspace.getLeaf('tab').openFile(file);
			else openExternal(e.target);
		},
	});
	items.push({
		icon: 'more-horizontal',
		label: tx('Altro'),
		onClick: (ev) => {
			const m = new Menu();
			m.addItem((i) => i.setTitle(tx('Copia immagine')).setIcon('clipboard-copy').onClick(() => copyImage(src)));
			m.addItem((i) =>
				i.setTitle(tx('Copia link')).setIcon('link').onClick(() => {
					void navigator.clipboard.writeText(formatEmbed(e));
					new Notice(tx('Link copiato'));
				}),
			);
			if (file) {
				m.addItem((i) =>
					i.setTitle(tx('Mostra nell’esplora file')).setIcon('folder-search').onClick(() => {
						const ex = app.workspace.getLeavesOfType('file-explorer')[0];
						if (ex) {
							void app.workspace.revealLeaf(ex);
							(ex.view as { revealInFolder?: (f: TFile) => void }).revealInFolder?.(file);
						}
					}),
				);
				m.addItem((i) =>
					i.setTitle(tx('Rinomina file…')).setIcon('pencil').onClick(async () => {
						const n = await prompt(app, tx('Rinomina immagine'), file.basename, '', tx('Rinomina'));
						if (!n || n === file.basename) return;
						const dest = normalizePath((file.parent && !file.parent.isRoot() ? file.parent.path + '/' : '') + sanitizeFileName(n) + '.' + file.extension);
						if (app.vault.getAbstractFileByPath(dest)) return new Notice(tx('Esiste già un file con questo nome'));
						await app.fileManager.renameFile(file, dest); // updates every link
						after();
					}),
				);
			} else if (isUrl(e.target)) {
				m.addItem((i) =>
					i.setTitle(tx('Scarica nel vault')).setIcon('download').onClick(async () => {
						try {
							const r = await requestUrl({ url: e.target });
							const type = (r.headers['content-type'] ?? '').split(';')[0];
							const ext = /png/.test(type) ? 'png' : /gif/.test(type) ? 'gif' : /webp/.test(type) ? 'webp' : /svg/.test(type) ? 'svg' : 'jpg';
							let base = 'immagine';
							try {
								base = sanitizeFileName(decodeURIComponent(new URL(e.target).pathname.split('/').pop() ?? '').replace(/\.[^.]+$/, '')) || base;
							} catch {
								/* ignore */
							}
							const path = await app.fileManager.getAvailablePathForAttachment(`${base}.${ext}`, ref.sourcePath);
							const saved = await app.vault.createBinary(path, r.arrayBuffer);
							const lt = app.metadataCache.fileToLinktext(saved, ref.sourcePath, false);
							await update((x) => ({ ...x, kind: 'wiki', target: lt }));
							new Notice(tx('Immagine salvata nel vault'));
						} catch (err) {
							new Notice(tx('Download non riuscito: ') + (err instanceof Error ? err.message : String(err)));
						}
					}),
				);
			}
			m.addSeparator();
			m.addItem((i) =>
				i.setTitle(tx('Rimuovi dalla nota')).setIcon('x').onClick(async () => {
					if (await ref.write(null)) after();
				}),
			);
			if (file)
				m.addItem((i) =>
					i.setTitle(tx('Elimina il file immagine')).setIcon('trash-2').setWarning(true).onClick(async () => {
						const others = Object.entries(app.metadataCache.resolvedLinks).filter(([p, links]) => p !== ref.sourcePath && links[file.path]).length;
						const msg = others ? tx('L’immagine è usata anche in altre {0} note. Spostarla comunque nel cestino?', others) : tx('Spostare l’immagine nel cestino e rimuoverla dalla nota?');
						if (!(await confirm(app, tx('Eliminare l’immagine?'), msg, tx('Elimina'), true))) return;
						await ref.write(null);
						await app.fileManager.trashFile(file);
						after();
					}),
				);
			m.showAtMouseEvent(ev);
		},
	});
	return items;
}

/** Items for an image embed selected as text in the editor. */
export function imageItemsForRange(plugin: AmbraiaPlugin, view: EditorView, from: number, to: number, bar: FloatingBar): BarItem[] {
	const e = parseEmbed(view.state.sliceDoc(from, to));
	if (!e) return [];
	const info = view.state.field(editorInfoField, false);
	const ref = cmRef(view, from, to, info?.file?.path ?? '');
	return buildItems(plugin, ref, e, () => bar.hide());
}

/** Click on any image in a note (editing or reading mode) shows the image toolbar. */
export class ImageClickTools {
	bar = new FloatingBar('ambraia-image-bar');
	private current: HTMLElement | null = null;
	constructor(private plugin: AmbraiaPlugin) {}

	load() {
		const p = this.plugin;
		p.registerDomEvent(document, 'click', (e) => this.onClick(e), { capture: true });
		p.registerDomEvent(document, 'keydown', () => this.hide());
		p.registerDomEvent(document, 'scroll', () => this.reposition(), { capture: true, passive: true });
		p.registerDomEvent(window, 'resize', () => this.hide());
		p.registerEvent(p.app.workspace.on('active-leaf-change', () => this.hide()));
	}

	unload() {
		this.hide();
	}

	hide() {
		this.bar.hide();
		this.current?.removeClass('ambraia-image-selected');
		this.current = null;
	}

	private reposition() {
		if (!this.current || !this.bar.visible) return;
		if (!this.current.isConnected) return this.hide();
		this.bar.moveTo(this.current.getBoundingClientRect());
	}

	private async onClick(ev: MouseEvent) {
		const t = ev.target as HTMLElement;
		if (this.bar.contains(t)) return;
		if (!this.plugin.settings.imageToolbar || !(t.instanceOf(HTMLImageElement))) return this.hide();
		const view = this.findView(t);
		if (!view?.file) return this.hide();
		const reading = !!t.closest('.markdown-reading-view');
		const source = !!t.closest('.markdown-source-view');
		if (!reading && !source) return this.hide();
		if (t.closest('.ambraia-header, .ambraia-db, .ambraia-banner, .callout-icon')) return this.hide();
		const embedEl = t.closest<HTMLElement>('.internal-embed');
		const name = this.nameOf(t, embedEl);
		if (!name) return this.hide();
		let ref: EmbedRef | null = null;
		if (source) {
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			if (!cm) return;
			let pos: number;
			try {
				pos = cm.posAtDOM(embedEl ?? t);
			} catch {
				return;
			}
			const line = cm.state.doc.lineAt(pos);
			const cands = findEmbeds(line.text)
				.map((x) => ({ ...x, from: x.from + line.from, to: x.to + line.from }))
				.filter((x) => embedMatchesName(x.embed, name));
			if (!cands.length) return;
			cands.sort((a, b) => Math.abs(a.from - pos) - Math.abs(b.from - pos));
			ref = cmRef(cm, cands[0].from, cands[0].to, view.file.path);
		} else {
			const root = t.closest('.markdown-reading-view')!;
			const same = Array.from(root.querySelectorAll('img')).filter((im) => this.nameOf(im, im.closest('.internal-embed')) === name);
			const nth = Math.max(0, same.indexOf(t));
			ref = vaultRef(this.plugin, view.file, name, nth);
		}
		const e = await ref.read();
		if (!e) return;
		this.current?.removeClass('ambraia-image-selected');
		this.current = t;
		t.addClass('ambraia-image-selected');
		const items = buildItems(this.plugin, ref, e, () => this.hide());
		this.bar.hide();
		this.bar.show(items, t.getBoundingClientRect(), 'img');
	}

	private nameOf(img: HTMLImageElement, embed: Element | null): string {
		const src = embed?.getAttribute('src');
		if (src) return src.split('#')[0].split('|')[0].split('/').pop() ?? src;
		const raw = img.getAttribute('src') ?? '';
		if (/^https?:/i.test(raw)) return raw.split('/').pop()?.split('?')[0] ?? '';
		// app://local/... resource path
		const clean = raw.split('?')[0];
		try {
			return decodeURIComponent(clean.split('/').pop() ?? '');
		} catch {
			return clean.split('/').pop() ?? '';
		}
	}

	private findView(el: HTMLElement): MarkdownView | null {
		let found: MarkdownView | null = null;
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(el)) found = leaf.view;
		});
		return found;
	}
}
