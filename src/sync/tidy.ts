import type { LocalFS } from './types';

const LABELS = ['conflitto', 'conflict', 'Konflikt', 'conflicto', 'conflit', '対立', 'конфликт', '冲突', 'صراع'];

/** "Note (conflitto 2024-05-01 10.30 2).md" → groups: 1 "Note", 2 ".md" */
export const CONFLICT_COPY = new RegExp(`^(.*) \\((?:${LABELS.join('|')}) \\d{4}-\\d{2}-\\d{2} \\d{2}\\.\\d{2}(?: \\d+)?\\)(\\.[^./]*)?$`);

/** The file a conflict copy was made from, or null if `path` is not a conflict copy. */
export function originalOf(path: string): string | null {
	const m = CONFLICT_COPY.exec(path);
	return m && m[1] && !m[1].endsWith('/') ? m[1] + (m[2] ?? '') : null;
}

export interface TidyResult {
	/** copies removed (moved to the trash) */
	removed: string[];
	/** originals whose content was replaced by a newer copy */
	updated: string[];
}

/**
 * Folds old "(conflict …)" copies into one version: among the original and its copies the most
 * recently modified one prevails and takes the original name; the others are removed.
 * `only` limits the work to these paths (copies or originals); null scans the whole vault.
 */
export async function tidyConflictCopies(local: LocalFS, only: string[] | null = null): Promise<TidyResult> {
	const out: TidyResult = { removed: [], updated: [] };
	const files = (await local.list()).filter((e) => !e.isFolder);
	const groups = new Map<string, string[]>();
	for (const e of files) {
		const o = originalOf(e.path);
		if (!o) continue;
		const g = groups.get(o) ?? [];
		g.push(e.path);
		groups.set(o, g);
	}
	const want = only ? new Set(only.map((p) => originalOf(p) ?? p)) : null;
	for (const [orig, copies] of groups) {
		if (want && !want.has(orig)) continue;
		try {
			const o = await local.stat(orig);
			if (o?.isFolder) continue; // file/folder clash: both must stay
			const cand: { path: string; mtime: number }[] = [];
			if (o) cand.push({ path: orig, mtime: o.mtime });
			for (const c of copies) {
				const s = await local.stat(c);
				if (s && !s.isFolder) cand.push({ path: c, mtime: s.mtime });
			}
			if (!cand.some((c) => c.path !== orig)) continue;
			// newest prevails; on equal times the original keeps its place
			cand.sort((a, b) => b.mtime - a.mtime || (a.path === orig ? -1 : b.path === orig ? 1 : 0));
			const win = cand[0].path;
			if (win !== orig) {
				if (o) {
					await local.write(orig, await local.read(win));
					out.updated.push(orig);
				} else {
					await local.rename(win, orig);
					out.updated.push(orig);
				}
			}
			for (const c of cand) {
				if (c.path === orig || (c.path === win && !o)) continue;
				await local.remove(c.path);
				out.removed.push(c.path);
			}
		} catch {
			/* next time */
		}
	}
	return out;
}
