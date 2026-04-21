#!/usr/bin/env bun

import { Command } from 'commander'
import { execSync } from 'child_process'
import {
  applyOAIPreset,
  DEFAULT_OAI_BASE_URL,
  DEFAULT_OAI_MODEL,
  findOAIPreset,
  getClaudeTokens,
  getCodexTokens,
  getOAIBaseUrl,
  getOAIDisplayName,
  getOAIKey,
  getOAIModel,
  OAI_PRESETS,
  readConfig,
  setConfigValue,
} from './config.js'
import { ClaudeProvider } from './providers/claude/index.js'
import { CodexProvider } from './providers/codex/index.js'
import { OAIProvider } from './providers/oai/index.js'
import { Orchestrator, type ProgressEvent } from './orchestrator/index.js'
import type { DebateOptions, JudgeStrategy, ProviderName } from './types.js'
import { startClaudeOAuthFlow } from './providers/claude/auth.js'
import { generateAuthUrl, startCallbackListener } from './providers/codex/auth.js'

const program = new Command()
  .name('triptych')
  .description('Three-model planning debate: Claude × Codex × any OpenAI-compatible model. Aliased as `pj`.')
  .version('0.2.0')

/** Normalize provider names: accept 'openrouter' as a legacy alias for 'oai'. */
function normalizeProviderName(raw: string): ProviderName {
  const n = raw.trim().toLowerCase()
  if (n === 'openrouter' || n === 'openai-compatible' || n === 'openai_compatible') return 'oai'
  return n as ProviderName
}

function normalizeJudgeStrategy(raw: string): JudgeStrategy {
  const n = raw.trim().toLowerCase()
  if (n === 'openrouter' || n === 'openai-compatible' || n === 'openai_compatible') return 'oai'
  return n as JudgeStrategy
}

// ── pj run ──────────────────────────────────────────────────────────────────

program
  .command('run <task>')
  .description('Run a full planning debate on the given task')
  .option('-c, --context <text>', 'Additional context for the task')
  .option(
    '--judge <strategy>',
    'Judge strategy: rotate|claude|codex|oai|vote',
    'rotate',
  )
  .option('--providers <list>', 'Comma-separated providers to use', 'claude,codex,oai')
  .option('--no-stream', 'Suppress streaming output, show only final result')
  .option('-v, --verbose', 'Show all intermediate steps')
  .option('-o, --output <file>', 'Save full debate JSON (all rounds + metadata) to file')
  .option('-p, --plan-out <file>', 'Save just the Final Plan markdown to file')
  .action(async (task: string, opts: {
    context?: string
    judge: string
    providers: string
    stream: boolean
    verbose: boolean
    output?: string
    planOut?: string
  }) => {
    const allProviders = [
      new ClaudeProvider(),
      new CodexProvider(),
      new OAIProvider(),
    ]

    const selectedNames = opts.providers.split(',').map(s => normalizeProviderName(s))

    // Check authentication
    for (const p of allProviders) {
      if (!selectedNames.includes(p.name)) continue
      if (!(await p.isAuthenticated())) {
        console.error(`\n✗ ${p.name} is not authenticated.`)
        if (p.name === 'oai') {
          console.error('  Run: pj config set oai_api_key <your-key>')
          console.error('  Or pick a provider:  pj config preset deepseek|kimi|glm|qwen|minimax|groq|mistral|xai|...')
        } else {
          console.error(`  Run: pj login ${p.name}`)
        }
        process.exit(1)
      }
    }

    const options: DebateOptions = {
      providers: selectedNames,
      judge: normalizeJudgeStrategy(opts.judge),
      verbose: opts.verbose,
    }

    const orchestrator = new Orchestrator(allProviders, options)

    const phaseLabels: Record<string, string> = {
      r0_start: '🎯 R0 任务对齐',
      r1_start: '📋 R1 独立规划',
      r2_start: '🔍 R2 交叉评审',
      r3_start: '✏️  R3 修订',
      r4_start: '⚖️  R4 仲裁',
    }

    let currentProvider = ''
    let currentPhase = ''
    let lineBuffer = ''

    const onProgress = (event: ProgressEvent) => {
      if (event.phase === 'r0_start') {
        console.log(`\n${phaseLabels.r0_start} — ${event.providers.join(' × ')}`)
      } else if (event.phase === 'r0_done') {
        if (!opts.verbose) console.log('  ✓ All frames complete')
      } else if (event.phase === 'r0_stream') {
        const provider = 'provider' in event ? event.provider : ''
        if (opts.stream && opts.verbose) {
          if (provider !== currentProvider || currentPhase !== event.phase) {
            if (lineBuffer) { process.stdout.write('\n'); lineBuffer = '' }
            currentProvider = provider
            currentPhase = event.phase
            process.stdout.write(`\n[${provider}] `)
          }
          if (event.chunk.type === 'text') {
            process.stdout.write(event.chunk.text)
            lineBuffer += event.chunk.text
          }
        } else if (event.chunk.type === 'done') {
          process.stdout.write(` ✓ ${provider}\n`)
        }
      } else if (event.phase === 'r1_start') {
        console.log(`\n${phaseLabels.r1_start} — ${event.providers.join(' × ')}`)
      } else if (event.phase === 'r2_start') {
        console.log(`\n${phaseLabels.r2_start}`)
        for (const { reviewer, target } of event.pairs) {
          console.log(`  ${reviewer} → ${target}`)
        }
      } else if (event.phase === 'r3_start') {
        console.log(`\n${phaseLabels.r3_start}`)
      } else if (event.phase === 'r4_start') {
        console.log(`\n${phaseLabels.r4_start} (judge: ${event.judge})`)
      } else if (event.phase === 'r1_stream' || event.phase === 'r3_stream') {
        const provider = 'provider' in event ? event.provider : ''
        if (opts.stream && opts.verbose) {
          if (provider !== currentProvider || currentPhase !== event.phase) {
            if (lineBuffer) { process.stdout.write('\n'); lineBuffer = '' }
            currentProvider = provider
            currentPhase = event.phase
            process.stdout.write(`\n[${provider}] `)
          }
          if (event.chunk.type === 'text') {
            process.stdout.write(event.chunk.text)
            lineBuffer += event.chunk.text
          }
        } else if (event.chunk.type === 'done') {
          process.stdout.write(` ✓ ${provider}\n`)
        }
      } else if (event.phase === 'r2_stream') {
        if (opts.stream && opts.verbose) {
          const key = `${event.reviewer}→${event.target}`
          if (key !== currentProvider || currentPhase !== event.phase) {
            if (lineBuffer) { process.stdout.write('\n'); lineBuffer = '' }
            currentProvider = key
            currentPhase = event.phase
            process.stdout.write(`\n[${event.reviewer}→${event.target}] `)
          }
          if (event.chunk.type === 'text') {
            process.stdout.write(event.chunk.text)
          }
        } else if (event.chunk.type === 'done') {
          process.stdout.write(`  ✓ ${event.reviewer} → ${event.target}\n`)
        }
      } else if (event.phase === 'r4_stream') {
        if (opts.stream) {
          if (event.chunk.type === 'text') {
            process.stdout.write(event.chunk.text)
          }
        }
      } else if (event.phase === 'r1_done') {
        if (!opts.verbose) console.log('  ✓ All initial plans complete')
      } else if (event.phase === 'r2_done') {
        if (!opts.verbose) console.log('  ✓ All critiques complete')
      } else if (event.phase === 'r3_done') {
        if (!opts.verbose) console.log('  ✓ All revisions complete')
      } else if (event.phase === 'r4_done') {
        console.log('\n')
        console.log('═'.repeat(60))
        console.log('  FINAL PLAN')
        console.log('═'.repeat(60))
        console.log()
        if (!opts.stream) {
          console.log(event.result.finalPlan)
        }
        console.log()
        console.log(`Total time: ${(event.result.durationMs / 1000).toFixed(1)}s`)
      }
    }

    console.log(`\nTask: ${task}`)
    console.log('─'.repeat(60))

    const ac = new AbortController()
    process.on('SIGINT', () => { ac.abort(); process.exit(0) })

    try {
      const result = await orchestrator.run(
        { task, context: opts.context },
        onProgress,
        ac.signal,
      )

      console.log(`Total debate time: ${(result.totalDurationMs / 1000).toFixed(1)}s`)

      const { writeFileSync } = await import('fs')
      if (opts.output) {
        writeFileSync(opts.output, JSON.stringify(result, null, 2), 'utf-8')
        console.log(`\nFull debate saved to: ${opts.output}`)
      }
      if (opts.planOut) {
        writeFileSync(opts.planOut, result.rounds.r4_judgment.finalPlan, 'utf-8')
        console.log(`Final Plan markdown saved to: ${opts.planOut}`)
      }
    } catch (err) {
      console.error('\n✗ Error:', (err as Error).message)
      process.exit(1)
    }
  })

// ── pj login ────────────────────────────────────────────────────────────────

program
  .command('login <provider>')
  .description('Authenticate a provider (claude | codex). For oai, use `pj config set oai_api_key <key>`.')
  .action(async (provider: string) => {
    if (provider === 'claude') {
      console.log('\nStarting Claude OAuth flow...')
      console.log('A browser window will open. If it does not, use the manual URL below.\n')

      try {
        await startClaudeOAuthFlow(
          (url) => {
            try { execSync(`open "${url}"`) } catch { /* macOS only */ }
          },
          (url) => {
            console.log('Manual login URL:')
            console.log(url)
            console.log()
          },
        )
        console.log('\n✓ Claude authenticated successfully!')
      } catch (err) {
        console.error('\n✗ Claude login failed:', (err as Error).message)
        process.exit(1)
      }
    } else if (provider === 'codex') {
      console.log('\nStarting Codex (ChatGPT) OAuth flow...')

      const { authUrl } = generateAuthUrl()
      console.log('Opening browser...')
      console.log('\nLogin URL (if browser does not open):')
      console.log(authUrl)
      console.log()

      try {
        execSync(`open "${authUrl}"`)
      } catch { /* macOS only */ }

      await new Promise<void>((resolve, reject) => {
        startCallbackListener(({ tokens, error }) => {
          if (error) {
            console.error('\n✗ Codex login failed:', error)
            reject(new Error(error))
          } else if (tokens) {
            console.log(`\n✓ Codex authenticated as ${tokens.email}`)
            resolve()
          }
        })
      })
    } else {
      console.error(`Unknown provider: ${provider}. Use: claude | codex`)
      console.error('For the third slot (OpenAI-compatible), use:')
      console.error('  pj config set oai_api_key <key>')
      console.error('  pj config preset <deepseek|kimi|glm|qwen|minimax|groq|mistral|xai|...>')
      process.exit(1)
    }
  })

// ── pj status ───────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show authentication status of all providers')
  .action(() => {
    const claude = getClaudeTokens()
    const codex = getCodexTokens()
    const oaiKey = getOAIKey()
    const config = readConfig()

    const oaiLabel = getOAIDisplayName()
    const oaiModel = getOAIModel()
    const oaiBase = getOAIBaseUrl()

    console.log('\nProvider Status:')
    console.log(`  Claude   ${claude ? `✓ authenticated (model: ${config.claude_model ?? 'claude-opus-4-7'}${config.claude_web_search ? ' +web' : ''}${config.claude_agent ? ' +agent' : ''})` : '✗ not authenticated — run: pj login claude'}`)
    console.log(`  Codex    ${codex ? `✓ authenticated as ${codex.email} (model: ${config.codex_model ?? 'gpt-5.4'}${config.codex_web_search ? ' +web' : ''}${config.codex_agent ? ' +agent' : ''})` : '✗ not authenticated — run: pj login codex'}`)
    if (oaiKey) {
      const webFlag = (config.oai_web_search ?? config.openrouter_web_search) ? ' +web' : ''
      const agentFlag = (config.oai_agent ?? config.openrouter_agent) ? ' +agent' : ''
      console.log(`  OAI      ✓ ${oaiLabel} (model: ${oaiModel}${webFlag}${agentFlag})`)
      console.log(`           base_url: ${oaiBase}`)
    } else {
      console.log('  OAI      ✗ not set — run: pj config set oai_api_key <key>')
      console.log('             then pick a provider: pj config preset <deepseek|kimi|glm|qwen|...>')
    }
    console.log()
    console.log(`  Default judge: ${config.default_judge ?? 'rotate'}`)
  })

// ── pj config ───────────────────────────────────────────────────────────────

const ALLOWED_CONFIG_KEYS = [
  // New canonical OAI keys
  'oai_api_key',
  'oai_base_url',
  'oai_model',
  'oai_web_search',
  'oai_agent',
  'oai_display_name',
  // Legacy openrouter_* aliases (still accepted; getters also fall back to these)
  'openrouter_api_key',
  'openrouter_model',
  'openrouter_web_search',
  'openrouter_agent',
  // Claude / Codex
  'claude_model',
  'claude_web_search',
  'claude_agent',
  'codex_model',
  'codex_web_search',
  'codex_agent',
  // Orchestration
  'default_judge',
] as const

const BOOLEAN_CONFIG_KEYS = new Set([
  'oai_web_search',
  'oai_agent',
  'openrouter_web_search',
  'openrouter_agent',
  'claude_web_search',
  'claude_agent',
  'codex_web_search',
  'codex_agent',
])

program
  .command('config')
  .description('Manage configuration')
  .addCommand(
    new Command('set')
      .argument('<key>', 'Config key')
      .argument('<value>', 'Config value')
      .description('Set a config value')
      .action((key: string, value: string) => {
        if (!ALLOWED_CONFIG_KEYS.includes(key as typeof ALLOWED_CONFIG_KEYS[number])) {
          console.error(`Unknown config key: ${key}`)
          console.error(`Allowed keys: ${ALLOWED_CONFIG_KEYS.join(', ')}`)
          process.exit(1)
        }
        if (BOOLEAN_CONFIG_KEYS.has(key)) {
          setConfigValue(key as any, value === 'true' || value === '1')
        } else {
          setConfigValue(key as any, value)
        }
        console.log(`✓ Set ${key}`)
      }),
  )
  .addCommand(
    new Command('show')
      .description('Show current configuration')
      .action(() => {
        const config = readConfig()
        const safe = {
          ...config,
          claude_access_token: config.claude_access_token ? '[set]' : undefined,
          claude_refresh_token: config.claude_refresh_token ? '[set]' : undefined,
          codex_access_token: config.codex_access_token ? '[set]' : undefined,
          codex_refresh_token: config.codex_refresh_token ? '[set]' : undefined,
          oai_api_key: config.oai_api_key ? '[set]' : undefined,
          openrouter_api_key: config.openrouter_api_key ? '[set]' : undefined,
        }
        console.log(JSON.stringify(safe, null, 2))
      }),
  )
  .addCommand(
    new Command('preset')
      .argument('[name]', 'Preset name (omit to list available presets)')
      .description('Apply a built-in preset (base_url + default model) for a popular OpenAI-compatible provider')
      .option('--keep-model', 'Keep the currently-configured oai_model instead of switching to the preset default')
      .action((name: string | undefined, opts: { keepModel?: boolean }) => {
        if (!name) {
          console.log('\nAvailable presets (pj config preset <name>):\n')
          const rows = OAI_PRESETS.map(p => [
            p.name.padEnd(14),
            p.display_name.padEnd(26),
            p.base_url.padEnd(54),
            p.default_model,
          ])
          for (const r of rows) console.log('  ' + r.join('  '))
          console.log(`\nDefault (no preset applied): ${DEFAULT_OAI_BASE_URL}  model=${DEFAULT_OAI_MODEL}`)
          console.log('\nAfter selecting a preset, set your API key:')
          console.log('  pj config set oai_api_key <your-key>')
          return
        }
        try {
          const preset = applyOAIPreset(name, { overrideModel: !opts.keepModel })
          console.log(`✓ Applied preset "${preset.name}" (${preset.display_name})`)
          console.log(`  oai_base_url = ${preset.base_url}`)
          console.log(`  oai_model    = ${opts.keepModel ? getOAIModel() : preset.default_model}`)
          const key = getOAIKey()
          if (!key) {
            console.log('\nNext: pj config set oai_api_key <your-key>')
          }
        } catch (err) {
          console.error(`✗ ${(err as Error).message}`)
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('presets')
      .description('List all built-in presets')
      .action(() => {
        for (const p of OAI_PRESETS) {
          console.log(`${p.name.padEnd(14)}  ${p.display_name.padEnd(26)}  ${p.base_url}`)
          console.log(`${''.padEnd(14)}  default model: ${p.default_model}`)
        }
      }),
  )

program.parse(process.argv)
