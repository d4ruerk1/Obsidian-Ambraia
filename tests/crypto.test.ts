import { describe, it, expect } from 'vitest';
import { ALGS, Cipher, createKeyfile, generateMasterKey, keyMatches, parseKeyfile, rewrapKeyfile, strength, newPairCode, normalizePairCode, formatPairCode, sealWithCode, openWithCode, unlockKeyfile, WrongKeyError, KEYFILE } from '../src/sync/crypto';
import { EncryptionStateError, SecureRemote, readKeyfile, writeKeyfile } from '../src/sync/secureRemote';
import { IntegrityError, SyncEngine } from '../src/sync/engine';
import { emptyState } from '../src/sync/types';
import { FakeDrive, FakeLocal } from './app-fake';

const te = new TextEncoder();
const buf = (s: string) => te.encode(s).buffer as ArrayBuffer;
const str = (b: ArrayBuffer) => new TextDecoder().decode(b);
const dek = () => crypto.getRandomValues(new Uint8Array(32));

describe('content encryption', () => {
	for (const alg of ALGS) {
		it(`${alg}: round trip, random nonce, tamper detection`, async () => {
			const c = new Cipher(dek(), alg, true);
			for (const size of [0, 1, 15, 16, 17, 1000, 70_000]) {
				const data = crypto.getRandomValues(new Uint8Array(Math.min(size, 65536)));
				const big = new Uint8Array(size);
				for (let i = 0; i < size; i += 65536) big.set(data.subarray(0, Math.min(65536, size - i)), i);
				const e1 = await c.encrypt(big.buffer);
				const e2 = await c.encrypt(big.buffer);
				expect(new Uint8Array(e1)).not.toEqual(new Uint8Array(e2));
				expect(new Uint8Array(await c.decrypt(e1))).toEqual(big);
				// flip one bit anywhere -> rejected
				for (const pos of [0, 5, Math.floor(e1.byteLength / 2), e1.byteLength - 1]) {
					const t = new Uint8Array(e1.slice(0));
					t[pos] ^= 1;
					await expect(c.decrypt(t.buffer)).rejects.toBeInstanceOf(IntegrityError);
				}
				// truncation -> rejected
				await expect(c.decrypt(e1.slice(0, e1.byteLength - 1))).rejects.toBeInstanceOf(IntegrityError);
			}
		});

		it(`${alg}: another key cannot decrypt`, async () => {
			const a = new Cipher(dek(), alg, true);
			const b = new Cipher(dek(), alg, true);
			await expect(b.decrypt(await a.encrypt(buf('secret')))).rejects.toBeInstanceOf(IntegrityError);
		});
	}

	it('decrypts files written with any algorithm (header identifies it)', async () => {
		const k = dek();
		const w = new Cipher(k, 'xchacha20', true);
		const r = new Cipher(k, 'aes-gcm', true);
		expect(str(await r.decrypt(await w.encrypt(buf('mixed'))))).toBe('mixed');
	});
});

describe('name encryption', () => {
	it('is deterministic, reversible, file-system safe and hides the name', async () => {
		const c = new Cipher(dek(), 'aes-gcm', true);
		for (const n of ['a.md', 'Perché è così.md', '日本語 ノート.md', 'x'.repeat(120), '.hidden', 'CON']) {
			const e = await c.encName(n);
			expect(e).toBe(await new Cipher((c as any).dek, 'aes-gcm', true).encName(n));
			expect(e).toMatch(/^[a-z2-7]+$/);
			expect(e).not.toContain(n.slice(0, 3).toLowerCase() === 'con' ? 'zzzz' : n);
			expect(await c.decName(e)).toBe(n);
		}
		expect(await c.encName('a.md')).not.toBe(await c.encName('b.md'));
	});

	it('rejects names not produced by this key', async () => {
		const c = new Cipher(dek(), 'aes-gcm', true);
		const other = new Cipher(dek(), 'aes-gcm', true);
		expect(await c.decName(await other.encName('a.md'))).toBeNull();
		expect(await c.decName('notes.md')).toBeNull();
		expect(await c.decName(KEYFILE)).toBeNull();
	});

	it('keeps names readable when name encryption is off', async () => {
		const c = new Cipher(dek(), 'aes-gcm', false);
		expect(await c.encName('a.md')).toBe('a.md');
		expect(await c.decName('a.md')).toBe('a.md');
	});
});

describe('key file and master key', () => {
	it('unlocks only with the right password (argon2id and pbkdf2)', async () => {
		for (const kdf of ['pbkdf2', 'argon2id'] as const) {
			const { keyfile, dek: k } = await createKeyfile('a long enough master key!', 'xchacha20', true, kdf);
			const parsed = parseKeyfile(JSON.stringify(keyfile));
			expect(await unlockKeyfile(parsed, 'a long enough master key!')).toEqual(k);
			await expect(unlockKeyfile(parsed, 'a long enough master key?')).rejects.toBeInstanceOf(WrongKeyError);
			expect(await keyMatches(parsed, k)).toBe(true);
			expect(await keyMatches(parsed, dek())).toBe(false);
		}
	}, 30_000);

	it('detects edits of the key file parameters', async () => {
		const { keyfile } = await createKeyfile('a long enough master key!', 'aes-gcm', true, 'pbkdf2');
		await expect(unlockKeyfile({ ...keyfile, alg: 'xchacha20' }, 'a long enough master key!')).rejects.toBeInstanceOf(WrongKeyError);
		await expect(unlockKeyfile({ ...keyfile, names: false }, 'a long enough master key!')).rejects.toBeInstanceOf(WrongKeyError);
		expect(() => parseKeyfile('{"format":"ambraia-crypt","v":1,"alg":"rot13"}')).toThrow();
		expect(() => parseKeyfile(JSON.stringify({ ...keyfile, kdf: { type: 'pbkdf2', i: 10 } }))).toThrow();
		expect(() => parseKeyfile('not json')).toThrow();
	});

	it('changing the master key keeps the data key', async () => {
		const { keyfile, dek: k } = await createKeyfile('first master key 123!', 'aes-gcm', true, 'pbkdf2');
		const next = await rewrapKeyfile(keyfile, k, 'second master key 456!');
		expect(next.kid).toBe(keyfile.kid);
		expect(next.salt).not.toBe(keyfile.salt);
		expect(await unlockKeyfile(next, 'second master key 456!')).toEqual(k);
		await expect(unlockKeyfile(next, 'first master key 123!')).rejects.toBeInstanceOf(WrongKeyError);
	});

	it('generated keys are strong and unique; strength meter', () => {
		const a = generateMasterKey();
		expect(a).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
		expect(generateMasterKey()).not.toBe(a);
		expect(strength(a)).toBeGreaterThanOrEqual(3);
		expect(strength('password')).toBeLessThan(2);
		expect(strength('')).toBe(0);
		expect(strength('Tr0ub4dor&3-horse-staple')).toBeGreaterThanOrEqual(3);
	});

	it('one-time pairing codes: 8 characters, forgiving input, open only with the right code', async () => {
		const c = newPairCode();
		expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
		expect(normalizePairCode(formatPairCode(c).toLowerCase())).toBe(c);
		expect(normalizePairCode('7k3m-9qxo')).toBe('7K3M9QX0');
		expect(normalizePairCode('ABC')).toBeNull();
		expect(normalizePairCode('ABCD-EFGU')).toBeNull();
		const { record } = await sealWithCode(c, { folder: 'Ambraia/Vault', provider: 'dropbox' }, 'offer-1.json');
		expect(JSON.stringify(record)).not.toContain('Vault');
		expect((await openWithCode(c, record, 'offer-1.json'))?.data).toEqual({ folder: 'Ambraia/Vault', provider: 'dropbox' });
		expect(await openWithCode(c === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA', record, 'offer-1.json')).toBeNull();
		expect(await openWithCode(c, record, 'offer-2.json')).toBeNull(); // bound to its file name
	});
});

describe('secure remote', () => {
	const setup = async (alg: 'aes-gcm' | 'xchacha20' = 'aes-gcm') => {
		const drive = new FakeDrive('feed');
		const inner = drive.api();
		const { keyfile, dek: k } = await createKeyfile('a long enough master key!', alg, true, 'pbkdf2');
		const root = await inner.createRoot();
		const kf = await writeKeyfile(inner, root.id, keyfile);
		return { drive, inner, keyfile, k, root, kf };
	};

	it('the cloud never sees names or contents', async () => {
		const { drive, inner, k, kf } = await setup();
		const remote = new SecureRemote(inner, new Cipher(k, 'aes-gcm', true), kf.rev);
		const local = new FakeLocal();
		local.put('Diario/Segreto.md', 'il mio segreto');
		await new SyncEngine(emptyState('Vault'), local, remote, { maxFileSize: 1e8 }).run(new Set(['Diario/Segreto.md']), true);
		const raw = [...drive.files.values()].filter((f) => !f.root && f.name !== KEYFILE);
		expect(raw.length).toBe(2);
		for (const f of raw) {
			expect(f.name).not.toMatch(/Diario|Segreto/);
			if (f.data) expect(str(f.data)).not.toContain('segreto');
		}
	});

	it('a tampered file is reported, never written locally, not retried forever', async () => {
		const { drive, inner, k, kf } = await setup('xchacha20');
		const mk = () => new SecureRemote(inner, new Cipher(k, 'xchacha20', true), kf.rev);
		const A = new FakeLocal();
		A.put('a.md', 'original');
		await new SyncEngine(emptyState('Vault'), A, mk(), { maxFileSize: 1e8 }).run(new Set(['a.md']), true);
		const f = [...drive.files.values()].find((x) => !x.isFolder && !x.root && x.name !== KEYFILE)!;
		const t = new Uint8Array(f.data!);
		t[t.length - 3] ^= 0xff;
		const B = new FakeLocal();
		const r = await new SyncEngine(emptyState('Vault'), B, mk(), { maxFileSize: 1e8 }).run(new Set(), true);
		expect(r.errors.length).toBe(1);
		expect(r.retry).toEqual([]);
		expect(B.get('a.md')).toBeUndefined();
	});

	it('plain device refuses an encrypted folder; encrypted device notices key changes or removal', async () => {
		const { drive, inner, keyfile, k, root, kf } = await setup();
		await expect(new SecureRemote(inner, null).listAll(root.id)).rejects.toMatchObject({ kind: 'remote-encrypted' });
		const sec = new SecureRemote(inner, new Cipher(k, 'aes-gcm', true), kf.rev);
		await sec.listAll(root.id);
		const r = await readKeyfile(inner, root.id);
		await writeKeyfile(inner, root.id, await rewrapKeyfile(keyfile, k, 'another long master key!'), r!.file);
		await expect(sec.listAll(root.id)).rejects.toMatchObject({ kind: 'keyfile-changed' });
		// change feed path
		const sec2 = new SecureRemote(inner, new Cipher(k, 'aes-gcm', true), (await readKeyfile(inner, root.id))!.file.rev);
		sec2.bind(root.id, (await readKeyfile(inner, root.id))!.file.id);
		const token = await sec2.changes!.start();
		drive.remoteTrash(KEYFILE);
		await expect(sec2.changes!.list(token)).rejects.toBeInstanceOf(EncryptionStateError);
		await expect(sec2.listAll(root.id)).rejects.toMatchObject({ kind: 'keyfile-missing' });
	});
});
