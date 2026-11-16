# Accio Bridge for Codex++

**English** | [中文](README.zh-CN.md)

Use Codex++ models in the stock **Accio Work** app while keeping your Accio
account, history, skills, and interface. The bridge starts Accio with a
child-only local gateway and never edits Accio databases, binaries, account
files, or private APIs.

Supports routed chat, tool calls, prompt enhancement, and image generation.
Video generation is not included in this release.

## Install

1. Open **Codex++ → Everything is an extension → Community**.
2. Search for **Accio**, **Accio Bridge**, or **Accio 桥接**.
3. Install and enable **Accio Bridge**.
4. Open Accio Bridge settings and click **Open routed Accio**.

Manual installation: download the latest release ZIP and extract its
`accio-bridge` folder into:

```text
%APPDATA%\Codex++\user_scripts\
```

## Use

1. Keep using your normal Accio login and workspace.
2. In Accio, select a model under **Codex++**.
3. For image tasks, keep a Codex++ chat model for planning and choose the
   picture backend under **Codex++ Image**.
4. Models added in Codex++ are refreshed from the live Codex++ catalog on the
   next Accio model request.

If Accio was already open normally, use **Restart routed**. A taskbar-started
Accio does not inherit the child-only gateway setting.

## Search Names

The Codex++ Community listing includes both English and Chinese search terms:

`Accio`, `Accio Work`, `Accio AI`, `Accio Desktop`, `Accio Bridge`,
`Accio 桥接`, `Accio 中文`, `Accio 桌面版`, `Accio 助手`, `Accio 智能体`,
`阿西欧`, `桥接`, `生图`

## Compatibility

- Windows 10 or 11
- Codex++ `2.6.10` or newer
- Stock Accio Work desktop
- Text and image generation: supported
- Video generation: not included

## Documentation

- [Chinese guide](README.zh-CN.md)
- [Maintainer handoff](docs/MAINTAINER_HANDOFF.md)
- [Agent Access handoff](docs/ACCIO-AGENT-ACCESS-HANDOFF.md)
- [Accio integration issue](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3109)

Publisher: [xenstar](https://github.com/xenstar)
