/** Dedicated settings capability tests: no real user data, process, network or installation is touched. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseHostPluginManifest } = loadTsCommonJs("src/main/plugins/hostPluginManifest.ts");
const { parsePluginRequest } = loadTsCommonJs("src/main/plugins/hostPluginPolicy.ts");
const { HostPluginBroker } = loadTsCommonJs("src/main/plugins/HostPluginBroker.ts");
const { readHostPluginPackage } = loadTsCommonJs("src/main/plugins/hostPluginFiles.ts");
const { buildHostPluginScaffold } = loadTsCommonJs("src/main/plugins/hostPluginScaffold.ts");
const { scaffoldChatWorkspaceDemo } = loadTsCommonJs("src/main/plugins/hostPluginScaffoldChatWorkspace.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const root = resolve("../plugin");
const manifest = (permissions = ["chatWorkspace.manage"]) => ({ schemaVersion: 1, apiVersion: 1, id: "chat-workspace-autosort", name: "Chat directories", version: "1.0.0", permissions, contributes: { panels: [{ id: "main", title: "Main", entry: "app.html" }], commands: [] } });
const context = { locale: "en-US", theme: "light" };
const get = { method: "chatWorkspace.getSettings" };
const update = { method: "chatWorkspace.updateSettings", settings: { enabled: true } };

/** Manager identity changes and scope changes use the same production authorization checks. */
function fixture(port, permissions = ["chatWorkspace.manage"]) {
	let enabled = true;
	let changed;
	const manager = {
		getEnabled: () => (enabled ? { manifest: manifest(permissions), fingerprint: "f" } : undefined),
		onChanged: (listener) => {
			changed = listener;
			return () => {};
		},
	};
	const broker = new HostPluginBroker(manager, { describe: (value) => value }, {}, undefined, undefined, undefined, undefined, port);
	broker.bind(1, "chat-workspace-autosort", "f", context);
	return {
		broker,
		revoke: () => {
			enabled = false;
			changed();
		},
		request: (input) => broker.request(1, true, input),
	};
}

test("manifest accepts only the dedicated chatWorkspace permission; policy rejects non-boolean and extra fields", () => {
	assert.deepEqual(plain(parseHostPluginManifest(manifest()).permissions), ["chatWorkspace.manage"]);
	assert.throws(() => parseHostPluginManifest(manifest(["chatWorkspace.write"])), /unsupported-permission/);
	assert.deepEqual(plain(parsePluginRequest(update)), update);
	for (const settings of [undefined, null, [], {}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, { enabled: false, rootPath: "E:/elsewhere" }, { enabled: true, sessionId: "s" }, { enabled: true, command: "run" }]) {
		assert.throws(() => parsePluginRequest({ ...update, settings }), /invalid-request/);
	}
	assert.throws(() => parsePluginRequest({ ...get, rootPath: "E:/elsewhere" }), /invalid-request/);
	assert.throws(() => parsePluginRequest({ ...update, sessionId: "s" }), /invalid-request/);
});

test("both methods require explicit permission and a sender-bound main frame", async () => {
	let calls = 0;
	const port = {
		getSettings: async () => {
			calls++;
			return { enabled: false };
		},
		updateSettings: async () => {
			calls++;
			return { enabled: true };
		},
	};
	const value = fixture(port, []);
	for (const input of [get, update]) assert.equal((await value.request(input)).code, "permission-denied");
	assert.equal((await value.broker.request(2, true, get)).code, "plugin-not-authorized");
	assert.equal((await value.broker.request(1, false, update)).code, "plugin-not-authorized");
	assert.equal(calls, 0);
	value.broker.dispose();
});

test("missing adapter reports unsupported and refuses writes; installed port owns the real setting", async () => {
	const missing = fixture();
	assert.deepEqual(plain(await missing.request(get)), { ok: true, value: { enabled: false, supported: false } });
	assert.equal((await missing.request(update)).code, "service-unavailable");
	missing.broker.dispose();
	let state = { enabled: false, rootPath: "E:/fixed-chat-root", supported: true };
	const value = fixture({
		getSettings: async () => state,
		updateSettings: async (input, beforeAttempt) => {
			assert.equal(beforeAttempt(), true);
			assert.deepEqual(plain(input), { enabled: true });
			state = { ...state, enabled: input.enabled };
			return state;
		},
	});
	assert.equal((await value.request(get)).value.enabled, false);
	assert.equal((await value.request(update)).value.enabled, true);
	assert.equal((await value.request(get)).value.rootPath, "E:/fixed-chat-root");
	assert.equal((await value.request({ ...update, settings: { enabled: true, path: "E:/arbitrary" } })).code, "invalid-request");
	value.broker.dispose();
});

for (const reason of ["disable", "close", "context", "dispose"])
	test(`queued write cannot commit after ${reason}`, async () => {
		let release;
		let entered;
		const started = new Promise((resolve) => {
			entered = resolve;
		});
		const barrier = new Promise((resolve) => {
			release = resolve;
		});
		let commits = 0;
		const value = fixture({
			getSettings: async () => ({ enabled: false }),
			updateSettings: async (_input, beforeAttempt) => {
				assert.equal(beforeAttempt(), true);
				entered();
				await barrier;
				if (!beforeAttempt()) throw new Error("plugin-revoked");
				commits++;
				return { enabled: true };
			},
		});
		const pending = value.request(update);
		await started;
		if (reason === "disable") value.revoke();
		if (reason === "close") value.broker.unbind(1);
		if (reason === "context") value.broker.update(1, { ...context, projectId: "another" });
		if (reason === "dispose") value.broker.dispose();
		release();
		assert.equal((await pending).code, "plugin-revoked");
		assert.equal(commits, 0);
		value.broker.dispose();
	});

test("preload forwards only dedicated typed settings requests", async () => {
	let api;
	const calls = [];
	loadTsCommonJs("src/preload/hostPlugin.ts", {
		stubs: {
			electron: {
				contextBridge: {
					exposeInMainWorld: (_key, value) => {
						api = value;
					},
				},
				ipcRenderer: {
					invoke: async (_channel, input) => {
						calls.push(plain(input));
						return { ok: true, value: { enabled: false, supported: true } };
					},
				},
			},
		},
	});
	await api.chatWorkspace.getSettings();
	await api.chatWorkspace.updateSettings({ enabled: false });
	assert.deepEqual(calls, [get, { ...update, settings: { enabled: false } }]);
});

/** Execute the shipped panel with a minimal DOM and fake host, preserving its actual event handlers. */
async function panel(api) {
	const elements = new Map();
	const element = (id) => {
		if (!elements.has(id))
			elements.set(id, {
				checked: false,
				disabled: false,
				textContent: "",
				handlers: new Map(),
				addEventListener(event, handler) {
					this.handlers.set(event, handler);
				},
			});
		return elements.get(id);
	};
	const window = { pideck: { context: { get: async () => context }, chatWorkspace: api }, addEventListener: () => {} };
	new Function("window", "document", readFileSync(resolve(root, "app.js"), "utf8"))(window, { getElementById: element, documentElement: { dataset: {} } });
	await setImmediate();
	return { element };
}

test("static package installs with only chatWorkspace.manage and panel fails closed on missing support", async () => {
	const pkg = await readHostPluginPackage(root);
	assert.deepEqual(Array.from(pkg.manifest.permissions), ["chatWorkspace.manage"]);
	for (const api of [undefined, { getSettings: async () => ({ enabled: true, supported: false }), updateSettings: async () => assert.fail("unsupported host cannot write") }]) {
		const value = await panel(api);
		assert.equal(value.element("enabled").disabled, true);
		assert.equal(value.element("enabled").checked, false);
		assert.match(value.element("status").textContent, /host adapter/);
	}
});

test("panel reads host truth, sends only enabled and refreshes after write failure", async () => {
	const calls = [];
	let reads = 0;
	const value = await panel({
		getSettings: async () => {
			reads++;
			return { enabled: false, supported: true, rootPath: "E:/root" };
		},
		updateSettings: async (input) => {
			calls.push(input);
			throw new Error("plugin-revoked");
		},
	});
	assert.equal(value.element("enabled").disabled, false);
	value.element("enabled").checked = true;
	await value.element("enabled").handlers.get("change")();
	assert.deepEqual(calls, [{ enabled: true }]);
	assert.equal(reads, 2);
	assert.equal(value.element("enabled").checked, false);
	assert.match(value.element("status").textContent, /plugin-revoked/);
	assert.equal(value.element("root").textContent, "E:/root");
});

test("scaffold emits the demo only with the matching grant", async () => {
	assert.deepEqual(plain(scaffoldChatWorkspaceDemo({ permissions: [] })), { html: "", code: "", wiring: "" });
	const demo = scaffoldChatWorkspaceDemo({ permissions: ["chatWorkspace.manage"] });
	assert.doesNotThrow(() => new Function(demo.code));
	assert.match(demo.html, /chat-workspace-enabled/);
	for (const permissions of [["chatWorkspace.manage"], ["chatWorkspace.manage", "sessions.read"]]) {
		const files = buildHostPluginScaffold({ id: "demo.chat", name: "Chat", permissions, presentation: "page" });
		assert.doesNotThrow(() => new Function(files.get("app.js")));
		assert.deepEqual(Array.from(parseHostPluginManifest(JSON.parse(files.get("pideck-plugin.json"))).permissions), permissions);
	}
	const nodes = new Map();
	const element = (id) => {
		if (!nodes.has(id))
			nodes.set(id, {
				checked: false,
				disabled: true,
				textContent: "",
				addEventListener(_event, handler) {
					this.change = handler;
				},
			});
		return nodes.get(id);
	};
	const calls = [];
	await new Function("pideck", "document", demo.code + "\nreturn initChatWorkspace();")(
		{
			chatWorkspace: {
				getSettings: async () => ({ enabled: false, supported: true }),
				updateSettings: async (settings) => {
					calls.push(settings);
					return { ...settings, supported: true };
				},
			},
		},
		{ documentElement: { lang: "en-US" }, getElementById: element },
	);
	const toggle = element("chat-workspace-enabled");
	assert.equal(toggle.disabled, false);
	toggle.checked = true;
	await toggle.change();
	assert.deepEqual(calls, [{ enabled: true }]);
	assert.equal(toggle.checked, true);
});
