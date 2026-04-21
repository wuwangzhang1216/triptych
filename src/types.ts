/** A planning request sent to all providers */
export interface PlanRequest {
  task: string          // 用户的原始任务描述
  context?: string      // 可选的补充上下文
  maxTokens?: number
}

/** A chunk streamed from a provider during generation */
export interface TextChunk {
  type: 'text'
  text: string
}

export interface DoneChunk {
  type: 'done'
  fullText: string
}

export type StreamChunk = TextChunk | DoneChunk

/** R0 task framing — short problem-understanding pass before planning */
export interface FrameResult {
  provider: ProviderName
  model: string
  frame: string
  durationMs: number
}

/** A completed plan from one provider */
export interface PlanResult {
  provider: ProviderName
  model: string
  plan: string
  durationMs: number
}

/** Structured critique of another provider's plan */
export interface CritiqueResult {
  reviewer: ProviderName    // who wrote this critique
  target: ProviderName      // whose plan is being critiqued
  critique: string          // raw critique text
  durationMs: number
}

/** Revised plan after seeing critiques */
export interface RevisionResult {
  provider: ProviderName
  model: string
  revision: string
  durationMs: number
}

/** Final synthesis from the judge */
export interface JudgeResult {
  judge: ProviderName
  finalPlan: string
  reasoning: string
  durationMs: number
}

/** Full debate output */
export interface DebateResult {
  task: string
  rounds: {
    r0_frames: FrameResult[]
    r1_plans: PlanResult[]
    r2_critiques: CritiqueResult[]
    r3_revisions: RevisionResult[]
    r4_judgment: JudgeResult
  }
  totalDurationMs: number
}

export type ProviderName = 'claude' | 'codex' | 'openrouter'

export type JudgeStrategy =
  | 'rotate'       // 每次换一个模型做主裁
  | 'claude'       // 固定 Claude 做主裁
  | 'codex'        // 固定 Codex 做主裁
  | 'openrouter'   // 固定 OpenRouter 做主裁
  | 'vote'         // 三模型投票, 多数决

/** Runtime options for a debate session */
export interface DebateOptions {
  providers?: ProviderName[]      // 默认 ['claude', 'codex', 'openrouter']
  judge?: JudgeStrategy           // 默认 'rotate'
  rounds?: number                 // 辩论轮数, 默认 1 (= R1-R4 一个完整循环)
  verbose?: boolean
}

/** Abstract interface every provider must implement */
export interface PlanningProvider {
  readonly name: ProviderName
  readonly model: string

  isAuthenticated(): Promise<boolean>

  /** R0: 任务理解 / 对齐（短小，先于规划） */
  frame(req: PlanRequest, signal: AbortSignal): AsyncIterable<StreamChunk>

  /** R1: 独立规划（可选读其他模型的 R0 framing 对齐） */
  plan(req: PlanRequest, frames: FrameResult[], signal: AbortSignal): AsyncIterable<StreamChunk>

  /** R2: 评审另一方的规划 */
  critique(
    req: PlanRequest,
    theirPlan: PlanResult,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk>

  /** R3: 看到别人的 critique 后修订自己的规划 */
  revise(
    req: PlanRequest,
    myPlan: PlanResult,
    critiques: CritiqueResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk>

  /** R4: 作为裁判输出最终综合 */
  judge(
    req: PlanRequest,
    allPlans: PlanResult[],
    allCritiques: CritiqueResult[],
    allRevisions: RevisionResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk>
}
