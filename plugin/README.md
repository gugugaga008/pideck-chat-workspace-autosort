# 聊天目录自动分类 / Chat workspace autosort

纯静态宿主插件，无 npm、构建器、服务端或网络请求。只声明 `chatWorkspace.manage`，只通过 `window.pideck.chatWorkspace` 读取设置和修改 `{ enabled: boolean }`。

## 安装

1. 使用实现聊天目录适配的定制 PiDeck；普通上游版本不保证提供此能力。
2. 在设置 → PiDeck 插件 → 从文件夹安装，选择本目录（含 `pideck-plugin.json` 的这一层）。
3. 核对权限，授权并启用；打开“聊天目录自动分类”面板，读取宿主当前状态后切换开关。
4. 修改本目录后重新安装并重新授权；修改安装目录后重新扫描并重新授权。授权绑定整包内容指纹。

本包只控制开关，根目录由宿主原有聊天根提供，插件不可修改。启用后新会话在固定根下使用 `date/intent--id`（日期 / 意图--会话标识）。仅新会话生效，旧会话不会移动、重命名或重写；关闭后新会话恢复原有规则。

设置持久化在主进程。关闭插件面板、重启应用后仍按已保存开关工作；插件面板不负责创建目录，也不需要保持打开。禁用/卸载插件不会反向修改已保存设置，需要关闭分类时先关开关。

API 缺失时显示“需安装宿主适配”；`supported: false` 时禁止切换，不以插件私有存储模拟成功。写入失败会重新读取宿主状态，无法读取时禁止继续切换。根目录只展示，不作为输入传回宿主。

## API

```js
const settings = await window.pideck.chatWorkspace.getSettings();
// { enabled: boolean, rootPath?: string, supported?: boolean }
const saved = await window.pideck.chatWorkspace.updateSettings({ enabled: true });
```

无任意路径、文件读写、会话修改、执行命令或直接网络能力。所有权限仍由 sender-bound broker 校验；撤权时，主进程在正式写入前再次检查授权。

## English

Install this folder through Settings → PiDeck plugins → Install from folder, then grant its single `chatWorkspace.manage` permission. Requires a custom PiDeck host with the chat workspace adapter; an unmodified upstream host may reject the permission or lack the API.

The host keeps the original chat root and organizes **new sessions only** as `date/intent--id`. Existing sessions remain in place. The main process persists and applies the switch without opening this panel, including after restart. Disable the switch before uninstalling if you want to stop organizing future chats. Missing APIs or `supported: false` are shown as unsupported and never simulated using plugin storage.
