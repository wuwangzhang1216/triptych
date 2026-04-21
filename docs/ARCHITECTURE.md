# triptych — Architecture & Design

## Problem statement

A single frontier LLM asked to produce an architectural plan will:

1. **Write confidently, even when wrong.** On a task with conflicting requirements (e.g. strong consistency across partitions at 1M QPS / P99 < 5ms), models routinely propose architectures that violate one of the constraints while asserting they satisfy all — in fluent prose that is hard to spot as broken.
2. **Pad with generic best-practices.** "Add observability, logging, tracing, Prometheus, OpenTelemetry, Grafana" is a motherhood paragraph that fills space without load-bearing decisions.
3. **Hide disagreement internally.** When there are three reasonable architectures (A, B, C), a single model often silently picks one — you lose the fact that this was a contested choice and the rationale for the rejected options.

Three models independently, plus cross-critique and synthesis, mitigates all three failure modes. That is the core design hypothesis. We've validated it empirically (see [Empirical evidence](#empirical-evidence)).

## Design philosophy

Five explicit principles, in priority order:

1. **Triangulation over depth.** Three independent mid-depth analyses beat one deep analysis for catching confident errors. A single model going 20 layers deep still has the same priors and blind spots; three models going 5 layers deep each have different priors.
2. **Make disagreement visible.** The orchestrator preserves every round: independent plans, critiques, revisions, judgment. Nothing is silently dropped or averaged. The judge must explicitly reject rather than quietly omit.
3. **Separate framing from planning.** Misunderstanding the problem is a larger source of error than misdesigning the solution. R0 forces alignment on constraint interpretation before anyone commits to an architecture.
4. **Enforce rigor via prompts, not review.** Strong prompts (each decision must name a rejected alternative; each number must have math; no motherhood statements) change the output distribution directly. Review catches defects after the fact; prompts prevent them.
5. **Agent > LLM only when the task benefits.** Agent mode costs ~1.5× wall time. It pays off only when the task requires reading a real codebase or doing iterative research. For greenfield architecture brainstorms, strong prompts + single LLM calls are Pareto-optimal.

## The five-round debate

```
   ┌────────────────────────────────────────────────────────────────┐
   │                           Task                                 │
   └─────────────────────────────┬──────────────────────────────────┘
                                 │
                                 ▼
     ┌───────────────────────────────────────────────────────────┐
     │  R0  TASK FRAMING                      (all 3 in parallel) │
     │                                                            │
     │  Each planner produces: Restatement / Hard Constraints /   │
     │  Implicit Constraints / Ambiguities / Success Criteria /   │
     │  Known Tensions.  NO SOLUTIONS.  Flags ambiguities,        │
     │  doesn't resolve them.                                     │
     │                                                            │
     │  Output: 3 frames, ~400 words each.                        │
     └─────────────────────────┬─────────────────────────────────┘
                               │  (all 3 frames fed to all planners)
                               ▼
     ┌───────────────────────────────────────────────────────────┐
     │  R1  INDEPENDENT PLANNING              (all 3 in parallel) │
     │                                                            │
     │  Each planner, knowing the other frames, produces a full   │
     │  plan.  Required structure:                                │
     │    - Overview + core tradeoff                              │
     │    - Key Decisions (each with rationale AND rejected alt.)│
     │    - Step-by-Step Plan with phase dependencies             │
     │    - Risks & Mitigations (ranked, each with detection)     │
     │    - Success Criteria (testable, not aspirational)         │
     │                                                            │
     │  Every number must have its math shown.                    │
     │  "Industry standard" / "best practice" are banned.         │
     └─────────────────────────┬─────────────────────────────────┘
                               │  (plans cross-connected)
                               ▼
     ┌───────────────────────────────────────────────────────────┐
     │  R2  CROSS-CRITIQUE        (N×(N-1) = 6 pairs in parallel) │
     │                                                            │
     │  Each planner reviews each other planner's plan.           │
     │  Required structure:                                       │
     │    - Strengths (2–3, with quotes)                          │
     │    - Critical Issues (must anchor to quoted text)          │
     │    - Gaps & Blind Spots                                    │
     │    - Improvement Suggestions (3–5, actionable)             │
     │    - Overall Score X/10                                    │
     │                                                            │
     │  NO reframing — you review their plan, not write yours.    │
     └─────────────────────────┬─────────────────────────────────┘
                               │  (each planner sees its own critiques)
                               ▼
     ┌───────────────────────────────────────────────────────────┐
     │  R3  REVISION                          (all 3 in parallel) │
     │                                                            │
     │  Each planner, having seen critiques of its own R1:        │
     │    - ACCEPT or DEFEND each Critical Issue explicitly       │
     │    - Rewrite the plan (full, self-contained)               │
     │    - Summarize what changed, what was defended             │
     │                                                            │
     │  Silently keeping disputed content is the worst outcome.   │
     └─────────────────────────┬─────────────────────────────────┘
                               │
                               ▼
     ┌───────────────────────────────────────────────────────────┐
     │  R4  JUDGMENT                                    (1 judge) │
     │                                                            │
     │  Judge (rotate / fixed / vote) synthesizes:                │
     │    ## Debate Summary                                       │
     │    ## Model Assessments                                    │
     │    ## Key Synthesis Decisions (adopted from / rejected)    │
     │    ## Confidence Level                                     │
     │    ## Final Plan  ← the user-facing deliverable            │
     │                                                            │
     │  Explicitly REJECT contested approaches with reasons.      │
     │  "Both are valid" is forbidden — make a call.              │
     └───────────────────────────────────────────────────────────┘
```

### Why these specific phases

- **R0 (framing)** — Empirical finding: without R0, planners diverge on interpretation of ambiguous constraints, and R2/R3 is wasted relitigating "what did the task actually mean". With R0, three frames are shared to everyone before R1, so R1 plans are about solutions under an agreed interpretation. R0 is short (~400 words each) — cost is ~6% of total wall time, benefit is large.

- **R1 (independent planning)** — Parallel, no cross-visibility. Each planner sees the R0 frames but not other planners' R1 drafts. This preserves genuine independence — if all three converge on the same architecture, that's signal. If they diverge, R2 will catch it.

- **R2 (cross-critique, 6 pairs)** — Every planner critiques every other planner. The 6-pair structure (for N=3) produces maximum adversarial pressure: each plan faces two independent critics with different priors. Crucially, critiques are anchored to **quoted text**, not paraphrase — this forces specificity.

- **R3 (revision)** — The plan that comes out of R3 is what the judge reads. Each planner is forced to respond to critiques either by accepting (and rewriting) or by defending (with a reason). Silent omission is discouraged in the prompt.

- **R4 (judgment)** — The judge reads all of R1–R3 and produces the final deliverable. The judge is required to make rejection calls explicitly: "I took X from Claude because ..., rejected Y from Codex because ...". "Both valid" is an explicit failure mode the prompt bans.

## Provider layer

Three concrete providers, one shared `PlanningProvider` interface:

```ts
interface PlanningProvider {
  readonly name: 'claude' | 'codex' | 'oai'
  readonly model: string
  isAuthenticated(): Promise<boolean>

  frame(req, signal): AsyncIterable<StreamChunk>                     // R0
  plan(req, frames, signal): AsyncIterable<StreamChunk>              // R1
  critique(req, theirPlan, signal): AsyncIterable<StreamChunk>       // R2
  revise(req, myPlan, critiques, signal): AsyncIterable<StreamChunk> // R3
  judge(req, plans, critiques, revisions, signal): AsyncIterable<StreamChunk> // R4
}
```

Providers are black boxes to the orchestrator. They can be upgraded from LLM to agent without touching the orchestrator.

### Claude subscription (OAuth)

- Endpoint: `https://api.anthropic.com/v1/messages` (the standard API)
- Auth: Claude.ai / Claude Pro / Claude Max / Claude Code subscription OAuth
- Headers: `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`
- **System prompt identity requirement**: every request's `system` must begin with `"You are Claude Code, Anthropic's official CLI for Claude."` — without it, the subscription endpoint returns `429 rate_limit_error` with a misleading message. This is the real gate, not rate limits.
- SDK: `@anthropic-ai/sdk` with `authToken` option, which sets Bearer auth correctly.

### Codex (ChatGPT) subscription (OAuth)

- Endpoint: `https://chatgpt.com/backend-api/codex/responses` (WHAM — not `api.openai.com`)
- Auth: ChatGPT Plus/Pro OAuth with client id `app_EMoamEEZ73f0CkXaXp7hrann`
- Headers: `Authorization: Bearer <token>` + `ChatGPT-Account-Id: <acct>`
- **Model whitelist**: `gpt-5.4`, `gpt-5.4-mini`, `gpt-4.1`, `gpt-4o` work; `o3` is rejected ("not supported when using Codex with a ChatGPT account")
- SDK: OpenAI's official SDK does **not** work here — the endpoint is non-public and has a bespoke response schema. We hand-roll the SSE parser.

### OAI — any OpenAI-compatible endpoint (API key)

- Endpoint: `oai_base_url` + `/chat/completions`. Default `https://openrouter.ai/api/v1`.
- Auth: `oai_api_key` — whatever key the configured endpoint expects.
- SDK: the official `openai` SDK with `baseURL` overridden — every OpenAI-Chat-Completions-compatible provider works unchanged. Switching provider = changing two config values (`oai_base_url` + `oai_model`).
- Supported out of the box via `pj config preset <name>`: OpenRouter (default), DeepSeek, Moonshot/Kimi, Zhipu/GLM (Z.AI + bigmodel.cn), DashScope/Qwen, MiniMax, Groq, Mistral, xAI Grok, Together, Fireworks, Cerebras, DeepInfra, SiliconFlow, Doubao (Volcengine), Perplexity, OpenAI direct.
- OpenRouter-specific behaviors (`HTTP-Referer`/`X-Title` headers, `:online` web-search suffix) are gated on the configured base URL and are **not** sent to other endpoints — stricter gateways would otherwise reject unknown headers or model suffixes.
- Default model on OpenRouter: `minimax/minimax-m2.7`. Presets swap this to a sensible default for each provider.
- Legacy `openrouter_*` config keys and the `openrouter` provider/judge name are still accepted as aliases for back-compat.

## Agent mode

Each provider has an optional agent mode. When enabled, the phase call becomes a multi-turn loop instead of a single LLM call:

```
while not_done:
    stream API response
    if contains tool_use:
        run tool locally (Read / Grep / Glob / WebFetch)
        append result to conversation
        loop
    else:
        done
```

### Client-side tools (`src/agent/tools.ts`)

| Tool | Implementation | Purpose |
|---|---|---|
| `read` | `fs.readFile` + cat -n line numbering | Inspect files |
| `grep` | `spawn('rg')`, fallback to `spawn('grep')` on ENOENT | Search code |
| `glob` | `fast-glob` library | Enumerate files |
| `web_fetch` | `fetch()` + `turndown` HTML→Markdown | Read URLs |

Server-side tools (executed inside the model's API call):
- **Claude**: `web_search_20250305` (returned as transparent text from the SDK)
- **Codex**: `web_search` with `search_context_size: 'low'` + `include: ['web_search_call.action.sources']`
- **OAI (OpenRouter base URL only)**: `:online` suffix on model id (routed through OpenRouter's search layer). Other OpenAI-compatible providers don't support this — use their native search product at the model-id level if available (e.g. Perplexity `sonar-*`).

The planner is **read-only by design** — no Edit, Write, Bash, or MCP tools. Planning-mode discipline enforced by tool selection.

### When agent mode pays off

| Task type | Agent mode benefit |
|---|---|
| Greenfield architecture (no codebase to inspect) | Marginal. Server-side web search covers most research needs. |
| Brownfield / code modification / cross-file planning | Decisive. Final plans cite real `file:line`, reference actual function signatures, propose surgical edits. |
| Research synthesis (compare libraries, look up CVEs) | Strong. Multi-turn search + fetch beats single search. |

### Cost / performance envelope

Measured on a distributed-systems planning task (rate limiter design), all three providers:

| Mode | Wall time | Dominant cost |
|---|---|---|
| Baseline (no web, no agent) | 500 s | LLM tokens |
| + web search (server-side on all 3) | 660 s | LLM + search latency |
| + agent on all 3 (full tool loop) | 1040 s | LLM + tool turns + ≥10 per-turn round trips |

## Strong-constraint prompting

Every phase prompt inherits a `COMMON_TONE` baseline designed to change output distribution:

- Reader is a senior engineer in the task's domain. No tutorial content.
- Every number must have math or a citation. "Industry standard" is banned.
- Concrete decisions over menus: "Choose X because Y, rejecting Z because W".
- Distinguish reversible from irreversible decisions; spend proportional rigor.
- No motherhood statements. No filler recap. No "nice to have" speculation.
- Say "I don't know" if you don't; do not fabricate benchmarks or APIs.

Each phase adds its own rules on top:
- R0: **do not propose solutions**; flag, don't resolve ambiguities.
- R1: every Key Decision names a rejected alternative.
- R2: every Critical Issue quotes source text.
- R3: accept/defend each critique explicitly; no silent edits.
- R4: make judgment calls; `## Final Plan` is the last top-level section and stands alone.

This is a deliberate port of the terseness and rigor conventions from the Claude Code CLI's planning-mode prompt — adapted to the multi-model debate context.

See [`src/providers/prompts.ts`](../src/providers/prompts.ts) for the current prompts.

## Extraction: getting the deliverable out of the judge

The judge emits a structured document:

```
## Debate Summary
## Model Assessments
## Key Synthesis Decisions
## Confidence Level
## Final Plan
<the deliverable>
```

Extraction is simple: find `## Final Plan` (case-insensitive, start-of-line) and take everything from there to end-of-document. The judge prompt mandates `## Final Plan` be the **last** top-level heading, so the rest is deliverable even if it uses `### 1. Foo`, `### 2. Bar` numbered subsections.

This avoids the failure mode of regex-capturing-to-next-`##`, which broke when judges used numbered `## 1.` subsections inside Final Plan. See the extraction logic in [`src/orchestrator/index.ts`](../src/orchestrator/index.ts).

## Judge strategies

- **`rotate`** (default) — persistent round-robin via `_judge_index` in the config. Removes judge bias across runs, preserves genuine independence across tasks.
- **`claude` / `codex` / `oai`** — pin the judge to one provider. Useful when one provider is markedly stronger for a class of task. (`openrouter` is still accepted as a legacy alias for `oai`.)
- **`vote`** — all three provide judgment; outputs concatenated. Currently the simplest synthesis strategy; a future `ranked-choice` with Borda aggregation is on the roadmap.

## Empirical evidence

From a controlled experiment on the same task (distributed rate limiter, 1M QPS, strong consistency, P99 < 5ms), comparing configurations:

| Variant | Wall time | Final plan length | Cited file:line refs | Notable failures caught |
|---|---|---|---|---|
| v1: basic prompts, no web, no agent | 184 s | 8 KB | 0 | The OAI planner's AP+rollback error **missed** |
| v2: + R0 framing | 556 s | 17 KB | 0 | The OAI planner's AP+rollback error **caught in R2** |
| v3: + strong prompts + web search | 661 s | 9 KB (denser) | 0 | All three converged on correct architecture first pass; judge explicitly rejected Claude's self-contradictory pre-reservation and Codex's per-request consensus |
| v4: + full agent mode (on brownfield code task) | 1040 s | 28 KB | **13** (validated accurate) | Produced PR-ready TypeScript with surgical line-level edits |

The progression from v1 → v4 is the story of the three hypotheses:
1. R0 framing reduces interpretation errors early (v1→v2 shift).
2. Strong prompts change output distribution toward discipline (v2→v3 shift).
3. Agent mode unlocks codebase-aware planning (v3→v4 shift, brownfield only).

## Roadmap (known limitations)

- **`ranked-choice` judge strategy** — each judge submits a Borda ballot, runner-up synthesizes with weighted grafts. Currently only `rotate/fixed/vote`.
- **Codex WHAM agent tool invocation rate** — Codex's model frequently declines to call client tools even when they are registered (unlike Claude and the OAI Chat-Completions path). Not clear whether this is a model, tier, or prompt-injection-protection effect. Investigation pending.
- **Hot-key cost for single-key rate limits** — ironically, the framework's example task surfaced this as a known limitation of the rate limiter design; same physical constraint applies to any extreme-hot-key workload.
- **No formal "rounds > 1" support** — the framework runs R0–R4 once. Multi-round iteration (R2 → R3 → R2' → R3' → R4) is not yet wired.

## File layout

```
src/
  cli.ts              Commander CLI (run / login / status / config)
  config.ts           Persistent config + OAuth tokens (~/.triptych/config.json; legacy .planing-judeger auto-migrated)
  types.ts            Shared types: PlanRequest, PlanResult, PlanningProvider, etc.
  index.ts            Library entry point

  providers/
    prompts.ts        R0–R4 prompt builders, including COMMON_TONE baseline
    claude/
      auth.ts         OAuth PKCE flow against platform.claude.com
      index.ts        ClaudeProvider (SDK-based, OAuth)
    codex/
      auth.ts         OAuth PKCE flow against auth.openai.com
      index.ts        CodexProvider (hand-rolled WHAM client)
    oai/
      index.ts        OAIProvider (OpenAI SDK, configurable baseURL; OpenRouterProvider re-exported as alias)

  orchestrator/
    index.ts          Orchestrator.run() — the 5-round flow

  agent/
    tools.ts          Read / Grep / Glob / WebFetch implementations
    types.ts          AgentEvent union
    claude.ts         Claude agent loop (Anthropic SDK + tool_use)
    codex.ts          Codex WHAM agent loop (manual SSE parser)
    oai.ts            OAI-compatible agent loop (OpenAI SDK tool_calls; works on any Chat-Completions-compatible endpoint)
```

## Design decisions we explicitly rejected

For the record — decisions that looked attractive but were rejected with reasons:

- **Port Claude Code's planning-mode subsystem verbatim.** Tried; abandoned. Every candidate file (query.ts, GrepTool, FileReadTool) pulls in 15–40 dependencies on Claude Code's permissions system, GrowthBook analytics, lazy schema machinery, React UI. Transitive closure was ~200 files. Our 760-line clean reimplementation gets identical planning capability without the cruft.
- **Have the judge be a larger synthesis LLM (e.g. GPT-4 Turbo) outside the 3 planners.** Adds a fourth provider, a fourth subscription dep, and doesn't fix the "judge bias" problem — rotating judge across runs already fixes that.
- **Require a codebase path on every task.** Makes agent mode always on, but most real tasks are greenfield. Agent mode is opt-in per provider for this reason.
- **Synchronously converge the three planners on the same final plan before R4.** Violates the framework's principle of preserving genuine disagreement. The judge's job is to make the call, not average.
- **Server-side tool-orchestration frameworks (MCP).** Too much surface area for a planner-only use case. Four specific tools beat a generic tool protocol for read-only code exploration.

## Further reading

- [README.md](../README.md) — install, configure, run
- [`src/providers/prompts.ts`](../src/providers/prompts.ts) — the actual prompts, source of truth for the rules described here
- [`src/orchestrator/index.ts`](../src/orchestrator/index.ts) — the 5-round state machine
- [`src/agent/claude.ts`](../src/agent/claude.ts) — reference implementation of an agent loop with OAuth + tool_use
