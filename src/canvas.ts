import { ItemView, Menu, Notice, setIcon, TFile } from 'obsidian';
import type AmbraiaPlugin from './main';
import { availablePath, getIconFor, renderIcon } from './ui/util';
import { tx } from './i18n';

/** The parts of Obsidian's (internal) canvas API used here; everything is feature-detected. */
interface CNode {
	x: number;
	y: number;
	width: number;
	height: number;
	file?: TFile;
	nodeEl?: HTMLElement;
	moveTo?: (p: { x: number; y: number }) => void;
}
interface Canvas {
	selection: Set<CNode>;
	nodes?: Map<string, CNode>;
	requestSave?(): void;
	pushHistory?(data: unknown): void;
	getData?(): unknown;
	createFileNode?(o: { file: TFile; pos: { x: number; y: number }; size?: { width: number; height: number }; save?: boolean; focus?: boolean }): CNode;
	getViewportBBox?(): { minX: number; minY: number; maxX: number; maxY: number };
	deselectAll?(): void;
	addNode?(n: CNode): void;
	select?(n: CNode): void;
}

export type Arrange = 'left' | 'top' | 'h' | 'v' | 'grid';
export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

const GAP = 40;

/** New positions for the boxes (same order). Pure: used by the canvas tools and the tests. */
export function arrange(boxes: Box[], how: Arrange): { x: number; y: number }[] {
	const out = boxes.map((b) => ({ x: b.x, y: b.y }));
	if (boxes.length < 2) return out;
	const minX = Math.min(...boxes.map((b) => b.x));
	const minY = Math.min(...boxes.map((b) => b.y));
	if (how === 'left') return boxes.map((b) => ({ x: minX, y: b.y }));
	if (how === 'top') return boxes.map((b) => ({ x: b.x, y: minY }));
	if (how === 'h' || how === 'v') {
		const k = how === 'h' ? 'x' : 'y';
		const size = how === 'h' ? 'width' : 'height';
		const order = boxes.map((b, i) => i).sort((a, b) => boxes[a][k] - boxes[b][k]);
		const first = boxes[order[0]];
		const last = boxes[order[order.length - 1]];
		const total = order.reduce((s, i) => s + boxes[i][size], 0);
		const span = last[k] + last[size] - first[k];
		const gap = Math.max(GAP / 2, (span - total) / (order.length - 1));
		let pos = first[k];
		for (const i of order) {
			out[i][k] = Math.round(pos);
			pos += boxes[i][size] + gap;
		}
		return out;
	}
	// grid: reading order, as square as possible, cells as big as the biggest card
	const cols = Math.ceil(Math.sqrt(boxes.length));
	const w = Math.max(...boxes.map((b) => b.width));
	const h = Math.max(...boxes.map((b) => b.height));
	const order = boxes.map((b, i) => i).sort((a, b) => boxes[a].y - boxes[b].y || boxes[a].x - boxes[b].x);
	order.forEach((i, n) => {
		out[i] = { x: minX + (n % cols) * (w + GAP), y: minY + Math.floor(n / cols) * (h + GAP) };
	});
	return out;
}

/** Extra tools for Obsidian's canvas ("Lavagna"): new page card, align / distribute / grid, page icons. */
export class CanvasTools {
	private observer: MutationObserver | null = null;
	constructor(private plugin: AmbraiaPlugin) {}

	load() {
		const p = this.plugin;
		p.registerEvent(p.app.workspace.on('layout-change', () => this.decorateAll()));
		p.registerEvent(p.app.workspace.on('active-leaf-change', () => this.decorateAll()));
		p.registerEvent(p.app.metadataCache.on('changed', () => this.decorateAll()));
		p.app.workspace.onLayoutReady(() => this.decorateAll());
	}

	unload() {
		this.observer?.disconnect();
		this.observer = null;
		activeDocument.querySelectorAll('.ambraia-canvas-tools, .ambraia-canvas-icon').forEach((e) => e.remove());
	}

	private views(): (ItemView & { canvas?: Canvas })[] {
		return this.plugin.app.workspace.getLeavesOfType('canvas').map((l) => l.view as ItemView & { canvas?: Canvas });
	}

	private active(): Canvas | null {
		const v = this.plugin.app.workspace.getActiveViewOfType<ItemView & { canvas?: Canvas }>(ItemView);
		return v?.getViewType() === 'canvas' && v.canvas?.selection ? v.canvas : null;
	}

	registerCommands() {
		const p = this.plugin;
		const sel = (min: number, run: (c: Canvas) => void) => (checking: boolean) => {
			const c = this.active();
			if (!c || c.selection.size < min) return false;
			if (!checking) run(c);
			return true;
		};
		p.addCommand({ id: 'canvas-new-page', name: tx('Lavagna: nuova pagina'), icon: 'file-plus', checkCallback: sel(0, (c) => void this.newPage(c)) });
		const actions: [Arrange, string, string][] = [
			['left', tx('Lavagna: allinea a sinistra'), 'align-start-vertical'],
			['top', tx('Lavagna: allinea in alto'), 'align-start-horizontal'],
			['h', tx('Lavagna: distribuisci in orizzontale'), 'align-horizontal-space-around'],
			['v', tx('Lavagna: distribuisci in verticale'), 'align-vertical-space-around'],
			['grid', tx('Lavagna: disponi a griglia'), 'layout-grid'],
		];
		for (const [how, name, icon] of actions) p.addCommand({ id: 'canvas-' + how, name, icon, checkCallback: sel(2, (c) => this.arrange(c, how)) });
	}

	arrange(c: Canvas, how: Arrange) {
		const nodes = Array.from(c.selection).filter((n) => typeof n.x === 'number' && n.moveTo);
		if (nodes.length < 2) return void new Notice(tx('Seleziona almeno due elementi.'));
		c.pushHistory?.(c.getData?.());
		arrange(nodes, how).forEach((pos, i) => nodes[i].moveTo!(pos));
		c.requestSave?.();
	}

	async newPage(c: Canvas) {
		const p = this.plugin;
		const view: (ItemView & { file?: TFile }) | undefined = this.views().find((v) => v.canvas === c);
		const from = view?.file?.path ?? '';
		const parent = p.app.fileManager.getNewFileParent(from);
		const f = await p.app.vault.create(availablePath(p.app, parent.isRoot() ? '' : parent.path, tx('Senza titolo'), 'md'), '');
		if (!c.createFileNode) return void p.app.workspace.getLeaf('split').openFile(f);
		const bb = c.getViewportBBox?.();
		const size = { width: 400, height: 300 };
		const pos = bb ? { x: (bb.minX + bb.maxX) / 2 - size.width / 2, y: (bb.minY + bb.maxY) / 2 - size.height / 2 } : { x: 0, y: 0 };
		c.createFileNode({ file: f, pos, size, save: true, focus: false });
		c.requestSave?.();
		this.decorateAll();
	}

	private decorateAll() {
		if (!this.views().length) return;
		for (const v of this.views()) {
			const c = v.canvas;
			if (!c) continue;
			this.addControls(v, c);
			for (const n of c.nodes?.values() ?? []) this.decorateNode(n);
		}
		this.watch();
	}

	/** Re-decorates when the canvas adds nodes (cheap: only while a canvas is open). */
	private watch() {
		if (this.observer) return;
		let t = 0;
		this.observer = new MutationObserver(() => {
			window.clearTimeout(t);
			t = window.setTimeout(() => {
				if (!this.views().length) {
					this.observer?.disconnect();
					this.observer = null;
					return;
				}
				for (const v of this.views()) for (const n of v.canvas?.nodes?.values() ?? []) this.decorateNode(n);
			}, 300);
		});
		for (const v of this.views()) {
			const el = v.containerEl.querySelector('.canvas-wrapper') ?? v.containerEl;
			this.observer.observe(el, { childList: true, subtree: true });
		}
	}

	private decorateNode(n: CNode) {
		const label = n.nodeEl?.querySelector<HTMLElement>('.canvas-node-label');
		if (!label || !(n.file instanceof TFile) || n.file.extension !== 'md') return;
		const icon = getIconFor(this.plugin, n.file);
		const old = label.querySelector<HTMLElement>('.ambraia-canvas-icon');
		if (old?.dataset.icon === icon) return;
		old?.remove();
		if (!icon) return;
		const el = createSpan({ cls: 'ambraia-canvas-icon' });
		el.dataset.icon = icon;
		renderIcon(this.plugin.app, el, icon, n.file.path);
		label.prepend(el);
	}

	private addControls(v: ItemView, c: Canvas) {
		const controls = v.containerEl.querySelector('.canvas-controls');
		if (!controls || controls.querySelector('.ambraia-canvas-tools')) return;
		const group = createDiv({ cls: 'canvas-control-group ambraia-canvas-tools' });
		const item = (icon: string, label: string, onClick: (e: MouseEvent) => void) => {
			const b = group.createDiv({ cls: 'canvas-control-item clickable-icon', attr: { 'aria-label': label, 'data-tooltip-position': 'left' } });
			setIcon(b, icon);
			b.addEventListener('click', onClick);
		};
		item('file-plus', tx('Nuova pagina'), () => void this.newPage(c));
		item('layout-grid', tx('Disponi'), (e) => {
			const m = new Menu();
			const n = c.selection.size;
			const add = (how: Arrange, title: string, icon: string) => m.addItem((i) => i.setTitle(title).setIcon(icon).setDisabled(n < 2).onClick(() => this.arrange(c, how)));
			add('left', tx('Allinea a sinistra'), 'align-start-vertical');
			add('top', tx('Allinea in alto'), 'align-start-horizontal');
			m.addSeparator();
			add('h', tx('Distribuisci in orizzontale'), 'align-horizontal-space-around');
			add('v', tx('Distribuisci in verticale'), 'align-vertical-space-around');
			add('grid', tx('Disponi a griglia'), 'layout-grid');
			if (n < 2) m.addItem((i) => i.setTitle(tx('Seleziona almeno due elementi.')).setDisabled(true));
			m.showAtMouseEvent(e);
		});
		controls.prepend(group);
	}
}
