import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage, VERIFIED_PATCHES, asar } from "./maintenance.mjs";

/**
 * Reproducible overlay builder for this project.
 *
 * Why not `--component main`: the installed DSH runtime file
 * `out/main/hostEntry.js` is unpacked and must keep its exact bytes. A fresh
 * main build naturally produces different bytes, so the maintenance tool would
 * (correctly) refuse to replace it. Here we mirror every packed main file and
 * leave every unpacked original untouched, while mirroring preload/renderer as
 * complete components because their hashed asset names must move together.
 */
const root = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_VERSION = "1.1.0";
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, values) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), values[index + 1]]);
    return pairs;
  }, []),
);
const baseAsar = path.resolve(
  args["base-asar"] ??
    (fs.existsSync(path.join(root, "verification", "base", "app.asar"))
      ? path.join(root, "verification", "base", "app.asar")
      : "D:/Users/MSI-1/AppData/Local/Programs/PiDeck/resources/app.asar"),
);
const source = path.resolve(args.source ?? path.join(root, "PiDeck"));
const output = path.resolve(args.output ?? path.join(root, "packages", `chat-workspace-${RELEASE_VERSION}`));
const evidenceFile = path.resolve(args.evidence ?? path.join(root, "source-validation.txt"));
for (const required of [baseAsar, evidenceFile]) if (!fs.existsSync(required)) throw new Error(`Missing file: ${required}`);
if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
for (const component of ["main", "preload", "renderer"]) {
  if (!fs.existsSync(path.join(source, "out", component))) throw new Error(`Build output missing: out/${component}`);
}

const files = [];
function collect(directory, prefix) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) collect(path.join(directory, entry.name), name);
    else {
      let original;
      try {
        original = asar.statFile(baseAsar, name, false);
      } catch {
        // A newly introduced packed chunk; include it.
      }
      if (!original?.unpacked) files.push(name);
    }
  }
}
collect(path.join(source, "out", "main"), "out/main");

fs.mkdirSync(path.dirname(output), { recursive: true });
const manifest = await buildPackage({
  root,
  baseAsar,
  source,
  files,
  components: ["preload", "renderer"],
  output,
  evidence: fs.readFileSync(evidenceFile, "utf8"),
  // Allow a direct upgrade from an older patch verified by this tool. The base
  // backup remains the ultimate rollback; previous patch bytes are kept too.
  previousPatches: VERIFIED_PATCHES,
  releaseVersion: RELEASE_VERSION,
});
console.log(
  JSON.stringify(
    {
      output,
      baseSha256: manifest.baseSha256,
      patchedSha256: manifest.patchedSha256,
      files: Object.keys(manifest.files).length,
      deleted: manifest.deleted.length,
    },
    null,
    2,
  ),
);
