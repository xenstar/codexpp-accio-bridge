# Codex++ 的 Accio 桥接（Accio Bridge）

[English](README.md) | **中文**

让原版 **Accio Work（Accio 桌面版 / Accio AI）** 使用 Codex++ 的模型，
同时保留你的 Accio 账号、历史记录、技能和完整界面。桥接只给由它启动的
Accio 子进程设置本地网关，不修改 Accio 数据库、程序文件、账号文件或私有接口。

当前支持文本对话、工具调用、提示词增强和生图。本版本暂不支持视频生成。

Accio 原生供应商与连接器工具仍由 Accio 自己执行。桥接不会把这些工具反向
暴露给 Codex++，正常启动的桥接会话也不会开启反向 MCP 端点。

## 功能归属

| 功能 | 实际执行方 | 桥接行为 |
| --- | --- | --- |
| 聊天、推理、模型选择和提示词增强 | Codex++ 供应商 | 正常路由模型请求，并按所选 Codex++ 供应商计费。 |
| 工具选择与客户端工具编排 | Codex++ 模型和 Accio 宿主工具 | 普通原生工具原样透传。在提供原生 Accio 工具的供应商或询盘会话中，可选 Harness 兼容层会添加路由指引、规范化 MCP 传输名并隐藏 Shell 路由。 |
| 生图与生成文件交付 | Codex++ 生图模型和 Accio `present_files` | 路由生图请求，并保留现有生成文件交付保护。 |
| 登录、历史、工作区、技能、原生界面和本地连接器执行 | 原版 Accio | 保持不变；桥接不修改 Accio 数据、界面、认证或二进制文件。 |
| 托管 MCP 工具、1688 询盘创建、供应商消息读取/发送、自动聊天、卖家智能体操作和阿里巴巴授权 | Accio 的账号级服务器 | 由 Accio 负责执行、授权、可用性和服务器侧积分消耗。桥接不会镜像或改写这些服务器 API。 |

这个边界是刻意设计的。Codex++ 模型可以选择一个 Accio 原生工具，但该工具
是否执行、如何执行以及是否返回结果，仍由 Accio 决定。仅服务器可执行的供应商
功能继续使用用户的 Accio 会话和额度。

### Harness 兼容

以下三个设置默认均为 **仅 Accio Harness 生效**：

- **Accio Harness 指引**：仅当当前会话提供原生 Accio 工具时，为供应商与询盘
  任务添加路由指引。
- **Harness 工具名兼容**：把旧供应商 MCP 传输名映射到当前原生工具。直接调用
  `send_msg` 和普通工具调用不会被改名或改写。
- **Harness Shell 路由拦截**：仅在供应商或询盘 Harness 会话中移除 `bash` 和
  `process`，不影响普通聊天或其他工具会话。

任意一项设为 **Off** 即可关闭。设置会在下一次启动路由 Accio 或点击
**Restart routed** 后生效。这些控制不会把 Accio 托管执行迁到 Codex++，也不会
消除询盘创建、供应商聊天、自动回复、智能体操作或阿里巴巴授权可能产生的
账号级服务器用量。

Accio 关闭时，扩展后端保持休眠。Codex++ 启动时不会自动打开 Accio，也不会
监听 `43100`-`43102`。只有点击 **Open routed Accio** 后才会启动本地路由，
Accio 退出后会自动停止。后台 Agent Access 状态检查不会探测 Codex++ 模型目录。

如果旧实验版本在 Codex 的 `config.toml` 留下了
`[mcp_servers.accio-bridge-accio-tools]`，打开一次桥接管理器即可删除精确匹配
的 `43103` 条目、创建备份，并同步清理 Codex++ 中转配置；其他 MCP 服务不会
被改动。显式点击 **Open routed Accio** 时也会自动执行此清理。之后请新开一个
Codex 对话。

## 安装

1. 打开 **Codex++ → Everything is an extension → Community**。
2. 搜索 **Accio**、**Accio 桥接**、**Accio 中文** 或 **Accio 桌面版**。
3. 安装并启用 **Accio Bridge**。
4. 打开 Accio Bridge 设置，点击 **Open routed Accio**。

手动安装：下载最新 Release 压缩包，把其中的 `accio-bridge` 文件夹解压到：

```text
%APPDATA%\Codex++\user_scripts\
```

## 使用

1. 继续使用原来的 Accio 账号和工作区。
2. 在 Accio 里选择 **Codex++** 分组中的模型。
3. 做设计或生图任务时，对话和规划使用 Codex++ 聊天模型，实际生图模型从
   **Codex++ Image** 分组选择。
4. 在 Codex++ 新加的供应商或模型，会在下一次 Accio 获取模型列表时自动刷新。

Accio 的额度横幅只代表 Accio 自己的模型额度。桥接模式的 Codex++ 用量单独
计费，不会消耗 Accio 积分。由 Codex++ 启动的会话会收到一个格式正常、余额为
零的 FREE 订阅响应，避免 Accio 因缓存了过期的“额度耗尽”状态而显示横幅或
禁用输入框；正常启动 Accio 时仍会保留原生额度提示。

如果 Accio 已经正常启动，请在插件面板点击 **Restart routed**。从任务栏直接
启动的 Accio 不会继承桥接设置。

## 搜索关键词

Codex++ 社区搜索同时支持英文和中文关键词：

`Accio`、`Accio Work`、`Accio AI`、`Accio Desktop`、`Accio Bridge`、
`Accio 桥接`、`Accio 中文`、`Accio 桌面版`、`Accio 助手`、`Accio 智能体`、
`阿西欧`、`桥接`、`生图`

## 兼容范围

- Windows 10 或 Windows 11
- Codex++ `2.6.10` 或更新版本
- 原版 Accio Work 桌面版
- 文本与生图：支持
- 视频生成：暂不支持

## 链接

- [English guide](README.md)
- [Codex++ 接入需求 Issue](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3109)

发布者：[xenstar](https://github.com/xenstar)
