# PiDeck 聊天工作目录自动分类 1.1.0

本目录是 PiDeck v0.12.0 的本机定制工程，发布版本为 **1.1.0**。目标只有一个：

> 原有聊天根目录不变；新建的本机 pi 聊天在根目录下按“日期 / 意图--会话 ID”自动创建独立子目录，旧会话不迁移。

```text
C:\Users\MSI-1\AppData\Roaming\PiDeck\chat-workspace\
├─ 原有文件……                        保持原位置，不移动
└─ 2026-11-13\
   ├─ 番茄钟网页--a2d86b46-…\    新聊天 A 的真实工作目录
   └─ 记账图标--6966b409-…\      新聊天 B 的真实工作目录
```

聊天文字记录仍由 pi 保存在原来的会话存储中；这里改变的是每个会话启动 agent 时的工作目录，以及文件树、相对文件链接、终端的工作位置。PiDeck 不会改写 pi 正在使用的聊天 JSONL。

## 当前支持范围

| 项目 | 状态 |
|---|---|
| 内置「聊天」项目 | 支持 |
| 本机 Windows、native 环境 | 支持 |
| pi 后端的新草稿 | 支持 |
| 旧会话、已激活会话、导入会话 | 不迁移，继续原行为 |
| DSH、ACP、生图、生视频 | 不改变 |
| SSH / 远端会话 | 不改变 |
| 聊天记录存储位置 | 不改变（仍由 pi 管理） |

功能默认关闭。安装宿主补丁后，还需要安装并授权设置插件，再在插件面板里打开开关；关闭面板后设置仍然生效。

版本说明：包目录和 `manifest.json` 的 `releaseVersion` 表示本工具发布版本（1.1.0）；`manifest.json` 的 `version` 仍表示兼容的 PiDeck 版本（0.12.0）。两者不要混淆。插件目录版本仍是 1.0.0（本次只改宿主补丁，插件代码未变），不需要重新安装或授权。

## 行为规则

1. 新聊天第一次发送消息时，先请一次模型生成简短意图，再创建：
   `<聊天根>\<YYYY-MM-DD>\<意图>--<会话稳定 ID>\`
2. 意图优先使用模型返回的短名称（如“WSL 内存占用排查”）；模型不可用、超时（6 秒）、返回空或未配置模型时，自动回退到首条消息原文。两种来源都会清理路径分隔符、控制字符和不可用字符；模型名称最多 20 个字符，原文最多 32 个字符，为空时使用 `chat`。
3. 目录一旦绑定就固定：改标题、跨天继续聊、重启应用、关闭再打开开关，都不会重命名或迁移。
4. 如果在发送消息前就手动激活了草稿，会先用会话标题分配目录；之后的首次消息不会改目录名。
5. 旧会话（`active`、已有会话文件、导入、DSH/ACP、远端）保持原目录。
6. 关闭开关只影响之后的新会话；已绑定会话继续使用原子目录。
7. 复制 / fork 会话会继承源会话的工作目录。
8. 文件树和文件名搜索按当前会话的工作目录读取；聊天子目录里的内容索引搜索首版不启用，退化为文件名搜索，避免跨会话索引。
9. 聊天子目录不会被自动登记成侧栏项目。

## 安装步骤

当前 PiDeck 正在运行时不能替换 `app.asar`。安装脚本会等待你退出，不会强制结束进程。

### 0. 前置

- Node.js 22+
- 已关闭 PiDeck 的自动更新流程（避免安装过程中被更新覆盖）
- 在 **外部 Windows PowerShell** 中执行，不要用 PiDeck 内置终端（PiDeck 退出时可能把它一起结束）

### 1. 安装宿主补丁（等待退出后自动执行）

在资源管理器中进入本目录，右键 `Install-After-Exit.ps1` → “使用 PowerShell 运行”，或在外部 PowerShell 执行：

```powershell
Set-Location E:/tools/pideck-chat-workspace-autosort
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-After-Exit.ps1
```

脚本行为：

- 检查目标 PiDeck 是否在运行；
- 如果在运行，提示后等待你完全退出；
- 二次确认后执行安装；
- 安装后复核状态必须是 `patched`；
- 不会删除聊天数据、设置或插件文件；
- 不会调用 `Stop-Process` / `taskkill`。

原始 `app.asar` 会备份到 `backups/<原 SHA256>.asar`，不会覆盖已有备份。

如果当前安装的是上一版已验证补丁（`previous-patch`），安装脚本可以直接升级，不需要先恢复原版；上一版补丁的哈希在 `maintenance.mjs` 的 `VERIFIED_PATCHES` 中独立核验并保留，同时上一版归档也会备份。旧补丁包保留在 `packages/chat-workspace-1.0.0/`，仅用于回退或审计。

### 2. 启动 PiDeck

安装成功后可以直接用官方图标启动；也可以使用带检查的启动器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:/tools/pideck-chat-workspace-autosort/Start-PiDeck.ps1
```

`Start-PiDeck.ps1` 会先检查版本、原版/补丁哈希和 EXE 的 ASAR fuse：

- `patched`：正常启动；
- `clean`、未知版本、未知哈希：明确提示“自动分类不会生效”，但仍允许以当前安装的程序启动，不会把 PiDeck 锁在无法启动的状态；
- 检查失败：提示后由你决定是否启动，不自动修改文件。

普通 PiDeck 快捷方式会跳过这项检查；两种入口都能启动补丁后的程序。

### 3. 安装设置插件

打开 PiDeck：

1. 设置 → PiDeck 插件 → “从文件夹安装…”；
2. 选择 `E:\tools\pideck-chat-workspace-autosort\plugin`；
3. 查看权限并授权启用，权限应为 `chatWorkspace.manage`；
4. 打开插件面板，启用“自动分类新聊天目录”。

插件只负责读取状态和切换开关；目录分配在主进程完成，面板关闭也不会停用。

### 4. 验证

新建一个聊天，发送例如：

```text
帮我做一个番茄钟网页
```

然后检查：

```text
C:\Users\MSI-1\AppData\Roaming\PiDeck\chat-workspace\2026-11-13\番茄钟网页--<会话ID>\
```

如果模型命名不可用，目录会回退为首条消息清洗后的名称，例如：

```text
C:\Users\MSI-1\AppData\Roaming\PiDeck\chat-workspace\2026-11-13\帮我做一个番茄钟网页--<会话ID>\
```

再开第二个聊天写同名文件，两者应互不覆盖。修改聊天标题、跨天继续聊、重启 PiDeck 后，目录应保持不变。

## PiDeck 更新之后

官方更新会替换 `app.asar`，本机补丁随之消失。这是预期行为，**不会自动把旧补丁写回新版本**。

- 用 `Start-PiDeck.ps1` 启动时，新版本会显示 `unknown-version` 警告，但允许以原版启动；
- 新聊天暂时不会自动分类；
- 原有聊天记录、聊天子目录、设置、插件文件和备份都保留；
- 想恢复功能，需要针对新版本重新核验基线、适配源码、跑测试、重建补丁并安装。

重新适配时不要直接把未知哈希登记为可信：`maintenance.mjs` 中的 allowlist 必须独立核验后修改。仅编辑 `verified-bases.json` 不会放宽 allowlist。

## 恢复原版

在外部 PowerShell 运行：

```powershell
Set-Location E:/tools/pideck-chat-workspace-autosort
powershell -NoProfile -ExecutionPolicy Bypass -File .\Restore-After-Exit.ps1
```

脚本等待 PiDeck 退出后，从已验证备份恢复原版 `app.asar`，并复核为 `clean`。当前安装的是上一版补丁（`previous-patch`）时也能直接恢复，因为新包的 manifest 保留了上一版哈希；不需要先找旧包。它不会删除：

- 聊天记录；
- 已经生成的聊天子目录和文件；
- 设置；
- 插件目录和授权；
- 备份。

恢复后：

- 新聊天回到原来的共享工作目录；
- 已绑定的历史会话记录仍在 catalog 中，但原版 PiDeck 不使用 `workspacePath`，运行时会回到项目根目录；
- 设置插件会显示宿主不支持，可以保留待下次补丁，或在插件管理中卸载。

## 维护者：源码与重建

### 目录

```text
PiDeck/                     v0.12.0 源码（含本功能改动）
plugin/                     宿主插件设置面板
packages/chat-workspace-1.1.0/      当前候选 app.asar + manifest
packages/chat-workspace-1.0.0/      上一版已验证补丁（回退/审计用）
PiDeck.commit             当前 PiDeck 源码分支/提交/标签
.gitignore                 排除大文件、日志和隔离测试副本
backups/                    原版归档备份（安装后生成）
verification/               隔离程序副本与 smoke 证据
maintenance.mjs             ASAR 检查/备份/安装/恢复核心
cli.mjs                     命令行入口
build-patch.mjs             本项目可复现的打包入口
prepare-base.mjs            把原版备份 + 当前 unpacked 铺到 verification/base
source-validation.txt       本次测试/构建证据
target.json                 本机 exe 与补丁包路径
```

### 测试与构建

```powershell
Set-Location E:/tools/pideck-chat-workspace-autosort/PiDeck
npm run typecheck
node --test tests/chatWorkspace*.test.mjs tests/hostPluginChatWorkspace.test.mjs tests/hostPlugins.test.mjs tests/hostPluginScaffold.test.mjs tests/hostPluginNetworkUi.test.mjs tests/docsSharedGuide.test.mjs tests/workspaceDirectoryUi.test.mjs tests/sessionRecordIdentity.test.mjs tests/projectServicesHook.test.mjs tests/filesListTarget.test.mjs tests/sessionRuntimeCoordinator.test.mjs tests/agentSessionReplacement.test.mjs tests/sessionCatalogRowsRemoved.test.mjs tests/sessionCatalogActivityTime.test.mjs

node node_modules/electron-vite/bin/electron-vite.js build
```

然后回到本目录重建候选包（输出目录必须不存在；已安装补丁时，先用备份铺出原版基线和 unpacked）：

```powershell
Set-Location E:/tools/pideck-chat-workspace-autosort
node .\prepare-base.mjs
node .\build-patch.mjs
```

`prepare-base.mjs` 只读取 `backups/<原版哈希>.asar` 和当前安装的 `resources/app.asar.unpacked`，写入 `verification/base/`，不修改真实安装。`build-patch.mjs` 默认优先使用这个 staging 基线；也可以显式传 `--base-asar`。

`build-patch.mjs` 的策略：

- 保留安装包中所有 unpacked 文件（包括 DSH 的 `out/main/hostEntry.js`）；
- 覆盖构建出的 packed main 文件；
- 完整覆盖 preload 和 renderer 组件，保证 hash 资源名一致；
- 由 `maintenance.mjs` 重新核对基线版本、基线 SHA256、ASAR 文件/块 integrity 和 EXE fuse；
- 输出 `app.asar` 与 `manifest.json`。

### 只读检查命令

```powershell
node .\cli.mjs status --exe "D:/Users/MSI-1/AppData/Local/Programs/PiDeck/PiDeck.exe" --package "E:/tools/pideck-chat-workspace-autosort/packages/chat-workspace-1.1.0"
node .\cli.mjs verify-base --base-asar "D:/Users/MSI-1/AppData/Local/Programs/PiDeck/resources/app.asar"
node .\cli.mjs inspect-exe --exe "D:/Users/MSI-1/AppData/Local/Programs/PiDeck/PiDeck.exe"
```

## Git 管理

本工程使用两个仓库：

| 仓库 | 范围 | 当前提交 |
|---|---|---|
| `PiDeck/` | PiDeck 上游 `0.12.0` + 本功能源码；保留上游历史 | 分支 `local/chat-workspace-1.1.0`，标签 `workspace-autosort-1.1.0` |
| 本目录 | 安装/检查/恢复工具、插件、文档、测试、包 manifest | 根仓库 `v1.1.0` |

`PiDeck.commit` 记录源码提交号，根仓库通过它关联对应的 PiDeck 提交。`app.asar`、`backups/`、`verification/app/`、隔离测试 profile、日志和依赖目录都不入库，避免把 100 MB 级二进制或本机运行数据写进历史。包 manifest 会入库，`app.asar` 需要时用 `prepare-base.mjs` + `build-patch.mjs` 重建。

> 注意：`PiDeck/`、`backups/`、`verification/app/` 等是 **ignored** 目录，不是已跟踪内容。不要在本目录运行 `git clean -xdf`，否则会删除源码副本、恢复备份和隔离测试程序。`target.json` 记录本机绝对路径；换机器或换安装位置时先修改它。

在 PiDeck 源码仓库查看改动：

```powershell
cd E:/tools/pideck-chat-workspace-autosort/PiDeck
git status
git log --oneline --decorate -5
git diff v0.12.0..workspace-autosort-1.1.0 --stat
```

在本目录查看工具改动：

```powershell
cd E:/tools/pideck-chat-workspace-autosort
git status
git log --oneline --decorate -5
```

如果以后重新克隆本目录，先克隆 PiDeck 上游到 `PiDeck/`，再检出 `PiDeck.commit` 里的提交和标签；`app.asar` 不在 git 中，需要按“测试与构建”重新生成。

## 已验证证据

- 源码版本：PiDeck v0.12.0（`cf57f7f0012f7a30431ac6164802eb1e08bab843`）
- 原版 `app.asar` SHA256：`e820040621072d30c22c55c376298d17f0fdb9279ef5bfe813ea31eba7a99db3`
- 候选补丁 SHA256：`2331c2ecb3765d4568877a858e457958c82ccc466fa0b0294bc8daa416432de1`
- 上一版已验证补丁 SHA256：`24edec508aa8adf3c7609b5c987ed8db34ee321320232eed95e630bf8163e94b`（保留在 `packages/chat-workspace-1.0.0/`）
- 原版归档核验：4417 个文件，其中 10 个 unpacked，文件与 block integrity 全部通过
- EXE fuse：embedded ASAR integrity 与 only-load-ASAR 均为 DISABLE（未修改 EXE）
- 全仓 TypeScript 检查：通过
- 针对性测试：218 通过，0 失败
- 维护工具 fixture 测试：8 通过，0 失败（含从上一版已验证补丁直接升级、再恢复原版）
- 隔离完整程序 smoke：通过
  - 两个新聊天得到不同子目录
  - 目录名来自一次模型补全的短意图（“番茄钟网页”“记账图标”），不是首条消息回退
  - pi 会话头 cwd 等于绑定目录
  - 同名文件互不覆盖
  - 文件树/文件名搜索读取当前会话目录
  - 聊天子目录未变成侧栏项目
  - 重启并重新激活后绑定不变
  - 证据：`verification/smoke-result.json`、`verification/smoke-ai.log`

本次 smoke 使用的是复制出来的完整程序目录 + 临时用户配置 + mock pi + 确定性的假补全 sidecar，没有修改真实安装目录，也没有调用真实模型。真实模型的首次冷启动耗时、长对话、DSH/ACP/远端、真实自动更新流程和多窗口并发仍未验证。

## 已知限制

- 仅 Windows、本机 native、内置聊天项目、pi 后端；其他后端和远端保持原样。
- 目录名来自首条消息的模型短意图；首条消息前手动激活会改用标题，且之后不重命名。
- 模型命名是尽力而为：未配置模型、sidecar 冷启动超过 6 秒、供应商报错或返回空时，会静默回退到首条消息原文（最多 32 字符），不会阻塞发送。
- 命名会把首条消息发给辅助模型：优先使用设置里的“提示词增强模型”，没有配置时跟随会话模型；只发送截断后的首条消息，不发送工具结果或会话文件。
- 聊天日志仍在 pi 的会话目录，不在聊天工作子目录里；这是刻意保留的原机制。
- 修改 PiDeck 的聊天根目录不会迁移已绑定会话；旧绑定继续使用原根，新会话使用新根。
- 如果手动删除已绑定目录，下次激活会重新创建；如果该路径被同名文件占用，激活会失败，不会静默退回共享根目录。
- 插件面板只是设置入口；主进程未装配端口时，插件会显示“不支持”，不会假装启用。
- 这是本机补丁，不是官方功能。升级后需要重新适配；不承诺所有未来版本零维护。
- 安装器依赖 EXE fuse 检查；若未来版本启用 embedded ASAR integrity / only-load-ASAR，安装会拒绝，需要另行审阅运行方式。
- 本项目不自动提交、不自动发布、不自动修改未知版本。
