import type { RemoteAPI } from '../types';
import { form, HttpFn, redact } from '../http';
import { TokenManager, tokenRequest } from '../oauth';
import { AuthError, NetworkError } from '../engine';
import { GoogleDrive } from './gdrive';
import { Dropbox } from './dropbox';
import { OneDrive } from './onedrive';
import { PCloud } from './pcloud';
import { LocalFolder } from './localFolder';
import { KEYFILE } from '../crypto';

export type ProviderId = 'gdrive' | 'dropbox' | 'onedrive' | 'pcloud' | 'mega' | 'proton';

export interface Credentials {
	provider: ProviderId;
	clientId?: string;
	clientSecret?: string;
	refreshToken?: string;
	/** pCloud: long-lived token */
	accessToken?: string;
	/** pCloud API host (US/EU) */
	host?: string;
	/** Google: optional own token endpoint */
	tokenEndpoint?: string;
}

export interface ProviderMeta {
	id: ProviderId;
	name: string;
	/** loopback = browser + automatic return (desktop), code = paste a code, folder = desktop app folder */
	flow: 'loopback' | 'code' | 'folder';
	fields: ('clientId' | 'clientSecret')[];
	color: string;
}

export const PROVIDERS: ProviderMeta[] = [
	{ id: 'gdrive', name: 'Google Drive', flow: 'loopback', fields: ['clientId', 'clientSecret'], color: '#1a73e8' },
	{ id: 'dropbox', name: 'Dropbox', flow: 'code', fields: ['clientId'], color: '#0061fe' },
	{ id: 'onedrive', name: 'Microsoft OneDrive', flow: 'loopback', fields: ['clientId'], color: '#0078d4' },
	{ id: 'pcloud', name: 'pCloud', flow: 'code', fields: ['clientId', 'clientSecret'], color: '#17bed0' },
	{ id: 'mega', name: 'MEGA', flow: 'folder', fields: [], color: '#d9272e' },
	{ id: 'proton', name: 'Proton Drive', flow: 'folder', fields: [], color: '#6d4aff' },
];
export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);
export const providerMeta = (id: ProviderId) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const DROPBOX_TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const MS_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0/';
const MS_SCOPE = 'offline_access Files.ReadWrite';
export const GOOGLE_MOBILE_REDIRECT = 'http://127.0.0.1:53682';
export const MS_MOBILE_REDIRECT = 'https://login.microsoftonline.com/common/oauth2/nativeclient';

/** Authorization page for the "connect" step. */
export function authUrl(p: ProviderId, clientId: string, challenge: string, state: string, redirect?: string): string {
	const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
	if (p === 'gdrive')
		return 'https://accounts.google.com/o/oauth2/v2/auth?' + q({ client_id: clientId, redirect_uri: redirect!, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state });
	if (p === 'dropbox')
		return 'https://www.dropbox.com/oauth2/authorize?' + q({ client_id: clientId, response_type: 'code', token_access_type: 'offline', code_challenge: challenge, code_challenge_method: 'S256' });
	if (p === 'onedrive')
		return MS_BASE + 'authorize?' + q({ client_id: clientId, response_type: 'code', redirect_uri: redirect!, response_mode: 'query', scope: MS_SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account' });
	return 'https://my.pcloud.com/oauth2/authorize?' + q({ client_id: clientId, response_type: 'code', state });
}

/** Exchanges the authorization code for long-lived credentials. */
export async function exchangeCode(http: HttpFn, c: Credentials, code: string, verifier: string, redirect?: string): Promise<Credentials> {
	const id = c.clientId ?? '';
	if (c.provider === 'gdrive') {
		const r = await tokenRequest(http, GOOGLE_TOKEN, { client_id: id, client_secret: c.clientSecret ?? '', code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect! });
		if (!r.refresh) throw new AuthError('no refresh token');
		return { ...c, refreshToken: r.refresh };
	}
	if (c.provider === 'dropbox') {
		const r = await tokenRequest(http, DROPBOX_TOKEN, { client_id: id, code, code_verifier: verifier, grant_type: 'authorization_code' });
		if (!r.refresh) throw new AuthError('no refresh token');
		return { ...c, refreshToken: r.refresh };
	}
	if (c.provider === 'onedrive') {
		const r = await tokenRequest(http, MS_BASE + 'token', { client_id: id, scope: MS_SCOPE, code, redirect_uri: redirect!, grant_type: 'authorization_code', code_verifier: verifier });
		if (!r.refresh) throw new AuthError('no refresh token');
		return { ...c, refreshToken: r.refresh };
	}
	// pCloud: the code works on the data region of the account
	let last: unknown;
	for (const host of ['api.pcloud.com', 'eapi.pcloud.com']) {
		try {
			const res = await http({ url: `https://${host}/oauth2_token?client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(c.clientSecret ?? '')}&code=${encodeURIComponent(code)}`, method: 'GET' });
			const j = res.json as { result?: number; access_token?: string; locationid?: number; error?: string };
			if (j?.result === 0 && j.access_token) {
				const h = j.locationid === 2 ? 'eapi.pcloud.com' : j.locationid === 1 ? 'api.pcloud.com' : host;
				return { ...c, accessToken: j.access_token, host: h };
			}
			last = new AuthError(j?.error ?? String(res.status));
		} catch (e) {
			last = e;
		}
	}
	throw last;
}

/** Device authorization (RFC 8628): sign in on any browser by typing a short code. */
export interface DeviceAuth {
	userCode: string;
	verifyUrl: string;
	deviceCode: string;
	interval: number;
	expiresAt: number;
}

export const supportsDevice = (p: ProviderId) => p === 'gdrive' || p === 'onedrive';

/** Starts device sign-in. Throws AuthError('device-unsupported') when the app type does not allow it. */
export async function deviceStart(http: HttpFn, c: Credentials): Promise<DeviceAuth> {
	const url = c.provider === 'gdrive' ? 'https://oauth2.googleapis.com/device/code' : MS_BASE + 'devicecode';
	const scope = c.provider === 'gdrive' ? 'https://www.googleapis.com/auth/drive.file' : MS_SCOPE;
	let res;
	try {
		res = await http({ url, method: 'POST', contentType: 'application/x-www-form-urlencoded', body: form({ client_id: c.clientId ?? '', scope }) });
	} catch (e) {
		throw new NetworkError(redact(String((e as Error)?.message ?? e)));
	}
	if (res.status >= 500 || res.status === 429) throw new NetworkError(`device ${res.status}`);
	const j = (res.json ?? {}) as { device_code?: string; user_code?: string; verification_url?: string; verification_uri?: string; interval?: number; expires_in?: number; error?: string };
	if (res.status !== 200 || !j.device_code || !j.user_code) throw new AuthError(j.error === 'invalid_client' || j.error === 'unauthorized_client' || res.status === 401 || /AADSTS7000218|AADSTS70002/.test(String(j.error)) ? 'device-unsupported' : redact(String(j.error ?? res.status)));
	const verifyUrl = String(j.verification_url ?? j.verification_uri ?? '');
	if (!/^https:\/\//.test(verifyUrl)) throw new AuthError('device-unsupported');
	return { userCode: j.user_code, verifyUrl, deviceCode: j.device_code, interval: Math.max(2, Number(j.interval) || 5), expiresAt: Date.now() + (Number(j.expires_in) || 900) * 1000 };
}

/** Waits until the user has signed in. `cancelled()` stops polling (returns null). */
export async function devicePoll(http: HttpFn, c: Credentials, d: DeviceAuth, cancelled: () => boolean, sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))): Promise<Credentials | null> {
	let interval = d.interval;
	const body: Record<string, string> = { client_id: c.clientId ?? '', device_code: d.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' };
	if (c.provider === 'gdrive') body.client_secret = c.clientSecret ?? '';
	const url = c.provider === 'gdrive' ? GOOGLE_TOKEN : MS_BASE + 'token';
	while (Date.now() < d.expiresAt) {
		await sleep(interval * 1000);
		if (cancelled()) return null;
		let res;
		try {
			res = await http({ url, method: 'POST', contentType: 'application/x-www-form-urlencoded', body: form(body) });
		} catch {
			continue; // offline for a moment: keep waiting
		}
		const j = (res.json ?? {}) as { access_token?: string; refresh_token?: string; error?: string };
		if (res.status === 200 && j.access_token) {
			if (!j.refresh_token) throw new AuthError('no refresh token');
			return { ...c, refreshToken: j.refresh_token };
		}
		if (j.error === 'authorization_pending' || res.status >= 500) continue;
		if (j.error === 'slow_down' || res.status === 429) {
			interval += 5;
			continue;
		}
		throw new AuthError(j.error === 'access_denied' || j.error === 'authorization_declined' ? 'access_denied' : j.error === 'expired_token' ? 'expired' : redact(String(j.error ?? res.status)));
	}
	throw new AuthError('expired');
}

export type Remote = RemoteAPI & { account?(): Promise<string> };

export interface RemoteOptions {
	folder: string;
	/** MEGA / Proton Drive: the folder kept in sync by the desktop app */
	localBase?: string;
	/** Microsoft rotates refresh tokens: persist the new one */
	onRotate?: (c: Credentials) => void;
}

export function makeRemote(http: HttpFn, c: Credentials, o: RemoteOptions): { remote: Remote; tokens: TokenManager | null } {
	if (c.provider === 'mega' || c.provider === 'proton') {
		if (!o.localBase) throw new AuthError('no-folder');
		const l = new LocalFolder(o.localBase, o.folder, [KEYFILE]) as Remote;
		l.account = async () => o.localBase!;
		return { remote: l, tokens: null };
	}
	let cur = c;
	const tokens = new TokenManager(async () => {
		if (cur.provider === 'pcloud') {
			if (!cur.accessToken) throw new AuthError('not-connected');
			return { access: cur.accessToken, expiresIn: 365 * 86400 };
		}
		if (!cur.refreshToken) throw new AuthError('not-connected');
		if (cur.provider === 'gdrive') {
			if (cur.tokenEndpoint) {
				const body: Record<string, string> = { refresh_token: cur.refreshToken, refreshToken: cur.refreshToken };
				if (cur.clientId) body.client_id = cur.clientId;
				return tokenRequest(http, cur.tokenEndpoint, body, true);
			}
			return tokenRequest(http, GOOGLE_TOKEN, { client_id: cur.clientId ?? '', client_secret: cur.clientSecret ?? '', refresh_token: cur.refreshToken, grant_type: 'refresh_token' });
		}
		if (cur.provider === 'dropbox') return tokenRequest(http, DROPBOX_TOKEN, { client_id: cur.clientId ?? '', refresh_token: cur.refreshToken, grant_type: 'refresh_token' });
		const r = await tokenRequest(http, MS_BASE + 'token', { client_id: cur.clientId ?? '', scope: MS_SCOPE, refresh_token: cur.refreshToken, grant_type: 'refresh_token' });
		if (r.refresh && r.refresh !== cur.refreshToken) {
			cur = { ...cur, refreshToken: r.refresh };
			o.onRotate?.(cur);
		}
		return r;
	});
	const tk = (f?: boolean) => tokens.get(f);
	const remote: Remote =
		c.provider === 'gdrive'
			? new GoogleDrive(http, tk, o.folder)
			: c.provider === 'dropbox'
				? new Dropbox(http, tk, o.folder)
				: c.provider === 'onedrive'
					? new OneDrive(http, tk, o.folder)
					: new PCloud(http, () => tokens.get(), c.host || 'api.pcloud.com', o.folder);
	return { remote, tokens };
}
