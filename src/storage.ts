import type { App, DataAdapter } from 'obsidian';

/**
 * Where Ambraia keeps its device state (sync state and merge bases, AI index).
 *
 * Everything lives inside the plugin folder, in `<config>/plugins/ambraia/state/`: removing the
 * plugin (from Obsidian or by deleting its folder) removes every trace of it. The state is never
 * synced by Ambraia (see obsidianLocal.ts) and can always be rebuilt. Versions up to 1.0 used
 * `<config>/ambraia/`: its content is moved here on the first start and the old folder is deleted.
 */
export const STATE_SUB = 'state';
/** Folder of older versions, next to the plugins folder. */
export const LEGACY_DIR = 'ambraia';
export const SETTINGS_BACKUP = 'settings.json';
/** Device state files that very old versions left in the plugin folder itself. */
const MOVABLE = /^(sync-state.*\.json|ai-index\.json|link\.ambraia)$/;

let pluginDirOf: string | null = null;

/** Called once at start-up with the plugin folder (manifest.dir). */
export function setPluginDir(dir: string | undefined) {
	pluginDirOf = dir || null;
}

export function stateDir(app: App): string {
	return `${pluginDirOf ?? `${app.vault.configDir}/plugins/ambraia`}/${STATE_SUB}`;
}

export function legacyDir(app: App): string {
	return `${app.vault.configDir}/${LEGACY_DIR}`;
}

/** Creates the state folder (and its parent chain) when missing. */
export async function ensureStateDir(app: App, sub = ''): Promise<string> {
	const dir = stateDir(app) + (sub ? '/' + sub : '');
	await ensureDir(app.vault.adapter, stateDir(app));
	if (sub) await ensureDir(app.vault.adapter, dir);
	return dir;
}

async function ensureDir(a: DataAdapter, dir: string) {
	try {
		if (!(await a.exists(dir))) await a.mkdir(dir);
	} catch {
		/* created meanwhile */
	}
}

/**
 * Settings saved by older versions outside the plugin folder (they survived a manual update that
 * replaced the folder). Read once when data.json is missing, then deleted with the old folder.
 */
export async function readBackup(app: App): Promise<Record<string, unknown> | null> {
	for (const p of [`${legacyDir(app)}/${SETTINGS_BACKUP}`, `${stateDir(app)}/${SETTINGS_BACKUP}`]) {
		try {
			if (!(await app.vault.adapter.exists(p))) continue;
			const d: unknown = JSON.parse(await app.vault.adapter.read(p));
			if (d && typeof d === 'object' && !Array.isArray(d)) return d as Record<string, unknown>;
		} catch {
			/* unreadable: ignored */
		}
	}
	return null;
}

/** Moves a folder's content (recursively) into another one, never overwriting what is already there. */
async function moveTree(a: DataAdapter, from: string, to: string, skip: (name: string) => boolean = () => false) {
	await ensureDir(a, to);
	const { files, folders } = await a.list(from);
	for (const f of files) {
		const name = f.split('/').pop() ?? '';
		if (!name || skip(name)) continue;
		const dest = `${to}/${name}`;
		if (!(await a.exists(dest))) await a.writeBinary(dest, await a.readBinary(f));
	}
	for (const d of folders) {
		const name = d.split('/').pop() ?? '';
		if (name) await moveTree(a, d, `${to}/${name}`);
	}
}

/**
 * Brings the device state of older versions into `<plugin>/state/`: files left in the plugin folder
 * itself and the old `<config>/ambraia/` folder (deleted afterwards). Never overwrites newer state.
 */
export async function migrateState(app: App, pluginDir: string | undefined): Promise<void> {
	if (!pluginDir) return;
	setPluginDir(pluginDir);
	const a = app.vault.adapter;
	const dir = stateDir(app);
	try {
		if (!(await a.exists(pluginDir))) return;
		const { files, folders } = await a.list(pluginDir);
		const move = files.filter((f) => MOVABLE.test(f.split('/').pop() ?? ''));
		const base = folders.find((f) => f.split('/').pop() === 'sync-base');
		if (move.length || base) {
			await ensureDir(a, dir);
			for (const f of move) {
				const to = `${dir}/${f.split('/').pop()}`;
				if (!(await a.exists(to))) await a.write(to, await a.read(f));
				await a.remove(f);
			}
			if (base) {
				await moveTree(a, base, `${dir}/sync-base`);
				await a.rmdir(base, true).catch(() => undefined);
			}
		}
	} catch {
		/* best effort */
	}
	try {
		const old = legacyDir(app);
		if (!(await a.exists(old))) return;
		// the settings copy is read by loadSettings() only when data.json is missing
		const keepBackup = !(await a.exists(`${pluginDir}/data.json`));
		await moveTree(a, old, dir, (name) => name === SETTINGS_BACKUP && !keepBackup);
		await a.rmdir(old, true);
	} catch {
		/* copied what could be copied: the old folder is tried again next time */
	}
}

/** Deletes the settings copy of older versions once data.json has been written. */
export async function dropBackup(app: App): Promise<void> {
	const p = `${stateDir(app)}/${SETTINGS_BACKUP}`;
	try {
		if (await app.vault.adapter.exists(p)) await app.vault.adapter.remove(p);
	} catch {
		/* harmless */
	}
}

/** Only the values that differ from the defaults are stored: data.json stays tiny and readable. */
export function sparse<T extends object>(value: T, defaults: T): Partial<T> {
	const out: Partial<T> = {};
	for (const k of Object.keys(defaults) as (keyof T)[]) {
		const v = value[k];
		if (v === undefined) continue;
		if (JSON.stringify(v) !== JSON.stringify(defaults[k])) out[k] = v;
	}
	return out;
}
