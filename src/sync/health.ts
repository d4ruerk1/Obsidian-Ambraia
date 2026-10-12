import { App, Notice } from 'obsidian';
import { tx } from '../i18n';

const STORE = 'ambraia-sync-alerts';

/** "1,5 GB" in the user's locale. */
export function formatBytes(n: number): string {
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	let v = Math.max(0, n);
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i++;
	}
	let s: string;
	try {
		s = v.toLocaleString(undefined, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 });
	} catch {
		s = String(Math.round(v));
	}
	return `${s} ${u[i]}`;
}

export interface AlertOptions {
	/** Same key within this time = shown only once (survives restarts). */
	cooldownMs?: number;
	/** Stays on screen until clicked. */
	sticky?: boolean;
}

/**
 * Deduplicated notifications about the health of the services: the user hears about a
 * problem once (also as a system notification when Obsidian is in the background),
 * not at every retry.
 */
export class Alerts {
	private seen: Record<string, number> = {};
	private open = new Map<string, Notice>();

	constructor(
		private app: App,
		private systemEnabled: () => boolean,
	) {
		try {
			const raw: unknown = this.app.loadLocalStorage(STORE);
			const o: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
			if (o && typeof o === 'object') this.seen = o as Record<string, number>;
		} catch {
			this.seen = {};
		}
	}

	private persist() {
		const now = Date.now();
		for (const [k, t] of Object.entries(this.seen)) if (now - t > 30 * 86400_000) delete this.seen[k];
		try {
			this.app.saveLocalStorage(STORE, JSON.stringify(this.seen));
		} catch {
			/* memory only */
		}
	}

	/** Shows msg unless the same key was shown within the cooldown. Returns true when shown. */
	show(key: string, msg: string, o: AlertOptions = {}): boolean {
		const now = Date.now();
		const last = this.seen[key] ?? 0;
		if (o.cooldownMs && now - last < o.cooldownMs) return false;
		this.seen[key] = now;
		this.persist();
		this.dismiss(key);
		const n = new Notice('Ambraia: ' + msg, o.sticky ? 0 : 15000);
		this.open.set(key, n);
		this.system(msg);
		return true;
	}

	/** Lets the same alert show again (the problem was solved). */
	reset(key: string) {
		if (!(key in this.seen)) return;
		delete this.seen[key];
		this.persist();
	}

	/** Hides an alert still on screen (e.g. "cloud full" once space is back). */
	dismiss(key: string) {
		const n = this.open.get(key);
		if (n) {
			try {
				n.hide();
			} catch {
				/* already gone */
			}
			this.open.delete(key);
		}
	}

	/** OS notification, only when the user is not looking at Obsidian. */
	private system(msg: string) {
		if (!this.systemEnabled()) return;
		try {
			const doc = typeof document !== 'undefined' ? document : null;
			if (doc && doc.visibilityState === 'visible' && doc.hasFocus()) return;
			const N = (window as unknown as { Notification?: typeof Notification }).Notification;
			if (!N) return;
			const fire = () => new N(tx('Ambraia – sincronizzazione'), { body: msg, silent: false });
			if (N.permission === 'granted') fire();
			else if (N.permission !== 'denied') void N.requestPermission().then((p) => p === 'granted' && fire());
		} catch {
			/* not supported (mobile) */
		}
	}
}
