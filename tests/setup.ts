// Obsidian runs plugins in a window; tests that use the node environment get the same global.
if (!('window' in globalThis)) (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
// No network in tests: sockets (live shared links) never connect.
class NoSocket {
	onopen: unknown = null;
	onmessage: unknown = null;
	onclose: unknown = null;
	onerror: unknown = null;
	constructor(public url: string) {}
	close() {}
	send() {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = NoSocket;
