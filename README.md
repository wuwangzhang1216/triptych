# triptych

> **Three panels, one plan.** A three-model planning debate framework — Claude, Codex (ChatGPT), and a third model via OpenRouter independently plan, cross-review, revise, then one judges. Catches confident-but-wrong architectural decisions that a single model would ship.
>
> CLI is installed as `triptych` (primary) or `pj` (short alias).

## Why

Frontier LLMs are confident even when wrong. A single model answering "design a distributed rate limiter with strong consistency and 1M QPS" will often converge on an architecturally broken design (e.g. optimistic-write-plus-rollback) and defend it fluently. Having three independent models review each other surfaces these mistakes before they become your `main` branch.

The framework's core value is showing up empirically. In our validation run on a distributed systems task, OpenRouter's initial plan violated the stated consistency requirement with an "AP + rollback" approach — Claude and Codex **independently** flagged the same fatal error, forcing a correct revision before the judge saw it. That correction almost never happens in a single-model flow.

## What it is

A CLI + library that runs a five-round planning debate:

```
R0 framing   →  R1 plan   →  R2 critique   →  R3 revise   →  R4 judge
 (aligning)     (independent)  (cross-review)   (respond to critique)   (synthesize)
```

Three providers in parallel per phase:

- **Claude** — Anthropic `claude-opus-4-7`, via your Claude/Claude Code subscription (OAuth)
- **Codex** — OpenAI `gpt-5.4`, via your ChatGPT Plus/Pro subscription (OAuth against WHAM endpoint)
- **OpenRouter** — any model (default `minimax/minimax-m2.7`), via API key

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

# OpenRouter — API key only, no OAuth
bun src/cli.ts config set openrouter_api_key sk-or-v1-...

# Verify
bun src/cli.ts status
```

Optional: enable web search for research-heavy tasks.

```bash
bun src/cli.ts config set claude_web_search true
bun src/cli.ts config set codex_web_search true
bun src/cli.ts config set openrouter_web_search true   # appends ':online' to the model
```

Optional: enable agent mode (multi-turn tool use, valuable when the task involves reading a real codebase).

```bash
bun src/cli.ts config set claude_agent true
bun src/cli.ts config set codex_agent true
bun src/cli.ts config set openrouter_agent true
```

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
bun src/cli.ts run "<task>" --providers claude,openrouter
```

## CLI reference

```
triptych run <task> [options]
  --context <text>          Additional task context
  --judge <strategy>        rotate | claude | codex | openrouter | vote   (default: rotate)
  --providers <csv>         Subset of claude,codex,openrouter              (default: all)
  --no-stream               Suppress live token stream
  -v, --verbose             Show every model's output as it streams
  -o, --output <file>       Save full debate JSON (R0–R4 + metadata)
  -p, --plan-out <file>     Save just the Final Plan as a standalone .md file

triptych login <provider>         OAuth flow for claude | codex
triptych status                   Show auth + config state for all providers
triptych config set <key> <value> Set a config key
triptych config show              Print config (secrets redacted)
```

(Everywhere above, `pj` is a synonym for `triptych`.)

**Config keys** (stored in `~/.triptych/config.json`; legacy `~/.planing-judeger/config.json` is auto-migrated on first read):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `claude_model` | string | `claude-opus-4-7` | Anthropic model id |
| `claude_web_search` | bool | `false` | Enable server-side `web_search_20250305` tool |
| `claude_agent` | bool | `false` | Run Claude as an agent with Read/Grep/Glob/WebFetch tools |
| `codex_model` | string | `gpt-5.4` | Codex model id (also valid: `gpt-5.4-mini`, `gpt-4.1`, `gpt-4o`, ...) |
| `codex_web_search` | bool | `false` | Enable native WHAM `web_search` tool |
| `codex_agent` | bool | `false` | Run Codex as an agent |
| `openrouter_api_key` | string | — | Required |
| `openrouter_model` | string | `minimax/minimax-m2.7` | Any OpenRouter model id |
| `openrouter_web_search` | bool | `false` | Appends `:online` to the model |
| `openrouter_agent` | bool | `false` | Run OpenRouter as an agent |
| `default_judge` | strategy | `rotate` | Used when `--judge` is omitted |

## Judge strategies

- **`rotate`** — each run picks a different provider as judge (persistent round-robin). Default. Removes judge bias across multiple runs.
- **`claude` / `codex` / `openrouter`** — pin the judge to one provider.
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
  ClaudeProvider, CodexProvider, OpenRouterProvider,
  Orchestrator,
} from 'triptych'

const orchestrator = new Orchestrator(
  [new ClaudeProvider(), new CodexProvider(), new OpenRouterProvider()],
  { judge: 'rotate' },
)

const result = await orchestrator.run(
  { task: 'your task here' },
  (event) => console.log(event.phase),    // optional progress callback
)

console.log(result.rounds.r4_judgment.finalPlan)
```

## Costs and wall time

Rough ballpark on a medium architectural task (varies with prompt size and model choice):

| Mode | Wall time | API cost per run |
|---|---|---|
| Bare (no web, no agent) | 5–9 min | Low — covered by one provider's subscription for two of three |
| + web search | 7–11 min | Same; server-side search is included for Claude/Codex subs |
| + full agent mode (all three) | 15–25 min | Higher — agent turns multiply token usage |

All three OAuth-subscription providers (Claude, Codex) charge against your existing subscription, not per-token API billing. OpenRouter is the only out-of-pocket cost in the default config.

## Acknowledgements

- OAuth and WHAM endpoint patterns adapted from [claude-code-source-all-in-one](../claude-code-source-all-in-one)
- Codex WHAM tool calling pattern from [openYak/openyak](../openYak)
- ripgrep fallback pattern inspired by Claude Code's built-in tool design

## License

MIT
