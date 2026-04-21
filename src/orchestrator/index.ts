import type {
  CritiqueResult,
  DebateOptions,
  DebateResult,
  FrameResult,
  JudgeResult,
  JudgeStrategy,
  PlanRequest,
  PlanResult,
  PlanningProvider,
  ProviderName,
  RevisionResult,
  StreamChunk,
} from '../types.js'
import { readConfig, writeConfig } from '../config.js'

export type OnProgress = (event: ProgressEvent) => void

export type ProgressEvent =
  | { phase: 'r0_start'; providers: ProviderName[] }
  | { phase: 'r0_stream'; provider: ProviderName; chunk: StreamChunk }
  | { phase: 'r0_done'; results: FrameResult[] }
  | { phase: 'r1_start'; providers: ProviderName[] }
  | { phase: 'r1_stream'; provider: ProviderName; chunk: StreamChunk }
  | { phase: 'r1_done'; results: PlanResult[] }
  | { phase: 'r2_start'; pairs: Array<{ reviewer: ProviderName; target: ProviderName }> }
  | { phase: 'r2_stream'; reviewer: ProviderName; target: ProviderName; chunk: StreamChunk }
  | { phase: 'r2_done'; results: CritiqueResult[] }
  | { phase: 'r3_start'; providers: ProviderName[] }
  | { phase: 'r3_stream'; provider: ProviderName; chunk: StreamChunk }
  | { phase: 'r3_done'; results: RevisionResult[] }
  | { phase: 'r4_start'; judge: ProviderName }
  | { phase: 'r4_stream'; chunk: StreamChunk }
  | { phase: 'r4_done'; result: JudgeResult }

/** Collect a full streamed response into a string, emitting progress events */
async function collectStream(
  iterable: AsyncIterable<StreamChunk>,
  onChunk: (chunk: StreamChunk) => void,
): Promise<string> {
  let full = ''
  for await (const chunk of iterable) {
    onChunk(chunk)
    if (chunk.type === 'done') {
      full = chunk.fullText
    }
  }
  return full
}

/** Pick the judge for this session based on strategy */
function pickJudge(
  strategy: JudgeStrategy,
  providers: PlanningProvider[],
): PlanningProvider {
  if (strategy === 'claude') return providers.find(p => p.name === 'claude') ?? providers[0]!
  if (strategy === 'codex') return providers.find(p => p.name === 'codex') ?? providers[0]!
  if (strategy === 'openrouter') return providers.find(p => p.name === 'openrouter') ?? providers[0]!

  if (strategy === 'rotate') {
    const config = readConfig()
    const idx = ((config._judge_index ?? 0)) % providers.length
    writeConfig(c => ({ ...c, _judge_index: idx + 1 }))
    return providers[idx]!
  }

  // 'vote' — fall back to first provider as synthesizer (full vote needs separate logic)
  return providers[0]!
}

export class Orchestrator {
  private providers: PlanningProvider[]
  private options: Required<DebateOptions>

  constructor(providers: PlanningProvider[], options: DebateOptions = {}) {
    this.providers = providers
    this.options = {
      providers: options.providers ?? ['claude', 'codex', 'openrouter'],
      judge: options.judge ?? 'rotate',
      rounds: options.rounds ?? 1,
      verbose: options.verbose ?? false,
    }
  }

  async run(
    req: PlanRequest,
    onProgress?: OnProgress,
    signal?: AbortSignal,
  ): Promise<DebateResult> {
    const abort = signal ?? new AbortController().signal
    const emit = onProgress ?? (() => {})
    const startTotal = Date.now()

    const activeProviders = this.providers.filter(p =>
      this.options.providers.includes(p.name),
    )

    // ── R0: Task framing (parallel) — short alignment pass before planning ──
    emit({ phase: 'r0_start', providers: activeProviders.map(p => p.name) })

    const r0Results = await Promise.all(
      activeProviders.map(async (provider): Promise<FrameResult> => {
        const t = Date.now()
        const frame = await collectStream(
          provider.frame(req, abort),
          chunk => emit({ phase: 'r0_stream', provider: provider.name, chunk }),
        )
        return { provider: provider.name, model: provider.model, frame, durationMs: Date.now() - t }
      }),
    )

    emit({ phase: 'r0_done', results: r0Results })

    // ── R1: Independent planning (parallel), conditioned on all frames ───────
    emit({ phase: 'r1_start', providers: activeProviders.map(p => p.name) })

    const r1Results = await Promise.all(
      activeProviders.map(async (provider): Promise<PlanResult> => {
        const t = Date.now()
        const plan = await collectStream(
          provider.plan(req, r0Results, abort),
          chunk => emit({ phase: 'r1_stream', provider: provider.name, chunk }),
        )
        return { provider: provider.name, model: provider.model, plan, durationMs: Date.now() - t }
      }),
    )

    emit({ phase: 'r1_done', results: r1Results })

    // ── R2: Cross-critique (parallel, each reviews the other two) ─────────────
    const critiquePairs: Array<{ reviewer: PlanningProvider; target: PlanResult }> = []
    for (const reviewer of activeProviders) {
      for (const target of r1Results) {
        if (target.provider !== reviewer.name) {
          critiquePairs.push({ reviewer, target })
        }
      }
    }

    emit({
      phase: 'r2_start',
      pairs: critiquePairs.map(({ reviewer, target }) => ({
        reviewer: reviewer.name,
        target: target.provider,
      })),
    })

    const r2Results = await Promise.all(
      critiquePairs.map(async ({ reviewer, target }): Promise<CritiqueResult> => {
        const t = Date.now()
        const critique = await collectStream(
          reviewer.critique(req, target, abort),
          chunk => emit({ phase: 'r2_stream', reviewer: reviewer.name, target: target.provider, chunk }),
        )
        return {
          reviewer: reviewer.name,
          target: target.provider,
          critique,
          durationMs: Date.now() - t,
        }
      }),
    )

    emit({ phase: 'r2_done', results: r2Results })

    // ── R3: Revision after seeing critiques (parallel) ────────────────────────
    emit({ phase: 'r3_start', providers: activeProviders.map(p => p.name) })

    const r3Results = await Promise.all(
      activeProviders.map(async (provider): Promise<RevisionResult> => {
        const myPlan = r1Results.find(p => p.provider === provider.name)!
        const myCritiques = r2Results.filter(c => c.target === provider.name)
        const t = Date.now()
        const revision = await collectStream(
          provider.revise(req, myPlan, myCritiques, abort),
          chunk => emit({ phase: 'r3_stream', provider: provider.name, chunk }),
        )
        return {
          provider: provider.name,
          model: provider.model,
          revision,
          durationMs: Date.now() - t,
        }
      }),
    )

    emit({ phase: 'r3_done', results: r3Results })

    // ── R4: Final judgment ────────────────────────────────────────────────────
    const judgeProvider = pickJudge(this.options.judge, activeProviders)
    emit({ phase: 'r4_start', judge: judgeProvider.name })

    let judgeText = ''
    const t4 = Date.now()

    if (this.options.judge === 'vote') {
      // Vote: ask all providers to judge, pick the longest/most detailed synthesis
      const judgments = await Promise.all(
        activeProviders.map(async provider => {
          const text = await collectStream(
            provider.judge(req, r1Results, r2Results, r3Results, abort),
            chunk => emit({ phase: 'r4_stream', chunk }),
          )
          return { provider: provider.name, text }
        }),
      )
      // Simple heuristic: synthesize all votes by concatenating summaries
      judgeText = judgments
        .map(j => `### Vote from ${j.provider}:\n${j.text}`)
        .join('\n\n---\n\n')
    } else {
      judgeText = await collectStream(
        judgeProvider.judge(req, r1Results, r2Results, r3Results, abort),
        chunk => emit({ phase: 'r4_stream', chunk }),
      )
    }

    // Extract final plan: the judge prompt mandates "## Final Plan" as the LAST top-level
    // section, so we take everything from that heading to EOF. Fall back to full text if
    // the heading is missing or the captured body is trivially short.
    const headerRe = /^##\s*Final Plan\b[^\n]*$/im
    const headerMatch = judgeText.match(headerRe)
    let finalPlan = judgeText
    let reasoning = ''
    if (headerMatch && headerMatch.index !== undefined) {
      const start = headerMatch.index
      const candidate = judgeText.slice(start).trim()
      if (candidate.length > 200) {
        finalPlan = candidate
        reasoning = judgeText.slice(0, start).trim()
      }
    }

    const judgeResult: JudgeResult = {
      judge: judgeProvider.name,
      finalPlan,
      reasoning,
      durationMs: Date.now() - t4,
    }

    emit({ phase: 'r4_done', result: judgeResult })

    return {
      task: req.task,
      rounds: {
        r0_frames: r0Results,
        r1_plans: r1Results,
        r2_critiques: r2Results,
        r3_revisions: r3Results,
        r4_judgment: judgeResult,
      },
      totalDurationMs: Date.now() - startTotal,
    }
  }
}
