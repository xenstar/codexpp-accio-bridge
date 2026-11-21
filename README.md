<div align="center">

# Accio Bridge

**Bring Codex++ models into the Accio Work you already use.**

Keep your Accio account, history, skills, connectors, and interface. Accio Bridge
changes the model route for sessions you launch from Codex++.

[Install](#-install) · [Features](#-features) · [Routing](#-how-routing-works) ·
[Development](#-development) · [中文](README.zh-CN.md)

[![Latest release][release-shield]][release-link]
[![License][license-shield]][license-link]
[![Platform][platform-shield]][compatibility]
[![Issues][issues-shield]][issues-link]

</div>

> **Important:** Accio-hosted tools remain Accio-hosted. Inquiry creation,
> supplier messaging, auto-chat, seller actions, and Alibaba authorization use
> the Accio session and server-side quota. The bridge does not reroute those
> server APIs through Codex++.

## ✨ Features

- [x] 💬 **Codex++ models in stock Accio**
  Adds Codex++ text, agent, and image models to the normal Accio model picker
  while preserving your account, history, workspace, skills, and UI.
- [x] 🔀 **Client-side model routing**
  Sends model traffic through the Codex++ provider you selected instead of
  using Accio's model quota.
- [x] 🧰 **Native Accio tools**
  Passes ordinary Accio tools through unchanged, so Accio remains responsible
  for execution and authorization.
- [x] 🎨 **Image generation**
  Routes Codex++ image models and preserves Accio's generated-file workflow.
- [x] 🧩 **Accio harness compatibility**
  Adds optional supplier and inquiry guidance, normalizes legacy supplier MCP
  transport names, and hides shell routes on active harness turns.
- [x] 🌙 **No background services**
  Stays inert while Accio is closed and starts its local gateway only after
  **Open routed Accio** is selected.
- [ ] 🎬 **Video generation**
  Not included in this release.

## 🚀 How routing works

| Work | Executed through | Billing and ownership |
| --- | --- | --- |
| Chat, reasoning, model selection, and prompt enhancement | Codex++ providers | Billed through the selected Codex++ provider. |
| Client-side tool choice and ordinary native Accio tools | Codex++ model plus Accio host | Accio executes the selected tool normally. |
| Image generation and generated-file delivery | Codex++ image models plus Accio `present_files` | Codex++ model usage and the existing Accio file flow. |
| Login, history, workspace, skills, native UI, and local connectors | Stock Accio | Preserved and owned by Accio. |
| Hosted MCP tools, 1688 inquiry creation, supplier chat, auto-chat, seller actions, and Alibaba authorization | Accio's account-scoped server | Accio owns execution, authorization, availability, and server-side credit usage. |

This boundary is intentional. A Codex++ model can choose an Accio tool, but
Accio still decides whether and how that tool runs.

### 🧩 Accio harness

Three optional settings apply only to supplier or inquiry turns that expose
native Accio tools:

- **Accio harness guidance** adds routing instructions for the current turn.
- **Harness tool-name compatibility** maps legacy supplier MCP transport names
  to the current native tool. Direct `send_msg` and ordinary calls stay intact.
- **Harness shell-route block** removes `bash` and `process` from active harness
  turns so the model uses the native Accio tool path.

The settings default to **On for the Accio harness** and can be disabled
individually. Changes apply after the next routed Accio session starts.

## 📦 Install

### 🛍️ Codex++ Community

1. Open **Codex++ → Everything is an extension → Community**.
2. Search for **Accio**, **Accio Bridge**, or **Accio 桥接**.
3. Install and enable **Accio Bridge**.
4. Open Accio Bridge settings and click **Open routed Accio**.

### 📁 Manual installation

Download the latest release ZIP, extract its `accio-bridge` folder into:

```text
%APPDATA%\Codex++\user_scripts\
```

## ⚡ Quick start

1. Keep using your normal Accio login and workspace.
2. In Accio, select a model from the **Codex++** group.
3. For image work, use a Codex++ chat model for planning and choose the picture
   backend from **Codex++ Image**.
4. If Accio is already running normally, click **Restart routed** so it inherits
   the child-only gateway configuration.

Accio's model quota banner describes Accio's own model service. A session
launched by Codex++ receives a clean zero-balance FREE subscription response so
Accio does not show a stale exhausted-credit banner or disable the composer.
Starting Accio normally keeps the native Accio quota behavior.

## 🔒 Compatibility and safety

- Windows 10 or Windows 11.
- Codex++ `2.6.10` or newer.
- Stock Accio Work desktop.
- Accio Bridge does not edit Accio databases, cookies, account files,
  `app.asar`, authentication state, or DOM.
- The backend does not launch Accio or bind ports `43100`-`43102` at Codex++
  startup. Routing starts with **Open routed Accio** and stops when Accio exits.
- If an older experimental build left
  `[mcp_servers.accio-bridge-accio-tools]` in Codex's `config.toml`, open the
  bridge manager once. It backs up and removes only that stale `43103` entry.

## 🛠️ Development

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

The plugin manifest is [`codexpp.json`](./codexpp.json). Release versions must
match the manifest, package filename, extracted stage, Git tag, and release
asset.

## 🔗 Links

- [Latest release][release-link]
- [Report an issue][issues-link]
- [Codex++ integration request](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3109)
- [Codex++](https://github.com/BigPizzaV3/CodexPlusPlus)
- [Chinese guide](README.zh-CN.md)

## 📝 License

MIT © 2026 [xenstar](https://github.com/xenstar)

[release-link]: https://github.com/xenstar/codexpp-accio-bridge/releases/latest
[release-shield]: https://img.shields.io/github/v/release/xenstar/codexpp-accio-bridge?label=release&color=369eff&labelColor=black&style=flat-square
[license-link]: https://github.com/xenstar/codexpp-accio-bridge/blob/main/LICENSE
[license-shield]: https://img.shields.io/github/license/xenstar/codexpp-accio-bridge?label=license&color=white&labelColor=black&style=flat-square
[compatibility]: #-compatibility-and-safety
[platform-shield]: https://img.shields.io/badge/platform-Windows-0078D4?labelColor=black&style=flat-square
[issues-link]: https://github.com/xenstar/codexpp-accio-bridge/issues
[issues-shield]: https://img.shields.io/github/issues/xenstar/codexpp-accio-bridge?label=issues&color=ff80eb&labelColor=black&style=flat-square
