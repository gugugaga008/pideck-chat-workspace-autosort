import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "PiDeck");
const require = createRequire(path.join(source, "package.json"));
const { _electron } = require("@playwright/test");
const executableArgument = process.argv[2];
assert(executableArgument && path.isAbsolute(executableArgument), "Supply an isolated copied PiDeck.exe, never the installed executable");
const executablePath = path.resolve(executableArgument);
assert(executablePath.startsWith(path.join(root, "verification") + path.sep), "Smoke app must be inside verification/");
const home = fs.mkdtempSync(path.join(root, "verification", "profile-"));
const profile = path.join(home, "profile");
for (const sub of ["AppData/Roaming", "AppData/Local", "AppData/LocalLow", "Desktop", "Documents", "profile"]) fs.mkdirSync(path.join(home, sub), { recursive: true });
const shim = path.join(home, "mock-pi.cmd");
fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${path.join(source, "e2e", "mock-pi.cjs")}" %*\r\n`);
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ customPiPath: shim, piEnvironmentChecked: true, language: "zh-CN", dshHomeDir: path.join(home, "dsh-home"), dshAutoImportSessions: false, standbyRuntimeEnabled: false, enableNotifications: false, enhanceModel: { provider: "fake", modelId: "fake" } }));
fs.writeFileSync(path.join(profile, "chat-workspace-autosort.json"), JSON.stringify({ enabled: true }));
// The app resolves the pi SDK entry even though the fake enhance helper ignores it.
const fakeSdk = path.join(home, "node_modules", "@earendil-works", "pi-coding-agent");
fs.mkdirSync(path.join(fakeSdk, "dist"), { recursive: true });
fs.writeFileSync(path.join(fakeSdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0-smoke" }));
fs.writeFileSync(path.join(fakeSdk, "dist", "index.js"), "export class ModelRuntime {}\n");
// Deterministic one-shot completion host: proves the directory name comes from the model
// response, not from the first-message fallback.
fs.writeFileSync(
  path.join(path.dirname(executablePath), "resources", "pi-enhance-host.mjs"),
  `import { createInterface } from "node:readline";\n` +
    `const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");\n` +
    `send({ type: "ready", protocolVersion: 1, piVersion: "fake-smoke" });\n` +
    `createInterface({ input: process.stdin }).on("line", (line) => {\n` +
    `  let cmd; try { cmd = JSON.parse(line); } catch { return; }\n` +
    `  if (cmd?.cmd !== "complete") return;\n` +
    `  send({ type: "started", id: cmd.id });\n` +
    `  const text = cmd.userText.includes("番茄") ? "番茄钟网页" : cmd.userText.includes("记账") ? "记账图标" : "短意图";\n` +
    `  setTimeout(() => { send({ type: "delta", id: cmd.id, text }); send({ type: "done", id: cmd.id, text }); }, 20);\n` +
    `});\n`,
);
const env = { ...process.env, PIDECK_E2E: "1", PIDECK_E2E_WINDOW_MODE: "quiet", PIDECK_E2E_USER_DATA_DIR: profile, APPDATA: home, LOCALAPPDATA: home, USERPROFILE: home, HOME: home, CI: "1" };
for (const key of Object.keys(env)) if (key.startsWith("PI_") || key.startsWith("PIDECK_LINKED_") || key.startsWith("PIDECK_MODEL_TRACE_") || key === "ELECTRON_RUN_AS_NODE" || key === "ELECTRON_RENDERER_URL" || key === "PIDECK_SECURITY_CONFIG") delete env[key];
let app;
async function launch() {
  app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 45000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.piDesktop?.sessions?.createDraft, { timeout: 30000 });
  return page;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, accept, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = read();
      if (accept(value)) return value;
      last = value;
    } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}: ${String(last)}`);
}
try {
  const page = await launch();
  const results = await page.evaluate(async () => {
    const api = window.piDesktop;
    const a = await api.sessions.createDraft({ projectId: "builtin-chat", backend: "pi", title: "隔离测试甲" });
    const b = await api.sessions.createDraft({ projectId: "builtin-chat", backend: "pi", title: "隔离测试乙" });
    const sentA = await api.sessions.sendPrompt({ sessionId: a.id, message: "创建番茄钟网页", requestId: "autosort-smoke-a" });
    const sentB = await api.sessions.sendPrompt({ sessionId: b.id, message: "创建记账图标", requestId: "autosort-smoke-b" });
    return { a: a.id, b: b.id, sentA, sentB };
  });
  assert.equal(results.sentA.accepted, true, JSON.stringify(results.sentA));
  assert.equal(results.sentB.accepted, true, JSON.stringify(results.sentB));
  const catalogPath = path.join(profile, "session-catalog.json");
  const rows = () => JSON.parse(fs.readFileSync(catalogPath, "utf8")).sessions;
  const findRows = () => waitFor(rows, list => list.some(x => x.id === results.a && x.workspacePath) && list.some(x => x.id === results.b && x.workspacePath), "catalog workspace bindings");
  const bound = await findRows();
  const a = bound.find(x => x.id === results.a);
  const b = bound.find(x => x.id === results.b);
  assert(a?.workspacePath && b?.workspacePath);
  assert.notEqual(a.workspacePath, b.workspacePath);
  assert(path.basename(a.workspacePath).startsWith("番茄钟网页--"), `Expected AI intent name for A, got ${a.workspacePath}`);
  assert(path.basename(b.workspacePath).startsWith("记账图标--"), `Expected AI intent name for B, got ${b.workspacePath}`);
  const chatRoot = path.join(profile, "chat-workspace");
  for (const row of [a, b]) {
    assert(row.workspacePath.startsWith(chatRoot + path.sep));
    fs.writeFileSync(path.join(row.workspacePath, "same-name.txt"), row.id, { flag: "wx" });
    const header = await waitFor(
      () => JSON.parse(fs.readFileSync(row.filePath, "utf8").split("\n")[0]),
      value => typeof value?.cwd === "string" && value.cwd.length > 0,
      `pi session header for ${row.id}`,
    );
    assert.equal(header.cwd, row.workspacePath, "Physical pi process cwd must equal bound workspace");
  }
  const tree = await page.evaluate(async sessionId => {
    const directory = await window.piDesktop.files.directoryPage({ projectId: "builtin-chat", relativePath: "", sessionId });
    const search = await window.piDesktop.files.searchPage({ projectId: "builtin-chat", relativePath: "", sessionId }, "same-name");
    return { directory, search };
  }, a.id);
  assert.equal(tree.directory.ok, true, JSON.stringify(tree.directory));
  assert(tree.directory.value.entries.some(entry => entry.target.relativePath.endsWith("same-name.txt")), "Session file tree must read the allocated chat directory");
  assert.equal(tree.search.ok, true, JSON.stringify(tree.search));
  assert(tree.search.value.results.some(entry => entry.target.relativePath.endsWith("same-name.txt")), "Session file search must stay inside the allocated chat directory");
  const projects = JSON.parse(fs.readFileSync(path.join(profile, "projects.json"), "utf8"));
  assert(!projects.projects.some(project => typeof project.path === "string" && project.path.startsWith(chatRoot + path.sep)), "Chat subdirectories must not be auto-registered as projects");
  await app.close(); app = undefined;
  const restored = await launch();
  const activated = await restored.evaluate(async ids => Promise.all(ids.map(id => window.piDesktop.sessions.activateRuntime(id))), [a.id, b.id]);
  assert(activated.every(x => x.ok), JSON.stringify(activated));
  for (const prior of [a, b]) {
    const current = await waitFor(rows, list => list.some(x => x.id === prior.id && x.workspacePath === prior.workspacePath), `restored binding for ${prior.id}`).then(list => list.find(x => x.id === prior.id));
    assert.equal(current.workspacePath, prior.workspacePath);
    assert.equal(fs.readFileSync(path.join(prior.workspacePath, "same-name.txt"), "utf8"), prior.id);
  }
  const report = { passed: true, executablePath, profile, sessions: [a, b].map(x => ({ id: x.id, workspacePath: x.workspacePath, filePath: x.filePath })), checks: ["packaged startup", "AI intent names from the completion sidecar", "first prompts accepted through mock pi", "different real process cwd", "same-name files isolated", "session-scoped file tree and search", "no chat subdirectory registered as project", "restart and reactivation keep binding"] };
  fs.writeFileSync(path.join(root, "verification", "smoke-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { if (app) await app.close(); }
