import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

function pngDimensions(buffer) {
  const signature = '89504e470d0a1a0a';
  assert.equal(buffer.subarray(0, 8).toString('hex'), signature, 'Invalid PNG signature');
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', 'Missing PNG IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const manifestPath = path.join(root, 'manifest.json');
const packagePath = path.join(root, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, packageJson.version);
assert.ok(Number(manifest.minimum_chrome_version) >= 120);
assert.ok(manifest.permissions.includes('scripting'));
assert.ok(manifest.permissions.includes('browsingData'));
assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
assert.equal(Object.keys(packageJson.dependencies || {}).length, 0);
assert.equal(Object.keys(packageJson.devDependencies || {}).length, 0);
assert.equal(packageJson.frostguardMetadata.runtimeDependencies, 0);
assert.equal(typeof packageJson.frostguardMetadata.implementation, 'string');
assert.ok(packageJson.frostguardMetadata.implementation.length > 0);
assert.ok(packageJson.frostguardMetadata.references.length >= 4);
for (const reference of packageJson.frostguardMetadata.references) {
  assert.equal(typeof reference.title, 'string');
  assert.equal(new URL(reference.url).protocol, 'https:');
}

const requiredFiles = [
  'manifest.json',
  'package.json',
  'README.md',
  'DESIGN.md',
  'LICENSE',
  'SECURITY.md',
  'src/service-worker.js',
  'src/main-shield.js',
  'src/bridge.js',
  'src/shared.js',
  'src/popup.html',
  'src/popup.css',
  'src/popup.js',
  'src/options.html',
  'src/options.css',
  'src/options.js',
  'tools/windows-lock-owners.ps1',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];
for (const relative of requiredFiles) await access(path.join(root, relative));

for (const [size, relative] of Object.entries(manifest.icons)) {
  const dimensions = pngDimensions(await readFile(path.join(root, relative)));
  assert.deepEqual(dimensions, { width: Number(size), height: Number(size) });
}

const files = await walk(root);
const scripts = files.filter((file) => /\.(?:js|mjs)$/.test(file));
for (const file of scripts) {
  await execFileAsync(process.execPath, ['--check', file]);
  const source = await readFile(file, 'utf8');
  assert.doesNotMatch(source, /\b(?:eval|Function)\s*\(/, `Dynamic code execution in ${file}`);
  assert.doesNotMatch(
    source,
    /(?:from\s*|import\s*\()\s*['"]https?:\/\//,
    `Remote JavaScript import in ${file}`,
  );
}

console.log(`Validated ${requiredFiles.length} required files and ${scripts.length} scripts.`);
console.log('Manifest V3 package has zero declared dependencies and no remote code imports.');
