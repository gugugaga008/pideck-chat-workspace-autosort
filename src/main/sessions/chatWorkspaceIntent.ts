/**
 * One-shot intent naming for chat workspace directories.
 *
 * The directory must exist before pi starts, so this deliberately runs before
 * activation. It is fail-open: any model/boot/timeout/empty-output problem
 * returns undefined and the caller falls back to the sanitized first message.
 */
import { clearTimeout, setTimeout } from "node:timers";
import type { SessionCatalogEntry } from "./SessionCatalog";

export type ChatWorkspaceIntentModel = { provider: string; modelId: string };
export type ChatWorkspaceIntentEntry = SessionCatalogEntry;

export type ChatWorkspaceIntentCompleter = {
	enhance(
		input: { provider: string; modelId: string; userText: string; systemPrompt: string },
		callbacks: {
			onDelta: (text: string) => void;
			onDone: (text: string) => void;
			onAborted: () => void;
			onError: (errorKind: string, message: string) => void;
		},
	): Promise<{ ok: true; runId: string } | { ok: false; errorKind: string; message: string }>;
	/** Cancels the active/queued run; this generator never overlaps two requests. */
	cancel(): void;
};

export const CHAT_WORKSPACE_INTENT_SYSTEM_PROMPT = `你为一段聊天任务生成一个简短、可读的目录名。
只输出目录名本身，不要解释、不要引号、不要标点、不要表情、不要路径分隔符。
尽量控制在 2-16 个字符；保留关键技术词（如 WSL、SVG、CLI、API）；去掉“帮我、请、看一下我当前的、我想”等口语前缀；使用与用户消息相同的语言。
如果用户消息本身已经是简短任务名，可轻度润色，不要扩写。`;

const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_PROMPT_CHARS = 2_000;

function cleanModelLine(text: string): string | undefined {
	const line = text.trim().split(/\r?\n/, 1)[0]?.trim();
	if (!line) return undefined;
	return (
		line
			.replace(/^(目录名|任务名|名称)\s*[:：]\s*/u, "")
			.replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
			.trim() || undefined
	);
}

export function createChatWorkspaceIntentGenerator(options: {
	completer: () => ChatWorkspaceIntentCompleter | null;
	resolveModel: (entry: ChatWorkspaceIntentEntry) => ChatWorkspaceIntentModel | undefined;
	logger?: { info?: (message: string, detail?: unknown) => unknown; warn?: (message: string, detail?: unknown) => unknown };
	timeoutMs?: number;
}): (prompt: string, entry: ChatWorkspaceIntentEntry) => Promise<string | undefined> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let busy = false;
	return async (prompt, entry) => {
		if (busy) return undefined;
		const completer = options.completer();
		if (!completer) return undefined;
		const model = options.resolveModel(entry);
		if (!model) return undefined;
		const userText = prompt.trim().slice(0, MAX_PROMPT_CHARS);
		if (!userText) return undefined;

		busy = true;
		return await new Promise<string | undefined>((resolve) => {
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				busy = false;
				resolve(value);
			};
			const timer = setTimeout(() => {
				try {
					completer.cancel();
				} catch {
					// Cancellation is best effort; the run callbacks are still guarded by settled.
				}
				options.logger?.warn?.("Chat workspace intent naming timed out; using first message", { timeoutMs });
				finish(undefined);
			}, timeoutMs);
			try {
				void completer
					.enhance(
						{ provider: model.provider, modelId: model.modelId, userText, systemPrompt: CHAT_WORKSPACE_INTENT_SYSTEM_PROMPT },
						{
							onDelta: () => undefined,
							onDone: (text) => {
								const cleaned = cleanModelLine(text);
								if (cleaned) options.logger?.info?.("Chat workspace intent named", { name: cleaned });
								finish(cleaned);
							},
							onAborted: () => finish(undefined),
							onError: (errorKind, message) => {
								options.logger?.warn?.("Chat workspace intent naming failed; using first message", { errorKind, message });
								finish(undefined);
							},
						},
					)
					.then((accepted) => {
						if (!accepted.ok) {
							options.logger?.warn?.("Chat workspace intent naming was not accepted; using first message", {
								errorKind: accepted.errorKind,
								message: accepted.message,
							});
							finish(undefined);
						}
					})
					.catch((error: unknown) => {
						options.logger?.warn?.("Chat workspace intent naming crashed; using first message", {
							error: error instanceof Error ? error.message : String(error),
						});
						finish(undefined);
					});
			} catch (error) {
				options.logger?.warn?.("Chat workspace intent naming threw synchronously; using first message", {
					error: error instanceof Error ? error.message : String(error),
				});
				finish(undefined);
			}
		});
	};
}
