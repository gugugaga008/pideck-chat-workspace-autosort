/* Static panel: the main process owns both persistence and directory allocation. */
const copy = {
	"zh-CN": {
		eyebrow: "PiDeck · 聊天目录", title: "让新聊天各归其位", description: "管理新聊天目录的自动分类开关。设置保存在宿主主进程，关闭面板后仍会自动生效。",
		toggle: "自动分类新聊天目录", refresh: "刷新设置", root: "固定聊天根目录", unknownRoot: "由宿主主进程管理",
		layout: "根目录保持不变，在其下按 date / intent--id 分类（日期 / 意图--会话标识）。",
		timing: "只对新会话生效；旧会话不会移动。关闭开关后，新会话恢复宿主原有目录规则。",
		loading: "正在读取宿主设置…", saving: "正在保存…", on: "已启用，新会话将自动分类。", off: "已关闭，新会话使用宿主原有目录规则。",
		missing: "需安装宿主适配：当前 PiDeck 没有聊天目录设置 API。", unsupported: "当前宿主不支持聊天目录自动分类，需安装支持此能力的宿主适配。", error: "设置操作失败：",
	},
	"en-US": {
		eyebrow: "PiDeck · Chat directories", title: "A place for every new chat", description: "Control automatic organization of new chat directories. The main process saves and applies this setting even when the panel is closed.",
		toggle: "Automatically organize new chat directories", refresh: "Refresh settings", root: "Fixed chat root", unknownRoot: "Managed by the host main process",
		layout: "The root stays unchanged. New directories follow date / intent--id (date / intent--session identifier).",
		timing: "Applies to new sessions only; existing sessions stay in place. Turning it off restores the host's original directory rules for new sessions.",
		loading: "Reading host settings…", saving: "Saving…", on: "Enabled. New sessions will be organized automatically.", off: "Disabled. New sessions follow the host's original directory rules.",
		missing: "Install a host adapter: this PiDeck has no chat directory settings API.", unsupported: "This host does not support automatic chat directory organization. Install a host adapter with this capability.", error: "Settings operation failed: ",
	},
};
const nodes = Object.fromEntries(["eyebrow", "title", "description", "toggle-label", "enabled", "status", "refresh", "root-label", "root", "layout", "timing"].map((id) => [id, document.getElementById(id)]));
let text = copy["zh-CN"];
let settings;
let busy = false;
let available = false;
let failure = "";
let phase = "loading";
const api = window.pideck?.chatWorkspace;

function render() {
	for (const key of ["eyebrow", "title", "description", "layout", "timing"]) nodes[key].textContent = text[key];
	nodes["toggle-label"].textContent = text.toggle;
	nodes["root-label"].textContent = text.root;
	nodes.refresh.textContent = text.refresh;
	nodes.root.textContent = settings?.rootPath || text.unknownRoot;
	const supported = available && settings?.supported !== false && typeof settings?.enabled === "boolean";
	nodes.enabled.checked = supported && settings.enabled;
	nodes.enabled.disabled = busy || !supported;
	nodes.refresh.disabled = busy || !available;
	nodes.status.textContent = !available ? text.missing : busy ? text[phase] : failure ? text.error + failure : !supported ? text.unsupported : settings.enabled ? text.on : text.off;
}

async function refresh() {
	busy = true;
	phase = "loading";
	failure = "";
	render();
	try {
		settings = await api.getSettings();
	} catch (error) {
		settings = undefined;
		failure = String(error?.message || error);
	} finally {
		busy = false;
		render();
	}
}

nodes.refresh.addEventListener("click", refresh);
nodes.enabled.addEventListener("change", async () => {
	if (busy || !available || !settings || settings.supported === false) return;
	const enabled = nodes.enabled.checked;
	busy = true;
	phase = "saving";
	failure = "";
	render();
	try {
		settings = await api.updateSettings({ enabled });
	} catch (error) {
		// Refresh host truth after a failed write; never display an optimistic enabled state.
		try { settings = await api.getSettings(); } catch { settings = undefined; }
		failure = String(error?.message || error);
	} finally {
		busy = false;
		render();
	}
});

async function main() {
	available = typeof api?.getSettings === "function" && typeof api?.updateSettings === "function";
	function contextChanged(context) {
		text = copy[context.locale] || copy["zh-CN"];
		document.documentElement.lang = context.locale;
		document.documentElement.dataset.theme = context.theme;
		render();
	}
	if (window.pideck?.context?.get) {
		try { contextChanged(await window.pideck.context.get()); } catch { /* The settings API can still report its own support state. */ }
	}
	if (window.pideck?.onEvent) {
		const unsubscribe = window.pideck.onEvent((event) => {
			if (event.type === "context.changed") contextChanged(event.context);
		});
		window.addEventListener("pagehide", unsubscribe, { once: true });
	}
	render();
	if (available) await refresh();
}
main().catch((error) => { busy = false; failure = String(error?.message || error); render(); });
