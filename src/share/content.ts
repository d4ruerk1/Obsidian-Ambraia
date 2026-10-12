import { merge3 } from '../sync/merge';

/**
 * What leaves the vault when a note is shared: the Markdown text only, without the properties
 * block (it often holds private metadata), Obsidian comments (%% … %%), or embedded files, which
 * are not part of the link. Internal links become plain text.
 */
export function shareableMarkdown(md: string): string {
	let s = md.replace(/^\uFEFF/, '');
	// properties (frontmatter)
	s = s.replace(/^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/, '');
	// Obsidian comments, inline and as blocks
	s = s.replace(/%%[\s\S]*?%%/g, '');
	// embeds: ![[file]] → (file); ![[note#heading|alias]] → (alias)
	s = s.replace(/!\[\[([^\]|#]+)(#[^\]|]*)?(\|([^\]]*))?\]\]/g, (_m, file: string, _h, _a, alias?: string) => `*(${(alias || file).trim()})*`);
	// wikilinks: [[note|alias]] → alias, [[note#h]] → note › h
	s = s.replace(/\[\[([^\]|#]*)(#([^\]|]*))?(\|([^\]]*))?\]\]/g, (_m, file: string, _h, head?: string, _a?: string, alias?: string) => (alias || [file, head].filter(Boolean).join(' › ')).trim());
	// local images and attachments in Markdown form: only web addresses are kept as links
	s = s.replace(/!\[([^\]]*)\]\((?!https?:)[^)]*\)/g, (_m, alt: string) => (alt ? `*(${alt})*` : ''));
	// block ids (^abc123) are private anchors
	s = s.replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/gm, '');
	return s.replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/;

/** Properties block and body of a note (editing profiles change only the body). */
export function splitFrontmatter(md: string): { fm: string; body: string } {
	const m = FRONTMATTER.exec(md);
	return m ? { fm: m[0], body: md.slice(m[0].length) } : { fm: '', body: md };
}

/**
 * A change from an editing profile made on `base` (the body it opened), applied to the note `md`:
 * properties stay as they are, and what changed meanwhile is merged line by line. When the same
 * lines changed on both sides the editor decides: nothing is lost silently.
 */
export function mergeEdit(md: string, base: string, text: string): { md: string; text: string; merged: boolean } | 'conflict' {
	const { fm, body } = splitFrontmatter(md);
	if (body === base || body === text) return { md: fm + text, text, merged: false };
	const m = merge3(base, body, text, false);
	if (!m || !m.clean) return 'conflict';
	return { md: fm + m.text, text: m.text, merged: true };
}
