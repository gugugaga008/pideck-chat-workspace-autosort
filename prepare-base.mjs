#!/usr/bin/env node
/**
 * Stage the verified original app.asar for a rebuild.
 *
 * After a patch is installed, the live resources/app.asar is no longer the base,
 * and its unpacked directory must stay next to the staged base for integrity
 * checks. This copies the immutable backup plus the live unpacked files into
 * verification/base, which build-patch.mjs can use without touching the install.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERIFIED_BASES } from "./maintenance.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const target = JSON.parse(fs.readFileSync(path.join(root, "target.json"), "utf8"));
const resources = path.join(path.dirname(target.exePath), "resources");
const base = VERIFIED_BASES[0];
const backup = path.join(root, "backups", `${base.sha256}.asar`);
if (!fs.existsSync(backup)) throw new Error(`Verified backup missing: ${backup}`);
const unpacked = path.join(resources, "app.asar.unpacked");
if (!fs.existsSync(unpacked)) throw new Error(`Live unpacked directory missing: ${unpacked}`);

const output = path.join(root, "verification", "base");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(backup, path.join(output, "app.asar"));
fs.cpSync(unpacked, path.join(output, "app.asar.unpacked"), { recursive: true });
console.log(path.join(output, "app.asar"));
