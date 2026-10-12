/**
 * Three-way merge of text files (line based, like git/diff3).
 * Changes made on two devices to different parts of a note are combined; where both changed
 * the same lines, the most recent side wins (the other version is discarded).
 */

/** Text formats where a line merge is meaningful (not JSON/canvas: a merge could break the syntax). */
export const isMergeable = (path: string) => /\.(md|markdown|txt|text|csv|tsv|org|tex)$/i.test(path);

const MAX_CELLS = 4_000_000;

/** For each line of a: index of the matching line in b (longest common subsequence), or -1. Null when too big. */
function matches(a: string[], b: string[]): Int32Array | null {
	const m = new Int32Array(a.length).fill(-1);
	let s = 0;
	while (s < a.length && s < b.length && a[s] === b[s]) {
		m[s] = s;
		s++;
	}
	let ea = a.length;
	let eb = b.length;
	while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
		ea--;
		eb--;
		m[ea] = eb;
	}
	const n = ea - s;
	const k = eb - s;
	if (n === 0 || k === 0) return m;
	if (n * k > MAX_CELLS) return null;
	// LCS lengths of suffixes, row by row (Uint16 is enough below 65535 lines in the middle part)
	const W = k + 1;
	const L = n < 65535 && k < 65535 ? new Uint16Array((n + 1) * W) : new Uint32Array((n + 1) * W);
	for (let i = n - 1; i >= 0; i--) {
		const ai = a[s + i];
		for (let j = k - 1; j >= 0; j--) {
			L[i * W + j] = ai === b[s + j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	while (i < n && j < k) {
		if (a[s + i] === b[s + j]) {
			m[s + i] = s + j;
			i++;
			j++;
		} else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++;
		else j++;
	}
	return m;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

export interface MergeResult {
	text: string;
	/** false = some lines were changed on both sides (resolved in favour of the newer side). */
	clean: boolean;
}

/**
 * @param base content at the last sync ('' for a file created on both devices at once)
 * @param ours local content, @param theirs cloud content
 * @param oursNewer which side wins where both changed the same lines
 * Returns null when the files are too large to compare.
 */
export function merge3(base: string, ours: string, theirs: string, oursNewer: boolean): MergeResult | null {
	if (ours === theirs) return { text: ours, clean: true };
	if (base === ours) return { text: theirs, clean: true };
	if (base === theirs) return { text: ours, clean: true };
	// the final newline is not a line of its own (otherwise two appends would look like a clash)
	const nl = ours.endsWith('\n') || theirs.endsWith('\n');
	const lines = (t: string) => (t === '' ? [] : (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n'));
	const O = lines(base);
	const A = lines(ours);
	const B = lines(theirs);
	const ma = matches(O, A);
	const mb = matches(O, B);
	if (!ma || !mb) return null;
	const out: string[] = [];
	let clean = true;
	let i = 0;
	let ja = 0;
	let jb = 0;
	for (;;) {
		let k = i;
		while (k < O.length && !(ma[k] >= ja && mb[k] >= jb)) k++;
		const ea = k < O.length ? ma[k] : A.length;
		const eb = k < O.length ? mb[k] : B.length;
		const o = O.slice(i, k);
		const a = A.slice(ja, ea);
		const b = B.slice(jb, eb);
		if (same(a, o)) out.push(...b);
		else if (same(b, o) || same(a, b)) out.push(...a);
		else if (o.length === 0) {
			// both added text at the same place: keep both (e.g. two devices appending to a log)
			out.push(...(oursNewer ? b : a), ...(oursNewer ? a : b));
		} else {
			clean = false;
			out.push(...(oursNewer ? a : b));
		}
		if (k >= O.length) break;
		out.push(O[k]);
		i = k + 1;
		ja = ea + 1;
		jb = eb + 1;
	}
	return { text: out.join('\n') + (nl && out.length ? '\n' : ''), clean };
}

/**
 * Merge without a common ancestor (same note created on two devices at once): lines both
 * versions share are kept once, everything else from both sides is kept, older side first.
 */
export function merge2(older: string, newer: string): string | null {
	if (older === newer) return older;
	const nl = older.endsWith('\n') || newer.endsWith('\n');
	const lines = (t: string) => (t === '' ? [] : (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n'));
	const A = lines(older);
	const B = lines(newer);
	const m = matches(A, B);
	if (!m) return null;
	const out: string[] = [];
	let j = 0;
	let chunk: string[] = [];
	for (let i = 0; i < A.length; i++) {
		if (m[i] < j) {
			chunk.push(A[i]);
			continue;
		}
		out.push(...chunk, ...B.slice(j, m[i]), A[i]);
		chunk = [];
		j = m[i] + 1;
	}
	out.push(...chunk, ...B.slice(j));
	return out.join('\n') + (nl && out.length ? '\n' : '');
}

/** UTF-8 text, or null for binary content. */
export function decodeText(data: ArrayBuffer): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
	} catch {
		return null;
	}
}
