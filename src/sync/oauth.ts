import { AuthError, NetworkError } from './engine';
import { form, HttpFn, redact } from './http';

export const b64url = (bytes: Uint8Array) => {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function createPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: b64url(new Uint8Array(digest)), state: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

/** Extracts `code` from a pasted redirect URL (or accepts a bare code). Rejects a foreign `state`. */
export function parseRedirect(input: string, expectedState?: string): string | null {
	const t = input.trim();
	if (!t) return null;
	if (!/^https?:/i.test(t) && !t.includes('code=')) return t;
	try {
		const u = new URL(t.includes('://') ? t : 'http://x/?' + t.replace(/^\?/, ''));
		const code = u.searchParams.get('code');
		const state = u.searchParams.get('state');
		if (expectedState && state !== null && state !== expectedState) return null;
		return code;
	} catch {
		return null;
	}
}

export interface TokenResult {
	access: string;
	expiresIn?: number;
}

/** Caches an access token and refreshes it once at a time. */
export class TokenManager {
	private token: string | null = null;
	private expiresAt = 0;
	private inflight: Promise<string> | null = null;

	constructor(private refreshFn: () => Promise<TokenResult>) {}

	reset() {
		this.token = null;
		this.expiresAt = 0;
	}

	async get(force = false): Promise<string> {
		if (!force && this.token && Date.now() < this.expiresAt - 60_000) return this.token;
		if (!this.inflight) {
			this.inflight = this.refreshFn()
				.then((r) => {
					this.token = r.access;
					this.expiresAt = Date.now() + (r.expiresIn || 3600) * 1000;
					return r.access;
				})
				.finally(() => (this.inflight = null));
		}
		return this.inflight;
	}
}

interface TokenJson {
	access_token?: string;
	accessToken?: string;
	refresh_token?: string;
	expires_in?: number;
	expiresIn?: number;
	error?: string | number;
	error_description?: string;
}

/** POST to a token endpoint; maps failures to Auth/Network errors without leaking secrets. */
export async function tokenRequest(http: HttpFn, url: string, body: Record<string, string>, json = false): Promise<{ access: string; refresh?: string; expiresIn?: number }> {
	let res;
	try {
		res = await http({
			url,
			method: 'POST',
			contentType: json ? 'application/json' : 'application/x-www-form-urlencoded',
			body: json ? JSON.stringify(body) : form(body),
		});
	} catch (e) {
		throw new NetworkError(redact(String((e as Error)?.message ?? e)));
	}
	const j = (res.json ?? {}) as TokenJson;
	if (res.status >= 500 || res.status === 429) throw new NetworkError(`token ${res.status}`, res.status >= 500 ? res.status : undefined);
	const access = j.access_token ?? j.accessToken;
	// servers in trouble, or a captive portal answering with its own page: not a revoked access
	if (j.error === 'temporarily_unavailable' || j.error === 'server_error') throw new NetworkError(`token ${j.error}`, 503);
	if (res.status === 200 && !access && !j.error) throw new NetworkError('token: unexpected response');
	if (res.status !== 200 || !access) {
		const err = String(j.error ?? res.status);
		throw new AuthError(err === 'invalid_grant' ? 'invalid_grant' : redact(`${j.error_description || err}`));
	}
	return { access, refresh: j.refresh_token, expiresIn: Number(j.expires_in ?? j.expiresIn) || 3600 };
}

export interface Loopback {
	port: number;
	wait: Promise<{ code: string; state: string }>;
	close: () => void;
}

/** Desktop only: one-shot HTTP server on 127.0.0.1 that receives the OAuth redirect. */
export function startLoopback(page: (ok: boolean) => string): Loopback {
	const http = (window as unknown as { require: (m: string) => typeof import('http') }).require('http');
	let resolveFn!: (v: { code: string; state: string }) => void;
	let rejectFn!: (e: Error) => void;
	const wait = new Promise<{ code: string; state: string }>((res, rej) => {
		resolveFn = res;
		rejectFn = rej;
	});
	const handler = (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const code = url.searchParams.get('code');
		const error = url.searchParams.get('error');
		if (!code && !error) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
		res.end(page(!!code));
		if (code) resolveFn({ code, state: url.searchParams.get('state') ?? '' });
		else rejectFn(new Error(String(error).slice(0, 100)));
	};
	const server = http.createServer(handler);
	// "localhost" may resolve to IPv6: listen on ::1 too (loopback only, never on the network)
	let v6: import('http').Server | null = null;
	server.once('listening', () => {
		try {
			const a = server.address();
			if (a && typeof a === 'object') {
				v6 = http.createServer(handler);
				v6.on('error', () => undefined);
				v6.listen(a.port, '::1');
			}
		} catch {
			v6 = null;
		}
	});
	server.listen(0, '127.0.0.1');
	const timer = window.setTimeout(() => rejectFn(new Error('timeout')), 5 * 60_000);
	return {
		get port() {
			const a = server.address();
			return a && typeof a === 'object' ? a.port : 0;
		},
		wait,
		close: () => {
			window.clearTimeout(timer);
			try {
				server.close();
				v6?.close();
			} catch {
				/* ignore */
			}
		},
	};
}

export async function waitListening(lb: Loopback) {
	for (let i = 0; i < 50 && !lb.port; i++) await new Promise((r) => window.setTimeout(r, 20));
	if (!lb.port) throw new Error('loopback');
	return lb.port;
}
