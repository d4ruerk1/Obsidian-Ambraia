import { TFile } from 'obsidian';
import type AmbraiaPlugin from './main';

/** Bump when a new clean-up step is added: vaults already cleaned run only the new version once. */
export const MAINTENANCE_VERSION = 1;

export interface MaintenanceReport {
	/** notes whose Ambraia metadata was compacted */
	notes: number;
	/** settings entries pointing to files that no longer exist */
	settings: number;
	/** device files removed from the state folder (never synced) */
	stateFiles: number;
	/** bytes freed in the state folder (approximate) */
	bytes: number;
}

const EMPTY_FM = /^---\r?\n(?:[ \t]*\r?\n)*---[ \t]*(?:\r?\n|$)/;
/** Keys written by Ambraia (or by the plugins it replaces) that carry no information when empty / default. */
const ICON_KEYS = ['icon', 'sticker'];
const BANNER_KEYS = ['banner', 'cover'];

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);

/**
 * Smart, safe defaults that keep the vault (and therefore every cloud copy) lean:
 * - removes empty frontmatter blocks and Ambraia keys with no value or the default value
 *   (empty icon/banner, banner position at the centre, legacy "banner-y");
 * - forgets settings for files that no longer exist (icons, views, favourites, spaces);
 * - deletes regenerable device data: the AI index when AI is off, the merge base when no
 *   cloud service is configured, the state of removed services.
 * Note text, attachments and any other property are never touched.
 */
export class Maintenance {
	private running: Promise<MaintenanceReport> | null = null;
	constructor(private plugin: AmbraiaPlugin) {}

	private get app() {
		return this.plugin.app;
	}

	/**
	 * Automatic upkeep, nothing to press: a few minutes after start-up (when Obsidian is idle) and
	 * at most once a week, forgets settings of deleted files and removes regenerable device data.
	 * Notes are compacted only once per MAINTENANCE_VERSION (never on every start).
	 */
	schedule(delay = 3 * 60_000) {
		const KEY = 'ambraia-maintenance-at';
		const WEEK = 7 * 24 * 3600_000;
		const ls = this.app as unknown as { loadLocalStorage?(k: string): unknown; saveLocalStorage?(k: string, v: unknown): void };
		const last = Number(ls.loadLocalStorage?.(KEY) ?? 0);
		const notes = (this.plugin.settings.maintenanceVersion ?? 0) < MAINTENANCE_VERSION;
		if (!notes && Date.now() - last < WEEK) return;
		const go = async () => {
			try {
				if (notes) await this.run();
				else {
					const r: MaintenanceReport = { notes: 0, settings: 0, stateFiles: 0, bytes: 0 };
					r.settings = await this.pruneSettings();
					await this.pruneState(r);
				}
				ls.saveLocalStorage?.(KEY, String(Date.now()));
				if (notes) {
					this.plugin.settings.maintenanceVersion = MAINTENANCE_VERSION;
					await this.plugin.saveSettings();
				}
			} catch {
				/* tried again on the next start */
			}
		};
		const t = window.setTimeout(() => {
			const idle = (window as unknown as { requestIdleCallback?(cb: () => void, o?: { timeout: number }): number }).requestIdleCallback;
			if (idle) idle(() => void go(), { timeout: 30_000 });
			else void go();
		}, delay);
		this.plugin.register(() => window.clearTimeout(t));
	}

	run(): Promise<MaintenanceReport> {
		if (!this.running) this.running = this.doRun().finally(() => (this.running = null));
		return this.running;
	}

	private async doRun(): Promise<MaintenanceReport> {
		const r: MaintenanceReport = { notes: 0, settings: 0, stateFiles: 0, bytes: 0 };
		await this.compactNotes(r);
		r.settings = await this.pruneSettings();
		await this.pruneState(r);
		return r;
	}

	/** true when the cached frontmatter shows something to compact (cheap: no file read). */
	needsCompaction(fm: Record<string, unknown> | undefined, hasBlock: boolean): boolean {
		if (!hasBlock) return false;
		if (!fm) return true;
		const keys = Object.keys(fm).filter((k) => k !== 'position');
		if (!keys.length) return true;
		const key = this.plugin.settings.bannerKey;
		const iconKey = this.plugin.settings.iconKey;
		for (const k of [iconKey, key, ...ICON_KEYS, ...BANNER_KEYS]) if (k in fm && blank(fm[k])) return true;
		if ('banner-y' in fm) return true;
		if ('banner_y' in fm && Math.round(Number(fm.banner_y)) === 50) return true;
		return false;
	}

	private async compactNotes(r: MaintenanceReport) {
		const files = this.app.vault.getMarkdownFiles();
		let n = 0;
		for (const f of files) {
			// keep the interface responsive on big vaults
			if (++n % 200 === 0) await new Promise((res) => window.setTimeout(res, 0));
			const cache = this.app.metadataCache.getFileCache(f);
			const hasBlock = !!cache?.frontmatterPosition || !!cache?.frontmatter;
			if (!this.needsCompaction(cache?.frontmatter, hasBlock)) continue;
			try {
				if (await this.compactNote(f)) r.notes++;
			} catch {
				/* unreadable or changed meanwhile: next time */
			}
		}
	}

	private async compactNote(f: TFile): Promise<boolean> {
		const s = this.plugin.settings;
		let touched = false;
		let empty = false;
		const fm0 = this.app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm0 && Object.keys(fm0).some((k) => k !== 'position')) {
			await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				for (const k of new Set([s.iconKey, s.bannerKey, ...ICON_KEYS, ...BANNER_KEYS]))
					if (k in fm && blank(fm[k])) {
						delete fm[k];
						touched = true;
					}
				if ('banner-y' in fm) {
					if (!('banner_y' in fm)) fm.banner_y = fm['banner-y'];
					delete fm['banner-y'];
					touched = true;
				}
				if ('banner_y' in fm && Math.round(Number(fm.banner_y)) === 50) {
					delete fm.banner_y;
					touched = true;
				}
				empty = Object.keys(fm).length === 0;
			});
		} else empty = true;
		if (empty) {
			await this.app.vault.process(f, (c) => {
				const next = c.replace(EMPTY_FM, '');
				if (next !== c) touched = true;
				return next;
			});
		}
		return touched;
	}

	/** Forgets icons, views, favourites and space items of files that no longer exist. */
	private async pruneSettings(): Promise<number> {
		const s = this.plugin.settings;
		const v = this.app.vault;
		const exists = (p: string) => p === '' || p === '/' || !!v.getAbstractFileByPath(p);
		let n = 0;
		for (const k of Object.keys(s.icons))
			if (!exists(k) || blank(s.icons[k])) {
				delete s.icons[k];
				n++;
			}
		for (const k of Object.keys(s.folderViews))
			if (!exists(k)) {
				delete s.folderViews[k];
				n++;
			}
		const clean = (l: string[]) => {
			const out = [...new Set(l.filter(exists))];
			n += l.length - out.length;
			return out;
		};
		s.pinned = clean(s.pinned);
		s.expanded = clean(s.expanded);
		for (const sp of s.spaces) sp.items = clean(sp.items);
		if (n) await this.plugin.saveSettings();
		return n;
	}

	/** Device data that can always be rebuilt (never synced, lives in the state folder). */
	private async pruneState(r: MaintenanceReport) {
		const a = this.app.vault.adapter;
		const dir = this.plugin.stateDir;
		const s = this.plugin.settings;
		const rm = async (p: string, folder = false) => {
			try {
				if (!(await a.exists(p))) return;
				const st = await a.stat(p);
				if (folder) await a.rmdir(p, true);
				else await a.remove(p);
				r.stateFiles++;
				r.bytes += st?.size ?? 0;
			} catch {
				/* in use: next time */
			}
		};
		// semantic index: rebuilt on demand when AI (and semantic search) is turned on again
		if (!s.aiEnabled || !s.aiEmbedding) await rm(`${dir}/ai-index.json`);
		// merge base of synced notes: useless without cloud services
		if (!s.syncTargets.length) await rm(`${dir}/sync-base`, true);
		// state of services removed from this vault
		try {
			if (!(await a.exists(dir))) return;
			const ids = new Set(s.syncTargets.map((t) => t.id));
			const { files } = await a.list(dir);
			for (const f of files) {
				const m = /\/sync-state(?:-([^/]+))?\.json$/.exec(f);
				if (!m) continue;
				const id = m[1] ?? 'main';
				if (!ids.has(id)) await rm(f);
			}
		} catch {
			/* state folder unreadable */
		}
	}
}
