<div align="center">

# Accio 桥接（Accio Bridge）

**在现有的 Accio Work 中使用 Codex++ 模型。**

保留 Accio 账号、历史记录、技能、连接器和完整界面。Accio 桥接只改变由
Codex++ 启动的 Accio 会话的模型路由。

[安装](#安装) · [功能](#功能) · [路由规则](#路由规则) ·
[开发](#开发) · [English](README.md)

[![最新版本][release-shield]][release-link]
[![许可证][license-shield]][license-link]
[![平台][platform-shield]][compatibility]
[![问题反馈][issues-shield]][issues-link]

</div>

> **重要说明：** Accio 托管工具仍由 Accio 执行。询盘创建、供应商消息、
> 自动聊天、卖家操作和阿里巴巴授权使用 Accio 会话及服务器侧额度。桥接不会
> 把这些服务器 API 改走 Codex++。

## 功能

| 能力 | Accio 桥接做什么 |
| --- | --- |
| **原版 Accio 中的 Codex++ 模型** | 把 Codex++ 文本、智能体和生图模型加入正常的 Accio 模型选择器。现有登录、历史、工作区、技能和界面保持不变。 |
| **客户端模型路由** | 模型请求走 Codex++ 中选择的供应商，而不是消耗 Accio 的模型额度。 |
| **原生 Accio 工具** | 普通 Accio 工具原名透传，工具执行和授权仍由 Accio 负责。 |
| **生图** | 路由 Codex++ 生图模型，同时保留 Accio 的生成文件交付流程。 |
| **Accio Harness 兼容** | 可选地为供应商与询盘会话添加路由指引、规范化旧 MCP 传输名，并在 Harness 会话中隐藏 Shell 路由。 |
| **无后台常驻服务** | Accio 关闭时扩展保持休眠；只有点击 **Open routed Accio** 后才启动本地网关。 |

本版本暂不支持视频生成。

## 路由规则

| 工作内容 | 实际执行方 | 计费与归属 |
| --- | --- | --- |
| 聊天、推理、模型选择和提示词增强 | Codex++ 供应商 | 按所选 Codex++ 供应商计费。 |
| 客户端工具选择与普通原生 Accio 工具 | Codex++ 模型和 Accio 宿主 | Accio 正常执行所选工具。 |
| 生图与生成文件交付 | Codex++ 生图模型和 Accio `present_files` | Codex++ 模型用量与现有 Accio 文件流程。 |
| 登录、历史、工作区、技能、原生界面和本地连接器 | 原版 Accio | 保留，并由 Accio 管理。 |
| 托管 MCP 工具、1688 询盘创建、供应商聊天、自动回复、卖家操作和阿里巴巴授权 | Accio 的账号级服务器 | 执行、授权、可用性和服务器侧额度均由 Accio 管理。 |

这个边界是刻意设计的。Codex++ 模型可以选择 Accio 工具，但工具是否执行、
如何执行以及是否返回结果，仍由 Accio 决定。

### Accio Harness

以下三个可选设置只作用于提供原生 Accio 工具的供应商或询盘会话：

- **Accio Harness 指引**：为当前会话添加路由指引。
- **Harness 工具名兼容**：把旧供应商 MCP 传输名映射到当前原生工具。直接
  调用 `send_msg` 和普通工具调用保持不变。
- **Harness Shell 路由拦截**：在活动的 Harness 会话中移除 `bash` 和
  `process`，让模型使用原生 Accio 工具路径。

设置默认值为 **仅 Accio Harness 生效**，也可以逐项关闭。修改会在下一次
启动路由 Accio 后生效。

## 安装

### Codex++ 社区

1. 打开 **Codex++ → Everything is an extension → Community**。
2. 搜索 **Accio**、**Accio 桥接** 或 **Accio Bridge**。
3. 安装并启用 **Accio Bridge**。
4. 打开 Accio Bridge 设置，点击 **Open routed Accio**。

### 手动安装

下载最新 Release 压缩包，把其中的 `accio-bridge` 文件夹解压到：

```text
%APPDATA%\Codex++\user_scripts\
```

## 快速开始

1. 继续使用原来的 Accio 账号和工作区。
2. 在 Accio 里从 **Codex++** 分组选择模型。
3. 做设计或生图时，用 Codex++ 聊天模型规划和对话，再从 **Codex++ Image**
   分组选择实际生图模型。
4. 如果 Accio 已经正常启动，请点击 **Restart routed**，让它重新继承桥接配置。

Accio 的额度横幅只代表 Accio 自己的模型服务。由 Codex++ 启动的会话会收到
一个格式正常、余额为零的 FREE 订阅响应，避免 Accio 显示过期的“额度耗尽”
横幅或禁用输入框。正常启动 Accio 时仍保留原生额度提示。

## 兼容与安全

- Windows 10 或 Windows 11。
- Codex++ `2.6.10` 或更新版本。
- 原版 Accio Work 桌面版。
- Accio 桥接不修改 Accio 数据库、Cookie、账号文件、`app.asar`、认证状态或 DOM。
- Codex++ 启动时不会自动打开 Accio，也不会监听 `43100`-`43102`。点击
  **Open routed Accio** 后才开始路由，Accio 退出后自动停止。
- 如果旧实验版本在 Codex 的 `config.toml` 留下了
  `[mcp_servers.accio-bridge-accio-tools]`，打开一次桥接管理器即可备份并
  删除这个过期的 `43103` 条目。

## 开发

```bash
git clone https://github.com/xenstar/codexpp-accio-bridge.git
cd codexpp-accio-bridge

node tools/test-package.mjs
node tools/test-harness-routing.mjs
node tools/test-image.mjs
node tools/test-routing.mjs
node tools/test-mcp.mjs
node tools/test-agent-status.mjs

node tools/pack.mjs
node tools/install.mjs
```

插件清单位于 [`codexpp.json`](./codexpp.json)。发布版本号必须在清单、
压缩包文件名、解压目录、Git Tag 和 Release 附件中保持一致。

## 链接

- [最新版本][release-link]
- [问题反馈][issues-link]
- [Codex++ 接入需求](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3109)
- [Codex++](https://github.com/BigPizzaV3/CodexPlusPlus)
- [English guide](README.md)

## 许可证

MIT © 2026 [xenstar](https://github.com/xenstar)

[release-link]: https://github.com/xenstar/codexpp-accio-bridge/releases/latest
[release-shield]: https://img.shields.io/github/v/release/xenstar/codexpp-accio-bridge?label=release&color=369eff&labelColor=black&style=flat-square
[license-link]: https://github.com/xenstar/codexpp-accio-bridge/blob/main/LICENSE
[license-shield]: https://img.shields.io/github/license/xenstar/codexpp-accio-bridge?label=license&color=white&labelColor=black&style=flat-square
[compatibility]: #兼容与安全
[platform-shield]: https://img.shields.io/badge/platform-Windows-0078D4?labelColor=black&style=flat-square
[issues-link]: https://github.com/xenstar/codexpp-accio-bridge/issues
[issues-shield]: https://img.shields.io/github/issues/xenstar/codexpp-accio-bridge?label=issues&color=ff80eb&labelColor=black&style=flat-square
