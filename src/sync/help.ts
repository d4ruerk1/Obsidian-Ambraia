import { setIcon } from 'obsidian';
import { tx } from '../i18n';

/** Small (?) button that shows/hides a short step-by-step tutorial. */
export function helpButton(parent: HTMLElement, title: string, steps: (string | ((li: HTMLElement) => void))[]): HTMLElement {
	const btn = parent.createEl('button', { cls: 'clickable-icon ambraia-help-btn', attr: { 'aria-label': tx('Come si fa?'), type: 'button' } });
	setIcon(btn, 'help-circle');
	let box: HTMLElement | null = null;
	btn.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (box) {
			box.remove();
			box = null;
			btn.removeClass('is-active');
			return;
		}
		btn.addClass('is-active');
		const host = btn.closest('.setting-item') ?? btn.parentElement!;
		box = createDiv({ cls: 'ambraia-help' });
		host.insertAdjacentElement('afterend', box);
		box.createDiv({ cls: 'ambraia-help-title', text: title });
		const ol = box.createEl('ol');
		for (const s of steps) {
			const li = ol.createEl('li');
			if (typeof s === 'string') li.setText(s);
			else s(li);
		}
	};
	return btn;
}

/** Line with a label and a (?) button. */
export function helpToggle(parent: HTMLElement, label: string, steps: (string | ((li: HTMLElement) => void))[]) {
	const row = parent.createDiv({ cls: 'ambraia-help-row' });
	row.createSpan({ text: label });
	helpButton(row, label, steps);
	return row;
}

/** Link that opens in the system browser. */
export const link = (parent: HTMLElement, text: string, href: string) => parent.createEl('a', { text, href, attr: { target: '_blank', rel: 'noopener' } });
