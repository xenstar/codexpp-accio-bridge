<!-- generated-by: gsd-doc-writer -->
# Codex++ Accio Integration Handoff

## Three-track decision (2026-11-16)

The integration now has three separate tracks. Do not combine them again.

1. **WebSocket route experiment: closed for this release.** It is not required
   for text or image routing and is not part of the publishable Accio Bridge.
   The clean worktree is reset to upstream, and the experimental commits remain
   only on `backup/codex-websocket-route-gate-20261116`.
2. **Accio Bridge: working for routed text and images.** Version `0.1.20`
   launches the stock Accio executable with a child-only gateway override,
   preserves Accio login/history/UI, refreshes Codex++ chat and image models,
   and does not modify Accio private data.
3. **Accio Agent Access: separate Codex++ integration.** Agent Access is the
   correct place for Codex++ to own the Accio binding and expose provider
   model choices. The plugin cannot add an Agent Access row by itself with the
   current upstream extension API.

The missing capability is a generic plugin-contributed Agent Access contract.
Upstream `main` at commit `657710ad` builds Agent Access rows from compile-time
`AgentSpec` values and has image-model bindings but no video-model registry.
Extensions can provide background services, but there is no current contract
that lets one contribute an Agent Access row, launcher action, or binding
lifecycle.

The screenshots demonstrate the desired Codex++ UI. They do not prove that the
same video selector exists in upstream. Upstream image exposure is verified in
source; video must remain out of the publishable claim until the matching source
and runtime build are verified.

The chosen architecture is a thin Accio plugin plus a generic upstream Agent
Access contract. JEV selected this path with `0.96` probability versus `0.02`
for hardcoding Accio now and `0.02` for keeping the plugin as the final
integration boundary. Accio-specific discovery, child-process environment,
relay services, and protocol translation stay in the plugin. Codex++ owns
Agent Access discovery, the model/image binding UI, launcher actions, and
future video bindings.

### Required next implementation

1. Extend the Codex++ extension manifest with a generic Agent Access
   contribution and validate it in `UserScriptManager`.
2. Let a contributed agent provide status, launch, restart, and stop actions
   through its declared extension service.
3. Include contributed agents in `listed_agents`, normal binding storage, model
   exposure, image selection, and the existing Agent Access run button.
4. Remove duplicate chat/image catalog ownership from the bridge where Agent
   Access provides the same data. Keep the current launcher bridge as a
   compatibility fallback.
5. Verify routed text, model refresh, image generation, disconnect/reconnect,
   credential redaction, and launcher cleanup before publishing.
6. Treat video as blocked on Codex++ video-model binding support. Do not add a
   bridge-owned video UI or claim video works from the screenshot alone.

## Current scope: 0.1.20

- Routed chat models and a separate Codex++ image provider group.
- The bridge has no video status client/UI, prompt, generate button, polling
  loop, or downloader. Video-intent requests return
  `ACCIO_VIDEO_UNSUPPORTED` and point to the harness's native video tool.
  Accio's paid video gateway is not used.
- Upstream recommendation: Codex++ should expose provider-neutral video model
  discovery in a focused feature request, analogous to image-model exposure.
  Harnesses own provider-native video paths, polling, progress, and saving.
- WebSocket experiments are not part of this release. On 2026-11-16 the active
  `codexpp-video-gateway-clean` worktree was reset to `origin/main`. The two
  experimental commits remain only on the local backup branch
  `backup/codex-websocket-route-gate-20261116`.
- The installed `codex-plus-plus.exe` is the gate build, SHA-256
  `54E343F3EFC969C6C32E44D02D74563562FA262126261C3BBC8D4BA6A5907092`
  (PR #3138 commits `9b3198b3` + `b91ffecc`: WebSocket eligibility decided
  before `101`, `426` for mixed-protocol pools). Live-probed 2026-11-16:
  owning pid verified, port accepting, `HTTP/1.1 426 Upgrade Required`.
  The earlier `2CDC2854...` build is superseded.

## Verification

- `node tools/test-package.mjs`, `test-image.mjs`, and `test-routing.mjs`
  pass locally with local-network access (sandbox loopback restrictions
  cause false failures; rerun escalated before diagnosing bridge logic).
- Bridge `0.1.20` package: `dist/accio-bridge-0.1.20.zip`, SHA-256
  `9A4E7F97365B7A8302D96C1B52485F40443A6AEFD49532941CC88D26E3AFC5A1`.
  Installed plugin manifest (`codexpp.json`) and source both read `0.1.20`.
- Agent Access candidate `7D3ABB2D...`
  (`dist/candidate-2.6.10-accio-agent-access-wsgate2-20261116-230438` in the
  `codexpp-accio-agent-access` worktree): 35 focused WebSocket tests, Vite
  and release Rust builds pass. NOT live-validated; see
  `docs/ACCIO-AGENT-ACCESS-HANDOFF.md`.
- Rust video/WebSocket checks are archived exploration and are not release
  gates for bridge `0.1.20`.
- No running Codex++ process was stopped or restarted.

## Recovery-tooling audit (2026-11-16)

- `fix-codex-gateway.ps1` (other agent, installed dir): recovers the port and
  checks `/v1/models`, but skips reclaim when the port already accepts and
  never verifies the 426 gate or the owning executable. It can certify a
  gate-less build as healthy.
- `probe-ws-upgrade.ps1` (other agent): correct handshake probe, but exits 0
  on timeout and does not attribute the port owner, so an old build can
  masquerade as a verified candidate.
- `start-codex-desktop-via-helper.ps1` (other agent): kills ALL ChatGPT/codex
  desktop processes. Never run it while a Codex session is live.
- Our `scripts/switch-codexpp-accio-wsgate2.ps1` originally filtered TCP
  `-State Listen`; the healthy helper's listener row shows a blank state, so
  that filter false-negatives even a working candidate. Fixed 2026-11-16:
  owner attribution by PID (excluding TimeWait/Closed) plus an explicit
  accept-connect check in `-ProbeOnly`. Live-verified: `PROBE_OK` exit 0
  against the installed gate build.
- Rollback caveat: `gateway.json` (`~/.codex-session-delete/gateway.json`)
  `bindings.accio.enabled` is `false` today. If a candidate test enables it,
  rolling back to a build without Accio support resumes a 1 Hz
  `extension_catalog_refresh_failed` loop; set it back to `false` manually.
  The switch script intentionally makes no persistent config changes.

## Release decision (2026-11-16)

JEV `jev_decide` selected `publish_bridge_only` (0.99, no contradicted
requirements): submit Accio Bridge `0.1.20` (text + image) only, after
explicit user approval; then comment on issue #3109. Hand the Agent Access
candidate and these handoffs to the Codex++ maintainer as a separate
integration. Video stays deferred to issue #3134.

## Pending work

1. Agent Access prototype is built and unit-tested but not live-validated.
   Optional external switch test (outside Codex/Codex++):
   `scripts/switch-codexpp-accio-wsgate2.ps1`, procedure in
   `docs/CODEXPP-CANDIDATE-SWITCH.md`. Not a gate for the bridge release.
2. Simplify Accio Bridge so Agent Access is authoritative for bindings while
   the existing routed launcher remains available as a fallback.
3. Submit the extension for distribution, for example
   `BigPizzaV3/CodexPlusPlusScriptMarket`, only after local end-to-end tests.
4. Only after submitting, post to GitHub issue #3109, which the user created.
5. Provider-neutral video-model discovery was submitted as
   <https://github.com/BigPizzaV3/CodexPlusPlus/issues/3134>, revised to a
   generic harness framing (Grok / Accio / WorkBuddy, Qwen Token Plan example)
   with no Accio Bridge-specific claims. Do not add a bridge-owned video task
   surface.
6. PR #3128 remains Draft. Do not push, force-update, or mark Ready without
   explicit user approval.

## Key paths

- Bridge: `G:\opencode\projects\Search\codexpp-accio-bridge`
- Archived video discovery worktree:
  `G:\opencode\projects\Search\codexpp-video-gateway-split`
- Reverted WebSocket worktree:
  `G:\opencode\projects\Search\codexpp-video-gateway-clean`
- Clean Agent Access prototype worktree:
  `G:\opencode\projects\Search\codexpp-accio-agent-access`
- WebSocket experiment backup branch:
  `backup/codex-websocket-route-gate-20261116`
- PR handoff: `docs/CODEXPP-PR-3128.md`
- Enhancement architecture: `docs/ACCIO-ENHANCEMENTS.md`
