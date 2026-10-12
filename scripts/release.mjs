// Release: copies the built plugin into dist/ambraia and zips it (dist/Ambraia-<version>.zip).
// main.js is plain, readable bundled code (language packs are plain strings, see scripts/i18n_pack.mjs).
import fs from 'fs';
import { execFileSync } from 'child_process';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
if (pkg.version !== manifest.version) throw new Error(`package.json ${pkg.version} ≠ manifest.json ${manifest.version}`);
if (!versions[manifest.version]) throw new Error(`versions.json has no entry for ${manifest.version}`);

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/ambraia', { recursive: true });
let total = 0;
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
	fs.copyFileSync(f, `dist/ambraia/${f}`);
	total += fs.statSync(f).size;
}
try {
	execFileSync('zip', ['-qr9', `../Ambraia-${manifest.version}.zip`, 'ambraia'], { cwd: 'dist' });
	fs.renameSync(`Ambraia-${manifest.version}.zip`, `dist/Ambraia-${manifest.version}.zip`);
} catch {
	/* zip not available: the folder is enough */
}
console.log(`dist/ambraia ready (${(total / 1024).toFixed(0)} KB)`);
