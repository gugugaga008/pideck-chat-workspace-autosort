import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { asar, hashFile, buildPackage, install, status } from '../maintenance.mjs';

test('enabled or unknown EXE integrity fuse blocks installation and patched launch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pideck-fuses-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'out/main'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"0.12.0"}');
  fs.writeFileSync(path.join(source, 'out/main/index.js'), 'original');
  const exe = path.join(root, 'installed/PiDeck.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'not executable');
  const baseAsar = path.join(path.dirname(exe), 'resources/app.asar');
  await asar.createPackage(source, baseAsar);
  const baseHash = hashFile(baseAsar);
  fs.writeFileSync(path.join(source, 'out/main/index.js'), 'patched');
  const packageDir = path.join(root, 'package');
  const guards = { policy: [{ version: '0.12.0', sha256: baseHash }], assertStopped: () => {}, inspectExecutable: () => ({ embeddedAsarIntegrity: 'ENABLE', patchAllowed: false }) };
  await buildPackage({ root, baseAsar, source, components: ['main'], output: packageDir, evidence: 'fixture build and test success' }, guards);
  const options = { root, exe, packageDir };
  assert.throws(() => install(options, guards), /embedded ASAR integrity is enabled or unknown/);
  assert.equal(hashFile(baseAsar), baseHash);
  const unknown = { ...guards, inspectExecutable: () => ({ embeddedAsarIntegrity: 'UNKNOWN', patchAllowed: false }) };
  assert.throws(() => install(options, unknown), /embedded ASAR integrity is enabled or unknown/);
  // Emulate a previously patched installation: launcher must independently gate the EXE too.
  fs.copyFileSync(path.join(packageDir, 'app.asar'), baseAsar);
  assert.throws(() => status(options, guards), /embedded ASAR integrity is enabled or unknown/);
});
