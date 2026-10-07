# OpenCode Kiro Auth Plugin

[![npm version](https://img.shields.io/npm/v/@servoy/opencode-kiro-auth)](https://www.npmjs.com/package/@servoy/opencode-kiro-auth)
[![npm downloads](https://img.shields.io/npm/dm/@servoy/opencode-kiro-auth)](https://www.npmjs.com/package/@servoy/opencode-kiro-auth)
[![license](https://img.shields.io/npm/l/@servoy/opencode-kiro-auth)](https://www.npmjs.com/package/@servoy/opencode-kiro-auth)

OpenCode plugin for AWS Kiro (CodeWhisperer). It exposes every model Kiro
serves — Claude Opus, Sonnet and Haiku, OpenAI's GPT-5.6 tiers, and the open-weight
models (DeepSeek, GLM, MiniMax, Qwen) — each with its own reasoning dial. Works on
both OpenCode v1 and v2 hosts from the same build.

## Features

- **Every Kiro model**: Claude Opus/Sonnet/Haiku, the GPT-5.6 tiers (Sol, Terra,
  Luna) and the open-weight models, discovered from Kiro's own catalog so each
  carries its real context window and capabilities.
- **v1 and v2 hosts**: One build runs on both OpenCode generations; the host
  binding differs, the request core is shared.
- **Multiple Auth Methods**: AWS Builder ID (IDC), IAM Identity Center (custom
  Start URL), and Kiro Desktop (CLI-based) authentication.
- **Auto-Sync Kiro CLI**: Imports and synchronizes active sessions from your
  local `kiro-cli` SQLite database.
- **Gradual Context Truncation**: Trims oversized conversations to prevent an
  error 400, keeping tool-use/tool-result pairs intact.
- **Intelligent Account Rotation**: Prioritizes multi-account usage based on
  lowest available quota.
- **High-Performance Storage**: Account and usage management on native Bun/Node
  SQLite.
- **Native Thinking Mode**: Streams Kiro's native reasoning to OpenCode's
  thinking block, with the reasoning flags declared on every thinking model, so
  it renders without any model configuration.
- **Reasoning Dial**: Every model that has one carries `off` through `max` as
  OpenCode variants, set per model or per agent. Claude reads
  `output_config.effort`, GPT reads `reasoning.effort`.
- **Automated Recovery**: Exponential backoff for rate limits and automated token
  refresh.

## Installation

Add the plugin to your `opencode.json` or `opencode.jsonc`. The npm package is
the recommended install — it is pinned, versioned and published on every
release:

```json
{
  "plugins": ["@servoy/opencode-kiro-auth"]
}
```

On OpenCode v1 the key is `plugin` (singular); v2 renamed it to `plugins`. The
plugin itself runs on both.

That is the whole configuration. The plugin registers the `kiro` provider and
advertises every model Kiro exposes, each with its own reasoning dial. Run
`/models` to pick one.

### Nightly build

For the latest `master` before it is released, point at the nightly tarball
instead. It is rebuilt and tested on every push to `master`, bundled into a
single file, and published to a fixed release asset:

```json
{
  "plugins": [
    "https://github.com/Servoy/opencode-kiro-auth/releases/download/_master/opencode-kiro-auth.tgz"
  ]
}
```

The URL never changes; the build behind it does. Use it to try an unreleased
fix. It is not version-pinned and can change under you, so prefer the npm
package for anything you depend on.

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
3. **API key**:
   - Create a key under **API Keys** at [app.kiro.dev](https://app.kiro.dev). Kiro offers
     them on the Pro, Pro+, Pro Max and Power plans; on a subscription managed by an
     administrator, the admin has to enable API keys first.
   - Provide it in any of three ways; the plugin validates it with Kiro before saving:
     - **`KIRO_API_KEY` environment variable** (wins over the config file). With it set the
       plugin registers the account on startup — no interactive login, no browser. This is
       the headless / CI path, and the one that lets a GUI-launched host (e.g. an IDE) bring
       the provider up on its own. See _Setting KIRO_API_KEY_ below.
     - **`api_key` in `~/.config/opencode/kiro.json`**. Survives restarts, read by every
       instance on the machine.
     - **Interactive**: run `opencode auth login`, pick **Kiro API key**, and paste the
       `ksk_...` key. When a key is already set in env or config, leaving the field blank
       reuses it (the prompt shows a masked hint, never the full key).
   - The region is handled for you: it comes from the key's own profile ARN. The plugin
     tries `default_region` first, then the other Kiro regions, so you never set a region
     for the key.
   - The plugin never refreshes a key. If Kiro rejects it (revoked, or API keys disabled),
     the account is marked unusable and you are asked to sign in again.
   - If an API key and an Identity Center login cover the **same profile**, the key wins and
     the IDC login is dropped on startup (logged, with the reason), so one subscription does
     not run as a two-account pool. Sign in again if you later remove the key.
   - The key is stored in plain text in `~/.config/opencode/kiro.db` (locked to `0600`), like
     the other credentials, and it is long-lived. Keep that file private. On OpenCode 2 the
     interactive key field is not masked while you type.
   - Kiro documents API keys for CI and headless use and recommends browser sign-in for
     interactive sessions, so using one in OpenCode is outside that guidance and Kiro may
     restrict it.
   - Before downgrading to a plugin version without API key support, remove the key accounts:
     `DELETE FROM accounts WHERE auth_method = 'apikey'` in `kiro.db`.
4. Configuration will be automatically managed at `~/.config/opencode/kiro.db`.

### Setting `KIRO_API_KEY`

A terminal `export` is seen only by programs started from that same shell. A host launched
from a desktop icon, Dock or Finder does **not** inherit it, so set it where the GUI picks
it up. Replace `ksk_your_key` with your own key.

**macOS** — for a `.app` launched from Finder/Dock, use `launchctl`; a plain `~/.zshrc`
`export` reaches terminal `opencode` but not the app:

```bash
launchctl setenv KIRO_API_KEY ksk_your_key     # for GUI-launched apps (resets on reboot)
echo 'export KIRO_API_KEY=ksk_your_key' >> ~/.zprofile   # restores it on next login
```

**Linux** — add to the file your desktop session reads, then log out and back in:

```bash
echo 'export KIRO_API_KEY=ksk_your_key' >> ~/.profile
```

**Windows** — set it for your user (survives restarts), then restart the app:

```powershell
setx KIRO_API_KEY ksk_your_key
```

**Any OS, current terminal only** — for a quick run, prefix the command:

```bash
KIRO_API_KEY=ksk_your_key opencode
```

If a GUI host still will not inherit the variable, use the `api_key` option in
`~/.config/opencode/kiro.json` instead — it does not depend on the environment at all.

## Local plugin development

The simplest way to test local changes is to point OpenCode directly at your local repo
path in `opencode.json` or `opencode.jsonc`:

```json
{
  "plugins": ["/path/to/opencode-kiro-auth"]
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
- `api_key`: A long-lived Kiro API key (`ksk_…`). The `KIRO_API_KEY` environment variable overrides it. See the API-key setup above for how to set the env var per OS. The region is never set here — it comes from the key's profile ARN.

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

- `KIRO_CONFIG_DIR` — move all state (`kiro.json`, `kiro.db`, `kiro-plugin.log`) to an explicit directory.
- `KIRO_CACHE_DIR` — move the regenerable image cache to an explicit directory.
- `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` — honoured on every platform (Windows included), matching OpenCode.
- `KIRO_IGNORE_XDG=true` — ignore `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` and use the OS default location instead. Useful when a host (e.g. Servoy) relocates XDG for its own config but you want the plugin to stay on the standard path. An explicit `KIRO_CONFIG_DIR`/`KIRO_CACHE_DIR` still wins over this. The value is read loosely: `true`/`1` in any case, with surrounding quotes or spaces trimmed.

A GUI-launched host (Servoy from the Dock, Finder or Start menu) does not read
your shell config, so set it where the OS passes it to apps and restart the host:

- **macOS:** `launchctl setenv KIRO_IGNORE_XDG true`
- **Windows:** `setx KIRO_IGNORE_XDG true` (bare `true`, no quotes)

## Releases

Per-version release notes are on the
[releases page](https://github.com/Servoy/opencode-kiro-auth/releases).

## Acknowledgements

Special thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for
providing the foundational Kiro authentication logic and request patterns.

## Disclaimer

This plugin is provided strictly for learning and educational purposes.
It is an independent implementation and is not affiliated with, endorsed by, or
supported by Amazon Web Services (AWS) or Anthropic.
Use of this plugin is at your own risk.

Feel free to open a PR to optimize this plugin further.
