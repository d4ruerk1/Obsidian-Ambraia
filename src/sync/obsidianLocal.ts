import { App, normalizePath, TFile, TFolder } from 'obsidian';
import type { LocalEntry, LocalFS } from './types';

const TEXT_EXT = new Set(['md', 'txt', 'canvas', 'json', 'css', 'csv', 'base', 'js', 'html', 'svg', 'yaml', 'yml', 'tex']);

export interface LocalOptions {
	configSettings: boolean;
	configAppearance: boolean;
	configPlugins: boolean;
	ignorePatterns: string;
	pluginDir: string;
}

/** Converts a simple glob (`*`, `**`, `?`) to a RegExp. Plain names match anywhere in the path. */
export function globToRegExp(glob: string): RegExp {
	const g = glob.trim().replace(/^\/+/, '');
	let re = '';
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*') {
			if (g[i + 1] === '*') {
				re += '.*';
				i++;
				if (g[i + 1] === '/') i++;
			} else re += '[^/]*';
		} else if (c === '?') re += '[^/]';
		else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	const anchored = g.includes('/') ? `^${re}` : `(^|/)${re}`;
	return new RegExp(`${anchored}(/|$)`);
}

export class ObsidianLocal implements LocalFS {
	private patterns: RegExp[] = [];

	constructor(private app: App, private opts: LocalOptions) {
		this.setOptions(opts);
	}

	setOptions(opts: LocalOptions) {
		this.opts = opts;
		this.patterns = opts.ignorePatterns
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith('#'))
			.map(globToRegExp);
	}

	get configDir() {
		return this.app.vault.configDir;
	}

	isConfigPath(p: string) {
		return p === this.configDir || p.startsWith(this.configDir + '/');
	}

	/** Which parts of the configuration folder are synced. */
	private configAllowed(p: string): boolean {
		const rel = p.slice(this.configDir.length + 1);
		if (!rel) return this.opts.configSettings || this.opts.configAppearance || this.opts.configPlugins;
		const top = rel.split('/')[0];
		const own = this.opts.pluginDir;
		if (p === own || p.startsWith(own + '/')) {
			// code, styles and UI settings; never the sync state (credentials live in the OS secret storage)
			if (!this.opts.configPlugins) return false;
			const f = p.slice(own.length + 1);
			return f === '' || f === 'main.js' || f === 'manifest.json' || f === 'styles.css' || f === 'data.json';
		}
		if (/^workspace(-mobile)?\.json$|^workspaces\.json$|^\.?cache|^graph\.json$/.test(top)) return false;
		if (top === 'themes' || top === 'snippets' || top === 'appearance.json') return this.opts.configAppearance;
		if (top === 'plugins' || top === 'community-plugins.json') return this.opts.configPlugins;
		if (rel.includes('/')) return false;
		return this.opts.configSettings && rel.endsWith('.json');
	}

	isIgnored(p: string): boolean {
		if (!p) return true;
		if (p === '.trash' || p.startsWith('.trash/')) return true;
		// control files of the device list / pairing (cloud side): never part of the vault
		if (p === '.ambraia' || p.startsWith('.ambraia/')) return true;
		if (/(^|\/)(\.git|\.DS_Store|Thumbs\.db|desktop\.ini|node_modules)(\/|$)/.test(p)) return true;
		if (this.isConfigPath(p)) return !this.configAllowed(p);
		if (p.split('/').some((seg) => seg.startsWith('.'))) return true;
		return this.patterns.some((r) => r.test(p));
	}

	async list(): Promise<LocalEntry[]> {
		const out: LocalEntry[] = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (!f.path || f.path === '/' || this.isIgnored(f.path)) continue;
			if (f instanceof TFile) out.push({ path: f.path, isFolder: false, mtime: f.stat.mtime, size: f.stat.size });
			else if (f instanceof TFolder) out.push({ path: f.path, isFolder: true, mtime: 0, size: 0 });
		}
		if (this.opts.configSettings || this.opts.configAppearance || this.opts.configPlugins) {
			await this.listConfig(this.configDir, out, 0);
		}
		return out;
	}

	async listConfigOnly(): Promise<LocalEntry[]> {
		const out: LocalEntry[] = [];
		await this.listConfig(this.configDir, out, 0);
		return out;
	}

	private async listConfig(dir: string, out: LocalEntry[], depth: number) {
		if (depth > 6) return;
		const adapter = this.app.vault.adapter;
		let listed;
		try {
			listed = await adapter.list(dir);
		} catch {
			return;
		}
		for (const folder of listed.folders) {
			const p = normalizePath(folder);
			if (this.isIgnored(p) && !this.hasAllowedDescendant(p)) continue;
			if (!this.isIgnored(p)) out.push({ path: p, isFolder: true, mtime: 0, size: 0 });
			await this.listConfig(p, out, depth + 1);
		}
		for (const file of listed.files) {
			const p = normalizePath(file);
			if (this.isIgnored(p)) continue;
			const st = await adapter.stat(p);
			if (st) out.push({ path: p, isFolder: false, mtime: st.mtime, size: st.size });
		}
	}

	private hasAllowedDescendant(folder: string) {
		// plugins/ is listed only when plugin syncing is on; own plugin folder is partially synced
		return this.opts.configPlugins && (this.opts.pluginDir.startsWith(folder + '/') || folder === this.opts.pluginDir);
	}

	async stat(p: string): Promise<LocalEntry | null> {
		const f = this.app.vault.getAbstractFileByPath(p);
		if (f instanceof TFile) return { path: p, isFolder: false, mtime: f.stat.mtime, size: f.stat.size };
		if (f instanceof TFolder) return { path: p, isFolder: true, mtime: 0, size: 0 };
		if (this.isConfigPath(p)) {
			const st = await this.app.vault.adapter.stat(p);
			if (!st) return null;
			return { path: p, isFolder: st.type === 'folder', mtime: st.type === 'folder' ? 0 : st.mtime, size: st.type === 'folder' ? 0 : st.size };
		}
		return null;
	}

	async read(p: string): Promise<ArrayBuffer> {
		const f = this.app.vault.getAbstractFileByPath(p);
		if (f instanceof TFile) return this.app.vault.readBinary(f);
		return this.app.vault.adapter.readBinary(p);
	}

	private async ensureFolder(p: string) {
		if (!p || p === '/') return;
		if (this.isConfigPath(p)) {
			if (!(await this.app.vault.adapter.exists(p))) await this.app.vault.adapter.mkdir(p);
			return;
		}
		const existing = this.app.vault.getAbstractFileByPath(p);
		if (existing instanceof TFolder) return;
		const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
		await this.ensureFolder(parent);
		try {
			await this.app.vault.createFolder(p);
		} catch (e) {
			if (!(this.app.vault.getAbstractFileByPath(p) instanceof TFolder)) throw e;
		}
	}

	async write(p: string, data: ArrayBuffer): Promise<void> {
		const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
		if (this.isConfigPath(p)) {
			await this.ensureFolder(parent);
			await this.app.vault.adapter.writeBinary(p, data);
			return;
		}
		const existing = this.app.vault.getAbstractFileByPath(p);
		const ext = p.split('.').pop()?.toLowerCase() ?? '';
		if (existing instanceof TFile) {
			if (TEXT_EXT.has(ext)) {
				const text = decodeUtf8(data);
				if (text !== null) {
					// vault.modify keeps open editors in sync with the new content
					await this.app.vault.modify(existing, text);
					return;
				}
			}
			await this.app.vault.modifyBinary(existing, data);
			return;
		}
		await this.ensureFolder(parent);
		await this.app.vault.createBinary(p, data);
	}

	async mkdir(p: string): Promise<void> {
		await this.ensureFolder(p);
	}

	async remove(p: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(p);
		if (f) {
			await this.app.fileManager.trashFile(f);
			return;
		}
		if (this.isConfigPath(p)) {
			const st = await this.app.vault.adapter.stat(p);
			if (st?.type === 'folder') await this.app.vault.adapter.rmdir(p, true);
			else if (st) await this.app.vault.adapter.remove(p);
		}
	}

	async rename(from: string, to: string): Promise<void> {
		const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
		await this.ensureFolder(parent);
		const f = this.app.vault.getAbstractFileByPath(from);
		if (f) {
			await this.app.vault.rename(f, to);
			return;
		}
		if (this.isConfigPath(from)) await this.app.vault.adapter.rename(from, to);
	}

	async children(p: string): Promise<string[]> {
		const f = this.app.vault.getAbstractFileByPath(p);
		if (f instanceof TFolder) return f.children.map((c) => c.path).filter((c) => !this.isIgnored(c));
		if (this.isConfigPath(p)) {
			try {
				const l = await this.app.vault.adapter.list(p);
				return [...l.files, ...l.folders].filter((c) => !this.isIgnored(c));
			} catch {
				return [];
			}
		}
		return [];
	}
}

function decodeUtf8(data: ArrayBuffer): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
	} catch {
		return null;
	}
}
