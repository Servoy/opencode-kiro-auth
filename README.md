# OpenCode Kiro Auth Plugin

[![npm version](https://img.shields.io/npm/v/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![npm downloads](https://img.shields.io/npm/dm/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![license](https://img.shields.io/npm/l/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)

OpenCode plugin for AWS Kiro (CodeWhisperer) providing access to Claude Sonnet and Haiku
models with substantial trial quotas.

## Features

- **Multiple Auth Methods**: Supports AWS Builder ID (IDC), IAM Identity Center (custom
  Start URL), and Kiro Desktop (CLI-based) authentication.
- **Auto-Sync Kiro CLI**: Automatically imports and synchronizes active sessions from
  your local `kiro-cli` SQLite database.
- **Gradual Context Truncation**: Intelligently prevents error 400 by reducing context
  size dynamically during retries.
- **Intelligent Account Rotation**: Prioritizes multi-account usage based on lowest
  available quota.
- **High-Performance Storage**: Efficient account and usage management using native Bun
  SQLite.
- **Native Thinking Mode**: Streams Kiro's native reasoning to OpenCode's thinking
  block, with the reasoning flags declared on every thinking model, so it renders
  without any model configuration.
- **Reasoning Dial**: Every model that has one carries `off` through `max` as
  OpenCode variants, set per model or per agent.
- **Automated Recovery**: Exponential backoff for rate limits and automated token
  refresh.

## Installation

Add the plugin to your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@servoy/opencode-kiro-auth"]
}
```

That is the whole configuration. The plugin registers the `kiro` provider and
advertises every model Kiro exposes, each with its own reasoning dial. Run
`/models` to pick one.

Defining `provider.kiro.models` yourself replaces the plugin's registry entirely.
Only do that to rename or restrict models, and see the reasoning flags below.

### Thinking Effort Configuration

Every model with a reasoning dial declares two fields OpenCode needs in order to
render what comes back:

```json
{
  "reasoning": true,
  "interleaved": { "field": "reasoning_content" }
}
```

Both are required. `reasoning` declares the capability, and `interleaved.field`
tells OpenCode that reasoning arrives in the non-standard `reasoning_content`
delta this plugin emits. If either is missing, OpenCode silently drops every
reasoning chunk and no thinking block appears.

If you override `provider.kiro.models` in your own config, you replace the
plugin's registry wholesale — copy both fields onto any model you define that
should reason, or reasoning will stop rendering.

Reasoning itself comes from the API: Kiro streams `reasoningContentEvent` on
thinking models, and the plugin forwards each one as a `reasoning_content` delta.
Nothing needs to be enabled for that. Models that instead inline reasoning as
`<thinking>` tags in their answer are still handled, via a fallback scraper.

Every model the catalog says has a reasoning dial carries it as OpenCode
variants: `off`, `low`, `medium`, `high`, `xhigh`, `max`. Pick one per model, or
per agent with `"variant"` in `opencode.json`. OpenCode sends the choice as a
top-level `reasoning_effort` and the plugin passes that level on as it is.

`off` is a real position: it sends `thinking.type = disabled`. Choosing no
variant is not the same thing — the service then applies its own default, which
its catalog reports as `high`.

`xhigh` appears only on models whose catalog entry lists it; the rest offer four
levels. The Claude family reads `output_config.effort` and the GPT family reads
`reasoning.effort`, so each gets the channel it understands.

Temperature and top_p do nothing: CodeWhisperer has no such fields, and the
plugin says so, so OpenCode stops offering them.

Use `~/.config/opencode/kiro.json` for plugin-wide behavior such as auth sync,
account selection and retry limits. Every setting with a default is listed in
that file, and a setting added by a later version is appended on start.

## Setup

1. **Authentication via Kiro CLI (Recommended)**:
   - Perform login directly in your terminal using `kiro-cli login`.
   - The plugin automatically bootstraps a minimal `kiro` placeholder in
     OpenCode's `auth.json` when it detects the Kiro CLI database, then imports
     and synchronizes your active session on startup.
   - For AWS IAM Identity Center (SSO/IDC), the plugin imports both the token and device
     registration (OIDC client credentials) from the `kiro-cli` database.
2. **Direct Authentication**:
   - Run `opencode auth login`.
   - Select `Other`, type `kiro`, and press enter.
   - You'll be prompted for your **IAM Identity Center Start URL** and **IAM Identity
     Center region** (`sso_region`).
     - Leave it blank to sign in with **AWS Builder ID**.
     - Enter your company's Start URL (e.g. `https://your-company.awsapps.com/start`) to
       use **IAM Identity Center (SSO)**.
   - Note: the TUI `/connect` flow currently does **not** run plugin OAuth prompts
     (Start URL / region), so Identity Center logins may fall back to Builder ID unless
     you use `opencode auth login` (or preconfigure defaults in
     `~/.config/opencode/kiro.json`).
   - For **IAM Identity Center**, you may also need a **profile ARN** (`profileArn`).
     - If `kiro-cli` is installed and you've selected a profile once
       (`kiro-cli profile`), the plugin auto-detects it.
     - Otherwise, set `idc_profile_arn` in `~/.config/opencode/kiro.json`.
   - A browser window will open directly to AWS' verification URL (no local auth
     server). If it doesn't, copy/paste the URL and enter the code printed by OpenCode.
   - You can also pre-configure defaults in `~/.config/opencode/kiro.json` via
     `idc_start_url` and `idc_region`.
3. Configuration will be automatically managed at `~/.config/opencode/kiro.db`.

## Local plugin development

The simplest way to test local changes is to point OpenCode directly at your local repo
path in `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["/path/to/opencode-kiro-auth"]
}
```

Then build and restart OpenCode to pick up changes:

```bash
npm run build
```

## Troubleshooting

### Error: Status: 403 (AccessDeniedException / User is not authorized)

If you're using **IAM Identity Center** (a custom Start URL), the Q Developer /
CodeWhisperer APIs typically require a **profile ARN**.

This plugin reads the active profile ARN from your local `kiro-cli` database
(`state.key = api.codewhisperer.profile`) and sends it as `profileArn`.

Fix:

1. Run `kiro-cli profile` and select a profile (e.g. `QDevProfile-us-east-1`).
2. Retry `opencode auth login` (or restart OpenCode so it re-syncs).

### Error: No accounts

This happens when the plugin has no records in `~/.config/opencode/kiro.db`.

1. Ensure `kiro-cli login` succeeds.
2. Ensure `auto_sync_kiro_cli` is `true` in `~/.config/opencode/kiro.json`.
3. Retry the request; the plugin will attempt a Kiro CLI sync when it detects zero
   accounts.

### Note: `/connect` vs `opencode auth login`

If you need to enter provider-specific values for an OAuth login (like IAM Identity
Center Start URL / region), use `opencode auth login`. The current TUI `/connect` flow
may not display plugin OAuth prompts, so it can’t collect those inputs.

Note for IDC/SSO (ODIC): the plugin may temporarily create an account with a placeholder
email if it cannot fetch the real email during sync (e.g. offline).
It will replace it with the real email once usage/email lookup succeeds.

### Kiro CLI (Google/GitHub OAuth) users: plugin sync does not start

If you authenticated via `kiro-cli login` using Google or GitHub OAuth (not AWS Builder
ID or IAM Identity Center), OpenCode still needs a stored `kiro` auth entry before it
will call the plugin loader.

The plugin now creates that minimal placeholder automatically when it detects the local
Kiro CLI database. Restart OpenCode after `kiro-cli login`; the loader should then run
and sync your actual tokens into `kiro.db`. The placeholder values are not used for API
calls.

If bootstrap is skipped because `auth.json` is malformed, fix the JSON first. The plugin
will not overwrite malformed auth files because they may contain other provider
credentials.

**Important:** Ensure `auto_sync_kiro_cli` is `true` in `~/.config/opencode/kiro.json`
and that `kiro-cli login` succeeds.

The plugin supports extensive configuration options.
Edit `~/.config/opencode/kiro.json`. The file is created with every setting
below, and any setting added by a later version is appended to it on start,
so it always lists what the plugin actually does.

```json
{
  "account_selection_strategy": "lowest-usage",
  "default_region": "us-east-1",
  "rate_limit_retry_delay_ms": 5000,
  "rate_limit_max_retries": 3,
  "max_request_iterations": 20,
  "request_timeout_ms": 300000,
  "token_expiry_buffer_ms": 300000,
  "usage_sync_max_retries": 3,
  "usage_tracking_enabled": true,
  "auto_sync_kiro_cli": true,
  "enable_log_api_request": false,
  "web_search_enabled": true,
  "image_carry_forward": true,
  "max_payload_bytes": 5000000,
  "trace": false,
  "show_usage_in_model_name": true
}
```

### Configuration Options

- `account_selection_strategy`: Which account serves a new session: `sticky`, `round-robin` or `lowest-usage`. A session then stays on whichever one answered. Default: `"lowest-usage"`.
- `default_region`: AWS region used when an account does not name one. Default: `"us-east-1"`.
- `rate_limit_retry_delay_ms`: How long to wait after a 429 before trying again. Default: `5000`.
- `rate_limit_max_retries`: How many times, before the error is shown instead. Default: `3`.
- `max_request_iterations`: Attempts within one request — account switches, token refreshes, retries. Not agent steps: the guard against a request that never settles. Default: `20`.
- `request_timeout_ms`: How long Kiro may take to _start_ answering, and how long we keep retrying one request. Not a limit on the answer: once it starts streaming it runs to the end. The wait grows with the conversation — a 300k-token history has been measured at 77 seconds. Default: `300000`.
- `token_expiry_buffer_ms`: Refresh a token this long before it expires, so it never expires mid-answer. Default: `300000`.
- `usage_sync_max_retries`: Attempts to read your quota. Failing leaves the last known percentage in place. Default: `3`.
- `usage_tracking_enabled`: Track quota and warn as it runs out. Default: `true`.
- `auto_sync_kiro_cli`: Import accounts the Kiro CLI has already signed in. Default: `true`.
- `enable_log_api_request`: Log the full request and response bodies. Heavy; `trace` is usually enough. Default: `false`.
- `web_search_enabled`: Offer Kiro's web_search tool. Default: `true`.
- `image_carry_forward`: Repeat an image on later turns of the conversation it arrived in. Without it the model loses sight of it after the first answer. Default: `true`.
- `max_payload_bytes`: Trim the conversation to fit this before sending. Default: `5000000`.
- `trace`: Log what each request carries and where its time went. Default: `false`.
- `show_usage_in_model_name`: Append the account quota to every model name — the one place OpenCode renders for a provider in all its clients. Default: `true`.

### Optional

These have no default and stay out of the file — setting a value turns them
on rather than describing them.

- `idc_start_url`: IAM Identity Center start URL. Unset means AWS Builder ID.
- `idc_region`: IAM Identity Center (SSO OIDC) region. Defaults to `us-east-1`.
- `idc_profile_arn`: Q Developer profile ARN, when your organisation requires one.

## Storage

**Linux/macOS:**

- SQLite Database: `~/.config/opencode/kiro.db`
- Plugin Config: `~/.config/opencode/kiro.json`

**Windows:**

- SQLite Database: `%APPDATA%\opencode\kiro.db`
- Plugin Config: `%APPDATA%\opencode\kiro.json`

### Relocating the storage directory

The plugin follows OpenCode's own directory resolution. You can override it with
environment variables:

- `KIRO_CONFIG_DIR` — move all state (`kiro.json`, `kiro.db`, `plugin.log`) to an explicit directory.
- `KIRO_CACHE_DIR` — move the regenerable image cache to an explicit directory.
- `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` — honoured on every platform (Windows included), matching OpenCode.
- `KIRO_IGNORE_XDG=true` — ignore `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` and use the OS default location instead. Useful when a host (e.g. Servoy) relocates XDG for its own config but you want the plugin to stay on the standard path. An explicit `KIRO_CONFIG_DIR`/`KIRO_CACHE_DIR` still wins over this.

## Acknowledgements

Special thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for
providing the foundational Kiro authentication logic and request patterns.

## Disclaimer

This plugin is provided strictly for learning and educational purposes.
It is an independent implementation and is not affiliated with, endorsed by, or
supported by Amazon Web Services (AWS) or Anthropic.
Use of this plugin is at your own risk.

Feel free to open a PR to optimize this plugin further.
