import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ChatWorkspaceSettings, ChatWorkspaceSettingsPort, ChatWorkspaceSettingsUpdate } from "../../shared/chatWorkspace";
import type { Project } from "../../shared/types/project";
import type { SessionCatalogEntry } from "./SessionCatalog";

/** Coordinator port runs inside the activation gate, before creating or claiming a process. */
export interface ChatWorkspaceRuntimePort {
	prepare(entry: SessionCatalogEntry, firstPrompt?: string): Promise<string | undefined>;
}

/** One-shot naming attempt. Any failure is the caller's cue to use the first message. */
export type ChatWorkspaceIntentGenerator = (prompt: string, entry: SessionCatalogEntry) => Promise<string | undefined>;

type WorkspaceCatalog = {
	get(id: string): SessionCatalogEntry | undefined;
	bindWorkspacePath(id: string, workspacePath: string): Promise<string>;
};

/** A short portable leaf: prompt text can never supply path segments or shell syntax. */
function intentLeaf(text: string, max = 32): string {
	return (
		Array.from(
			text
				.normalize("NFKC")
				.replace(/[^\p{L}\p{N}]+/gu, "-")
				.replace(/^-+|-+$/g, ""),
		)
			.slice(0, max)
			.join("")
			.replace(/-+$/g, "") || "chat"
	);
}

/** Owns opt-in settings and native built-in chat cwd allocation; pi still owns all session logs. */
export class ChatWorkspaceService implements ChatWorkspaceSettingsPort, ChatWorkspaceRuntimePort {
	private readonly settingsFile: string;
	private mutationTail: Promise<unknown> = Promise.resolve();

	constructor(
		userDataDir: string,
		private readonly getProject: (id: string) => Project | undefined,
		private readonly catalog: WorkspaceCatalog,
		private readonly now: () => Date = () => new Date(),
		private readonly generateIntent?: ChatWorkspaceIntentGenerator,
	) {
		this.settingsFile = join(userDataDir, "chat-workspace-autosort.json");
	}

	/** Report only host-owned root facts; plugins cannot choose a different directory. */
	private settingsSnapshot(enabled: boolean): ChatWorkspaceSettings {
		const project = this.getProject("builtin-chat");
		const supported = project?.kind === "chat" && Boolean(project.path) && project.environment !== "wsl";
		return { enabled, supported, rootPath: supported ? project?.path : undefined };
	}

	/** Missing settings preserve the legacy shared-root behavior. Corrupt files fail closed. */
	async getSettings(): Promise<ChatWorkspaceSettings> {
		try {
			const value: unknown = JSON.parse(await readFile(this.settingsFile, "utf8"));
			return this.settingsSnapshot(typeof value === "object" && value !== null && "enabled" in value && value.enabled === true);
		} catch (error) {
			if (error instanceof SyntaxError || (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) return this.settingsSnapshot(false);
			throw error;
		}
	}

	/** Serialize updates and recheck plugin authorization immediately before atomic replacement. */
	updateSettings(input: ChatWorkspaceSettingsUpdate, beforeAttempt?: () => boolean): Promise<ChatWorkspaceSettings> {
		if (!input || typeof input.enabled !== "boolean" || Object.keys(input).some((key) => key !== "enabled")) return Promise.reject(new Error("invalid-request"));
		const enabled = input.enabled;
		const operation = this.mutationTail.then(async () => {
			if (beforeAttempt && !beforeAttempt()) throw new Error("plugin-revoked");
			const temporary = `${this.settingsFile}.${randomUUID()}.tmp`;
			try {
				await mkdir(dirname(this.settingsFile), { recursive: true });
				await writeFile(temporary, `${JSON.stringify({ enabled })}\n`, { flag: "wx" });
				if (beforeAttempt && !beforeAttempt()) throw new Error("plugin-revoked");
				await rename(temporary, this.settingsFile);
				return this.settingsSnapshot(enabled);
			} finally {
				await unlink(temporary).catch(() => undefined);
			}
		});
		this.mutationTail = operation.catch(() => undefined);
		return operation;
	}

	/** Existing allocations survive disable/title/date/root changes; new ones require native pi drafts. */
	async prepare(snapshot: SessionCatalogEntry, firstPrompt?: string): Promise<string | undefined> {
		const entry = this.catalog.get(snapshot.id);
		if (!entry) throw new Error(`Session not found: ${snapshot.id}`);
		const project = this.getProject(entry.projectId);
		if (!project || project.id !== "builtin-chat" || !project.path || project.environment === "wsl" || entry.environment !== "native" || entry.source !== "pi" || (entry.backend && entry.backend !== "pi") || entry.locator?.kind === "ssh" || entry.noSession) return undefined;
		if (entry.workspacePath) {
			if (!isAbsolute(entry.workspacePath)) throw new Error("Invalid persisted workspace path");
			await mkdir(entry.workspacePath, { recursive: true });
			return entry.workspacePath;
		}
		if (entry.status !== "draft" || entry.filePath || (entry.locator?.kind === "local" && entry.locator.filePath) || entry.importedSourceId || !(await this.getSettings()).enabled) return undefined;
		// Catalog IDs are stable, but imported legacy IDs may contain separators: reject rather than truncate identity.
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id)) throw new Error("Invalid draft session identity");
		const date = this.now();
		const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		// The directory must exist before pi starts, so intent naming runs here, not after the first reply.
		// A model failure/timeout/empty answer must never block the chat: fall back to the first message.
		let leaf = intentLeaf(firstPrompt ?? entry.title);
		if (firstPrompt?.trim() && this.generateIntent) {
			try {
				const generated = await this.generateIntent(firstPrompt, entry);
				const generatedLeaf = generated ? intentLeaf(generated, 20) : "";
				if (generatedLeaf && generatedLeaf !== "chat") leaf = generatedLeaf;
			} catch {
				// Best effort only; the raw first message is still a stable, readable fallback.
			}
		}
		const workspacePath = join(resolve(project.path), day, `${leaf}--${entry.id}`);
		await mkdir(workspacePath, { recursive: true });
		return this.catalog.bindWorkspacePath(entry.id, workspacePath);
	}
}
