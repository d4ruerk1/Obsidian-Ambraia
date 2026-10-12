import esbuild from 'esbuild';
import builtins from 'builtin-modules';
import { i18nPlugin } from './scripts/i18n-esbuild.mjs';
import fs from 'fs';
const prod = process.argv[2] === 'production';
// optional built-in OAuth apps (apps.json, never committed): users then just sign in
let apps = {};
if (fs.existsSync('apps.json')) {
  const raw = JSON.parse(fs.readFileSync('apps.json', 'utf8'));
  for (const id of ['gdrive', 'dropbox', 'onedrive', 'pcloud']) {
    const a = raw[id];
    if (a && typeof a.clientId === 'string' && a.clientId && !/x{6}|^0{8}-/.test(a.clientId)) apps[id] = { clientId: a.clientId, ...(a.clientSecret ? { clientSecret: String(a.clientSecret) } : {}) };
  }
}
// licence notices kept in the released main.js (MIT requires them in every copy, also when minified)
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const banner = `/*! ${manifest.name} ${manifest.version} — https://github.com/d4ruerk1/Obsidian-Ambraia
Copyright (c) 2026 d4ruerk1 — MIT License (see below).

Includes code from @noble/ciphers and @noble/hashes — Copyright (c) 2022 Paul Miller (https://paulmillr.com) — MIT License.
Cover previews: photos from Unsplash (Unsplash License). Service marks: Simple Icons (CC0 1.0); trademarks belong to their owners.\nSee THIRD_PARTY_NOTICES.md in the repository.

The MIT License applies to Ambraia and to @noble/ciphers and @noble/hashes:
${MIT}
*/`;
const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands', '@codemirror/language', '@codemirror/lint', '@codemirror/search', '@codemirror/state', '@codemirror/view', '@lezer/common', '@lezer/highlight', '@lezer/lr', ...builtins],
  format: 'cjs',
  target: 'es2022',
  legalComments: 'none',
  banner: { js: banner },
  charset: 'utf8',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minifyWhitespace: prod,
  minifySyntax: prod, // identifiers are kept readable for reviewers
  outfile: 'main.js',
  define: { __AMBRAIA_APPS__: JSON.stringify(apps) },
  plugins: [i18nPlugin()],
});
// styles.css is generated (minified) from src/styles.css
const css = await esbuild.context({ entryPoints: ['src/styles.css'], bundle: true, minify: prod, outfile: 'styles.css', logLevel: 'info' });
// static page that opens shared links (docs/share, published with GitHub Pages): no Obsidian, no i18n
const viewerBanner = `/*! ${manifest.name} share viewer ${manifest.version} — https://github.com/d4ruerk1/Obsidian-Ambraia
Copyright (c) 2026 d4ruerk1 — MIT License.
Includes code from @noble/ciphers and @noble/hashes — Copyright (c) 2022 Paul Miller (https://paulmillr.com) — MIT License.
${MIT}
*/`;
const viewer = await esbuild.context({ entryPoints: ['src/share/viewer.ts'], bundle: true, format: 'iife', target: 'es2022', legalComments: 'none', banner: { js: viewerBanner }, charset: 'utf8', logLevel: 'info', minify: prod, outfile: 'docs/share/viewer.js' });
if (prod) { await ctx.rebuild(); await css.rebuild(); await viewer.rebuild(); process.exit(0); } else { await ctx.watch(); await css.watch(); await viewer.watch(); }
