# triptych

> **Three panels, one plan.** A three-model planning debate framework — Claude, Codex (ChatGPT), and **any OpenAI-compatible model** independently plan, cross-review, revise, then one judges. Catches confident-but-wrong architectural decisions that a single model would ship.
>
> CLI is installed as `triptych` (primary) or `pj` (short alias).

## Why

Frontier LLMs are confident even when wrong. A single model answering "design a distributed rate limiter with strong consistency and 1M QPS" will often converge on an architecturally broken design (e.g. optimistic-write-plus-rollback) and defend it fluently. Having three independent models review each other surfaces these mistakes before they become your `main` branch.

The framework's core value is showing up empirically. In our validation run on a distributed systems task, the third planner's initial plan violated the stated consistency requirement with an "AP + rollback" approach — Claude and Codex **independently** flagged the same fatal error, forcing a correct revision before the judge saw it. That correction almost never happens in a single-model flow.

## What it is

A CLI + library that runs a five-round planning debate:

```
R0 framing   →  R1 plan   →  R2 critique   →  R3 revise   →  R4 judge
 (aligning)     (independent)  (cross-review)   (respond to critique)   (synthesize)
```

Three providers in parallel per phase:

- **Claude** — Anthropic `claude-opus-4-7`, via your Claude/Claude Code subscription (OAuth)
- **Codex** — OpenAI `gpt-5.4`, via your ChatGPT Plus/Pro subscription (OAuth against WHAM endpoint)
- **OAI** — **any OpenAI-Chat-Completions-compatible endpoint**, via API key. Default: OpenRouter with `minimax/minimax-m2.7`. Swap to DeepSeek, Kimi (Moonshot), GLM (Zhipu), Qwen (DashScope), MiniMax, Groq, Mistral, xAI Grok, Together, Fireworks, Cerebras, DeepInfra, SiliconFlow, Doubao, Perplexity, or direct OpenAI by pointing at a different `base_url` — see [Presets](#oai-presets).

Each provider can optionally run as a full agent (multi-turn tool use over Read / Grep / Glob / WebFetch plus server-side WebSearch) instead of a single LLM call.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full design and rationale.

## Install

Requires [Bun](https://bun.sh) ≥ 1.0.

```bash
git clone <this-repo> triptych && cd triptych
bun install
```

To install the CLI on your PATH (both `triptych` and `pj` aliases):

```bash
bun link        # adds bin shims for the current checkout
# or: npm install -g .
```

Examples below use `bun src/cli.ts` so they work without linking. Once linked, drop the prefix and use `triptych` (or the short alias `pj`) directly.

Optional for better `grep`:

```bash
brew install ripgrep     # rg; otherwise `grep` fallback is used
```

## Configure

Authenticate at least two providers (one works but defeats the point):

```bash
# Claude (claude.ai / Claude Pro / Max / Claude Code subscription)
bun src/cli.ts login claude

# Codex (ChatGPT Plus/Pro)
bun src/cli.ts login codex

# OAI (the third slot) — pick any OpenAI-compatible provider + key
bun src/cli.ts config preset deepseek       # or kimi / glm / qwen / minimax / groq / ...
bun src/cli.ts config set oai_api_key sk-...

# Verify
bun src/cli.ts status
```

The third slot defaults to OpenRouter. Use a preset to switch endpoints in one command — presets update `oai_base_url` and the default `oai_model`:

```bash
bun src/cli.ts config preset                  # list all presets
bun src/cli.ts config preset kimi             # Moonshot Kimi (intl)
bun src/cli.ts config preset glm-cn           # Zhipu GLM (CN mainland)
bun src/cli.ts config preset qwen             # Alibaba Qwen
bun src/cli.ts config preset deepseek         # DeepSeek
```

Or set the two fields directly for an endpoint we don't have a preset for:

```bash
bun src/cli.ts config set oai_base_url https://my-gateway.example.com/v1
bun src/cli.ts config set oai_model my-model-id
bun src/cli.ts config set oai_api_key sk-...
```

Optional: enable web search for research-heavy tasks.

```bash
bun src/cli.ts config set claude_web_search true
bun src/cli.ts config set codex_web_search true
bun src/cli.ts config set oai_web_search true      # appends ':online' — only honored when base_url is OpenRouter
```

Optional: enable agent mode (multi-turn tool use, valuable when the task involves reading a real codebase).

```bash
bun src/cli.ts config set claude_agent true
bun src/cli.ts config set codex_agent true
bun src/cli.ts config set oai_agent true
```

### OAI presets

| Preset | Endpoint | Default model |
|---|---|---|
| `openrouter`  (default) | `https://openrouter.ai/api/v1` | `minimax/minimax-m2.7` |
| `deepseek`    | `https://api.deepseek.com` | `deepseek-chat` |
| `kimi`        | `https://api.moonshot.ai/v1` | `kimi-k2-turbo-preview` |
| `kimi-cn`     | `https://api.moonshot.cn/v1` | `kimi-k2-turbo-preview` |
| `glm`         | `https://api.z.ai/api/paas/v4/` | `glm-5.1` |
| `glm-cn`      | `https://open.bigmodel.cn/api/paas/v4/` | `glm-5.1` |
| `qwen`        | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3-coder-plus` |
| `qwen-cn`     | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-coder-plus` |
| `minimax`     | `https://api.minimax.io/v1` | `MiniMax-M2` |
| `minimax-cn`  | `https://api.minimaxi.com/v1` | `MiniMax-M2` |
| `groq`        | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| `mistral`     | `https://api.mistral.ai/v1` | `mistral-large-latest` |
| `xai`         | `https://api.x.ai/v1` | `grok-4` |
| `together`    | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| `fireworks`   | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/deepseek-v3` |
| `cerebras`    | `https://api.cerebras.ai/v1` | `llama-3.3-70b` |
| `deepinfra`   | `https://api.deepinfra.com/v1/openai` | `MiniMaxAI/MiniMax-M2` |
| `siliconflow` | `https://api.siliconflow.com/v1` | `deepseek-ai/DeepSeek-V3` |
| `doubao`      | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-pro` |
| `perplexity`  | `https://api.perplexity.ai` | `sonar-pro` |
| `openai`      | `https://api.openai.com/v1` | `gpt-5.4-mini` |

Default model ids are a starting point — override with `pj config set oai_model <id>` if you want a different one. Endpoints that don't appear above still work fine via manual `oai_base_url` + `oai_model`.

## Run

```bash
bun src/cli.ts run "Design a distributed rate limiter supporting token-bucket,
sliding-window, and leaky-bucket; strongly consistent across partitions; rule
hot-reload; Prometheus + trace; Go; 1M QPS, P99 < 5ms."
```

With output saved:

```bash
# Full debate (JSON: all rounds + metadata):
bun src/cli.ts run "<task>" --output /tmp/debate.json --judge rotate

# Just the Final Plan markdown (ready to paste into a PR or doc):
bun src/cli.ts run "<task>" --plan-out plan.md

# Both at once:
bun src/cli.ts run "<task>" -o /tmp/debate.json -p plan.md
```

Verbose streaming (watch each model think in real time):

```bash
bun src/cli.ts run "<task>" -v
```

Constrain the providers:

```bash
bun src/cli.ts run "<task>" --providers claude,oai
```

## CLI reference

```
triptych run <task> [options]
  --context <text>          Additional task context
  --judge <strategy>        rotate | claude | codex | oai | vote   (default: rotate)
  --providers <csv>         Subset of claude,codex,oai              (default: all)
  --no-stream               Suppress live token stream
  -v, --verbose             Show every model's output as it streams
  -o, --output <file>       Save full debate JSON (R0–R4 + metadata)
  -p, --plan-out <file>     Save just the Final Plan as a standalone .md file

triptych login <provider>              OAuth flow for claude | codex
triptych status                        Show auth + config state for all providers
triptych config set <key> <value>      Set a config key
triptych config show                   Print config (secrets redacted)
triptych config preset [name]          List or apply an OAI endpoint preset
triptych config preset <name> --keep-model   Apply preset without touching oai_model
```

(Everywhere above, `pj` is a synonym for `triptych`. `openrouter` is still accepted as a legacy alias for `oai` in `--providers`, `--judge`, and the legacy `openrouter_*` config keys.)

**Config keys** (stored in `~/.triptych/config.json`; legacy `~/.planing-judeger/config.json` is auto-migrated on first read):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `claude_model` | string | `claude-opus-4-7` | Anthropic model id |
| `claude_web_search` | bool | `false` | Enable server-side `web_search_20250305` tool |
| `claude_agent` | bool | `false` | Run Claude as an agent with Read/Grep/Glob/WebFetch tools |
| `codex_model` | string | `gpt-5.4` | Codex model id (also valid: `gpt-5.4-mini`, `gpt-4.1`, `gpt-4o`, ...) |
| `codex_web_search` | bool | `false` | Enable native WHAM `web_search` tool |
| `codex_agent` | bool | `false` | Run Codex as an agent |
| `oai_api_key` | string | — | **Required.** Your API key for whichever OpenAI-compatible endpoint you're using. |
| `oai_base_url` | string | `https://openrouter.ai/api/v1` | Endpoint base URL. `pj config preset <name>` sets this for you. |
| `oai_model` | string | `minimax/minimax-m2.7` | Model id for the configured endpoint. |
| `oai_web_search` | bool | `false` | Only meaningful on OpenRouter — appends `:online` to the model id. Other endpoints ignore this flag. |
| `oai_agent` | bool | `false` | Run the OAI provider as an agent |
| `oai_display_name` | string | auto | Friendly label shown in `status`. Auto-inferred from `oai_base_url` when unset. |
| `oai_extra_headers` | object | `{}` | Optional custom headers to send on every request (e.g. `{"Workspace-Id": "abc"}`). |
| `default_judge` | strategy | `rotate` | Used when `--judge` is omitted |

Legacy keys `openrouter_api_key`, `openrouter_model`, `openrouter_web_search`, `openrouter_agent` are still read as fallbacks, so existing installs keep working without edits.

## Judge strategies

- **`rotate`** — each run picks a different provider as judge (persistent round-robin). Default. Removes judge bias across multiple runs.
- **`claude` / `codex` / `oai`** — pin the judge to one provider.
- **`vote`** — all providers judge in parallel; their syntheses are concatenated. Heaviest; most expensive.

## When to use which mode

| Mode | Good for | Bad for |
|---|---|---|
| Default (single LLM per phase, no web, no agent) | Quick greenfield architecture brainstorm | Tasks that need real citations or current info |
| `+web` on all providers | Greenfield + research (tech choice, API contracts) | Fast iteration — each search adds 2–5s |
| `+agent` on all providers | Modifying an existing codebase, refactoring, cross-file planning | Greenfield — no files to read, marginal benefit |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the detailed design and evaluation data.

## Output shape

`--output <file>` writes the full debate JSON:

```jsonc
{
  "task": "...",
  "rounds": {
    "r0_frames":     [ { provider, model, frame, durationMs } ],
    "r1_plans":      [ { provider, model, plan, durationMs } ],
    "r2_critiques":  [ { reviewer, target, critique, durationMs } ],   // N×(N-1) entries
    "r3_revisions":  [ { provider, model, revision, durationMs } ],
    "r4_judgment":   { judge, finalPlan, reasoning, durationMs }
  },
  "totalDurationMs": 1040123
}
```

The user-facing deliverable is `rounds.r4_judgment.finalPlan`, extracted from the judge's output starting at the `## Final Plan` heading. Use `--plan-out plan.md` to write just that field as a standalone Markdown file without the rest of the JSON.

## Library use

```ts
import {
  ClaudeProvider, CodexProvider, OAIProvider,
  Orchestrator,
} from 'triptych'

const orchestrator = new Orchestrator(
  [new ClaudeProvider(), new CodexProvider(), new OAIProvider()],
  { judge: 'rotate' },
)

const result = await orchestrator.run(
  { task: 'your task here' },
  (event) => console.log(event.phase),    // optional progress callback
)

console.log(result.rounds.r4_judgment.finalPlan)
```

`OpenRouterProvider` is still exported as a deprecated alias for `OAIProvider` so existing library consumers keep working.

## Costs and wall time

Rough ballpark on a medium architectural task (varies with prompt size and model choice):

| Mode | Wall time | API cost per run |
|---|---|---|
| Bare (no web, no agent) | 5–9 min | Low — covered by one provider's subscription for two of three |
| + web search | 7–11 min | Same; server-side search is included for Claude/Codex subs |
| + full agent mode (all three) | 15–25 min | Higher — agent turns multiply token usage |

Claude and Codex charge against your existing OAuth subscription (not per-token API billing). The OAI slot is the only out-of-pocket cost; pick a cheap model for that slot to keep runs nearly free.

## Acknowledgements

- OAuth and WHAM endpoint patterns adapted from [claude-code-source-all-in-one](../claude-code-source-all-in-one)
- Codex WHAM tool calling pattern from [openYak/openyak](../openYak)
- ripgrep fallback pattern inspired by Claude Code's built-in tool design

## License

MIT
