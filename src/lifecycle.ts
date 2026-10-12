import type AmbraiaPlugin from './main';
import { tx } from './i18n';
import { riskConfirm, uninstallKeeps, uninstallRisks } from './safety';
import { legacyDir } from './storage';

type Plugins = { uninstallPlugin?: (id: string) => Promise<unknown> };

/**
 * Clean removal without a dedicated button:
 * - "Uninstall" in Obsidian's community plugins list: the last changes are sent, this device leaves
 *   the device list and every trace of Ambraia on the device (state, keychain entries) is deleted.
 *   With end-to-end encrypted services the user confirms the consequences first (or cancels).
 * - plugin folder deleted by hand while Obsidian is open: the same device data is deleted.
 * Notes are never touched.
 */
export function watchRemoval(plugin: AmbraiaPlugin) {
	const app = plugin.app;
	const id = plugin.manifest.id;
	const plugins = (app as unknown as { plugins?: Plugins }).plugins;
	const orig = plugins?.uninstallPlugin;
	if (plugins && typeof orig === 'function') {
		let busy = false;
		const patched = async function (this: unknown, pid: string) {
			if (pid !== id || busy) return orig.call(this, pid);
			busy = true;
			try {
				if (plugin.sync?.managers.some((m) => m.t.encrypt)) {
					const r = await riskConfirm(app, {
						title: tx('Disinstallare Ambraia?'),
						intro: tx('Ambraia invia le ultime modifiche al cloud, ripristina le impostazioni di Obsidian che aveva cambiato ed elimina i suoi dati tecnici da questo dispositivo.'),
						risks: uninstallRisks(plugin),
						keep: uninstallKeeps(),
						checks: [tx('Ho salvato la chiave principale e capisco i rischi.')],
						cta: tx('Disinstalla'),
					});
					if (!r.ok) return;
				}
				await plugin.beforeUninstall(true).catch(() => undefined);
				plugins.uninstallPlugin = orig;
				return await orig.call(this, pid);
			} finally {
				busy = false;
			}
		};
		plugins.uninstallPlugin = patched;
		plugin.register(() => {
			if (plugins.uninstallPlugin === patched) plugins.uninstallPlugin = orig;
		});
	}

	// folder deleted from the file manager (desktop: Obsidian reports changes in the config folder)
	const dir = plugin.manifest.dir;
	if (!dir) return;
	let timer: number | null = null;
	plugin.registerEvent(
		(app.vault as unknown as { on(n: 'raw', cb: (p: string) => void): import('obsidian').EventRef }).on('raw', (p: string) => {
			if (p !== dir && !p.startsWith(dir + '/')) return;
			if (timer) window.clearTimeout(timer);
			// an update rewrites the files within a moment: only a folder still missing later counts
			timer = window.setTimeout(async () => {
				timer = null;
				const a = app.vault.adapter;
				if ((await a.exists(`${dir}/manifest.json`).catch(() => true)) || (await a.exists(`${dir}/main.js`).catch(() => true))) return;
				await plugin.sync?.unload().catch(() => undefined);
				await plugin.beforeUninstall(true).catch(() => undefined);
				await a.rmdir(legacyDir(app), true).catch(() => undefined);
			}, 5000);
		}),
	);
	plugin.register(() => timer && window.clearTimeout(timer));
}
