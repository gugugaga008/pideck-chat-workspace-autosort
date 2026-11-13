import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const { parseProjectDirectoryRequest, resolveSessionDirectory } = loadTsCommonJs("src/main/files/sessionDirectoryRequest.ts");
const { sessionDirectoryServices, sessionFileBaseDir } = loadTsCommonJs("src/renderer/src/hooks/files/sessionDirectoryServices.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("project service hook follows the focused chat and keeps ordinary project services intact", async () => {
	const host = quickMessageHookHost();
	const currentAtom = {};
	let selected = "left";
	const records = { left: { projectId: "p", workspacePath: "/chat/left" }, right: { projectId: "p", workspacePath: "/chat/right" } };
	const requests = [];
	const base = { projectId: "p", generation: "local", capabilities: { files: { contentSearch: true } }, files: {} };
	const { useProjectServices } = loadTsCommonJs("src/renderer/src/hooks/useProjectServices.ts", {
		stubs: {
			react: host.react,
			jotai: { useAtomValue: (atom) => (atom === currentAtom ? selected : records[atom]) },
			"../atoms/session-atoms": { currentSessionIdAtom: currentAtom },
			"../atoms/session-selectors": { sessionRecordByIdAtomFamily: (id) => id },
			"../desktopApi": {
				desktopApi: {
					files: {
						directoryPage: async (request) => {
							requests.push(request);
							return { ok: true, value: { entries: [], truncated: false, revision: 1, generation: "local" } };
						},
					},
				},
			},
			"../services/projectServiceRuntime": { createProjectServiceRuntime: () => ({ start: () => () => {}, getSnapshot: () => base, subscribe: () => () => {} }) },
		},
	});
	const chat = { id: "p", kind: "chat", path: "/chat" };
	const left = host.render(() => useProjectServices(chat));
	await left.files.listDirectory({ projectId: "p", relativePath: "" });
	selected = "right";
	const right = host.render(() => useProjectServices(chat));
	await right.files.listDirectory({ projectId: "p", relativePath: "" });
	assert.notEqual(left.generation, right.generation);
	assert.deepEqual(
		plain(requests).map((request) => request.sessionId),
		["left", "right"],
	);
	assert.equal(
		host.render(() => useProjectServices({ ...chat, kind: undefined })),
		base,
	);
	host.unmount();
});

test("relative links select runtime, persisted workspace, then project independently for each pane", () => {
	assert.equal(sessionFileBaseDir("/live", "/saved", "/project"), "/live");
	assert.equal(sessionFileBaseDir(undefined, "/saved-left", "/project"), "/saved-left");
	assert.equal(sessionFileBaseDir(undefined, "/saved-right", "/project"), "/saved-right");
	assert.equal(sessionFileBaseDir(undefined, undefined, "/project"), "/project");
});

test("directory requests reject renderer roots, traversal and invalid session identities", () => {
	for (const value of [
		{ projectId: "p", relativePath: "", cwd: "/arbitrary" },
		{ projectId: "p", relativePath: "../other", sessionId: "s" },
		{ projectId: "p", relativePath: "", sessionId: " " },
		{ projectId: "p", relativePath: "", sessionId: 1 },
	])
		assert.throws(() => parseProjectDirectoryRequest(value), /INVALID_PROJECT_FILE_TARGET/);
});

test("catalog scopes root and nested reads, rejects project mismatch and symlink escapes", async () => {
	const temp = await mkdtemp(join(tmpdir(), "pideck-directory-ui-"));
	try {
		const projectRoot = join(temp, "chat");
		const workspacePath = join(projectRoot, "date", "intent--id");
		await mkdir(join(workspacePath, "nested"), { recursive: true });
		await mkdir(join(projectRoot, "other"));
		const request = { projectId: "p", relativePath: "", sessionId: "s" };
		const getSession = () => ({ projectId: "p", workspacePath });
		const root = await resolveSessionDirectory(request, projectRoot, getSession);
		assert.equal(root.root, await realpath(workspacePath));
		assert.equal(root.target.relativePath, "date/intent--id");
		const nested = await resolveSessionDirectory({ ...request, relativePath: "date/intent--id/nested" }, projectRoot, getSession);
		assert.equal(nested.target.relativePath, "date/intent--id/nested");
		await assert.rejects(
			resolveSessionDirectory(request, projectRoot, () => ({ projectId: "other", workspacePath })),
			/INVALID_PROJECT_FILE_TARGET/,
		);
		await assert.rejects(resolveSessionDirectory(request, projectRoot), /INVALID_PROJECT_FILE_TARGET/);
		await assert.rejects(resolveSessionDirectory({ ...request, relativePath: "other" }, projectRoot, getSession), /FILE_OUTSIDE_PROJECT/);
		await symlink(join(projectRoot, "other"), join(workspacePath, "escape"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(resolveSessionDirectory({ ...request, relativePath: "date/intent--id/escape" }, projectRoot, getSession), /FILE_OUTSIDE_PROJECT/);
		await assert.rejects(
			resolveSessionDirectory(request, projectRoot, () => ({ projectId: "p", workspacePath: temp })),
			/FILE_OUTSIDE_PROJECT/,
		);
		assert.equal((await resolveSessionDirectory(request, projectRoot, () => ({ projectId: "p" }))).target.relativePath, "");
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("session services send bounded identities and distinguish generations when switching chats", async () => {
	const calls = [];
	const base = { projectId: "p", generation: "local", capabilities: { files: { contentSearch: true } }, files: { readText: async () => "kept" } };
	const api = {
		files: {
			directoryPage: async (request) => {
				calls.push(request);
				return { ok: true, value: { entries: [], truncated: false, revision: 1, generation: "local" } };
			},
			searchPage: async (request) => {
				calls.push(request);
				return { ok: true, value: { results: [] } };
			},
		},
	};
	const first = sessionDirectoryServices(base, api, "s1", "/chat/first");
	const second = sessionDirectoryServices(base, api, "s2", "/chat/second");
	assert.notEqual(first.generation, second.generation);
	await first.files.listDirectory({ projectId: "p", relativePath: "" });
	await second.files.listDirectory({ projectId: "p", relativePath: "" });
	await second.files.searchFiles("report");
	assert.deepEqual(plain(calls), [
		{ projectId: "p", relativePath: "", sessionId: "s1" },
		{ projectId: "p", relativePath: "", sessionId: "s2" },
		{ projectId: "p", relativePath: "", sessionId: "s2" },
	]);
	assert.equal(first.capabilities.files.contentSearch, false);
	assert.equal(await first.files.searchContent("report"), null);
	assert.equal(first.files.readText, base.files.readText);
});

test("public directory IPC lists the session subdirectory and name search scans only that root", async () => {
	const temp = await mkdtemp(join(tmpdir(), "pideck-directory-ipc-"));
	try {
		const workspacePath = join(temp, "date", "intent--id");
		await mkdir(workspacePath, { recursive: true });
		const handlers = new Map();
		const calls = [];
		const { registerFilesIpc } = loadTsCommonJs("src/main/ipc/filesIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, shell: {} } } });
		registerFilesIpc({
			projectStore: { get: () => ({ id: "p", path: temp }) },
			getSession: () => ({ projectId: "p", workspacePath }),
			settingsStore: { get: () => ({}) },
			appLogger: { info() {}, error() {} },
			openExternalUrl: async () => {},
			fileSystemService: {
				listTreePage: async (root, depth, directory) => {
					calls.push([root, directory]);
					return { nodes: [{ name: "report.txt", path: join(directory, "report.txt"), relativePath: "date/intent--id/report.txt", type: "file" }], truncated: false };
				},
				searchNames: async (root) => {
					calls.push([root]);
					return [
						{ name: "report.txt", path: join(root, "report.txt"), relativePath: "report.txt", type: "file" },
						{ name: "nested.txt", relativePath: "nested.txt", type: "file" },
					];
				},
			},
		});
		const request = { projectId: "p", relativePath: "", sessionId: "s" };
		const directory = await handlers.get(ipcChannels.filesDirectoryPage)({}, request);
		assert.equal(directory.ok, true);
		assert.equal(directory.value.entries[0].relativePath, "date/intent--id/report.txt");
		const search = await handlers.get(ipcChannels.filesSearchPage)({}, request, "report");
		assert.equal(search.ok, true);
		assert.equal(search.value.results[0].target.relativePath, "date/intent--id/report.txt");
		assert.equal(search.value.results[1].target.relativePath, "date/intent--id/nested.txt");
		assert.deepEqual(calls, [[await realpath(temp), await realpath(workspacePath)], [await realpath(workspacePath)]]);
		const invalid = await handlers.get(ipcChannels.filesDirectoryPage)({}, { ...request, cwd: temp });
		assert.equal(invalid.ok, false);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
