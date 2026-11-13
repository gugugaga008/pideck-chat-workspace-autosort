/** Optional scaffold demo for the host-owned boolean setting; no paths or session operations. */
import type { HostPluginScaffoldInput } from "../../shared/types/hostPlugin";

export function scaffoldChatWorkspaceDemo(input: HostPluginScaffoldInput): { html: string; code: string; wiring: string } {
	if (!input.permissions.includes("chatWorkspace.manage")) return { html: "", code: "", wiring: "" };
	return {
		html: '      <section class="detail"><label><input id="chat-workspace-enabled" type="checkbox" disabled /><span id="chat-workspace-label"></span></label><p id="chat-workspace-status" role="status"></p></section>\n',
		code: `/** Only adapted hosts support this setting. Never simulate success with plugin storage. */
async function initChatWorkspace() {
  const enabled = document.getElementById("chat-workspace-enabled");
  const status = document.getElementById("chat-workspace-status");
  const english = document.documentElement.lang === "en-US";
  document.getElementById("chat-workspace-label").textContent = english ? "Automatically organize new chat directories" : "自动分类新聊天目录";
  const unavailable = english ? "Install a host build with chatWorkspace support." : "需安装支持 chatWorkspace 的宿主适配。";
  const note = english ? "The root stays fixed. New sessions use date/intent--id; existing sessions stay in place. The host applies this setting even when this panel is closed." : "根目录不变，新会话使用 date/intent--id，旧会话不移动；关闭面板后主进程仍按设置运行。";
  if (!pideck.chatWorkspace || typeof pideck.chatWorkspace.getSettings !== "function" || typeof pideck.chatWorkspace.updateSettings !== "function") {
    status.textContent = unavailable;
    return;
  }
  function show(settings) {
    const supported = settings.supported !== false;
    enabled.checked = supported && settings.enabled === true;
    enabled.disabled = !supported;
    status.textContent = supported ? note : unavailable;
  }
  show(await pideck.chatWorkspace.getSettings());
  enabled.addEventListener("change", async () => {
    const next = enabled.checked;
    enabled.disabled = true;
    try {
      show(await pideck.chatWorkspace.updateSettings({ enabled: next }));
    } catch (error) {
      // A failed write may have an unknown outcome: refresh host truth before allowing another edit.
      enabled.checked = false;
      try { show(await pideck.chatWorkspace.getSettings()); } catch { enabled.disabled = true; }
      status.textContent = String(error && error.message ? error.message : error);
    }
  });
}

`,
		wiring: "  await initChatWorkspace();\n",
	};
}
