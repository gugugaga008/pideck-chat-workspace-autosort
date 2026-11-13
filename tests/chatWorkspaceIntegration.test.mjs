import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { ChatWorkspaceService } = loadTsCommonJs("src/main/sessions/ChatWorkspaceService.ts");
const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");
const { createAgentSessionReplacer } = loadTsCommonJs("src/main/sessions/agentSessionReplacement.ts");

/** Only the process boundary is fake: allocation, activation, catalog transactions and reload are real. */
function runtime(catalog, service, project, logFile, createGate = Promise.resolve()) {
	const tabs = [];
	const calls = { creates: [], claims: 0, messages: [] };
	const agents = {
		list: () => tabs,
		create: async (input) => {
			calls.creates.push(input);
			await createGate;
			await mkdir(join(logFile, ".."), { recursive: true });
			await writeFile(logFile, "{}\n");
			const tab = { id: "agent-1", projectId: project.id, cwd: input.workspacePath ?? project.path, title: input.title, status: "idle", sessionEnvironment: "native", sessionSource: "pi", sessionPath: input.sessionPath ?? logFile, sessionId: "pi-1", createdAt: 1 };
			tabs.push(tab);
			return tab;
		},
		claimStandbyAgent: async () => {
			calls.claims++;
			return null;
		},
		publishRuntimeState: async () => {},
		stop: async () => {},
		rename: async () => {},
	};
	const coordinator = new SessionRuntimeCoordinator(
		catalog,
		agents,
		async (input) => {
			calls.messages.push(input.message);
			return { accepted: true };
		},
		undefined,
		undefined,
		undefined,
		service,
	);
	return { agents, coordinator, calls, tabs };
}

test("real catalog/service/coordinator share one first-prompt cwd across concurrent sends, fork and restart", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "chat-workspace-integration-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const project = { id: "builtin-chat", kind: "chat", name: "Chat", path: join(dir, "chat") };
	const catalogFile = join(dir, "catalog.json");
	const catalog = new SessionCatalog(catalogFile);
	await catalog.load();
	const service = new ChatWorkspaceService(
		dir,
		() => project,
		catalog,
		() => new Date(2026, 0, 2),
	);
	await service.updateSettings({ enabled: true });
	const draft = await catalog.createDraft({ projectId: project.id, title: "New chat", source: "pi", environment: "native" });
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const logFile = join(dir, "pi-owned-logs", "origin.jsonl");
	const h = runtime(catalog, service, project, logFile, gate);
	const first = h.coordinator.send({ sessionId: draft.id, requestId: "first", message: "Fix cache eviction" });
	const second = h.coordinator.send({ sessionId: draft.id, requestId: "second", message: "A different intent" });
	release();
	const results = await Promise.all([first, second]);
	assert.ok(results.every((result) => result.accepted));
	const cwd = join(project.path, "2026-01-02", `Fix-cache-eviction--${draft.id}`);
	assert.equal(h.calls.creates.length, 1);
	assert.equal(h.calls.creates[0].workspacePath, cwd);
	assert.equal(h.calls.claims, 0);
	assert.equal(h.tabs[0].cwd, cwd);
	assert.equal(catalog.getRecord(draft.id).workspacePath, cwd);
	assert.deepEqual(await readdir(join(project.path, "2026-01-02")), [`Fix-cache-eviction--${draft.id}`]);
	assert.deepEqual(h.calls.messages.sort(), ["A different intent", "Fix cache eviction"]);

	const forkLogFile = join(dir, "pi-owned-logs", "fork.jsonl");
	await writeFile(forkLogFile, "{}\n");
	const replace = createAgentSessionReplacer({
		agentManager: h.agents,
		sessionCatalog: catalog,
		sessionRuntimeCoordinator: h.coordinator,
		appLogger: { warn: () => {} },
		forkedSuffix: () => "(fork)",
		resolveProjectLocator: () => ({ kind: "local", environment: "native", localPath: project.path }),
		onDetached: () => {},
		onAttached: () => {},
		onRestored: () => {},
	});
	const fork = await replace(h.tabs[0].id, async () => {
		h.tabs[0].sessionPath = forkLogFile;
		h.tabs[0].sessionId = "pi-fork";
		return {};
	});
	assert.notEqual(fork.targetSessionId, draft.id);
	assert.equal(catalog.getRecord(fork.targetSessionId).workspacePath, cwd, "fork shares the actual runtime cwd");
	assert.equal(catalog.getRecord(draft.id).workspacePath, cwd, "fork does not mutate the source allocation");
	await catalog.update(fork.targetSessionId, { title: "Renamed fork" });
	await service.updateSettings({ enabled: false });
	const persisted = JSON.parse(await readFile(catalogFile, "utf8"));
	assert.equal(persisted.sessions.find((entry) => entry.id === fork.targetSessionId).workspacePath, cwd);

	const reloadedCatalog = new SessionCatalog(catalogFile);
	await reloadedCatalog.load();
	const reloadedService = new ChatWorkspaceService(
		dir,
		() => project,
		reloadedCatalog,
		() => new Date(2027, 7, 9),
	);
	const restored = runtime(reloadedCatalog, reloadedService, project, forkLogFile);
	assert.equal((await restored.coordinator.send({ sessionId: fork.targetSessionId, requestId: "after-restart", message: "Continue tomorrow" })).accepted, true);
	assert.equal(restored.calls.creates.length, 1);
	assert.equal(restored.calls.creates[0].workspacePath, cwd);
	assert.equal(restored.calls.creates[0].sessionPath, forkLogFile);
	assert.equal(restored.calls.claims, 0);
	assert.deepEqual(await readdir(join(project.path, "2026-01-02")), [`Fix-cache-eviction--${draft.id}`]);
});
