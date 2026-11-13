import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ChatWorkspaceService } = loadTsCommonJs("src/main/sessions/ChatWorkspaceService.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { isReapableStaleDraft } = loadTsCommonJs("src/main/sessions/StaleDraftReaper.ts");

async function rig(t) {
	const dir = await mkdtemp(join(tmpdir(), "chat-workspace-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const project = { id: "builtin-chat", kind: "chat", name: "Chat", path: join(dir, "chat") };
	const catalogFile = join(dir, "catalog.json");
	const catalog = new SessionCatalog(catalogFile);
	await catalog.load();
	const service = new ChatWorkspaceService(
		dir,
		() => project,
		catalog,
		() => new Date(2026, 0, 2, 23, 59),
	);
	const draft = await catalog.createDraft({ projectId: project.id, title: "New chat", environment: "native", source: "pi" });
	return { dir, project, catalogFile, catalog, service, draft, entry: () => catalog.get(draft.id) };
}

test("settings default off, persist enabled only, and reject revoked queued writes before replacement", async (t) => {
	const r = await rig(t);
	const initial = await r.service.getSettings();
	assert.equal(initial.enabled, false);
	assert.equal(initial.supported, true);
	assert.equal(initial.rootPath, r.project.path);
	await r.service.updateSettings({ enabled: true });
	assert.equal(JSON.parse(await readFile(join(r.dir, "chat-workspace-autosort.json"), "utf8")).enabled, true);
	const restarted = new ChatWorkspaceService(r.dir, () => r.project, r.catalog);
	assert.equal((await restarted.getSettings()).enabled, true);
	await assert.rejects(r.service.updateSettings({ enabled: false, root: "arbitrary" }), /invalid-request/);
	let checks = 0;
	await assert.rejects(
		r.service.updateSettings({ enabled: false }, () => ++checks === 1),
		/plugin-revoked/,
	);
	assert.equal(checks, 2);
	assert.equal((await restarted.getSettings()).enabled, true);
	assert.deepEqual(
		(await readdir(r.dir)).filter((name) => name.endsWith(".tmp")),
		[],
	);
	const outcomes = await Promise.allSettled([r.service.updateSettings({ enabled: false }, () => false), r.service.updateSettings({ enabled: false })]);
	assert.equal(outcomes[0].status, "rejected");
	assert.equal(outcomes[1].status, "fulfilled");
	assert.equal((await restarted.getSettings()).enabled, false);
});

test("first prompt selects a safe dated cwd; title/date/root/settings changes and restart preserve it", async (t) => {
	const r = await rig(t);
	assert.equal(await r.service.prepare(r.entry(), "first intent"), undefined);
	await r.service.updateSettings({ enabled: true });
	const cwd = await r.service.prepare(r.entry(), "修复 ../../缓存 / C:\\tmp : 故障\n更多说明");
	assert.equal(dirname(cwd), join(r.project.path, "2026-01-02"));
	assert.ok(basename(cwd).startsWith("修复-缓存-C-tmp-故障-更多说明--"));
	assert.ok(basename(cwd).endsWith(r.draft.id));
	assert.ok((await stat(cwd)).isDirectory());
	assert.equal(r.catalog.getRecord(r.draft.id).workspacePath, cwd);
	await r.catalog.update(r.draft.id, { title: "Changed title" });
	await r.service.updateSettings({ enabled: false });
	const restartedCatalog = new SessionCatalog(r.catalogFile);
	await restartedCatalog.load();
	assert.equal(restartedCatalog.getRecord(r.draft.id).workspacePath, cwd, "bound draft survives crash before first send");
	r.project.path = join(r.dir, "new-chat-root");
	const restarted = new ChatWorkspaceService(
		r.dir,
		() => r.project,
		restartedCatalog,
		() => new Date(2027, 9, 8),
	);
	assert.equal(await restarted.prepare(restartedCatalog.get(r.draft.id), "different intent"), cwd);
	assert.equal(isReapableStaleDraft(restartedCatalog.get(r.draft.id), Date.now() + 86400000, {}), false);
});

test("only fresh builtin-chat native pi drafts are allocated, prewarm uses title and never renames", async (t) => {
	const r = await rig(t);
	await r.service.updateSettings({ enabled: true });
	for (const patch of [{ status: "active" }, { source: "codex" }, { environment: "wsl" }, { backend: "dsh" }, { backend: "acp" }, { backend: "imagegen" }, { importedSourceId: "imported" }, { filePath: join(r.dir, "old.jsonl") }, { noSession: true }, { locator: { kind: "ssh", hostId: "host" } }]) {
		const entry = { ...r.entry(), ...patch };
		let bound = false;
		const service = new ChatWorkspaceService(r.dir, () => r.project, {
			get: () => entry,
			bindWorkspacePath: () => {
				bound = true;
				throw new Error("must not bind");
			},
		});
		assert.equal(await service.prepare(entry, "intent"), undefined, JSON.stringify(patch));
		assert.equal(bound, false);
	}
	const ordinary = new ChatWorkspaceService(r.dir, () => ({ ...r.project, id: "other" }), r.catalog);
	assert.equal(await ordinary.prepare(r.entry(), "intent"), undefined);
	const cwd = await r.service.prepare(r.entry());
	assert.ok(basename(cwd).startsWith("New-chat--"));
	assert.equal(await r.service.prepare(r.entry(), "first real intent"), cwd);
});

test("uses a generated short intent when available and falls back to the first message on failure", async (t) => {
	const r = await rig(t);
	await r.service.updateSettings({ enabled: true });
	const create = () => r.catalog.createDraft({ projectId: r.project.id, title: "New chat", environment: "native", source: "pi" });
	const fixedDate = () => new Date(2026, 0, 2);

	const first = await create();
	const named = new ChatWorkspaceService(
		r.dir,
		() => r.project,
		r.catalog,
		fixedDate,
		async () => "WSL 内存占用排查",
	);
	const namedPath = await named.prepare(r.catalog.get(first.id), "看一下我当前的wsl什么东西内存占用大");
	assert.equal(basename(namedPath), `WSL-内存占用排查--${first.id}`);

	const second = await create();
	const thrown = new ChatWorkspaceService(
		r.dir,
		() => r.project,
		r.catalog,
		fixedDate,
		async () => {
			throw new Error("model unavailable");
		},
	);
	const rawPath = await thrown.prepare(r.catalog.get(second.id), "帮我做一个土豆钟网页");
	assert.equal(basename(rawPath), `帮我做一个土豆钟网页--${second.id}`);

	const third = await create();
	const empty = new ChatWorkspaceService(
		r.dir,
		() => r.project,
		r.catalog,
		fixedDate,
		async () => "   ",
	);
	const emptyPath = await empty.prepare(r.catalog.get(third.id), "检查 ws 内存");
	assert.equal(basename(emptyPath), `检查-ws-内存--${third.id}`);
});

test("root-only scans keep existing child-cwd logs but still remove truly deleted files", async (t) => {
	const r = await rig(t);
	await r.service.updateSettings({ enabled: true });
	const cwd = await r.service.prepare(r.entry(), "work");
	const sessionFile = join(cwd, "pi-owned.jsonl");
	await writeFile(sessionFile, "{}\n");
	await r.catalog.attachRuntime({ sessionId: r.draft.id, filePath: sessionFile, piSessionId: "pi-id", promoteToActive: true });
	await r.catalog.mergeScanned(r.project.id, []);
	assert.equal(r.catalog.getRecord(r.draft.id).workspacePath, cwd);
	await unlink(sessionFile);
	await r.catalog.mergeScanned(r.project.id, []);
	assert.equal(r.catalog.getRecord(r.draft.id), undefined);
});
