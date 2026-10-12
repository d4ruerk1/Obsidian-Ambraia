/**
 * Minimal client of an ntfy-compatible relay (https://ntfy.sh or a self-hosted server), used only
 * by live links. Everything posted is already end-to-end encrypted; topic names are random.
 * Shared by the plugin (requests through Obsidian's requestUrl) and the viewer page (fetch).
 */

export interface RelayHttp {
	(req: { url: string; method: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }>;
}

export interface RelayMessage {
	id: string;
	time: number;
	topic: string;
	event?: string;
	message?: string;
	attachment?: { url?: string; size?: number };
}

/** Messages above this size are sent as attachments (ntfy's limit for a message is 4096 bytes). */
const INLINE_MAX = 3800;
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

export class RelayError extends Error {
	constructor(
		public status: number,
		msg: string,
	) {
		super(msg);
		this.name = 'RelayError';
	}
}

export class Relay {
	readonly base: string;

	constructor(
		base: string,
		private http: RelayHttp,
	) {
		this.base = base.replace(/\/+$/, '');
	}

	private topics(t: string[]): string {
		const list = [...new Set(t)].filter((x) => TOPIC.test(x));
		if (!list.length) throw new RelayError(0, 'no topic');
		return list.join(',');
	}

	/** Publishes an encrypted message. Not forwarded to push services (Firebase / UnifiedPush). */
	async publish(topic: string, body: string): Promise<void> {
		if (!TOPIC.test(topic)) throw new RelayError(0, 'bad topic');
		const big = body.length > INLINE_MAX;
		const headers: Record<string, string> = { 'X-Firebase': 'no', 'X-UnifiedPush': '0' };
		if (big) headers['X-Filename'] = 'a.txt';
		const res = await this.http({ url: `${this.base}/${topic}`, method: big ? 'PUT' : 'POST', headers, body });
		if (res.status === 429) throw new RelayError(429, 'relay: too many requests');
		if (res.status === 413) throw new RelayError(413, 'relay: message too large');
		if (res.status < 200 || res.status >= 300) throw new RelayError(res.status, `relay: HTTP ${res.status}`);
	}

	/** Cached messages of the topics since a message id, a unix time or a duration ("2m"). */
	async poll(topics: string[], since: string): Promise<RelayMessage[]> {
		const res = await this.http({ url: `${this.base}/${this.topics(topics)}/json?poll=1&since=${encodeURIComponent(since)}`, method: 'GET' });
		if (res.status === 429) throw new RelayError(429, 'relay: too many requests');
		if (res.status < 200 || res.status >= 300) throw new RelayError(res.status, `relay: HTTP ${res.status}`);
		return parseLines(res.text);
	}

	/** Text of a message, downloading its attachment when the relay stored it as one. */
	async body(m: RelayMessage): Promise<string | null> {
		const url = m.attachment?.url;
		if (!url) return typeof m.message === 'string' ? m.message : null;
		// attachments are fetched only from the relay itself (never from a URL chosen by someone else)
		if (!sameOrigin(url, this.base) || (m.attachment?.size ?? 0) > 2_100_000) return null;
		const res = await this.http({ url, method: 'GET' });
		return res.status >= 200 && res.status < 300 ? res.text : null;
	}

	/**
	 * Live subscription (WebSocket when available), with polling as a fallback. `onMessage` gets
	 * every new message; the subscription reconnects by itself until close() is called.
	 */
	subscribe(topics: string[], onMessage: (m: RelayMessage) => void, opts: { since?: string; pollMs?: number; socket?: typeof WebSocket | null } = {}): { close(): void } {
		const list = this.topics(topics);
		let closed = false;
		let last = opts.since ?? '';
		let ws: WebSocket | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let backoff = 3000;
		const seen = new Set<string>();
		const deliver = (m: RelayMessage) => {
			if (!m || m.event !== 'message' || !m.id || seen.has(m.id)) return;
			seen.add(m.id);
			if (seen.size > 2000) seen.clear();
			last = m.id;
			try {
				onMessage(m);
			} catch {
				/* the handler deals with its own errors */
			}
		};
		const Socket = opts.socket === undefined ? (typeof WebSocket === 'function' ? WebSocket : null) : opts.socket;
		const poll = async () => {
			if (closed) return;
			try {
				for (const m of await this.poll(topics, last || '1m')) deliver(m);
				backoff = 3000;
			} catch {
				backoff = Math.min(backoff * 2, 120_000);
			}
			if (!closed) timer = setTimeout(() => void poll(), Math.max(opts.pollMs ?? 15_000, backoff === 3000 ? 0 : backoff));
		};
		const connect = () => {
			if (closed) return;
			if (!Socket) return void poll();
			try {
				const url = `${this.base.replace(/^http/, 'ws')}/${list}/ws${last ? `?since=${encodeURIComponent(last)}` : ''}`;
				ws = new Socket(url);
			} catch {
				return void poll();
			}
			let opened = false;
			ws.onopen = () => {
				opened = true;
				backoff = 3000;
			};
			ws.onmessage = (e: MessageEvent) => {
				try {
					deliver(JSON.parse(String(e.data)) as RelayMessage);
				} catch {
					/* keepalive or garbage */
				}
			};
			ws.onclose = () => {
				ws = null;
				if (closed) return;
				// sockets refused (proxy, policy): polling from now on
				if (!opened && backoff >= 48_000) return void poll();
				timer = setTimeout(connect, backoff);
				backoff = Math.min(backoff * 2, 120_000);
			};
			ws.onerror = () => ws?.close();
		};
		connect();
		return {
			close() {
				closed = true;
				if (timer) clearTimeout(timer);
				try {
					ws?.close();
				} catch {
					/* already closed */
				}
			},
		};
	}
}

export function parseLines(text: string): RelayMessage[] {
	const out: RelayMessage[] = [];
	for (const line of (text ?? '').split('\n')) {
		const l = line.trim();
		if (!l) continue;
		try {
			const m = JSON.parse(l) as RelayMessage;
			if (m && m.event === 'message' && typeof m.id === 'string') out.push(m);
		} catch {
			/* partial line */
		}
	}
	return out;
}

function sameOrigin(url: string, base: string): boolean {
	try {
		return new URL(url).origin === new URL(base).origin;
	} catch {
		return false;
	}
}
