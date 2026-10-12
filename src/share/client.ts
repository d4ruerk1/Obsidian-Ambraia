import { decodeLive, fragmentOf, liveK1, liveKeys, makeRequest, openResponse, ShareError, SharedNote, LiveEdit, LiveKeys } from './format';
import { Relay, RelayHttp, RelayMessage } from './relay';

/** Opens a shared link and sends changes, the same way in the viewer page and inside Obsidian. */

export interface OpenOptions {
	password?: string;
	http: RelayHttp;
	socket?: typeof WebSocket | null;
	/** how long to wait for one of the owner's devices */
	timeoutMs?: number;
	onStatus?: (s: 'deriving' | 'waiting') => void;
	pollMs?: number;
}

export const LIVE_TIMEOUT = 90_000;
export const SAVE_TIMEOUT = 60_000;

/** An opened link: the note and what is needed to send changes (editing profiles). */
export interface OpenedLink {
	note: SharedNote;
	/** sends a change; resolves with the text now in the vault (merged with other changes) */
	save?(base: string, text: string, o?: { timeoutMs?: number }): Promise<{ text: string; merged: boolean }>;
}

interface Ctx {
	relay: Relay;
	keys: LiveKeys;
	k1: Uint8Array;
	o: OpenOptions;
}

/** One request/answer round trip through the relay. */
function ask(c: Ctx, opts: { session?: string; edit?: LiveEdit }, timeoutMs: number) {
	const req = makeRequest(c.keys, c.k1, opts);
	return new Promise<SharedNote | { saved: string; merged: boolean }>((resolve, reject) => {
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sub.close();
			fn();
		};
		const onMessage = (m: RelayMessage) => {
			void c.relay.body(m).then((body) => {
				if (!body || done) return;
				try {
					const r = openResponse(c.keys, c.k1, req.nonce, body);
					finish(() => resolve(r));
				} catch (e) {
					// a refusal from a device is final; anything unreadable is ignored
					if (e instanceof ShareError && e.code !== 'corrupt') finish(() => reject(e));
				}
			});
		};
		// listen first, then ask: an answer can never arrive before the subscription
		const since = String(Math.floor(Date.now() / 1000) - 5);
		const sub = c.relay.subscribe([req.replyTopic], onMessage, { since, socket: c.o.socket, pollMs: c.o.pollMs ?? 5000 });
		const timer = setTimeout(() => finish(() => reject(new ShareError('offline'))), timeoutMs);
		c.relay.publish(c.keys.topic, req.body).catch(() => finish(() => reject(new ShareError('offline'))));
	});
}

export async function openLink(link: string, o: OpenOptions): Promise<OpenedLink> {
	const l = decodeLive(fragmentOf(link));
	const keys = liveKeys(l.secret);
	if (o.password) o.onStatus?.('deriving');
	const k1 = await liveK1(l.secret, o.password ?? '', l.log2m, l.t);
	const c: Ctx = { relay: new Relay(l.relay, o.http), keys, k1, o };
	o.onStatus?.('waiting');
	const note = await ask(c, {}, o.timeoutMs ?? LIVE_TIMEOUT);
	if ('saved' in note) throw new ShareError('corrupt');
	const out: OpenedLink = { note };
	if (note.canEdit && note.session) {
		const session = note.session;
		out.save = async (base, text, so = {}) => {
			const r = await ask(c, { session, edit: { base, text } }, so.timeoutMs ?? SAVE_TIMEOUT);
			if (!('saved' in r)) throw new ShareError('corrupt');
			return { text: r.saved, merged: r.merged };
		};
	}
	return out;
}
