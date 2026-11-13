import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { asar, hashFile, verifyBase, buildPackage, install, restore, status, inspectArchive, replaceArchive } from '../maintenance.mjs';

function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pideck-maintenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'original');
  write(path.join(original, 'package.json'), JSON.stringify({ version: '0.12.0', main: 'out/main/index.js' }));
  write(path.join(original, 'out/main/index.js'), 'original main');
  write(path.join(original, 'out/preload/index.js'), 'original preload');
  write(path.join(original, 'out/renderer/index.html'), '<script src="assets/old.js"></script>');
  write(path.join(original, 'out/renderer/assets/old.js'), 'old chunk');
  write(path.join(original, 'node_modules/retained/index.js'), 'dependency stays untouched');
  write(path.join(original, 'native/addon.node'), 'native stays untouched');
  write(path.join(original, 'empty'), '');
  const exe = path.join(root, 'installed', 'PiDeck.exe');
  write(exe, 'fixture exe - never executed');
  const archive = path.join(path.dirname(exe), 'resources/app.asar');
  await asar.createPackageWithOptions(original, archive, { unpack: '**/*.node' });
  const source = path.join(root, 'source');
  fs.cpSync(original, source, { recursive: true });
  write(path.join(source, 'out/main/index.js'), 'patched main');
  write(path.join(source, 'out/preload/index.js'), 'patched preload');
  write(path.join(source, 'out/renderer/index.html'), '<script src="assets/new.js"></script>');
  fs.unlinkSync(path.join(source, 'out/renderer/assets/old.js'));
  write(path.join(source, 'out/renderer/assets/new.js'), 'new chunk');
  const data = path.join(root, 'chat-data/session.jsonl');
  write(data, 'existing chat data must stay byte-identical');
  const policy = [{ version: '0.12.0', sha256: hashFile(archive) }];
  const guards = { policy, assertStopped: () => {}, inspectExecutable: () => ({ patchAllowed: true, embeddedAsarIntegrity: 'DISABLE' }) };
  const packageDir = path.join(root, 'package');
  await buildPackage({ root, baseAsar: archive, source, components: ['main', 'preload', 'renderer'], output: packageDir, evidence: 'fixture source: tests and build passed' }, guards);
  return { root, archive, exe, source, data, packageDir, guards, policy };
}

test('overlay matches all three source components, retains dependencies and validates header integrity', async t => {
  const f = await fixture(t);
  const candidate = path.join(f.packageDir, 'app.asar');
  assert.equal(asar.extractFile(candidate, 'out/main/index.js').toString(), 'patched main');
  assert.equal(asar.extractFile(candidate, 'out/preload/index.js').toString(), 'patched preload');
  assert.equal(asar.extractFile(candidate, 'out/renderer/assets/new.js').toString(), 'new chunk');
  assert.throws(() => asar.extractFile(candidate, 'out/renderer/assets/old.js'));
  assert.equal(asar.extractFile(candidate, 'node_modules/retained/index.js').toString(), 'dependency stays untouched');
  assert.equal(inspectArchive(candidate, f.archive).checked, 8);
  assert.equal(fs.existsSync(candidate + '.unpacked'), false);
});

test('backup is immutable and installs/restores are idempotent without touching chat data or unpacked bytes', async t => {
  const f = await fixture(t);
  const options = { root: f.root, exe: f.exe, packageDir: f.packageDir };
  const chatHash = hashFile(f.data);
  const nativeHash = hashFile(f.archive + '.unpacked/native/addon.node');
  assert.equal(status(options, f.guards).state, 'clean');
  const first = install(options, f.guards);
  assert.equal(first.changed, true);
  const backupStat = fs.statSync(first.backup);
  assert.equal(install(options, f.guards).changed, false);
  assert.equal(fs.statSync(first.backup).mtimeMs, backupStat.mtimeMs);
  assert.equal(status(options, f.guards).state, 'patched');
  assert.equal(restore(options, f.guards).changed, true);
  assert.equal(restore(options, f.guards).changed, false);
  assert.equal(hashFile(f.archive), f.policy[0].sha256);
  assert.equal(hashFile(f.data), chatHash);
  assert.equal(hashFile(f.archive + '.unpacked/native/addon.node'), nativeHash);
});

test('upgrades from a verified previous patch and restores it without a clean reinstall', async t => {
  const f = await fixture(t);
  const original = path.join(f.root, 'base.asar');
  fs.copyFileSync(f.archive, original);
  if (fs.existsSync(f.archive + '.unpacked')) fs.cpSync(f.archive + '.unpacked', original + '.unpacked', { recursive: true });
  const options = { root: f.root, exe: f.exe, packageDir: f.packageDir };
  install(options, f.guards);
  const v1Hash = hashFile(f.archive);
  assert.notEqual(v1Hash, f.policy[0].sha256);

  const source2 = path.join(f.root, 'source-v2');
  fs.cpSync(f.source, source2, { recursive: true });
  write(path.join(source2, 'out/main/index.js'), 'patched main v2');
  const package2 = path.join(f.root, 'package-v2');
  const guards2 = { ...f.guards, previousPatches: [v1Hash] };
  await buildPackage({ root: f.root, baseAsar: original, source: source2, components: ['main', 'preload', 'renderer'], output: package2, evidence: 'fixture v2', previousPatches: [v1Hash] }, guards2);

  const beforeUpgrade = status({ ...options, packageDir: package2 }, guards2);
  assert.equal(beforeUpgrade.state, 'previous-patch');
  assert.equal(beforeUpgrade.launchAllowed, true);
  assert.equal(install({ ...options, packageDir: package2 }, guards2).changed, true);
  assert.equal(status({ ...options, packageDir: package2 }, guards2).state, 'patched');
  assert.equal(hashFile(path.join(f.root, 'backups', v1Hash + '.asar')), v1Hash);

  assert.equal(restore({ ...options, packageDir: package2 }, guards2).changed, true);
  assert.equal(hashFile(f.archive), f.policy[0].sha256);
  assert.equal(status({ ...options, packageDir: package2 }, guards2).state, 'clean');
});

test('records the tool release version separately from the target PiDeck version', async t => {
  const f = await fixture(t);
  const output = path.join(f.root, 'package-release');
  const manifest = await buildPackage({ root: f.root, baseAsar: f.archive, source: f.source, components: ['main', 'preload', 'renderer'], output, evidence: 'fixture release', releaseVersion: '1.1.0' }, f.guards);
  assert.equal(manifest.version, '0.12.0');
  assert.equal(manifest.releaseVersion, '1.1.0');
  const report = status({ root: f.root, exe: f.exe, packageDir: output }, f.guards);
  assert.equal(report.releaseVersion, '1.1.0');
  await assert.rejects(
    () => buildPackage({ root: f.root, baseAsar: f.archive, source: f.source, components: ['main'], output: path.join(f.root, 'package-bad-release'), evidence: 'fixture', releaseVersion: 'v1.1' }, f.guards),
    /Invalid release version/,
  );
});

test('unknown version and unknown hash refuse modification; allowlist cannot be registered ad hoc', async t => {
  const f = await fixture(t);
  assert.throws(() => verifyBase({ root: f.root, baseAsar: f.archive }), /Unknown base hash/);
  const unknown = path.join(f.root, 'unknown-source');
  write(path.join(unknown, 'package.json'), '{"version":"0.13.0"}');
  await asar.createPackage(unknown, f.archive);
  asar.uncache(f.archive);
  const before = hashFile(f.archive);
  const options = { root: f.root, exe: f.exe, packageDir: f.packageDir };
  assert.equal(status(options, f.guards).state, 'unknown-version');
  assert.throws(() => install(options, f.guards), /Unsupported version/);
  assert.throws(() => restore(options, f.guards), /Unsupported version/);
  assert.equal(hashFile(f.archive), before);
  write(path.join(unknown, 'package.json'), '{"version":"0.12.0"}');
  await asar.createPackage(unknown, f.archive);
  asar.uncache(f.archive);
  assert.equal(status(options, f.guards).state, 'unknown-hash');
  assert.throws(() => install(options, f.guards), /Unknown installed hash/);
});

test('running process and failed atomic replacement leave original and verified backup intact', async t => {
  const f = await fixture(t);
  const options = { root: f.root, exe: f.exe, packageDir: f.packageDir };
  assert.throws(() => install(options, { ...f.guards, assertStopped: () => { throw Error('running'); } }), /running/);
  assert.throws(() => install(options, { ...f.guards, rename: () => { throw Error('locked'); } }), /locked/);
  assert.equal(hashFile(f.archive), f.policy[0].sha256);
  assert.equal(hashFile(path.join(f.root, 'backups', f.policy[0].sha256 + '.asar')), f.policy[0].sha256);
});

test('post-replacement verification failure rolls back original bytes', async t => {
  const f = await fixture(t);
  const old = path.join(f.root, 'old.asar'); fs.copyFileSync(f.archive, old);
  const candidate = path.join(f.packageDir, 'app.asar');
  assert.throws(() => replaceArchive(f.archive, candidate, hashFile(candidate), old, hashFile(old), (from, to) => {
    fs.renameSync(from, to); fs.appendFileSync(to, 'corruption');
  }), /Post-install hash mismatch/);
  assert.equal(hashFile(f.archive), hashFile(old));
});

test('corrupt existing backup is rejected and never overwritten', async t => {
  const f = await fixture(t);
  const backup = path.join(f.root, 'backups', f.policy[0].sha256 + '.asar');
  write(backup, 'do not overwrite');
  assert.throws(() => install({ root: f.root, exe: f.exe, packageDir: f.packageDir }, f.guards), /Existing backup has wrong hash/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'do not overwrite');
  assert.equal(hashFile(f.archive), f.policy[0].sha256);
});
