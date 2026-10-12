import { HttpError } from './types';
import { AuthError, LimitError, NetworkError, QuotaError } from './engine';

export interface HttpRequest {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}
export interface HttpResponse {
	status: number;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
	headers?: Record<string, string>;
}
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Removes credentials from anything that may end up in a log or a notice. */
export function redact(s: string): string {
	return s
		.replace(/\b(access_token|refresh_token|client_secret|code|auth|token|code_verifier)=([^&\s"']+)/gi, '$1=***')
		.replace(/("(?:access_token|refresh_token|client_secret|accessToken|refreshToken)"\s*:\s*")[^"]*"/g, '$1***"')
		.replace(/Bearer\s+[\w\-.~+/]+=*/g, 'Bearer ***');
}

const header = (res: HttpResponse, name: string) => {
	const h = res.headers ?? {};
	for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k];
	return undefined;
};

/** Bodies that mean "the account is full" on Google Drive, Dropbox, OneDrive and pCloud. */
const QUOTA_RE = /storageQuotaExceeded|quotaLimitReached|insufficientStorage|insufficient_space|insufficient_quota|over_quota|over quota|quota.?exceeded|not enough (?:free )?space/i;
/** Limits that won't lift in a few seconds (daily caps): wait instead of hammering the API. */
const LONG_LIMIT_RE = /dailyLimitExceeded|uploadLimitExceeded|activityLimitReached|userRateLimitExceeded.*daily/i;

/** How a failed response should be treated, independently of the provider. */
export function classifyResponse(res: { status: number; text?: string }): 'quota' | 'limit' | null {
	if (res.status < 400) return null;
	let t = '';
	try {
		t = String(res.text ?? '').slice(0, 4000);
	} catch {
		/* unreadable body */
	}
	if (res.status === 507 || ((res.status === 403 || res.status === 409 || res.status === 413 || res.status === 400) && QUOTA_RE.test(t) && !/download.?quota|rate.?limit|per (?:minute|second|day|user)|queries/i.test(t))) return 'quota';
	if ((res.status === 403 || res.status === 429) && LONG_LIMIT_RE.test(t)) return 'limit';
	return null;
}

export interface ApiOptions {
	label: string;
	retries?: number;
	/** Extra "rate limited" detection (e.g. Drive's 403 rateLimitExceeded). */
	isRateLimited?: (res: HttpResponse) => boolean;
	/** Extracts a readable message from an error body. */
	message?: (res: HttpResponse) => string | undefined;
}

/**
 * Authenticated request with automatic token refresh (401), exponential backoff on
 * 429/5xx honoring Retry-After, and one retry on transport errors.
 */
export async function apiRequest(
	http: HttpFn,
	getToken: ((force?: boolean) => Promise<string>) | null,
	req: HttpRequest,
	o: ApiOptions,
): Promise<HttpResponse> {
	const retries = o.retries ?? 4;
	let attempt = 0;
	let netFails = 0;
	let forced = false;
	for (;;) {
		const headers = { ...(req.headers ?? {}) };
		if (getToken) headers.Authorization = `Bearer ${await getToken(forced)}`;
		let res: HttpResponse;
		try {
			res = await http({ ...req, headers });
		} catch (e) {
			if (netFails++ < 1) {
				await sleep(800);
				continue;
			}
			throw new NetworkError(redact(String((e as Error)?.message ?? e)));
		}
		if (res.status >= 200 && res.status < 300) return res;
		if (res.status === 401 && getToken && !forced) {
			forced = true;
			continue;
		}
		if (res.status === 401) throw new AuthError(`${o.label}: 401`);
		const describe = () => {
			let msg: string | undefined;
			try {
				msg = o.message?.(res);
			} catch {
				/* ignore */
			}
			let body = '';
			try {
				body = res.text?.slice(0, 300) ?? '';
			} catch {
				/* ignore */
			}
			return redact(`${o.label} ${res.status}: ${msg ?? body}`);
		};
		const kind = classifyResponse(res);
		if (kind === 'quota') throw new QuotaError(describe());
		if (kind === 'limit') throw new LimitError(describe(), 3600_000);
		const limited = res.status === 429 || res.status >= 500 || !!o.isRateLimited?.(res);
		const ra = Number(header(res, 'retry-after'));
		// a long Retry-After: give up now and let the manager wait, instead of blocking the cycle
		if (limited && ra >= 120) throw new LimitError(describe(), Math.min(6 * 3600_000, ra * 1000));
		if (limited && attempt < retries) {
			const wait = ra > 0 ? ra * 1000 : Math.min(16000, 500 * 2 ** attempt) + Math.random() * 300;
			await sleep(wait);
			attempt++;
			continue;
		}
		if (limited && res.status >= 500) throw new NetworkError(describe(), res.status);
		if (limited) throw new LimitError(describe(), ra > 0 ? ra * 1000 : 60_000);
		throw new HttpError(res.status, describe());
	}
}

export const form = (o: Record<string, string>) =>
	Object.entries(o)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');

/** Joins path segments of a user-chosen remote directory: "a//b/" -> "a/b". */
export const cleanPath = (p: string) =>
	p
		.split(/[\\/]+/)
		.map((s) => s.trim())
		.filter((s) => s && s !== '.' && s !== '..')
		.join('/');

export function multipart(parts: { headers: string; body: Uint8Array | string }[], boundary: string): ArrayBuffer {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (const p of parts) {
		chunks.push(enc.encode(`--${boundary}\r\n${p.headers}\r\n\r\n`));
		chunks.push(typeof p.body === 'string' ? enc.encode(p.body) : p.body);
		chunks.push(enc.encode('\r\n'));
	}
	chunks.push(enc.encode(`--${boundary}--`));
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out.buffer;
}

export const randomId = (bytes = 16) => {
	const b = crypto.getRandomValues(new Uint8Array(bytes));
	return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};
