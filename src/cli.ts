#!/usr/bin/env bun

import { Command } from 'commander'
import { execSync } from 'child_process'
import { readConfig, setConfigValue, getOpenRouterKey, getClaudeTokens, getCodexTokens } from './config.js'
import { ClaudeProvider } from './providers/claude/index.js'
import { CodexProvider } from './providers/codex/index.js'
import { OpenRouterProvider } from './providers/openrouter/index.js'
import { Orchestrator, type ProgressEvent } from './orchestrator/index.js'
import type { DebateOptions, JudgeStrategy } from './types.js'
import { startClaudeOAuthFlow } from './providers/claude/auth.js'
import { generateAuthUrl, startCallbackListener } from './providers/codex/auth.js'

const program = new Command()
  .name('triptych')
  .description('Three-model planning debate: Claude × Codex × OpenRouter. Aliased as `pj`.')
  .version('0.1.0')

// ── pj run ──────────────────────────────────────────────────────────────────

program
  .command('run <task>')
  .description('Run a full planning debate on the given task')
  .option('-c, --context <text>', 'Additional context for the task')
  .option(
    '--judge <strategy>',
    'Judge strategy: rotate|claude|codex|openrouter|vote',
    'rotate',
  )
  .option('--providers <list>', 'Comma-separated providers to use', 'claude,codex,openrouter')
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
      new OpenRouterProvider(),
    ]

    const selectedNames = opts.providers.split(',').map(s => s.trim())

    // Check authentication
    for (const p of allProviders) {
      if (!selectedNames.includes(p.name)) continue
      if (!(await p.isAuthenticated())) {
        console.error(`\n✗ ${p.name} is not authenticated.`)
        if (p.name === 'openrouter') {
          console.error('  Run: pj config set openrouter_api_key <your-key>')
        } else {
          console.error(`  Run: pj login ${p.name}`)
        }
        process.exit(1)
      }
    }

    const options: DebateOptions = {
      providers: selectedNames as any,
      judge: opts.judge as JudgeStrategy,
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
  .description('Authenticate a provider (claude | codex)')
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
      console.error('For OpenRouter, use: pj config set openrouter_api_key <key>')
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
    const orKey = getOpenRouterKey()
    const config = readConfig()

    console.log('\nProvider Status:')
    console.log(`  Claude      ${claude ? `✓ authenticated (model: ${config.claude_model ?? 'claude-opus-4-7'}${config.claude_web_search ? ' +web' : ''}${config.claude_agent ? ' +agent' : ''})` : '✗ not authenticated — run: pj login claude'}`)
    console.log(`  Codex       ${codex ? `✓ authenticated as ${codex.email} (model: ${config.codex_model ?? 'gpt-5.4'}${config.codex_web_search ? ' +web' : ''}${config.codex_agent ? ' +agent' : ''})` : '✗ not authenticated — run: pj login codex'}`)
    console.log(`  OpenRouter  ${orKey ? `✓ key set (model: ${config.openrouter_model ?? 'minimax/minimax-m2.7'}${config.openrouter_web_search ? ' +web' : ''}${config.openrouter_agent ? ' +agent' : ''})` : '✗ not set — run: pj config set openrouter_api_key <key>'}`)
    console.log()
    console.log(`  Default judge: ${config.default_judge ?? 'rotate'}`)
  })

// ── pj config ───────────────────────────────────────────────────────────────

program
  .command('config')
  .description('Manage configuration')
  .addCommand(
    new Command('set')
      .argument('<key>', 'Config key')
      .argument('<value>', 'Config value')
      .description('Set a config value')
      .action((key: string, value: string) => {
        const allowed = [
          'openrouter_api_key',
          'openrouter_model',
          'openrouter_web_search',
          'openrouter_agent',
          'claude_model',
          'claude_web_search',
          'claude_agent',
          'codex_model',
          'codex_web_search',
          'codex_agent',
          'default_judge',
        ]
        const booleanKeys = new Set([
          'openrouter_web_search',
          'openrouter_agent',
          'claude_web_search',
          'claude_agent',
          'codex_web_search',
          'codex_agent',
        ])
        if (!allowed.includes(key)) {
          console.error(`Unknown config key: ${key}`)
          console.error(`Allowed keys: ${allowed.join(', ')}`)
          process.exit(1)
        }
        if (booleanKeys.has(key)) {
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
          openrouter_api_key: config.openrouter_api_key ? '[set]' : undefined,
        }
        console.log(JSON.stringify(safe, null, 2))
      }),
  )

program.parse(process.argv)
