import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.12.0';
export const VERIFIED_BASES = [{ version: VERSION, sha256: 'e820040621072d30c22c55c376298d17f0fdb9279ef5bfe813ea31eba7a99db3' }];
// Older patches built by this tool. Kept so a newer package can upgrade or restore
// an installation that still has the previous verified patch, without a clean reinstall.
export const VERIFIED_PATCHES = ['24edec508aa8adf3c7609b5c987ed8db34ee321320232eed95e630bf8163e94b'];
const ownRequire = createRequire(import.meta.url);
// Prefer the source tree's electron-builder dependency graph; root fallback is isolated.
export function loadAsar(source = path.join(ROOT, 'PiDeck')) {
  try {
    const sourceRequire = createRequire(path.join(source, 'package.json'));
    const builderRequire = createRequire(sourceRequire.resolve('electron-builder/package.json'));
    try { return builderRequire('@electron/asar'); }
    catch { return createRequire(builderRequire.resolve('app-builder-lib/package.json'))('@electron/asar'); }
  } catch { return ownRequire('@electron/asar'); }
}
const asarApi = loadAsar();
export const asar = {
  ...asarApi,
  // ASAR's Windows filesystem lookup expects native separators; manifests use '/'.
  statFile: (archive, name, ...args) => asarApi.statFile(archive, path.normalize(name), ...args),
  extractFile: (archive, name, ...args) => asarApi.extractFile(archive, path.normalize(name), ...args),
};
export const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function hashFile(file) {
  const fd = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = fs.readSync(fd, chunk)) > 0;) hash.update(chunk.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function demand(ok, message) { if (!ok) throw new Error(message); }
function digest(value) { demand(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA256'); return value; }
function strictVersion(version) { demand(version === VERSION, `Unsupported version: ${version}; only ${VERSION} is supported. Original program retained.`); }
function archiveVersion(file) { asar.uncache(file); return JSON.parse(asar.extractFile(file, 'package.json')).version; }
function entries(file) {
  asar.uncache(file);
  return Object.fromEntries(asar.listPackage(file).map(name => {
    const key = name.replace(/^[\\/]/, '').replaceAll('\\', '/');
    demand(!key.split('/').some(x => x === '..' || x === '.' || x === ''), `Unsafe archive entry ${key}`);
    return [key, asar.statFile(file, key, false)];
  }));
}
export function inspectArchive(file, unpackedBase = file) {
  const files = entries(file);
  let checked = 0;
  for (const [name, info] of Object.entries(files)) {
    if (info.files || info.link) continue;
    const data = asar.extractFile(info.unpacked ? unpackedBase : file, name);
    demand(data.length === info.size, `Size mismatch: ${name}`);
    const integrity = info.integrity;
    demand(integrity?.algorithm === 'SHA256' && integrity.hash === sha(data), `Missing/invalid ASAR integrity: ${name}`);
    demand(Number.isSafeInteger(integrity.blockSize) && integrity.blockSize > 0, `Invalid integrity block size: ${name}`);
    const blocks = [];
    for (let i = 0; i < data.length; i += integrity.blockSize) blocks.push(sha(data.subarray(i, i + integrity.blockSize)));
    if (!blocks.length) blocks.push(sha(Buffer.alloc(0)));
    demand(JSON.stringify(blocks) === JSON.stringify(integrity.blocks), `Invalid integrity blocks: ${name}`);
    checked++;
  }
  return { checked, headerSha256: sha(asar.getRawHeader(file).headerString) };
}
function trustedBase(root, hash, policy = VERIFIED_BASES) {
  demand(policy.some(b => b.version === VERSION && b.sha256 === hash), `Unknown base hash ${hash}; no modification allowed.`);
}
export function verifyBase({ root = ROOT, baseAsar }, guards = {}) {
  strictVersion(archiveVersion(baseAsar));
  const expectedSha256 = hashFile(baseAsar);
  trustedBase(root, expectedSha256, guards.policy);
  const integrity = inspectArchive(baseAsar);
  fs.mkdirSync(root, { recursive: true });
  const dest = path.join(root, 'verified-bases.json');
  const record = { version: VERSION, sha256: expectedSha256, ...integrity };
  if (fs.existsSync(dest)) {
    const old = json(dest);
    demand(old.bases.some(b => b.sha256 === expectedSha256 && b.version === VERSION), 'Manifest already exists with a different base; review manually.');
    return record;
  }
  writeJson(dest, { schema: 1, bases: [record], note: 'Verified against hardcoded independently supplied allowlist; not a vendor signature.' });
  return record;
}
function allowedFile(name) { return /^out\/(main|preload|renderer)\/.+/.test(name) && !name.split('/').some(p => ['..', '.', ''].includes(p)) && !name.includes('\\') && !name.includes(':'); }
function regular(file) { demand(fs.lstatSync(file).isFile(), `Regular file required: ${file}`); }
function releaseVersion(value) { demand(typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value), 'Invalid release version'); return value; }
export async function buildPackage({ root = ROOT, baseAsar, source, files, components = [], output, evidence, previousPatches = [], releaseVersion: release }, guards = {}) {
  demand(path.isAbsolute(baseAsar) && path.isAbsolute(source) && path.isAbsolute(output), 'Absolute paths required');
  const releaseValue = release === undefined ? undefined : releaseVersion(release);
  const previousAllowlist = guards.previousPatches ?? VERIFIED_PATCHES;
  demand(Array.isArray(previousPatches) && previousPatches.every(hash => digest(hash) && previousAllowlist.includes(hash)), 'Unverified previous patch; add it to the reviewed allowlist first');
  strictVersion(archiveVersion(baseAsar));
  strictVersion(json(path.join(source, 'package.json')).version);
  const baseHash = hashFile(baseAsar);
  verifyBase({ root, baseAsar }, guards);
  const original = entries(baseAsar);
  demand(components.every(c => ['main', 'preload', 'renderer'].includes(c)), 'Unknown component');
  const replacements = {};
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      demand(!entry.isSymbolicLink(), `Source symlink forbidden: ${name}`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), name);
      else { demand(entry.isFile(), `Unsupported source file ${name}`); replacements[name] = fs.readFileSync(path.join(dir, entry.name)); }
    }
  }
  for (const c of components) walk(path.join(source, 'out', c), `out/${c}`);
  files = [...new Set([...(files ?? []), ...Object.keys(replacements)])];
  demand(files.length, 'Select --component main/preload/renderer or --file out/main/...');
  demand(typeof evidence === 'string' && evidence.trim().length > 0, 'Provide --evidence with successful source test/build commands and results');
  for (const name of files) {
    demand(allowedFile(name), `Disallowed replacement: ${name}`);
    const sourceFile = path.join(source, name);
    regular(sourceFile);
    demand(fs.realpathSync(sourceFile).startsWith(fs.realpathSync(source) + path.sep), 'Source symlink escape');
    replacements[name] = fs.readFileSync(sourceFile);
    if (original[name]?.unpacked) demand(sha(replacements[name]) === sha(asar.extractFile(baseAsar, name)), `Cannot change unpacked file ${name}`);
  }
  const deleted = Object.entries(original).filter(([name, info]) => !info.files && components.some(c => name.startsWith(`out/${c}/`)) && !(name in replacements)).map(([name]) => name);
  for (const name of deleted) demand(!original[name].unpacked, `Cannot delete unpacked file ${name}`);
  const desired = { ...original };
  for (const name of deleted) delete desired[name];
  for (const name of files) {
    demand(!original[name]?.files && !original[name]?.link, `Cannot replace directory/link ${name}`);
    desired[name] = original[name] ?? { size: replacements[name].length };
    const parts = name.split('/'); parts.pop();
    while (parts.length) { const dir = parts.join('/'); desired[dir] ??= { files: {} }; parts.pop(); }
  }
  // A fresh output directory prevents partial packages from being mistaken for successful ones.
  fs.mkdirSync(output);
  try {
    const candidate = path.join(output, 'app.asar');
    const streams = Object.entries(desired).sort(([a], [b]) => a.localeCompare(b)).map(([name, info]) => {
      demand(!info.link, `Archive links are not supported by this Windows maintenance tool: ${name}`);
      if (info.files) return { path: name, type: 'directory', unpacked: !!info.unpacked };
      const streamGenerator = () => Readable.from(replacements[name] ?? asar.extractFile(baseAsar, name));
      return { path: name, type: 'file', unpacked: !!info.unpacked, streamGenerator,
        stat: { size: replacements[name]?.length ?? info.size, mode: info.executable ? 0o100755 : 0o100644 } };
    });
    const outputStream = await asar.createPackageFromStreams(candidate, streams);
    // v3 stream API resolves at end(), before the OS file descriptor is closed.
    if (outputStream?.on) await finished(outputStream);
    const integrity = inspectArchive(candidate);
    const after = entries(candidate);
    demand(JSON.stringify(Object.keys(desired).sort()) === JSON.stringify(Object.keys(after).sort()), 'Archive entry set changed');
    for (const [name, before] of Object.entries(desired)) {
      const info = after[name];
      demand(!!before.unpacked === !!info.unpacked && !!before.executable === !!info.executable && !!before.files === !!info.files, `Archive metadata changed: ${name}`);
      if (!before.files) demand(sha(asar.extractFile(candidate, name)) === sha(replacements[name] ?? asar.extractFile(baseAsar, name)), `Unexpected content change: ${name}`);
    }
    demand(hashFile(baseAsar) === baseHash, 'Base changed while building');
    const manifest = { schema: 1, version: VERSION, ...(releaseValue ? { releaseVersion: releaseValue } : {}), baseSha256: baseHash, patchedSha256: hashFile(candidate), previousPatches, ...integrity,
      files: Object.fromEntries(files.map(name => [name, sha(replacements[name])])), deleted, components, evidence,
      executableIntegrity: 'Install and launcher must read the target EXE fuse with @electron/fuses and reject enabled/unknown embedded ASAR integrity. EXE is never patched.' };
    writeJson(path.join(output, 'manifest.json'), manifest);
    // Unpacked bytes were checked against original. Installer must retain installed unpacked directory.
    fs.rmSync(candidate + '.unpacked', { recursive: true, force: true });
    return manifest;
  } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
}
export function inspectExecutable({ exe }) {
  demand(path.isAbsolute(exe), 'Explicit absolute --exe path required');
  regular(exe);
  return JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'inspect-fuses.mjs'), exe], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' },
  }));
}
function patchableExecutable(exe, guards) {
  const report = (guards.inspectExecutable ?? inspectExecutable)({ exe });
  demand(report.patchAllowed === true && report.embeddedAsarIntegrity === 'DISABLE', 'EXE embedded ASAR integrity is enabled or unknown; patch installation/launch refused. Use a separately reviewed standalone Electron runtime directory instead. Original program retained.');
  return report;
}
function installation(exe) {
  demand(path.isAbsolute(exe), 'Explicit absolute --exe path required');
  regular(exe);
  const realExe = fs.realpathSync(exe);
  demand(path.basename(realExe).toLowerCase() === 'pideck.exe', 'Expected explicit PiDeck.exe');
  const archive = path.join(path.dirname(realExe), 'resources', 'app.asar');
  regular(archive);
  demand(fs.realpathSync(archive) === archive, 'Archive symlink is not allowed');
  return { exe: realExe, archive, version: archiveVersion(archive), sha256: hashFile(archive) };
}
export function assertStopped(exe) {
  demand(process.platform === 'win32', 'Installation supported only on Windows');
  // Literal environment argument: never interpolate operator-controlled paths into PowerShell code.
  const script = `$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:PIDECK_PATCH_TARGET); $hits=@(Get-Process -Name PiDeck -ErrorAction SilentlyContinue | ForEach-Object { if (-not $_.Path) { throw 'Cannot read PiDeck process executable path' }; if ([String]::Equals([IO.Path]::GetFullPath($_.Path),$target,[StringComparison]::OrdinalIgnoreCase)) { $_.Id } }); if ($hits.Count -gt 0) { throw ('PiDeck is running at target path (PID '+($hits -join ',')+'). Close it manually.') }`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, PIDECK_PATCH_TARGET: exe }, timeout: 15000, windowsHide: true, stdio: 'pipe' });
}
function knownHashes(m) { return [m.baseSha256, m.patchedSha256, ...(m.previousPatches ?? [])]; }
function manifestFor(root, packageDir, policy = VERIFIED_BASES, previousPatches = VERIFIED_PATCHES) {
  const m = json(path.join(packageDir, 'manifest.json'));
  demand(m.schema === 1, 'Unknown package schema'); strictVersion(m.version);
  if (m.releaseVersion !== undefined) releaseVersion(m.releaseVersion);
  trustedBase(root, digest(m.baseSha256), policy); digest(m.patchedSha256);
  demand(Array.isArray(m.previousPatches ?? []) && (m.previousPatches ?? []).every(hash => digest(hash) && previousPatches.includes(hash)), 'Invalid previous patch list');
  m.previousPatches = m.previousPatches ?? [];
  demand(m.files && Object.keys(m.files).length && Object.keys(m.files).every(allowedFile), 'Invalid replacement list');
  demand(Array.isArray(m.deleted) && m.deleted.every(allowedFile), 'Invalid deletion list');
  demand(m.components?.every(c => ['main', 'preload', 'renderer'].includes(c)), 'Invalid components');
  demand(m.deleted.every(name => m.components.some(c => name.startsWith(`out/${c}/`))), 'Deletion outside selected component');
  demand(hashFile(path.join(packageDir, 'app.asar')) === m.patchedSha256, 'Package hash mismatch');
  return m;
}
export function status({ root = ROOT, exe, packageDir }, guards = {}) {
  const app = installation(exe);
  if (app.version !== VERSION) return { ...app, state: 'unknown-version', launchAllowed: false };
  if (!packageDir) {
    const known = (guards.policy ?? VERIFIED_BASES).some(b => b.version === app.version && b.sha256 === app.sha256);
    return { ...app, state: known ? 'clean' : 'unknown-hash', launchAllowed: false };
  }
  const m = manifestFor(root, packageDir, guards.policy, guards.previousPatches);
  const state = app.sha256 === m.patchedSha256 ? 'patched' : app.sha256 === m.baseSha256 ? 'clean' : m.previousPatches.includes(app.sha256) ? 'previous-patch' : 'unknown-hash';
  const executableIntegrity = state === 'patched' || state === 'previous-patch' ? patchableExecutable(app.exe, guards) : undefined;
  return { ...app, state, launchAllowed: state === 'patched' || state === 'previous-patch', baseSha256: m.baseSha256, patchedSha256: m.patchedSha256, releaseVersion: m.releaseVersion, executableIntegrity };
}
function withLock(root, exe, action) {
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
  const lock = path.join(root, 'backups', sha(exe.toLowerCase()) + '.lock');
  const fd = fs.openSync(lock, 'wx');
  try { return action(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function backupPath(root, hash) { return path.join(root, 'backups', hash + '.asar'); }
function ensureBackup(root, archive, hash) {
  const backup = backupPath(root, hash);
  try { fs.copyFileSync(archive, backup, fs.constants.COPYFILE_EXCL); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  demand(hashFile(backup) === hash, 'Existing backup has wrong hash; refusing overwrite');
  return backup;
}
// Single same-directory rename over the existing file: failure leaves it in place.
export function replaceArchive(target, source, expected, rollback, expectedCurrent, rename = fs.renameSync) {
  const temp = path.join(path.dirname(target), `.pideck-patch-${crypto.randomUUID()}.tmp`);
  let replaced = false;
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    demand(hashFile(temp) === expected, 'Staged archive hash mismatch');
    const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    demand(hashFile(target) === expectedCurrent, 'Installed archive changed concurrently');
    rename(temp, target); replaced = true;
    demand(hashFile(target) === expected, 'Post-install hash mismatch');
  } catch (error) {
    if (replaced) {
      try { fs.copyFileSync(rollback, temp, fs.constants.COPYFILE_EXCL); fs.renameSync(temp, target); }
      catch (restoreError) { throw new AggregateError([error, restoreError], `Replacement and rollback failed; recover from ${rollback}`); }
    }
    throw error;
  } finally { fs.rmSync(temp, { force: true }); asar.uncache(target); }
}
export function install({ root = ROOT, exe, packageDir }, guards = {}) {
  return withLock(root, exe, () => {
    const app = installation(exe); strictVersion(app.version);
    const m = manifestFor(root, packageDir, guards.policy, guards.previousPatches);
    (guards.assertStopped ?? assertStopped)(app.exe);
    demand(knownHashes(m).includes(app.sha256), 'Unknown installed hash; original retained');
    const baseBackup = backupPath(root, m.baseSha256);
    patchableExecutable(app.exe, guards);
    if (app.sha256 === m.patchedSha256) {
      demand(fs.existsSync(baseBackup) && hashFile(baseBackup) === m.baseSha256, 'Patched app has no verified original backup');
      return { state: 'patched', changed: false, backup: baseBackup };
    }
    // Install from a previous verified patch: keep that patch as the immediate rollback,
    // while the original base backup remains the long-term recovery anchor.
    const rollback = ensureBackup(root, app.archive, app.sha256);
    demand(fs.existsSync(baseBackup) && hashFile(baseBackup) === m.baseSha256, 'Original backup is missing; restore the original app first');
    inspectArchive(app.archive);
    // Verify candidate with installed unpacked bytes, without changing that directory.
    const original = entries(app.archive);
    const candidate = entries(path.join(packageDir, 'app.asar'));
    inspectArchive(path.join(packageDir, 'app.asar'), app.archive);
    for (const [name, expected] of Object.entries(m.files)) {
      digest(expected);
      demand(candidate[name] && !candidate[name].files && !candidate[name].link, `Missing replacement ${name}`);
      const data = asar.extractFile(candidate[name].unpacked ? app.archive : path.join(packageDir, 'app.asar'), name);
      demand(sha(data) === expected, `Replacement hash mismatch ${name}`);
    }
    for (const name of Object.keys(candidate)) {
      if (!original[name]) demand(allowedFile(name) && (candidate[name].files || name in m.files), `Unexpected new entry ${name}`);
    }
    for (const name of m.deleted) demand(!candidate[name], `Deleted entry still present: ${name}`);
    for (const [name, info] of Object.entries(original)) {
      if (m.deleted.includes(name)) continue;
      const next = candidate[name];
      demand(next && !!info.unpacked === !!next.unpacked && !!info.files === !!next.files && !!info.executable === !!next.executable && !info.link && !next.link, `Candidate metadata mismatch: ${name}`);
      if (info.files) continue;
      const before = asar.extractFile(app.archive, name);
      if (info.unpacked) demand(info.integrity.hash === next.integrity.hash, `Unpacked change forbidden: ${name}`);
      else {
        const after = asar.extractFile(path.join(packageDir, 'app.asar'), name);
        demand(sha(after) === (m.files[name] ?? sha(before)), `Unexpected replacement: ${name}`);
      }
    }
    (guards.assertStopped ?? assertStopped)(app.exe);
    replaceArchive(app.archive, path.join(packageDir, 'app.asar'), m.patchedSha256, rollback, app.sha256, guards.rename);
    return { state: 'patched', changed: true, backup: baseBackup };
  });
}
export function restore({ root = ROOT, exe, packageDir }, guards = {}) {
  return withLock(root, exe, () => {
    const app = installation(exe); strictVersion(app.version);
    const m = manifestFor(root, packageDir, guards.policy, guards.previousPatches);
    (guards.assertStopped ?? assertStopped)(app.exe);
    demand(knownHashes(m).includes(app.sha256), 'Unknown installed hash; original retained');
    if (app.sha256 === m.baseSha256) return { state: 'clean', changed: false };
    const backup = backupPath(root, m.baseSha256);
    demand(hashFile(backup) === m.baseSha256, 'Original backup hash mismatch');
    // Save whichever patch is installed (current or previous) for rollback on a failed restore.
    const patchedBackup = ensureBackup(root, app.archive, app.sha256);
    (guards.assertStopped ?? assertStopped)(app.exe);
    replaceArchive(app.archive, backup, m.baseSha256, patchedBackup, app.sha256, guards.rename);
    return { state: 'clean', changed: true };
  });
}
