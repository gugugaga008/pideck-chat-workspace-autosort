import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createChatWorkspaceIntentGenerator, CHAT_WORKSPACE_INTENT_SYSTEM_PROMPT } = loadTsCommonJs("src/main/sessions/chatWorkspaceIntent.ts");

function completer(handler) {
	return {
		calls: [],
		cancelled: 0,
		enhance(input, callbacks) {
			this.calls.push(input);
			return handler(input, callbacks, this);
		},
		cancel() {
			this.cancelled += 1;
		},
	};
}

test("uses a cleaned one-line intent and sends the bounded first message", async () => {
	const fake = completer((_input, callbacks) => {
		setTimeout(() => callbacks.onDone("目录名：WSL 内存占用排查。\n多余说明"), 1);
		return Promise.resolve({ ok: true, runId: "r1" });
	});
	const generator = createChatWorkspaceIntentGenerator({ completer: () => fake, resolveModel: () => ({ provider: "p", modelId: "m" }), timeoutMs: 100 });
	assert.equal(await generator("看一下我当前的wsl什么东西内存占用大", {}), "WSL 内存占用排查。");
	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0].systemPrompt, CHAT_WORKSPACE_INTENT_SYSTEM_PROMPT);
	assert.match(fake.calls[0].userText, /wsl/);
});

test("accepts a quoted short name without the surrounding quotes", async () => {
	const fake = completer((_input, callbacks) => {
		callbacks.onDone("“番茄钟网页”");
		return Promise.resolve({ ok: true, runId: "r1" });
	});
	const generator = createChatWorkspaceIntentGenerator({ completer: () => fake, resolveModel: () => ({ provider: "p", modelId: "m" }) });
	assert.equal(await generator("帮我做一个番茄钟网页", {}), "番茄钟网页");
});

test("falls back on empty output, model errors, rejected requests, and a synchronous throw", async () => {
	const empty = completer((_input, callbacks) => {
		callbacks.onDone("   \n");
		return Promise.resolve({ ok: true, runId: "r1" });
	});
	const error = completer((_input, callbacks) => {
		callbacks.onError("model-error", "nope");
		return Promise.resolve({ ok: true, runId: "r1" });
	});
	const rejected = completer(() => Promise.resolve({ ok: false, errorKind: "sdk-unavailable", message: "no helper" }));
	const thrown = completer(() => {
		throw new Error("spawn failed");
	});
	for (const fake of [empty, error, rejected, thrown]) {
		const generator = createChatWorkspaceIntentGenerator({ completer: () => fake, resolveModel: () => ({ provider: "p", modelId: "m" }) });
		assert.equal(await generator("原始消息", {}), undefined);
	}
});

test("times out and cancels without blocking the caller", async () => {
	const fake = completer(() => new Promise(() => undefined));
	const generator = createChatWorkspaceIntentGenerator({ completer: () => fake, resolveModel: () => ({ provider: "p", modelId: "m" }), timeoutMs: 20 });
	const started = Date.now();
	assert.equal(await generator("原始消息", {}), undefined);
	assert(fake.cancelled >= 1);
	assert(Date.now() - started < 1000);
});

test("does not overlap concurrent naming attempts", async () => {
	let release;
	const fake = completer(
		(_input, callbacks) =>
			new Promise((resolve) => {
				release = () => {
					callbacks.onDone("第一个");
					resolve({ ok: true, runId: "r1" });
				};
			}),
	);
	const generator = createChatWorkspaceIntentGenerator({ completer: () => fake, resolveModel: () => ({ provider: "p", modelId: "m" }) });
	const first = generator("第一条", {});
	assert.equal(await generator("第二条", {}), undefined);
	assert.equal(fake.calls.length, 1);
	release();
	assert.equal(await first, "第一个");
});

test("skips naming without a usable model or prompt", async () => {
	const fake = completer((_input, callbacks) => {
		callbacks.onDone("不应该出现");
		return Promise.resolve({ ok: true, runId: "r1" });
	});
	const noModel = createChatWorkspaceIntentGenerator({ completer: () => fake, resolveModel: () => undefined });
	assert.equal(await noModel("消息", {}), undefined);
	const noPrompt = createChatWorkspaceIntentGenerator({ completer: () => fake, resolveModel: () => ({ provider: "p", modelId: "m" }) });
	assert.equal(await noPrompt("   ", {}), undefined);
	assert.equal(fake.calls.length, 0);
});
