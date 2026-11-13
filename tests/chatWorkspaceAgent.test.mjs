import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", { stubs: { electron: { app: { getPath: () => resolve("test-user-data"), getAppPath: () => resolve("."), isPackaged: false }, powerSaveBlocker: { start: () => 1, stop: () => {}, isStarted: () => false } } } });

function rig() {
	const project = { id: "builtin-chat", name: "Chat", kind: "chat", path: resolve("chat-root") };
	const manager = new AgentManager(
		() => project,
		() => null,
		{ get: () => ({}) },
		{},
	);
	const calls = { spawn: [], handshake: [] };
	const fakeProcess = { getDiagnostics: () => null, client: { request: async () => ({ success: true, data: { sessionId: "pi-id", sessionFile: ".pi/log.jsonl" } }) }, stop: () => {} };
	manager.projectTrust.ensureProjectTrust = async () => undefined;
	manager.createPiProcess = (cwd) => {
		calls.spawn.push(cwd);
		return fakeProcess;
	};
	manager.handshakePiProcess = async (_id, options) => {
		calls.handshake.push(options.projectPath);
		return { process: fakeProcess, state: { success: true, data: { sessionId: "pi-id", sessionFile: ".pi/log.jsonl" } }, fallbackFromExtensions: false };
	};
	manager.emitState = () => {};
	manager.getHistoryAutoLoadDecision = () => ({});
	manager.readRecentMessagesFromSessionFile = async () => [];
	manager.loadMessages = async () => [];
	manager.notifyMcpThirdPartyTakeover = async () => {};
	return { project, manager, calls };
}

test("pi spawn, handshake, relative log resolution and restart all use the session cwd", async () => {
	const { project, manager, calls } = rig();
	const cwd = join(project.path, "2026-01-02", "intent--deck-id");
	const tab = await manager.create({ projectId: project.id, deckSessionId: "deck-id", environment: "native", source: "pi", workspacePath: cwd });
	assert.equal(tab.status, "idle");
	assert.equal(tab.cwd, cwd);
	assert.equal(tab.sessionPath, join(cwd, ".pi/log.jsonl"));
	assert.deepEqual(calls.spawn, [cwd]);
	assert.deepEqual(calls.handshake, [cwd]);
	await manager.rename(tab.id, "New display title");
	assert.equal(tab.cwd, cwd);
	assert.equal(tab.sessionPath, join(cwd, ".pi/log.jsonl"));
	await manager.reattachProcess(tab.id, tab.sessionPath);
	assert.equal(tab.cwd, cwd);
	assert.equal(tab.sessionPath, join(cwd, ".pi/log.jsonl"));
	assert.deepEqual(calls.handshake, [cwd, cwd]);
});

test("pi without a host cwd override retains the project root", async () => {
	const { project, manager, calls } = rig();
	const tab = await manager.create({ projectId: project.id, deckSessionId: "old-deck-id", environment: "native", source: "pi" });
	assert.equal(tab.status, "idle");
	assert.equal(tab.cwd, project.path);
	assert.deepEqual(calls.spawn, [project.path]);
});
