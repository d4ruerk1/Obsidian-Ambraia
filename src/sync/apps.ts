import type { ProviderId } from './providers';

/** OAuth app of the plugin distribution: users then only have to sign in. */
export interface AppKeys {
	clientId: string;
	/** Google / pCloud (for installed apps it is not confidential) */
	clientSecret?: string;
}

declare const __AMBRAIA_APPS__: Partial<Record<ProviderId, AppKeys>> | undefined;

/** Filled at build time from `apps.json` (see apps.example.json). Empty = users bring their own app. */
export const BUILTIN_APPS: Partial<Record<ProviderId, AppKeys>> = typeof __AMBRAIA_APPS__ === 'object' && __AMBRAIA_APPS__ ? __AMBRAIA_APPS__ : {};

export function builtinApp(p: ProviderId): AppKeys | null {
	const a = BUILTIN_APPS[p];
	if (!a?.clientId) return null;
	if ((p === 'gdrive' || p === 'pcloud') && !a.clientSecret) return null;
	return a;
}
