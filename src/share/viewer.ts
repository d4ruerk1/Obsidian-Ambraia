/**
 * Entry point of the static page that opens shared links (docs/share/index.html, served by
 * GitHub Pages or any static host). Runs only in the reader's browser: the keys are in the URL
 * fragment, which browsers never send to a server. No cookies, no storage, no analytics, no
 * third-party resources (enforced by the page's Content-Security-Policy).
 */
import { openLink, OpenedLink } from './client';
import { shareableMarkdown } from './content';
import { ConflictError, fragmentOf, isLink, ShareError, ShareFailure } from './format';
import { renderMarkdown } from './markdown';
import type { RelayHttp } from './relay';

const IT = /^it\b/i.test(navigator.language || '');
const T = {
	title: IT ? 'Nota condivisa' : 'Shared note',
	noLink: IT ? 'Nessuna nota da mostrare: apri il link completo che hai ricevuto, compresa la parte dopo “#”.' : 'Nothing to show: open the full link you received, including the part after “#”.',
	needPw: IT ? 'Questa nota è protetta da una password.' : 'This note is protected by a password.',
	pw: IT ? 'Password' : 'Password',
	open: IT ? 'Apri' : 'Open',
	deriving: IT ? 'Verifico la password…' : 'Checking the password…',
	decrypting: IT ? 'Decifro la nota…' : 'Decrypting the note…',
	waiting: IT ? 'Attendo uno dei dispositivi di chi ha condiviso la nota (fino a 90 secondi)…' : 'Waiting for one of the sender’s devices (up to 90 seconds)…',
	expires: IT ? 'Il link scade il {0}.' : 'This link expires on {0}.',
	left: IT ? 'Aperture rimaste: {0}.' : 'Openings left: {0}.',
	reload: IT ? 'Per rileggerla riapri il link originale.' : 'To read it again, open the original link.',
	retry: IT ? 'Riprova' : 'Try again',
	other: IT ? 'Hai una password? Entra con un altro profilo' : 'Have a password? Enter with another profile',
	profile: IT ? 'Profilo: {0}.' : 'Profile: {0}.',
	edit: IT ? 'Modifica' : 'Edit',
	preview: IT ? 'Anteprima' : 'Preview',
	save: IT ? 'Salva' : 'Save',
	saving: IT ? 'Salvo…' : 'Saving…',
	saved: IT ? 'Salvato.' : 'Saved.',
	merged: IT ? 'Salvato e unito alle modifiche fatte nel frattempo.' : 'Saved and merged with changes made in the meantime.',
	pending: IT ? 'Non ancora salvato: nessun dispositivo raggiungibile. Riprovo da solo quando torna la connessione; non chiudere la pagina.' : 'Not saved yet: no device reachable. It will retry by itself when the connection is back; do not close the page.',
	unsaved: IT ? 'Modifiche non salvate' : 'Unsaved changes',
	conflictMsg: IT
		? 'La nota è cambiata nel frattempo e le modifiche non si possono unire. Sopra c’è il testo attuale; sotto la tua versione da ricopiare.'
		: 'The note changed in the meantime and the changes cannot be merged. Above is the current text; below is your version to copy back.',
	yours: IT ? 'La tua versione' : 'Your version',
	editNote: IT
		? 'Puoi modificare questa nota: ciò che salvi entra nella nota di chi l’ha condivisa, che lo vede e può cambiarlo. Non inserire dati che non vuoi condividere con lui.'
		: 'You can edit this note: what you save goes into the note of the person who shared it, who sees it and can change it. Do not enter data you do not want to share with them.',
	about: IT
		? 'Nota condivisa con Ambraia per Obsidian. Il contenuto è cifrato end-to-end: si decifra solo in questo browser, né chi ospita la pagina né i server intermedi possono leggerlo. Chi l’ha condivisa è responsabile del contenuto.'
		: 'Note shared with Ambraia for Obsidian. The content is end-to-end encrypted: it is decrypted only in this browser, and neither the host of this page nor any server in between can read it. The sender is responsible for the content.',
	fail: {
		password: IT ? 'Password errata.' : 'Wrong password.',
		expired: IT ? 'Il link è scaduto.' : 'This link has expired.',
		revoked: IT ? 'Il link è stato revocato da chi lo ha condiviso.' : 'The sender has revoked this link.',
		exhausted: IT ? 'Il link ha raggiunto il numero massimo di aperture.' : 'This link has reached its maximum number of openings.',
		gone: IT ? 'La nota non esiste più.' : 'The note no longer exists.',
		locked: IT ? 'Troppi tentativi con una password errata: riprova tra 15 minuti.' : 'Too many wrong passwords: try again in 15 minutes.',
		'too-large': IT ? 'La nota è troppo grande per essere inviata.' : 'The note is too large to be sent.',
		offline: IT
			? 'Nessun dispositivo di chi ha condiviso la nota risponde in questo momento: riprova quando uno dei suoi dispositivi è acceso con Obsidian aperto.'
			: 'None of the sender’s devices is answering right now: try again when one of them is on with Obsidian open.',
		unsupported: IT ? 'Questo link è di una versione precedente di Ambraia e non è più valido: chiedine uno nuovo.' : 'This link comes from an older version of Ambraia and is no longer valid: ask for a new one.',
		readonly: IT ? 'Questo profilo può solo leggere la nota.' : 'This profile can only read the note.',
		session: IT ? 'La sessione di modifica è scaduta: riapri il link.' : 'The editing session has expired: open the link again.',
		conflict: IT ? 'La nota è cambiata nel frattempo.' : 'The note changed in the meantime.',
		corrupt: IT ? 'Il link non è valido o è stato copiato in modo incompleto.' : 'The link is invalid or was copied incompletely.',
	} as Record<ShareFailure, string>,
};

const fmt = (s: string, v: string | number) => s.replace('{0}', String(v));
const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
};

const http: RelayHttp = async (r) => {
	const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' });
	return { status: res.status, text: await res.text() };
};

function main() {
	document.documentElement.lang = IT ? 'it' : 'en';
	document.title = T.title;
	const root = document.getElementById('app') ?? document.body;
	root.replaceChildren();
	const status = $('p', 'status');
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	const form = $('form', 'pw');
	const out = $('article', 'note');
	const foot = $('footer', 'about', T.about);
	root.append(status, form, out, foot);

	const link = location.hash.slice(1);
	// the key does not stay in the address bar, the history or synced browsing data
	if (link) history.replaceState(null, '', location.pathname + location.search);
	const frag = fragmentOf(link);
	if (!frag || !isLink(frag)) {
		status.textContent = !frag ? T.noLink : frag.startsWith('c1') || frag.startsWith('s1') ? T.fail.unsupported : T.fail.corrupt;
		return;
	}
	if (!globalThis.crypto?.getRandomValues) {
		status.textContent = T.fail.unsupported;
		return;
	}

	let busy = false;
	const askPassword = (msg: string) => {
		status.textContent = '';
		form.replaceChildren();
		const label = $('label', '', msg);
		const input = $('input');
		input.type = 'password';
		input.autocomplete = 'off';
		input.placeholder = T.pw;
		input.setAttribute('aria-label', T.pw);
		const btn = $('button', '', T.open);
		btn.type = 'submit';
		form.append(label, input, btn);
		form.onsubmit = (e) => {
			e.preventDefault();
			if (input.value) void go(input.value);
		};
		form.hidden = false;
		input.focus();
	};

	let dirty = false;
	let retryOnline: (() => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	addEventListener('online', () => retryOnline?.());
	addEventListener('beforeunload', (e) => {
		if (dirty) e.preventDefault();
	});

	const show = (opened: OpenedLink, password: string) => {
		// a change still waiting for another profile is dropped with it
		retryOnline = null;
		if (timer) clearTimeout(timer);
		timer = null;
		dirty = false;
		const note = opened.note;
		form.hidden = true;
		status.textContent = '';
		document.title = note.title || T.title;
		out.replaceChildren();
		out.append($('h1', 'title', note.title || T.title));
		const meta: string[] = [];
		if (note.profile) meta.push(fmt(T.profile, note.profile));
		if (note.expires) meta.push(fmt(T.expires, new Date(note.expires).toLocaleString(IT ? 'it-IT' : undefined, { dateStyle: 'long', timeStyle: 'short' })));
		if (note.left != null) meta.push(fmt(T.left, note.left));
		meta.push(T.reload);
		out.append($('p', 'meta', meta.join(' ')));
		if (!password) {
			const other = $('button', 'link', T.other);
			other.type = 'button';
			other.onclick = () => askPassword(T.needPw);
			out.append(other);
		}
		const body = $('div', 'body');
		out.append(body);
		let base = note.md;
		const preview = () => {
			body.replaceChildren();
			renderMarkdown(document, body, opened.save ? shareableMarkdown(base) : base);
		};
		preview();
		if (!opened.save) return;
		const save = opened.save;
		// editing profile: plain Markdown editor, changes merged on the owner's device
		const bar = $('div', 'bar');
		const editBtn = $('button', '', T.edit);
		const saveBtn = $('button', '', T.save);
		const info = $('p', 'status');
		info.setAttribute('role', 'status');
		saveBtn.hidden = true;
		bar.append(editBtn, saveBtn);
		out.insertBefore(bar, body);
		out.insertBefore(info, body);
		out.insertBefore($('p', 'meta', T.editNote), bar);
		const area = $('textarea', 'editor');
		area.spellcheck = true;
		let editing = false;
		let pending: string | null = null;
		const setEditing = (on: boolean) => {
			editing = on;
			editBtn.textContent = on ? T.preview : T.edit;
			saveBtn.hidden = !on && !dirty;
			if (on) {
				body.replaceChildren(area);
				area.focus();
			} else {
				// preview of the draft (or of the saved text)
				body.replaceChildren();
				renderMarkdown(document, body, shareableMarkdown(dirty ? area.value : base));
			}
		};
		editBtn.onclick = () => setEditing(!editing);
		area.value = base;
		area.oninput = () => {
			dirty = area.value !== base;
			info.textContent = dirty ? T.unsaved : '';
		};
		const trySave = async () => {
			if (busy) return;
			const text = pending ?? area.value;
			if (text === base) return;
			busy = true;
			area.readOnly = true;
			saveBtn.disabled = true;
			info.textContent = T.saving;
			try {
				const r = await save(base, text);
				base = r.text;
				area.value = r.text;
				pending = null;
				dirty = false;
				info.textContent = r.merged ? T.merged : T.saved;
				if (!editing) setEditing(false);
			} catch (e) {
				const code: ShareFailure = e instanceof ShareError ? e.code : 'offline';
				if (e instanceof ConflictError) {
					base = e.current;
					area.value = e.current;
					pending = null;
					body.querySelectorAll('.yours, .yours-label').forEach((x) => x.remove());
					const yours = $('textarea', 'editor yours');
					yours.readOnly = true;
					yours.value = text;
					body.append($('p', 'meta yours-label', T.yours), yours);
					info.textContent = T.conflictMsg;
				} else if (code === 'offline') {
					// nobody reachable now: keep the change and retry by itself
					pending = text;
					info.textContent = T.pending;
					if (timer) clearTimeout(timer);
					timer = setTimeout(() => void trySave(), 30_000);
				} else info.textContent = T.fail[code] ?? T.fail.corrupt;
			} finally {
				busy = false;
				area.readOnly = false;
				saveBtn.disabled = false;
			}
		};
		saveBtn.onclick = () => void trySave();
		area.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				void trySave();
			}
		});
		// one retry handler at a time (opening another profile replaces it)
		retryOnline = () => {
			if (pending !== null) void trySave();
		};
	};

	const go = async (password: string) => {
		if (busy) return;
		busy = true;
		form.hidden = true;
		status.textContent = password ? T.deriving : T.decrypting;
		try {
			const opened = await openLink(frag, { password, http, socket: typeof WebSocket === 'function' ? WebSocket : null, onStatus: (s) => (status.textContent = s === 'waiting' ? T.waiting : T.deriving) });
			busy = false;
			show(opened, password);
		} catch (e) {
			const code: ShareFailure = e instanceof ShareError ? e.code : 'corrupt';
			if (code === 'password') askPassword(password ? T.fail.password : T.needPw);
			else {
				status.textContent = T.fail[code] ?? T.fail.corrupt;
				if (code === 'offline' || code === 'locked') {
					form.replaceChildren();
					const btn = $('button', '', T.retry);
					btn.type = 'submit';
					form.append(btn);
					form.onsubmit = (ev) => {
						ev.preventDefault();
						void go(password);
					};
					form.hidden = false;
				}
			}
		} finally {
			busy = false;
		}
	};

	void go('');
}

main();
// another link opened in the same tab only changes the fragment: no reload happens
addEventListener('hashchange', () => {
	if (location.hash.length > 1) main();
});
