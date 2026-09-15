# vMix Workbench MCP

让 Agent 通过 MCP 检查 vMix、导入素材、搭建多层画面、修改字幕、配置原生转场，并创建可运行的托管触发器。

**V0.1：独立依据 vMix 官方 API 实现。已通过模拟 vMix 与真实 MCP stdio 客户端测试；真实 Windows/vMix 画面验收仍待完成。**

## 能做什么

- 检查工程：输入 GUID、名字、字幕文字/图片字段、图层、Preview、Program、叠加层。
- 素材暂存和导入：本机文件复制、SHA-256 校验、Windows 共享目录映射；导入视频、图片、GT 标题、音频和色板。
- 搭画面：全屏、双画面、四宫格、画中画模板，或最多 10 层的自定义矩形与裁切。
- 图文与播放：批量更新字幕、替换图片、叠加层显隐、播放/暂停/循环、音量与静音。
- 原生转场设置：四个转场按钮的效果与时长；GT Stinger 1–8 动画源绑定；保存常用 MCP 转场预设并执行。
- 托管触发器：观察节目/叠加状态变化、播放暂停或时间跨越，按顺序执行动作；支持保存、启用、停用和取消延迟动作。
- 基本回放命令：标记最近 N 秒、指定 A/B 通道播放/暂停、0–1 慢放速度。

### 两个区别

1. **托管触发器运行在 MCP 进程中，不会写入 vMix 原生 Triggers 列表。** 进程关闭即停止；重启后定义保留，但全部未启用。250ms 默认轮询不能保证帧级触发，也可能错过两次读取之间的短暂事件。
2. **导入路径不等于上传文件。** 同机部署可以直接读本机素材；Mac 远控 Windows 时，要配置已挂载的共享目录，或先把素材复制到 Windows 再导入。

普通视频/图片序列 Stinger 的原生动画源、切点，以及原生触发器列表编辑没有在此实现中假定存在 API。`vmix_native_setup_guide` 会输出具体设置步骤，明确 `applied:false`。GT Stinger 的时间来自 GT 动画本身。

## 安装

需要 Node.js 22 或以上。vMix API 基线为官方 v29 文档；实际版本的支持情况要通过目标工程确认。

```sh
git clone https://github.com/chendpoc/vmix-workbench-mcp.git
cd vmix-workbench-mcp
npm ci --ignore-scripts
npm run build
```

在 vMix 的 Settings → Web 中启用 Web Controller，确认本机能访问其 `/api/` 并返回 vMix XML。首次接入建议设置 `VMIX_READ_ONLY=true`，先调用 `vmix_inspect` 核对工程，再设为 `false` 开启写操作。此项目不会改动现有客户端配置。

### Windows 本机运行（最简单）

把 [Windows 配置示例](examples/windows-client.json) 中的代码目录、素材目录改成真实路径，加入支持 `mcpServers` 的客户端。MCP 启动命令使用 `node .../build/index.js`，**不要使用 `npm start` 作为 stdio 客户端启动命令**，因为 npm 的输出可能混入协议流。

Codex CLI 可用下面的命令登记（路径请替换；`--env` 可重复）：

```powershell
codex mcp add vmix --env VMIX_API_URL=http://127.0.0.1:8088/api/ --env VMIX_DATA_DIR=C:\vMixMCP\state --env VMIX_ASSET_ROOT=C:\vMixMCP\assets -- node C:\tools\vmix-workbench-mcp\build\index.js
```

素材暂存默认只读取启动工作目录。使用 `vmix_asset_stage` 前，把 `VMIX_SOURCE_ROOTS` 设置为允许读取的素材目录 JSON 数组；完整可复制的转义写法见配置示例文件。

### Mac 通过局域网控制 Windows

使用 [Mac 配置示例](examples/mac-client.json)。例如：

- Windows 素材目录：`D:\vMixAssets`。
- 同一目录通过 SMB 挂载到 Mac：`/Volumes/vMixAssets`。
- `VMIX_ASSET_ROOT=/Volumes/vMixAssets`。
- `VMIX_VISIBLE_ASSET_ROOT=D:\vMixAssets`。

`vmix_asset_stage` 会把本机素材复制到共享目录，并返回 Windows 端的 `vmix_path`；随后将该路径交给 `vmix_input_add`。没有共享挂载时，仅填写 Windows 路径不会传输文件。

一个工程只运行一个有写权限的 MCP 实例。局域网访问 vMix 时按现有网络与 Web Controller 认证配置开放连接，不把控制 API 暴露到公网。

## 让 Agent 开始工作

可以直接告诉 Agent：

> 检查当前 vMix 工程，找到四路摄像机。以 3840×2160 的当前工程尺寸搭建四宫格，先展示 dry-run；确认输入名称后创建。把第一个转场按钮设为 500ms Fade，先留在预览，不要上屏。

> 把素材目录中的选手介绍图暂存后导入 vMix，告诉我新输入的 GUID。找到比分标题的实际字段，把比分改为 15 : 12，并查询结果。

> 创建一个托管触发器：主机位进入节目画面后，在 Overlay 1 显示比分。先保存为未启用，列出动作，然后按我的指令启用。

完整调用示例：[羽毛球工作流](examples/badminton-workflow.json)。所有名字必须替换为实际工程中的唯一名字，或使用 GUID。模板尺寸必须匹配当前 vMix 工程；工具不会自动修改输出分辨率。

## 工具列表

| 工具 | 用途 |
|---|---|
| `vmix_inspect` | 读取工程状态、输入身份及字段 |
| `vmix_operation_get` | 查询持久化操作结果 |
| `vmix_actions` | 有序执行经过校验的动作组合 |
| `vmix_title_update` | 按实际字段名批量更新字幕 |
| `vmix_asset_stage` | 暂存/校验素材，返回 vMix 可见路径 |
| `vmix_input_add` | 导入素材或创建色板，返回新 GUID |
| `vmix_scene_create` | 创建自定义多层画面 |
| `vmix_scene_template` | 创建 full / two_up / quad / pip 模板画面 |
| `vmix_transition_configure` | 设置原生转场按钮及 GT Stinger 绑定 |
| `vmix_transition_preset_save` | 保存 MCP 命名转场预设 |
| `vmix_transition` | 使用预设切到指定输入 |
| `vmix_trigger_save` | 保存未启用的托管触发器 |
| `vmix_trigger_arm` | 启用/停用，取消待执行延迟动作 |
| `vmix_trigger_delete` | 停用并删除托管定义 |
| `vmix_configuration` | 查看预设、触发器及运行状态 |
| `vmix_native_setup_guide` | 生成尚未自动应用的原生设置步骤 |

`vmix_actions` 中允许的动作：`preview`、`transition`、`overlay`、`text`、`image`、`playback`、`audio`、`layer`、`transition_button`、`stinger_gt`、`replay`、`wait`。不提供任意脚本、系统命令或无约束的 vMix Function 工具。

## 结果与恢复

每次实际控制请求都需要 `request_id`。重复提交同一 ID/参数返回原结果，重启也不重做；同一 ID/不同参数拒绝。`dry_run:true` 不占用 ID，可先预览再用同一 ID 执行。

- `completed`：计划步骤执行结束。逐步查看 `verification`；`state_observed` 与仅 `api_accepted` 有区别。
- `unconfirmed`：命令可能已经影响 vMix，但结果未可靠确认。检查 `vmix_inspect`、`vmix_operation_get` 和实际画面，不能换个 ID 盲目重试。
- `partial` / `failed`：查看已完成步骤与错误。工具不会为了回滚而自动删除已创建的输入。

创建输入只能通过前后状态差识别新 GUID。**搭建期间不要让另一个操作者同时新增输入。** 发现多个新输入或类型不符会停止；这个 API 没有提供创建事务标识，外部并发无法完全消除。

多字段字幕更新不是原子画面事务。图层位置、GT 动画是否正确、实际音频及 4K 性能须在 vMix 中监看。此 MCP 也不拥有官方比赛比分规则或自动判断精彩球。

## 配置

| 环境变量 | 默认值 / 说明 |
|---|---|
| `VMIX_API_URL` | `http://127.0.0.1:8088/api/`，固定控制目标 |
| `VMIX_READ_ONLY` | `false`；`true` 禁止写入，仍可 dry-run |
| `VMIX_TIMEOUT_MS` | `5000`，完整 HTTP 响应的期限 |
| `VMIX_POLL_MS` | `250`，托管触发器轮询间隔 |
| `VMIX_DATA_DIR` | 启动工作目录下 `.vmix-mcp`，配置与操作记录 |
| `VMIX_SOURCE_ROOTS` | 允许读取的素材目录 JSON 数组，默认启动目录 |
| `VMIX_ASSET_ROOT` | 数据目录下 `assets`，MCP 主机实际复制目标 |
| `VMIX_VISIBLE_ASSET_ROOT` | 默认同上；可映射为 Windows 可见目录 |
| `VMIX_API_USERNAME` / `VMIX_API_PASSWORD` | 可选 Basic Authorization；仅用于目标接受这种认证时 |

每个数据目录有进程锁。服务会回收已确认死亡的本机进程锁；活跃、未知或其他主机的锁不会自动删除。锁损坏或遗留 `recovery.lock` 时，先确认没有该目录的服务进程，再处理锁文件；不要删除 `state.json` 来“修复连接”，它保存重复请求记录与配置。正常关闭会释放锁。数据目录应位于本机磁盘，素材目录才使用共享挂载。

托管触发器默认每次启用只执行一次，最高可配置 100 次；重连只建立新观察基线，不补发历史事件。`playback_stopped` 包含人工暂停，不等于原生 OnCompletion；`playback_time` 可能由拖动进度条跨越触发。需要精确播放完成事件时，使用原生 vMix 触发器。

## 开发验证

```sh
npm test
npm run smoke
npm run format:check
npm pack --dry-run
```

`npm test` 使用真实 MCP SDK 与本机模拟 HTTP 服务，覆盖素材、场景、字段、转场、重复请求、失败与托管触发器。`npm run smoke` 启动真实 stdio 子进程，验证工具发现、四宫格创建和切换。测试不会访问现场 vMix。`npm run mock` 可单独启动模拟服务（默认 8098 端口）。

GitHub CI 覆盖 Windows/Linux、Node 22/24；CI 与模拟测试均不能替代真实 vMix 的节目画面验收。详细边界见 [架构与验收](docs/ARCHITECTURE.md)。

## 官方接口依据

- [HTTP Web API](https://www.vmix.com/help29/DeveloperAPI.html)
- [Shortcut Function Reference](https://www.vmix.com/help29/ShortcutFunctionReference.html)
- [原生 Triggers](https://www.vmix.com/help29/Triggers.html)
- [Stinger Transitions](https://www.vmix.com/help29/StingerTransitions.html)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

仓库未复制此前审查的第三方 vMix MCP 源码、知识库或示例实现。
