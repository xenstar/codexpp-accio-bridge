# Accio Bridge for Codex++

**English** | [中文](README.zh-CN.md)

Use Codex++ models in the stock **Accio Work** app while keeping your Accio
account, history, skills, and interface. The bridge starts Accio with a
child-only local gateway and never edits Accio databases, binaries, account
files, or private APIs.

Supports routed chat, tool calls, prompt enhancement, and image generation.
Video generation is not included in this release.

Accio keeps ownership of its native supplier and connector tools. The bridge
does not mirror them into Codex++, and a normally launched routed session does
not open a reverse MCP endpoint.

## Feature ownership

| Feature | Runs through | Bridge behavior |
| --- | --- | --- |
| Chat, reasoning, model selection, and prompt enhancement | Codex++ providers | Routes model traffic normally and bills it through the selected Codex++ provider. |
| Tool choice and client-side tool orchestration | Codex++ model plus Accio host tools | Passes ordinary native tools unchanged. On supplier or inquiry turns that expose native Accio tools, optional harness compatibility adds routing guidance, normalizes the MCP transport name, and hides shell routes. |
| Image generation and generated-file delivery | Codex++ image models plus Accio `present_files` | Routes image work and preserves the existing artifact-delivery guard. |
| Login, history, workspace, skills, native UI, and local connector execution | Stock Accio | Preserved; the bridge does not edit Accio data, UI, authentication, or binaries. |
| Hosted MCP tools, 1688 inquiry creation, supplier message reading/sending, auto-chat, seller-agent actions, and Alibaba authorization | Accio's account-scoped server | Accio owns execution, authorization, availability, and any server-side credit usage. The bridge does not mirror or reroute these server APIs. |

This boundary is intentional. A client-side Codex++ model can choose a native
Accio tool, but Accio remains responsible for executing that tool and returning
the result. Server-only supplier features continue to use the user's Accio
session and quota.

### Harness compatibility

Three settings default to **On for the Accio harness**:

- **Accio harness guidance** adds supplier and inquiry routing instructions only
  when the current turn exposes native Accio tools.
- **Harness tool-name compatibility** maps legacy supplier MCP transport names
  to the current native tool. Direct `send_msg` and ordinary tool calls are not
  renamed or rewritten.
- **Harness shell-route block** removes `bash` and `process` only from an active
  supplier or inquiry harness turn. It does not change ordinary chat or other
  tool sessions.

Set any control to **Off** to disable that behavior. Settings apply when the
next routed Accio session starts or after **Restart routed**. These controls do
not move Accio-hosted execution into Codex++, and they do not remove
account-scoped server usage from inquiry creation, supplier chat, auto-chat,
agent actions, or Alibaba authorization.

The extension backend is inert while Accio is closed. It does not launch Accio
or bind ports `43100`-`43102` at Codex++ startup. Local routing starts only when
you choose **Open routed Accio**, then stops automatically when Accio exits.
Background Agent Access status checks do not probe the Codex++ model catalog.

If an older experimental build left
`[mcp_servers.accio-bridge-accio-tools]` in Codex's `config.toml`, open the
bridge manager once. It removes that exact `43103` entry, creates a backup, and
does the same inside saved Codex++ relay profiles. Every unrelated MCP server
stays unchanged. The explicit **Open routed Accio** action also performs this
cleanup. Start a new Codex chat afterward.

The cleanup leaves the registration in place when
`ACCIO_MCP_DEVELOPMENT_SERVER=1`, because that entry is then intentional for
local development rather than stale.

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

Accio credit banners describe Accio's own model quota. Routed Codex++ usage is
billed separately and does not consume Accio credits. In a Codex++-launched
session, the bridge returns a clean zero-balance FREE subscription response so
Accio cannot show a stale exhausted-credit banner or disable the composer.
Starting Accio normally keeps the native Accio quota behavior.

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

## Links

- [Chinese guide](README.zh-CN.md)
- [Codex++ integration request](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3109)

Publisher: [xenstar](https://github.com/xenstar)
