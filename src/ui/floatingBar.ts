import { setIcon } from 'obsidian';
import { tx } from '../i18n';

export interface BarButton {
	icon?: string;
	text?: string;
	label: string;
	active?: boolean;
	cls?: string;
	dropdown?: boolean;
	onClick: (e: MouseEvent, btn: HTMLElement) => unknown;
}

export type BarItem = BarButton | 'sep' | { info: string };

export interface Anchor {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** A small floating toolbar positioned near a selection or element. */
export class FloatingBar {
	el: HTMLElement | null = null;
	private panel: HTMLElement | null = null;
	private anchor: Anchor | null = null;
	private key = '';

	constructor(private cls: string) {}

	get visible() {
		return !!this.el;
	}

	contains(n: Node | null): boolean {
		return !!n && (!!this.el?.contains(n) || !!this.panel?.contains(n));
	}

	show(items: BarItem[], anchor: Anchor, key = '') {
		const doc = activeDocument;
		if (this.el && key && key === this.key) {
			this.anchor = anchor;
			this.position();
			return;
		}
		this.hide();
		this.key = key;
		this.anchor = anchor;
		const el = doc.body.createDiv(`ambraia-floating-bar ${this.cls}`);
		// keep the editor selection while clicking the toolbar
		el.addEventListener('mousedown', (e) => {
			if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
		});
		for (const it of items) {
			if (it === 'sep') {
				el.createDiv('ambraia-bar-sep');
				continue;
			}
			if ('info' in it) {
				el.createDiv({ cls: 'ambraia-bar-info', text: it.info });
				continue;
			}
			const b = el.createEl('button', { cls: `ambraia-bar-btn ${it.cls ?? ''}`.trim(), attr: { 'aria-label': it.label, 'data-tooltip-position': 'top' } });
			if (it.icon) setIcon(b.createSpan('ambraia-bar-btn-icon'), it.icon);
			if (it.text) b.createSpan({ cls: 'ambraia-bar-btn-text', text: it.text });
			if (it.dropdown) setIcon(b.createSpan('ambraia-bar-caret'), 'chevron-down');
			if (it.active) b.addClass('is-active');
			b.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				void it.onClick(e, b);
			});
		}
		this.el = el;
		this.position();
		window.requestAnimationFrame(() => el.addClass('is-shown'));
	}

	moveTo(anchor: Anchor) {
		this.anchor = anchor;
		this.position();
	}

	position() {
		if (!this.el || !this.anchor) return;
		const a = this.anchor;
		const el = this.el;
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		const vw = activeWindow.innerWidth;
		const vh = activeWindow.innerHeight;
		let top = a.top - h - 8;
		if (top < 40) top = a.bottom + 8; // not enough room above: show below
		if (top + h > vh - 4) top = Math.max(4, vh - h - 4);
		let left = (a.left + a.right) / 2 - w / 2;
		left = Math.max(6, Math.min(left, vw - w - 6));
		el.style.top = `${Math.round(top)}px`;
		el.style.left = `${Math.round(left)}px`;
		if (this.panel) this.placePanel(this.panel, this.panelBtn);
	}

	private panelBtn: HTMLElement | null = null;

	/** Open a small panel (e.g. colour palette) under a toolbar button. */
	openPanel(btn: HTMLElement, build: (panel: HTMLElement, close: () => void) => void) {
		if (this.panel && this.panelBtn === btn) {
			this.closePanel();
			return;
		}
		this.closePanel();
		const p = activeDocument.body.createDiv('ambraia-floating-panel');
		p.addEventListener('mousedown', (e) => {
			if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
		});
		this.panel = p;
		this.panelBtn = btn;
		build(p, () => this.closePanel());
		this.placePanel(p, btn);
	}

	private placePanel(p: HTMLElement, btn: HTMLElement | null) {
		if (!btn) return;
		const r = btn.getBoundingClientRect();
		const vw = activeWindow.innerWidth;
		const vh = activeWindow.innerHeight;
		let top = r.bottom + 6;
		if (top + p.offsetHeight > vh - 6) top = Math.max(6, r.top - p.offsetHeight - 6);
		const left = Math.max(6, Math.min(r.left, vw - p.offsetWidth - 6));
		p.style.top = `${Math.round(top)}px`;
		p.style.left = `${Math.round(left)}px`;
	}

	closePanel() {
		this.panel?.remove();
		this.panel = null;
		this.panelBtn = null;
	}

	hide() {
		this.closePanel();
		this.el?.remove();
		this.el = null;
		this.key = '';
	}
}

export const COLORS: { id: string; label: string }[] = [
	{ id: 'gray', label: tx('Grigio') },
	{ id: 'brown', label: tx('Marrone') },
	{ id: 'orange', label: tx('Arancione') },
	{ id: 'yellow', label: tx('Giallo') },
	{ id: 'green', label: tx('Verde') },
	{ id: 'blue', label: tx('Blu') },
	{ id: 'purple', label: tx('Viola') },
	{ id: 'pink', label: tx('Rosa') },
	{ id: 'red', label: tx('Rosso') },
];

/** Colour palette: text colours + backgrounds. */
export function buildColorPanel(panel: HTMLElement, onPick: (cls: string | null, bg: boolean) => void, close: () => void) {
	panel.addClass('ambraia-color-panel');
	panel.createDiv({ cls: 'ambraia-panel-label', text: tx('Colore testo') });
	const g1 = panel.createDiv('ambraia-color-grid');
	const def = g1.createDiv({ cls: 'ambraia-color-swatch', text: 'A', attr: { 'aria-label': tx('Predefinito') } });
	def.onclick = () => {
		onPick(null, false);
		close();
	};
	for (const c of COLORS) {
		const s = g1.createDiv({ cls: `ambraia-color-swatch ob-c-${c.id}`, text: 'A', attr: { 'aria-label': c.label } });
		s.onclick = () => {
			onPick(`ob-c-${c.id}`, false);
			close();
		};
	}
	panel.createDiv({ cls: 'ambraia-panel-label', text: tx('Sfondo') });
	const g2 = panel.createDiv('ambraia-color-grid');
	const def2 = g2.createDiv({ cls: 'ambraia-color-swatch', text: 'A', attr: { 'aria-label': tx('Nessuno sfondo') } });
	def2.onclick = () => {
		onPick(null, true);
		close();
	};
	for (const c of COLORS) {
		const s = g2.createDiv({ cls: `ambraia-color-swatch ob-bg-${c.id}`, text: 'A', attr: { 'aria-label': tx('Sfondo {0}', c.label.toLowerCase()) } });
		s.onclick = () => {
			onPick(`ob-bg-${c.id}`, true);
			close();
		};
	}
}
