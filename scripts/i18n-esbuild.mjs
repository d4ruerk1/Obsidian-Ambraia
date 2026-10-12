// esbuild plugin: replaces tx('Italian source') with tx(<index>) using i18n/source.json,
// so the strings are stored only once (compressed in src/i18n/packs.ts).
// The literal parser mirrors scripts/i18n_extract.py.
import fs from 'fs';
import path from 'path';

const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
function parse(src, i) {
	const q = src[i];
	let j = i + 1;
	let out = '';
	while (src[j] !== q) {
		if (j >= src.length) return null;
		const c = src[j];
		if (c === '\\') {
			const d = src[j + 1];
			if (d === 'u') {
				if (src[j + 2] === '{') {
					const k = src.indexOf('}', j);
					out += String.fromCodePoint(parseInt(src.slice(j + 3, k), 16));
					j = k + 1;
					continue;
				}
				out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
				j += 6;
				continue;
			}
			if (d === 'x') {
				out += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
				j += 4;
				continue;
			}
			if (d === '\n') {
				j += 2;
				continue;
			}
			out += ESC[d] ?? d;
			j += 2;
			continue;
		}
		if (q === '`' && c === '$' && src[j + 1] === '{') return null;
		out += c;
		j++;
	}
	return { text: out, end: j + 1 };
}

export function i18nPlugin() {
	const list = JSON.parse(fs.readFileSync('i18n/source.json', 'utf8'));
	const index = new Map(list.map((s, i) => [s, i]));
	return {
		name: 'ambraia-i18n',
		setup(build) {
			build.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, async (args) => {
				if (args.path.split(path.sep).includes('i18n')) return undefined;
				const src = await fs.promises.readFile(args.path, 'utf8');
				let out = '';
				let last = 0;
				const re = /(?<![\w$.])tx\(\s*/g;
				const missing = [];
				for (let m; (m = re.exec(src)); ) {
					const at = m.index + m[0].length;
					if (!`'"\``.includes(src[at])) continue;
					const lit = parse(src, at);
					if (!lit) continue;
					const i = index.get(lit.text);
					if (i === undefined) {
						missing.push(lit.text);
						continue;
					}
					out += src.slice(last, at) + i;
					last = lit.end;
					re.lastIndex = lit.end;
				}
				if (missing.length)
					return { errors: missing.map((t) => ({ text: `String not in i18n/source.json (run "npm run i18n"): ${JSON.stringify(t.slice(0, 80))}` })) };
				return { contents: out + src.slice(last), loader: 'ts' };
			});
		},
	};
}
