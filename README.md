# dsh-nvidia-models-panel (One-Balance Edition)

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) sidebar plugin forked from [`windxxf/dsh-nvidia-models-panel`](https://github.com/windxxf/dsh-nvidia-models-panel) to route NVIDIA NIM inference through [`akincansenol/one-balance`](https://github.com/akincansenol/one-balance) and Cloudflare AI Gateway.

## Prerequisites (`one-balance`)

This plugin requires a working [`akincansenol/one-balance`](https://github.com/akincansenol/one-balance) deployment for key rotation, rate-limit cooldowns, and request forwarding:

1. Deploy [`akincansenol/one-balance`](https://github.com/akincansenol/one-balance) on Cloudflare Workers + D1.
2. In your Cloudflare AI Gateway, add a **Custom Provider** with slug **`custom-nvidia`** and Base URL `https://integrate.api.nvidia.com/v1`.
3. Add your NVIDIA NIM API keys into `one-balance` under the `nvidia` provider.
4. *(Self-hosting)* Update `ONE_BALANCE_COMPLETIONS_URL` and `baseUrl` in `src/index.js` if you are using your own `one-balance` Worker URL instead of `https://one-balance.eplani.com.tr/api/compat`.

## Features

- **Detect Models**: Fetches the live model catalog anonymously from NVIDIA NIM (`https://integrate.api.nvidia.com/v1/models` — no API key required for listing).
- **Verify All**: Probes each chat model via `one-balance` using a streaming first-byte check (60s initial / 90s retry timeout to tolerate NVIDIA queueing).
- **Save Key**: Stores your `ONE_BALANCE_API_KEY` (`AUTH_KEY`) in DSH's credential store (never written to config files or logs).
- **One-Click Configure**: Writes verified models (prefixed with `custom-nvidia/`) into `@deepseek-ai/dsh-llm-pi-ai` under the `one-balance-nvidia` provider.
- **NVIDIA Group (`nvidia-group`)**: Virtual auto-failover provider with **NVIDIA Group (Auto)** (`__auto__`), circuit-breaker cooldowns (20s–5m exponential backoff), 30s first-byte / 60s first-text watchdogs, multimodal-aware soft routing, and `EMPTY_ANSWER` protection for reasoning models.
- **Group Health & Usage Log**: Real-time member health, manual probe/reset controls, daily call/token/failover logs persisted to `$DSH_PROFILE_DIR/nvidia-usage.json`, and a composer dock badge.

## Installation

In DeepSeek Harness (`plugin_manager` → `install_bundle`):

```text
github:akincansenol/dsh-nvidia-models-panel
```

Or install from a local clone:

```bash
git clone https://github.com/akincansenol/dsh-nvidia-models-panel.git
```

Refresh the page after enabling the plugin.

## Usage

1. Open **NVIDIA Models** in the sidebar.
2. Paste your One-Balance `AUTH_KEY` and click **Save Key**.
3. Click **Detect Models** → **Verify All** → **One-Click Configure**.
4. Select **NVIDIA Group (Auto)** (or any configured `one-balance-nvidia` model) in the chat model picker.

## Requirements

- DeepSeek Harness `>= 0.2.1-rc.2`
- Zero npm dependencies (all runtime services provided by DSH)

## License

[MIT](LICENSE)
