# Codex++ 的 Accio 桥接（Accio Bridge）

[English](README.md) | **中文**

让原版 **Accio Work（Accio 桌面版 / Accio AI）** 使用 Codex++ 的模型，
同时保留你的 Accio 账号、历史记录、技能和完整界面。桥接只给由它启动的
Accio 子进程设置本地网关，不修改 Accio 数据库、程序文件、账号文件或私有接口。

当前支持文本对话、工具调用、提示词增强和生图。本版本暂不支持视频生成。

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
