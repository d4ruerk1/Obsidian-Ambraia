import { Notice } from 'obsidian';
import type AmbraiaPlugin from './main';
import { tx } from './i18n';

/**
 * Clean removal with Obsidian's own "Uninstall" button, without patching or intercepting it and
 * without private APIs. Obsidian has no uninstall event: "Uninstall" turns the plugin off (onunload)
 * and then deletes its folder. So, right after being turned off, Ambraia checks a few times with
 * the public file API whether its own manifest.json still exists:
 * - still there (turned off, updated, Obsidian closing, folder kept) → nothing is deleted;
 * - gone (uninstalled) → the device data outside the notes is removed (see removeDeviceData).
 * Everything Ambraia keeps on disk (settings, sync state, AI index) lives in the plugin folder,
 * which Obsidian deletes; notes, attachments and icons always stay.
 */
export const CHECKS = [700, 1500, 3000, 6000];

export async function afterUnload(plugin: AmbraiaPlugin, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => window.setTimeout(r, ms))): Promise<boolean> {
	await plugin.sync?.unload().catch(() => undefined);
	const dir = plugin.manifest?.dir;
	if (!dir || !plugin.installedOnDisk) return false;
	const a = plugin.app.vault.adapter;
	const gone = async () => !(await a.exists(`${dir}/manifest.json`).catch(() => true));
	let removed = false;
	for (const ms of CHECKS) {
		await wait(ms);
		if (await gone()) {
			// confirmed a moment later: an update rewriting the folder never leaves it missing this long
			await wait(500);
			removed = await gone();
			break;
		}
	}
	if (!removed) return false;
	const encrypted = !!plugin.sync?.managers.some((m) => m.t.encrypt);
	await plugin.removeDeviceData(dir).catch(() => undefined);
	new Notice(
		tx('Ambraia è stato disinstallato: questo dispositivo è uscito dall’elenco dei dispositivi e chiavi e dati tecnici sono stati eliminati. Le note restano.') +
			(encrypted ? '\n\n' + tx('Le copie cifrate nel cloud restano leggibili solo con Ambraia e la chiave principale.') : ''),
		15000,
	);
	return true;
}
