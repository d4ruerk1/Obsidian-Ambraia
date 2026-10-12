import { App, getAllTags, normalizePath, TFile, TFolder } from 'obsidian';
import { moment } from '../ui/util';
import { tx } from '../i18n';

export interface AiAction {
	id: string;
	title: string;
	icon: string;
	/** Template; `{}` = selected text. */
	prompt: string;
	group: 'modifica' | 'genera' | 'traduci' | 'personalizzato';
	/** Result replaces the selection by default (otherwise inserted below). */
	replace: boolean;
	/** Path of the custom prompt note (custom prompts only). */
	path?: string;
	model?: string;
}

const KEEP = tx('Mantieni la lingua originale, la formattazione Markdown, i link [[...]] e i tag. Rispondi SOLO con il testo risultante, senza commenti o virgolette.');

export const BUILTIN_ACTIONS: AiAction[] = [
	{ id: 'improve', title: tx('Migliora la scrittura'), icon: 'wand-2', group: 'modifica', replace: true, prompt: tx('Migliora la scrittura del testo seguente: rendilo più chiaro, scorrevole e corretto. {0}\n\n{}', KEEP) },
	{ id: 'fix', title: tx('Correggi ortografia e grammatica'), icon: 'spell-check', group: 'modifica', replace: true, prompt: tx('Correggi solo gli errori di ortografia, grammatica e punteggiatura del testo seguente, senza cambiarne lo stile. {0}\n\n{}', KEEP) },
	{ id: 'shorter', title: tx('Rendi più breve'), icon: 'minimize-2', group: 'modifica', replace: true, prompt: tx('Riscrivi il testo seguente in modo più conciso, mantenendo le informazioni importanti. {0}\n\n{}', KEEP) },
	{ id: 'longer', title: tx('Rendi più lungo'), icon: 'maximize-2', group: 'modifica', replace: true, prompt: tx('Espandi il testo seguente con più dettagli ed esempi pertinenti, senza inventare fatti. {0}\n\n{}', KEEP) },
	{ id: 'simplify', title: tx('Semplifica il linguaggio'), icon: 'baby', group: 'modifica', replace: true, prompt: tx('Riscrivi il testo seguente con parole semplici e frasi brevi. {0}\n\n{}', KEEP) },
	{ id: 'professional', title: tx('Tono professionale'), icon: 'briefcase', group: 'modifica', replace: true, prompt: tx('Riscrivi il testo seguente con un tono professionale. {0}\n\n{}', KEEP) },
	{ id: 'friendly', title: tx('Tono amichevole'), icon: 'smile', group: 'modifica', replace: true, prompt: tx('Riscrivi il testo seguente con un tono cordiale e amichevole. {0}\n\n{}', KEEP) },
	{ id: 'summarize', title: tx('Riassumi'), icon: 'list-collapse', group: 'genera', replace: false, prompt: tx('Riassumi il testo seguente in pochi punti chiave, nella stessa lingua del testo. Rispondi solo con il riassunto in Markdown.\n\n{}') },
	{ id: 'explain', title: tx('Spiega'), icon: 'graduation-cap', group: 'genera', replace: false, prompt: tx('Spiega in modo chiaro e semplice il significato del testo seguente, nella stessa lingua.\n\n{}') },
	{ id: 'bullets', title: tx('Trasforma in elenco puntato'), icon: 'list', group: 'genera', replace: true, prompt: tx('Trasforma il testo seguente in un elenco puntato Markdown ben organizzato. Rispondi solo con l’elenco.\n\n{}') },
	{ id: 'table', title: tx('Trasforma in tabella'), icon: 'table-2', group: 'genera', replace: true, prompt: tx('Organizza le informazioni del testo seguente in una tabella Markdown. Rispondi solo con la tabella.\n\n{}') },
	{ id: 'tasks', title: tx('Estrai le attività'), icon: 'list-checks', group: 'genera', replace: false, prompt: tx('Estrai dal testo seguente tutte le azioni da fare come lista di attività Markdown "- [ ] ". Rispondi solo con la lista.\n\n{}') },
	{ id: 'title', title: tx('Suggerisci un titolo'), icon: 'heading', group: 'genera', replace: false, prompt: tx('Proponi un titolo breve ed efficace per il testo seguente. Rispondi solo con il titolo, senza virgolette.\n\n{}') },
	{ id: 'continue', title: tx('Continua a scrivere'), icon: 'pen-line', group: 'genera', replace: false, prompt: tx('Continua il testo seguente in modo coerente con stile e lingua, per uno o due paragrafi. Rispondi solo con la continuazione.\n\n{}') },
];

export const LANGUAGES = [tx('Italiano'), tx('Inglese'), tx('Spagnolo'), tx('Francese'), tx('Tedesco'), tx('Portoghese'), tx('Arabo'), tx('Cinese'), tx('Giapponese')];

export function translateAction(lang: string): AiAction {
	return {
		id: 'translate-' + lang.toLowerCase(),
		title: tx('Traduci in {0}', lang.toLowerCase()),
		icon: 'languages',
		group: 'traduci',
		replace: true,
		prompt: tx('Traduci il testo seguente in {0}. Mantieni formattazione Markdown e link. Rispondi solo con la traduzione.\n\n{}', lang.toLowerCase()),
	};
}

// ---------------------------------------------------------------- custom prompts (notes in a folder)

export const SAMPLE_PROMPT = `---
mostra-nel-menu: true
sostituisci: false
---
Scrivi un'email cortese e chiara basata su questi appunti:

{}
`;

export async function loadCustomPrompts(app: App, folder: string): Promise<AiAction[]> {
	const root = app.vault.getAbstractFileByPath(normalizePath(folder || 'Ambraia/Prompt'));
	if (!(root instanceof TFolder)) return [];
	const out: AiAction[] = [];
	const walk = async (f: TFolder) => {
		for (const c of f.children) {
			if (c instanceof TFolder) await walk(c);
			else if (c instanceof TFile && c.extension === 'md') {
				const raw = await app.vault.cachedRead(c);
				const fm = app.metadataCache.getFileCache(c)?.frontmatter ?? {};
				if (fm['mostra-nel-menu'] === false || fm['showInMenu'] === false) continue;
				const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
				if (!body) continue;
				out.push({
					id: 'custom:' + c.path,
					title: c.basename,
					icon: typeof fm.icon === 'string' && !/\p{Extended_Pictographic}/u.test(fm.icon) ? fm.icon : 'sparkle',
					group: 'personalizzato',
					replace: fm['sostituisci'] === true || fm['replace'] === true,
					prompt: body,
					path: c.path,
					model: typeof fm['modello'] === 'string' ? fm['modello'] : undefined,
				});
			}
		}
	};
	await walk(root);
	return out.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Expands template variables:
 *  {} or {selezione} → selected text (or the whole note if nothing is selected)
 *  {nota} / {activeNote} → the active note
 *  {[[Nome nota]]} → content of that note
 *  {#tag} → contents of notes with that tag
 *  {data} → today's date
 */
export async function expandTemplate(app: App, tpl: string, selection: string, active: TFile | null): Promise<string> {
	const activeText = active ? await app.vault.cachedRead(active) : '';
	const sel = selection.trim() ? selection : activeText;
	let usedSel = false;
	let usedNote = false;
	const parts: string[] = [];
	const re = /\{(\s*|selezione|selection|nota|activeNote|data|date|\[\[[^\]]+\]\]|#[^}\s]+)\}/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(tpl))) {
		parts.push(tpl.slice(last, m.index));
		last = m.index + m[0].length;
		const k = m[1].trim();
		if (k === '' || k === 'selezione' || k === 'selection') {
			usedSel = true;
			parts.push(sel);
		} else if (k === 'nota' || k === 'activeNote') {
			usedNote = true;
			parts.push(activeText);
		}
		else if (k === 'data' || k === 'date') parts.push(moment().format('YYYY-MM-DD'));
		else if (k.startsWith('[[')) {
			const name = k.slice(2, -2).split('|')[0];
			const f = app.metadataCache.getFirstLinkpathDest(name, active?.path ?? '');
			parts.push(f ? tx('<nota titolo="{0}">\n{1}\n</nota>', f.basename, await app.vault.cachedRead(f)) : tx('(nota “{0}” non trovata)', name));
		} else if (k.startsWith('#')) {
			const tag = k.toLowerCase();
			const files = app.vault
				.getMarkdownFiles()
				.filter((f) => {
					const c = app.metadataCache.getFileCache(f);
					return !!c && (getAllTags(c) ?? []).some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(tag + '/'));
				})
				.slice(0, 20);
			const texts: string[] = [];
			for (const f of files) texts.push(tx('<nota titolo="{0}">\n{1}\n</nota>', f.basename, (await app.vault.cachedRead(f)).slice(0, 6000)));
			parts.push(texts.join('\n\n') || tx('(nessuna nota con {0})', k));
		}
	}
	parts.push(tpl.slice(last));
	let out = parts.join('');
	if (!usedSel) {
		if (selection.trim()) out += `\n\n${selection}`;
		else if (!usedNote && activeText.trim()) out += `\n\n${activeText}`;
	}
	return out;
}
