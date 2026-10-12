import type { RelayHttp, RelayMessage } from '../src/share/relay';

/** In-memory ntfy: publish, poll with since, attachments. `onPublish` lets a test deliver to a server. */
export class FakeNtfy {
	base = 'https://relay.test';
	msgs: (RelayMessage & { body: string })[] = [];
	files = new Map<string, string>();
	n = 0;
	onPublish: ((m: RelayMessage) => void) | null = null;
	sockets = new Set<{ push(m: RelayMessage & { body: string }): void }>();
	/** WebSocket class talking to this relay (live delivery, replay with since=id|time). */
	get Socket(): typeof WebSocket {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const relay = this;
		class S {
			onopen: (() => void) | null = null;
			onmessage: ((e: { data: string }) => void) | null = null;
			onclose: (() => void) | null = null;
			onerror: (() => void) | null = null;
			private topics: string[];
			private closed = false;
			constructor(url: string) {
				const u = new URL(url.replace(/^ws/, 'http'));
				this.topics = u.pathname.split('/').filter(Boolean)[0].split(',');
				const since = u.searchParams.get('since') ?? '';
				setTimeout(() => {
					if (this.closed) return;
					this.onopen?.();
					let list = relay.msgs.filter((m) => this.topics.includes(m.topic));
					const i = list.findIndex((m) => m.id === since);
					if (i >= 0) list = list.slice(i + 1);
					else if (/^\d+$/.test(since)) list = list.filter((m) => m.time >= Number(since));
					else list = [];
					for (const m of list) this.push(m);
					relay.sockets.add(this);
				}, 0);
			}
			push(m: RelayMessage & { body: string }) {
				if (this.closed || !this.topics.includes(m.topic)) return;
				const { body: _b, ...rest } = m;
				this.onmessage?.({ data: JSON.stringify(rest) });
			}
			close() {
				this.closed = true;
				relay.sockets.delete(this);
				this.onclose?.();
			}
		}
		return S as unknown as typeof WebSocket;
	}
	http: RelayHttp = async (r) => {
		const u = new URL(r.url);
		if (u.origin !== this.base) return { status: 404, text: '' };
		const parts = u.pathname.split('/').filter(Boolean);
		if (parts[0] === 'file') return this.files.has(parts[1]) ? { status: 200, text: this.files.get(parts[1])! } : { status: 404, text: '' };
		if (r.method === 'POST' || r.method === 'PUT') {
			const id = `m${++this.n}`;
			const body = r.body ?? '';
			const m: RelayMessage & { body: string } = { id, time: Math.floor(Date.now() / 1000), topic: parts[0], event: 'message', body };
			if (r.method === 'PUT') {
				this.files.set(id, body);
				m.attachment = { url: `${this.base}/file/${id}`, size: body.length };
			} else m.message = body;
			this.msgs.push(m);
			queueMicrotask(() => {
				this.onPublish?.(m);
				for (const s of this.sockets) s.push(m);
			});
			return { status: 200, text: JSON.stringify(m) };
		}
		if (parts[1] === 'json') {
			const topics = parts[0].split(',');
			const since = u.searchParams.get('since') ?? '';
			let list = this.msgs.filter((m) => topics.includes(m.topic));
			const i = list.findIndex((m) => m.id === since);
			if (i >= 0) list = list.slice(i + 1);
			else if (/^\d+$/.test(since)) list = list.filter((m) => m.time >= Number(since));
			return { status: 200, text: list.map(({ body: _b, ...m }) => JSON.stringify(m)).join('\n') };
		}
		return { status: 404, text: '' };
	};
}
