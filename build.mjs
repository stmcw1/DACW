/**
 * Builds the loadable DSH Host plugin from the TypeScript sources.
 *
 * Why this exists: a DSH Host plugin must be plain ESM JavaScript. This package
 * deliberately keeps the TypeScript sources as the single source of truth and
 * produces `dist/` with Node's built-in type-stripping (`module.stripTypeScriptTypes`,
 * Node >= 22.13) instead of requiring a `typescript` dependency, so the plugin can be
 * built and installed offline from a bare workspace directory.
 *
 * Two transformations happen here:
 *   1. TypeScript types are erased (`mode: 'transform'`).
 *   2. Extensionless relative imports are rewritten to explicit `.js` specifiers,
 *      because Node's ESM resolver does not infer extensions.
 *
 * Run: node build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, 'dist');

/** Runtime modules, in no particular order. */
const SOURCES = ['index.ts', 'runner.ts', 'sandbox.ts', 'state_manager.ts', 'plugin.ts'];

const RELATIVE_IMPORT = /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)(['"]\s*\)?)/g;

/** Append `.js` to extensionless relative specifiers so Node can resolve them. */
export function rewriteRelativeImports(code) {
  return code.replace(RELATIVE_IMPORT, (match, head, specifier, tail) => {
    if (/\.(?:js|mjs|cjs|json)$/.test(specifier)) return match;
    return head + specifier + '.js' + tail;
  });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of SOURCES) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const stripped = stripTypeScriptTypes(source, { mode: 'transform' });
  const output = rewriteRelativeImports(stripped);
  writeFileSync(path.join(outDir, file.replace(/\.ts$/, '.js')), output, 'utf8');
}

// Import the generated modules once so a broken build fails here instead of at
// plugin activation time inside the Harness.
const engine = await import(pathToFileURL(path.join(outDir, 'index.js')));
const plugin = await import(pathToFileURL(path.join(outDir, 'plugin.js')));

for (const name of ['apply', 'parseWriterDelta', 'mergeDelta', 'parseReviewVerdict', 'enumerateWorkspace', 'diffDigest']) {
  if (typeof engine[name] !== 'function') throw new Error(`build: dist/index.js does not export ${name}()`);
}
for (const name of ['apply', 'normalizePluginConfig', 'extractTextBlocks', 'buildActivationSpec', 'restrictChildTools', 'runSubagentChat']) {
  if (typeof plugin[name] !== 'function') throw new Error(`build: dist/plugin.js does not export ${name}()`);
}
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('tools')) throw new Error('build: dist/plugin.js must export inject = [\'tools\']');

console.log(`build: ${SOURCES.length} modules -> ${path.relative(root, outDir)}/ (smoke check passed)`);
