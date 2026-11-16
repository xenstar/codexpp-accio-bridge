# Accio Bridge for Codex++

Launch stock Accio with Codex++ models while keeping the normal Accio account, history, skills, and interface.

Current package: `0.1.21`.

## Publisher

- Author / 作者: **xenstar** — <https://github.com/xenstar>
- Issues and feature discussion: <https://github.com/BigPizzaV3/CodexPlusPlus/issues/3109>

## What it does

- Detects Accio from the current user's standard install, machine-wide install,
  Windows App Paths, or the user-configured executable path.
- Detects the running Codex++ protocol proxy and its model catalog.
- Starts loopback-only bridge services on ports `43100` to `43102`.
- Starts `Accio.exe` with a child-only `GATEWAY_BASE_URL=http://127.0.0.1:43100`.
- Generates a native-shaped Accio provider catalog for every model exposed by Codex++.
- Refreshes that catalog from Codex++ on every Accio model-list request and disables HTTP caching.
- Decodes gzip, deflate, and Brotli request bodies before translating Accio's ADK payload.
- Handles Accio's metadata-only startup probes locally instead of sending empty turns to Codex++.
- Routes modelless and Accio-internal requests to `codexplus/auto` while the plugin is configured for Codex++ only.
- Preserves explicit Codex++ model selections and explicit legacy provider prefixes.
- Translates Accio tool declarations, tool choices, function calls, and function results to the Responses API.
- Unwraps nested JSON paths in `present_files` before Accio validates them, so
  generated artifacts are presented on the first delivery call.
- Prevents post-generation shell cleanup loops by instructing image agents to
  reuse the generated path and bounding omitted `bash`/`process` timeouts.
- Routes model requests through Codex++ and sends unrelated Accio gateway traffic back to the original Accio gateway.
- Routes a turn to the image bridge when Accio asks for image output
  (`responseModalities` or `imageConfig`, in object or JSON-string form). An
  `codexplus-image/...` code on a plain chat turn goes to a Codex++ chat model
  instead of spending a billable image generation, because Accio has no
  client-side concept of an image model.
- Publishes Codex++'s own image models as a separate **Codex++ Image** provider
  group in Accio's model picker, so `GPT Image`, `wan2.7-image`,
  `wan2.7-image-pro` and `qwen-image-3.0-pro` are selectable like any other model.
- Keeps video-only models out of Accio's chat catalog and does not ship a video
  status client, prompt, generate button, polling loop, or downloader.
- Rejects video-intent requests inside Accio instead of forwarding them to
  Accio's paid video gateway. Video generation belongs to the harness/agent's
  native video mechanism, not to the bridge.
- Reads that image pool from Codex++ state on every catalog request, read-only
  and key-free, so models added in Codex++ appear without a reinstall.
- Gives those image entries the same context window as the models beside them, so
  Accio's own pre-flight context check does not reject the turn before it is sent.
- Forwards Accio's real `User-Agent` and replaces Accio's internal `node` identity with an honest `Accio/<installed-version>` value.
- Allows slow Design Expert image jobs up to ten minutes; a live `gpt-image-2` retry took 229 seconds.
- Resolves the Windows Codex CLI package path directly for the optional image bridge.
- Stops only the processes it owns when Accio or the Codex++ extension session closes.

It does not modify `Accio.exe`, `app.asar`, Accio databases, account files, or private Accio APIs. It does not call `setx` and does not change user or machine environment variables.

## Language and discovery

- Codex++ extension details use `locale/en.json` and `locale/zh.json`, so the package card follows the manager interface language.
- The plugin appears in Codex++ local extensions without adding a separate
  Tools navigation page. Open its panel from the extension's menu.
- The bridge panel follows the browser's Chinese or English language preference.

## Install locally

Place this folder under:

```text
%APPDATA%\Codex++\user_scripts\accio-bridge
```

Then reopen Codex++ Manager, find **Accio Bridge** under local extensions, open
its panel from the extension menu, and click **Open routed Accio**.

If Accio was already started normally, use **Restart routed**. A normally started Accio does not inherit the child-only gateway override.

To distribute it, send the `dist/accio-bridge-0.1.21.zip` archive. The receiving user extracts the included `accio-bridge` folder into the same `%APPDATA%\Codex++\user_scripts` directory.

### Update Codex++ without losing the active model route

Staging and activation are separate. `tools/stage-codexpp-update.ps1` only
copies and hash-verifies the candidate. The optional
`tools/activate-codexpp-stage.ps1` swaps the executable on disk without
stopping the running Codex++ process; the new build loads on the next normal
start. Do not use `tools/swap-codexpp.ps1` while Codex++ is carrying the active
Codex connection, because that helper stops and relaunches it.

## Usage

1. Open routed Accio from Codex++.
2. Keep using the existing Accio login and workspace normally.
3. Open **Select model** and choose a model under the **Codex++** provider.
4. Start the task normally.

Accio features that do not request a model, such as prompt enhancement, use
Codex++ `auto`. Explicit model selections always win.

Image models are listed separately because Codex++ deliberately keeps them out of
its chat model list (`gateway/route.rs` `chat_models()` filters them, and the
Codex++ UI says the same thing: "Agents don't chat with these"). Accio therefore
receives two groups:

- **Codex++** — chat and agent models, used for planning, tool calls and text.
- **Codex++ Image** — `GPT Image` plus every image model enabled on a Codex++
  provider, used when an Accio agent asks for a picture.

For Design Expert work, keep the conversation model on a Codex++ chat model so
tool calling stays reliable, and pick the picture backend from **Codex++ Image**.
The panel's **Image model** field pins a default for turns where Accio names no
image model; **Image route** can force `gateway`, `helper`, `codex-cli` or stay
on `auto`; **Image models** can hide the group without losing the routing.

Video is intentionally outside this release. Accio Bridge is not a video
generation app. It rejects video-intent turns and points them to the harness's
native video tool instead of spending on Accio's gateway. Codex++ video-model
discovery is a separate upstream feature request; prompt entry, polling,
progress, and saving belong to the harness.

Accio remains logged in because the launcher uses the same stock executable and user-data directory. Only the Accio child process receives the bridge gateway URL; taskbar-started Accio remains unchanged.

## Why Accio needs a launcher

Verified against Accio Desktop `0.39.0` on Windows:

- Accio has no user-facing custom OpenAI-compatible Base URL or API-key setting.
- Accio reads `GATEWAY_BASE_URL` when the process starts.
- The model/provider UI is populated from Accio's authenticated gateway catalog.
- Accio's app-managed user-data files are not a supported provider configuration surface.

This extension therefore supplies the startup variable only to the Accio child process and translates Accio's gateway contracts locally. Taskbar-started Accio is intentionally left untouched.

## Verification

Local live testing on Codex++ `2.6.10` PR `#3128` and Accio `0.39.0` confirmed:

- Ports `43100`, `43101`, and `43102` become healthy.
- The generated Accio catalog exposes two groups and 31 models (27 Codex++ chat
  models plus 4 Codex++ image models) with matching `modelCode` and `modelName` values.
- `codexplus/gpt-5.6-luna` returns HTTP `200` and streams `routed-ok`.
- Codex++ `auto`, `auto:balanced`, and `auto:quality` each returned HTTP `200` in a minimal live request.
- The unprefixed fallback model `gpt-5.6-luna` also returns HTTP `200` and streams `fallback-ok`.
- A real gzip-compressed Accio payload with `contents: array:12` reached Codex++ and returned HTTP `200`.
- Metadata-only Accio probes receive a local empty SSE turn with HTTP `200` and are not sent upstream.
- Prompt enhancement succeeds without `OPENAI_API_KEY` or `OMNIROUTE_API_KEY`.
- A forced live tool call produced `FUNCTION_CALL`, accepted the function result, and completed with `STOP`.
- A real image-generation request returned a valid `image/png` inline result of about 1 MB.
- A slower live Design Expert image job completed on `gpt-image-2` after 229 seconds when the relay allowed more than two minutes.
- Design Expert's visible failure was traced to malformed `present_files`
  arguments after the image had already been generated. Release `0.1.11`
  normalizes those calls before Accio validates them.
- A later Design Expert run generated the PNG successfully in about 23 seconds,
  then stalled for about 156 seconds in a Recycle Bin cleanup command after
  several nested JSON `present_files` paths failed. Release `0.1.15` unwraps
  those paths recursively, tells the model not to shell-clean generated
  artifacts, and applies a schema-declared 60-second shell timeout when the
  model omits one.
- The reported Artifact index contained 49 entries and 48 existing files; the
  only missing item was an older `harness-smoke-probe.txt`. The generated image
  and its Artifact metadata were present, so the visible failure was delivery,
  not image persistence.
- Codex++ model discovery is forced on each Accio catalog request, so a model
  added while Accio is open appears on the next model-list refresh.
- An image request reaches the image bridge when it carries an image signal, in
  object or JSON-string form. A `codexplus-image/...` code alone does not: that
  turn goes to `codexplus/auto` on the text bridge, so chatting with an image
  model selected still returns text.
- Codex++ reports four image options for the current provider set:
  `chatgpt/gpt-image-2`, `qwentokenplan/wan2.7-image`,
  `qwentokenplan/wan2.7-image-pro`, `qwentokenplan/qwen-image-3.0-pro`.
- Live image turns through the relay all returned HTTP `200` with one inline
  PNG each: `gpt-image-2` 1.9 MB / 16 s, `qwen-image-3.0-pro` 1.9 MB / 15 s,
  `wan2.7-image` 2.0 MB / 15 s, `wan2.7-image-pro` 1.9 MB / 21 s.
- A plain chat turn that carries a `codexplus-image/...` code returns a text
  stream in about 1.5 s and generates no image.
- An image turn with an explicit `responseModalities` signal honours the selected
  image model (`modelSource: accio`) rather than defaulting to Codex++ auto.
- The image group reports the same `contextWindow` as the chat models beside it
  (1,050,000 on the current provider set), so Accio's pre-flight context check passes.
- Neither the user-level nor machine-level `GATEWAY_BASE_URL` is set.

Automated verification:

```text
node tools/test-package.mjs   package tests passed
node tools/test-image.mjs     image tests passed
node tools/test-routing.mjs   routing tests passed
```

The suites cover gzip, deflate, and Brotli decoding, Accio `contents`
payloads, explicit Codex++ model routing, Codex++ Auto fallback for internal
requests, prompt-enhancement routing, tool-choice translation, function-call
history, idempotent streamed tool names, image-versus-text turn routing,
metadata-only probes, and Accio `User-Agent` forwarding with a safe bridge
fallback. `test-image.mjs` adds the Codex++ image pool reader, the separate image
catalog group, gateway/helper selection with auto-upgrade, per-vendor size
formatting, reference-image `edits`, and upstream error mapping.
`test-package.mjs` also asserts that the image client performs no filesystem
writes, so Codex++ state stays read-only.

## Why the old side tool is not needed

The relay, text bridge, image bridge, launcher, and catalog injection are all
part of this Codex++ user script. A separate custom-provider side tool is not
required for the routed-Accio workflow.

## Maintainer note

The practical integration boundary is Accio's startup environment variable `GATEWAY_BASE_URL`. It is behaviorally supported but should be treated as a compatibility point rather than a documented public provider API.

The current package is a user script. It is not yet a built-in **Connect Agent** entry, so the Codex++ developer must add an application-launcher registration before Accio appears there natively. An upstream Codex++ integration can either:

1. add an application launcher that supplies `GATEWAY_BASE_URL` to Accio, or
2. wait for Accio to expose a supported custom OpenAI-compatible provider setting.

No database edits, account-file edits, binary patching, or private Accio endpoint calls are required.

See `MAINTAINER_HANDOFF.md` for the tested paths, request flow, and evidence.
