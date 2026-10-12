import type { App, TFile } from 'obsidian';

/**
 * Machine-readable marking of AI-generated text (EU AI Act, Regulation (EU) 2024/1689, art. 50(2)).
 * Notes created by the AI get `ai-generated: true`; notes where AI text was inserted or that the
 * agent edited get `ai-assisted: true`. Plain front-matter properties: readable by people and
 * tools, visible in Obsidian's properties, removable by the user. Turned off in Settings → AI.
 */
export const AI_GENERATED = 'ai-generated';
export const AI_ASSISTED = 'ai-assisted';

export async function markAiContent(app: App, file: TFile | null | undefined, enabled: boolean, whole = false): Promise<void> {
	if (!enabled || !file || file.extension !== 'md') return;
	try {
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (whole) fm[AI_GENERATED] = true;
			else if (fm[AI_GENERATED] !== true) fm[AI_ASSISTED] = true;
		});
	} catch {
		/* front matter not writable (e.g. invalid YAML): the text is still inserted */
	}
}
