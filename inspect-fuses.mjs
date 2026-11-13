// Read-only helper. Kept separate so the synchronous transaction can call the official async reader.
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
const exe = process.argv[2];
try {
  const wire = await getCurrentFuseWire(exe);
  const state = wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation];
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(exe)) hash.update(chunk);
  console.log(JSON.stringify({
    exe, exeSha256: hash.digest('hex'), wireVersion: wire.version,
    embeddedAsarIntegrity: FuseState[state] ?? 'UNKNOWN',
    onlyLoadAppFromAsar: FuseState[wire[FuseV1Options.OnlyLoadAppFromAsar]] ?? 'UNKNOWN',
    patchAllowed: wire.version === '1' && state === FuseState.DISABLE,
    wire,
  }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
