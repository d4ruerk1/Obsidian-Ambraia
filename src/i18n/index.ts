import * as obsidian from 'obsidian';
import { PACKS } from './packs';

/** Languages of the interface. Italian is the source language of the strings. */
export const LANGS: Record<string, string> = {
	en: 'English',
	it: 'Italiano',
	es: 'Español',
	de: 'Deutsch',
	fr: 'Français',
	ar: 'العربية',
	ru: 'Русский',
	zh: '中文',
	ja: '日本語',
};
const OVERRIDE = 'ambraia-language';

const supported = (l: string | null | undefined) => {
	const base = (l ?? '').toLowerCase().split(/[-_]/)[0];
	return base in LANGS ? base : null;
};

/** Language of Obsidian itself (English when unknown or unsupported). */
export function detectLanguage(): string {
	let l: string | null = null;
	try {
		l = (obsidian as { getLanguage?: () => string }).getLanguage?.() ?? null;
	} catch {
		l = null;
	}
	return supported(l) ?? 'en';
}

const initial = () => {
	try {
		return supported(window.localStorage.getItem(OVERRIDE)) ?? detectLanguage();
	} catch {
		return detectLanguage();
	}
};

let lang = typeof window === 'undefined' ? 'it' : initial();
let table: string[] | null = null;
let source: string[] | null = null;
let index: Map<string, number> | null = null;

export const currentLanguage = () => lang;
export const isRtl = () => lang === 'ar';

/** 'auto' follows Obsidian; anything else forces a language (applied fully after a reload). */
export function setLanguage(choice: string) {
	const next = choice === 'auto' ? detectLanguage() : (supported(choice) ?? detectLanguage());
	try {
		if (choice === 'auto') window.localStorage.removeItem(OVERRIDE);
		else window.localStorage.setItem(OVERRIDE, next);
	} catch {
		/* ignore */
	}
	if (next !== lang) {
		lang = next;
		table = null;
	}
}

const cache = new Map<string, string[]>();

/** Strings of one language pack. Empty entries mean "same as English". */
export function unpack(l: string): string[] {
	let out = cache.get(l);
	if (out) return out;
	out = PACKS[l] ?? [];
	cache.set(l, out);
	return out;
}

/** Strings of the current language; empty entries fall back to English, then to the Italian source. */
function load(): string[] {
	source ??= unpack('it');
	if (lang === 'it') return source;
	const en = unpack('en');
	const own = lang === 'en' ? en : unpack(lang);
	return source.map((s, i) => own[i] || en[i] || s);
}

/**
 * Translates a UI string and fills {0}, {1}… The Italian source text is the key; the production
 * build replaces each literal with its index in the language packs (scripts/i18n-esbuild.mjs),
 * so main.js does not carry the strings twice.
 */
export function tx(s: string | number, ...args: unknown[]): string {
	let out: string;
	if (typeof s === 'number') {
		table ??= load();
		out = table[s] ?? '';
	} else if (lang === 'it') out = s;
	else {
		table ??= load();
		if (!index) {
			index = new Map();
			source!.forEach((t, i) => index!.set(t, i));
		}
		const i = index.get(s);
		out = i === undefined ? s : table[i];
	}
	return args.length ? out.replace(/\{(\d)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : out;
}
