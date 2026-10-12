import { BRANDS } from './brandData';

const DARK = /^#(000000|191919|1[0-9a-f]{5})$/i;

/**
 * Small square with the service's mark (Simple Icons, CC0) or, when no mark may be used,
 * a badge with its initial in the service colour.
 */
export function brandBadge(parent: HTMLElement, id: string, name: string, color: string, cls = ''): HTMLElement {
	const el = parent.createDiv({ cls: `ambraia-brand ${cls}`.trim(), attr: { 'aria-hidden': 'true' } });
	const b = BRANDS[id];
	if (b) {
		el.addClass('has-mark');
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', role: 'img', width: '20', height: '20' })) svg.setAttribute(k, v);
		const path = document.createElementNS(NS, 'path');
		path.setAttribute('d', b.path);
		// near-black marks follow the theme so they stay visible in dark mode
		path.setAttribute('fill', DARK.test(b.hex) ? 'currentColor' : b.hex);
		svg.appendChild(path);
		el.appendChild(svg);
	} else {
		el.addClass('is-initial');
		el.style.setProperty('--ambraia-brand', color);
		el.setText((name.replace(/^Microsoft\s+/, '').trim()[0] ?? '?').toUpperCase());
	}
	return el;
}
