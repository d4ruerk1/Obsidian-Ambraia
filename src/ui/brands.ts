import { BRANDS } from './brandData';

const DARK = /^#(000000|191919|1[0-9a-f]{5})$/i;

/**
 * Ambraia's own simple glyphs for services whose official mark is not available under a free
 * licence: a generic cloud (OneDrive) and a cloud with a "p" (pCloud). They are not logos.
 */
const GLYPHS: Record<string, string> = {
	onedrive: 'M6.5 19a4.5 4.5 0 0 1-.42-8.98A6 6 0 0 1 17.7 8.6 5.2 5.2 0 0 1 17.5 19h-11z',
	pcloud:
		'M6.5 19a4.5 4.5 0 0 1-.42-8.98A6 6 0 0 1 17.7 8.6 5.2 5.2 0 0 1 17.5 19h-11zM9.4 11h1.4v6.6H9.4zM12.9 11.1a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2zM12.9 12.4a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z',
};

/**
 * Small square with the service's mark: Simple Icons (CC0) or Ambraia's own glyph, always drawn
 * in one colour (the service colour) on a lightly tinted badge, so every mark looks consistent.
 * Without any mark: the initial of the service on a badge in its colour.
 */
export function brandBadge(parent: HTMLElement, id: string, name: string, color: string, cls = ''): HTMLElement {
	const el = parent.createDiv({ cls: `ambraia-brand ${cls}`.trim(), attr: { 'aria-hidden': 'true' } });
	const b = BRANDS[id];
	const d = b?.path ?? GLYPHS[id];
	const tint = color.startsWith('#') ? color : (b?.hex ?? color);
	if (d) {
		el.addClass('has-mark');
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', role: 'img', width: '20', height: '20' })) svg.setAttribute(k, v);
		const path = document.createElementNS(NS, 'path');
		path.setAttribute('d', d);
		path.setAttribute('fill', 'currentColor');
		if (!b) path.setAttribute('fill-rule', 'evenodd');
		svg.appendChild(path);
		el.appendChild(svg);
		// near-black marks follow the theme so they stay visible in dark mode
		if (tint && !DARK.test(tint)) {
			el.addClass('is-tinted');
			el.setCssProps({ '--ambraia-brand': tint });
		}
	} else {
		el.addClass('is-initial');
		el.setCssProps({ '--ambraia-brand': color || 'var(--interactive-accent)' });
		el.setText((name.replace(/^Microsoft\s+/, '').trim()[0] ?? '?').toUpperCase());
	}
	return el;
}
