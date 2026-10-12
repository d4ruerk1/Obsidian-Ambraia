import { describe, expect, it } from 'vitest';
import { markAiContent } from '../src/ai/marking';

const app = (fm: Record<string, unknown>) => ({ fileManager: { processFrontMatter: async (_f: unknown, fn: (x: Record<string, unknown>) => void) => fn(fm) } }) as never;
const md = { extension: 'md' } as never;

describe('AI output marking (EU AI Act art. 50)', () => {
	it('marks whole notes as ai-generated and edited notes as ai-assisted', async () => {
		const a: Record<string, unknown> = {};
		await markAiContent(app(a), md, true, true);
		expect(a).toEqual({ 'ai-generated': true });
		const b: Record<string, unknown> = { title: 'x' };
		await markAiContent(app(b), md, true);
		expect(b).toEqual({ title: 'x', 'ai-assisted': true });
		await markAiContent(app(a), md, true);
		expect(a).toEqual({ 'ai-generated': true });
	});
	it('does nothing when turned off or for non-Markdown files', async () => {
		const c: Record<string, unknown> = {};
		await markAiContent(app(c), md, false, true);
		await markAiContent(app(c), { extension: 'canvas' } as never, true, true);
		expect(c).toEqual({});
	});
});
