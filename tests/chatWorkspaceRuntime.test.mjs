import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");

function rig(port) {
	const entry = { id: "session-1", projectId: "builtin-chat", title: "New chat", source: "pi", environment: "native", status: "draft", createdAt: 1, updatedAt: 1 };
	const tabs = [];
	const calls = { creates: [], claims: 0, sent: [] };
	const catalog = {
		get: () => ({ ...entry }),
		getRecord: () => ({ ...entry, preview: "", messageCount: 0 }),
		getLocator: () => (entry.filePath ? { kind: "local", environment: "native", filePath: entry.filePath } : undefined),
		attachRuntime: async (patch) => {
			if (patch.filePath) entry.filePath = patch.filePath;
		},
	};
	const agents = {
		list: () => tabs,
		create: async (input) => {
			calls.creates.push(input);
			const tab = { id: `agent-${tabs.length}`, projectId: entry.projectId, cwd: input.workspacePath ?? "/shared", status: "idle", title: entry.title, createdAt: 1 };
			tabs.push(tab);
			return tab;
		},
		claimStandbyAgent: async () => {
			calls.claims++;
			return null;
		},
		publishRuntimeState: async () => {},
		stop: async () => {},
	};
	const sender = async (input) => {
		calls.sent.push(input);
		return { accepted: true };
	};
	const coordinator = new SessionRuntimeCoordinator(catalog, agents, sender, undefined, undefined, undefined, port);
	return { entry, calls, coordinator };
}

const prompt = (requestId = "request-1", message = "Fix cache eviction") => ({ sessionId: "session-1", requestId, message });

test("send binds first-prompt cwd before create and never claims shared-cwd standby", async () => {
	const prepared = [];
	const h = rig({
		prepare: async (entry, message) => {
			prepared.push({ entry, message });
			return "/chat/2026-01-02/cache--session-1";
		},
	});
	const result = await h.coordinator.send(prompt());
	assert.equal(result.accepted, true);
	assert.equal(prepared[0].message, "Fix cache eviction");
	assert.equal(h.calls.creates[0].workspacePath, "/chat/2026-01-02/cache--session-1");
	assert.equal(h.calls.claims, 0);
	await h.coordinator.send(prompt("request-2", "Rename title"));
	assert.equal(prepared.length, 1);
	assert.equal(h.calls.creates.length, 1);
});

test("prewarm binds a default cwd once; concurrent first send waits for that allocation", async () => {
	let release;
	let started;
	const entered = new Promise((resolve) => {
		started = resolve;
	});
	const barrier = new Promise((resolve) => {
		release = resolve;
	});
	const messages = [];
	const h = rig({
		prepare: async (_entry, message) => {
			messages.push(message);
			started();
			await barrier;
			return "/chat/default--session-1";
		},
	});
	const activation = h.coordinator.activateRuntime("session-1");
	await entered;
	const send = h.coordinator.send(prompt());
	assert.equal(h.calls.creates.length, 0, "no process starts in shared cwd while allocation is pending");
	release();
	await activation;
	assert.equal((await send).accepted, true);
	assert.deepEqual(messages, [undefined]);
	assert.equal(h.calls.creates.length, 1);
	assert.equal(h.calls.creates[0].workspacePath, "/chat/default--session-1");
	assert.equal(h.calls.claims, 0);
});

test("allocation failure rejects sending before any create, claim or dispatch; retry can succeed", async () => {
	let fail = true;
	const h = rig({
		prepare: async () => {
			if (fail) throw new Error("disk denied");
			return "/chat/retry--session-1";
		},
	});
	const result = await h.coordinator.send(prompt());
	assert.equal(result.accepted, false);
	assert.equal(h.calls.creates.length, 0);
	assert.equal(h.calls.claims, 0);
	assert.equal(h.calls.sent.length, 0);
	fail = false;
	assert.equal((await h.coordinator.send(prompt("retry"))).accepted, true);
});

test("optional or ineligible workspace port preserves legacy standby activation", async () => {
	for (const port of [undefined, { prepare: async () => undefined }]) {
		const h = rig(port);
		assert.equal((await h.coordinator.send(prompt())).accepted, true);
		assert.equal(h.calls.claims, 1);
		assert.equal(h.calls.creates[0].workspacePath, undefined);
	}
});
