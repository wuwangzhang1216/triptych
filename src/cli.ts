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
import { Dashboard } from './cli/dashboard.js'
import {
  arrow,
  bold,
  checkmark,
  cross,
  cyan,
  dim,
  divider,
  formatElapsed,
  green,
  heavyDivider,
  hideCursor,
  IS_TTY,
  kv,
  magenta,
  phaseBanner,
  providerColor,
  providerTag,
  red,
  renderMarkdownForTerminal,
  showCursor,
  yellow,
} from './cli/ui.js'

const program = new Command()
  .name('triptych')
  .description('Three-model planning debate: Claude × Codex × any OpenAI-compatible model. Aliased as `pj`.')
  .version('0.2.0')

// Shared: give Ctrl+C a clean exit path that restores the cursor.
function installSigintHandler(ac: AbortController, extraCleanup?: () => void): void {
  process.on('SIGINT', () => {
    ac.abort()
    if (extraCleanup) extraCleanup()
    showCursor()
    process.stderr.write('\n' + yellow('⏹  Aborted.') + '\n')
    process.exit(130)
  })
}

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
  .option('-v, --verbose', 'Show every model\'s output as it streams')
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

    // Auth check up front
    for (const p of allProviders) {
      if (!selectedNames.includes(p.name)) continue
      if (!(await p.isAuthenticated())) {
        console.error('\n' + cross() + ' ' + providerTag(p.name) + red(' is not authenticated.'))
        if (p.name === 'oai') {
          console.error('  ' + dim('Run:') + ' pj config set oai_api_key <your-key>')
          console.error('  ' + dim('Or pick a provider:') + ' pj config preset deepseek|kimi|glm|qwen|...')
        } else {
          console.error('  ' + dim('Run:') + ' pj login ' + p.name)
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

    // ── Header ──
    console.log()
    console.log(bold('⚡ triptych') + dim('  ') + dim(`(${selectedNames.join(' × ')} · judge=${options.judge})`))
    console.log(heavyDivider())
    console.log(dim('Task'))
    console.log('  ' + task.split('\n').join('\n  '))
    if (opts.context) {
      console.log(dim('Context'))
      console.log('  ' + opts.context.split('\n').join('\n  '))
    }
    console.log(heavyDivider())
    console.log()

    const dashboard = new Dashboard()
    const ac = new AbortController()
    installSigintHandler(ac, () => dashboard.finalize())

    // In verbose mode we print streams inline and skip the dashboard (its
    // in-place updates would fight with the token stream). Non-verbose mode
    // is the default and shows the dashboard with per-provider live status.
    const useDashboard = !opts.verbose

    // Shared state for verbose streaming tag management
    let currentStreamKey = ''

    function openVerboseStream(key: string, colored: string): void {
      if (currentStreamKey === key) return
      if (currentStreamKey) process.stdout.write('\n')
      currentStreamKey = key
      process.stdout.write('\n' + dim('┃ ') + colored + '\n' + dim('┃ '))
    }

    function endVerboseStream(): void {
      if (currentStreamKey) {
        process.stdout.write('\n')
        currentStreamKey = ''
      }
    }

    const onProgress = (event: ProgressEvent) => {
      switch (event.phase) {
        // ── R0 framing ──────────────────────────────────────────────────────
        case 'r0_start': {
          endVerboseStream()
          console.log(phaseBanner('r0', event.providers.join(' × ')))
          if (useDashboard) {
            dashboard.reset()
            dashboard.start()
            for (const p of event.providers) dashboard.addRow(p, providerTag(p))
          }
          break
        }
        case 'r0_stream': {
          if (useDashboard) {
            if (event.chunk.type === 'text') dashboard.incrementChars(event.provider, event.chunk.text.length)
            else if (event.chunk.type === 'done') dashboard.markDone(event.provider, event.chunk.fullText.length)
          } else if (opts.stream) {
            if (event.chunk.type === 'text') {
              openVerboseStream(`r0:${event.provider}`, providerColor(event.provider, `▸ R0  ${event.provider}`))
              process.stdout.write(event.chunk.text.replace(/\n/g, '\n' + dim('┃ ')))
            }
          }
          break
        }
        case 'r0_done': {
          if (useDashboard) dashboard.finalize()
          else endVerboseStream()
          console.log()
          break
        }

        // ── R1 independent planning ─────────────────────────────────────────
        case 'r1_start': {
          endVerboseStream()
          console.log(phaseBanner('r1', event.providers.join(' × ')))
          if (useDashboard) {
            dashboard.reset()
            dashboard.start()
            for (const p of event.providers) dashboard.addRow(p, providerTag(p))
          }
          break
        }
        case 'r1_stream': {
          if (useDashboard) {
            if (event.chunk.type === 'text') dashboard.incrementChars(event.provider, event.chunk.text.length)
            else if (event.chunk.type === 'done') dashboard.markDone(event.provider, event.chunk.fullText.length)
          } else if (opts.stream) {
            if (event.chunk.type === 'text') {
              openVerboseStream(`r1:${event.provider}`, providerColor(event.provider, `▸ R1  ${event.provider}`))
              process.stdout.write(event.chunk.text.replace(/\n/g, '\n' + dim('┃ ')))
            }
          }
          break
        }
        case 'r1_done': {
          if (useDashboard) dashboard.finalize()
          else endVerboseStream()
          console.log()
          break
        }

        // ── R2 cross-critique (N×(N-1) pairs) ───────────────────────────────
        case 'r2_start': {
          endVerboseStream()
          const pairSummary = event.pairs.length + ' pairs'
          console.log(phaseBanner('r2', pairSummary))
          if (useDashboard) {
            dashboard.reset()
            dashboard.start()
            for (const { reviewer, target } of event.pairs) {
              const key = `${reviewer}→${target}`
              const label = `${providerColor(reviewer, reviewer.padEnd(7))} ${dim('→')} ${providerColor(target, target.padEnd(7))}`
              dashboard.addRow(key, label)
            }
          } else {
            for (const { reviewer, target } of event.pairs) {
              console.log(`  ${dim('·')} ${providerColor(reviewer, reviewer)} ${arrow()} ${providerColor(target, target)}`)
            }
          }
          break
        }
        case 'r2_stream': {
          const key = `${event.reviewer}→${event.target}`
          if (useDashboard) {
            if (event.chunk.type === 'text') dashboard.incrementChars(key, event.chunk.text.length)
            else if (event.chunk.type === 'done') dashboard.markDone(key, event.chunk.fullText.length)
          } else if (opts.stream) {
            if (event.chunk.type === 'text') {
              const label = providerColor(event.reviewer, `▸ R2  ${event.reviewer}`) + dim('→') + providerColor(event.target, event.target)
              openVerboseStream(`r2:${key}`, label)
              process.stdout.write(event.chunk.text.replace(/\n/g, '\n' + dim('┃ ')))
            }
          }
          break
        }
        case 'r2_done': {
          if (useDashboard) dashboard.finalize()
          else endVerboseStream()
          console.log()
          break
        }

        // ── R3 revision ─────────────────────────────────────────────────────
        case 'r3_start': {
          endVerboseStream()
          console.log(phaseBanner('r3', event.providers.join(' × ')))
          if (useDashboard) {
            dashboard.reset()
            dashboard.start()
            for (const p of event.providers) dashboard.addRow(p, providerTag(p))
          }
          break
        }
        case 'r3_stream': {
          if (useDashboard) {
            if (event.chunk.type === 'text') dashboard.incrementChars(event.provider, event.chunk.text.length)
            else if (event.chunk.type === 'done') dashboard.markDone(event.provider, event.chunk.fullText.length)
          } else if (opts.stream) {
            if (event.chunk.type === 'text') {
              openVerboseStream(`r3:${event.provider}`, providerColor(event.provider, `▸ R3  ${event.provider}`))
              process.stdout.write(event.chunk.text.replace(/\n/g, '\n' + dim('┃ ')))
            }
          }
          break
        }
        case 'r3_done': {
          if (useDashboard) dashboard.finalize()
          else endVerboseStream()
          console.log()
          break
        }

        // ── R4 judgment — always stream this to stdout; it's the deliverable
        case 'r4_start': {
          endVerboseStream()
          console.log(phaseBanner('r4', `judge: ${providerColor(event.judge, event.judge)}`))
          console.log(divider())
          break
        }
        case 'r4_stream': {
          if (opts.stream && event.chunk.type === 'text') {
            process.stdout.write(event.chunk.text)
          }
          break
        }
        case 'r4_done': {
          if (!opts.stream) {
            // Non-streaming mode: we never wrote anything during r4_stream, so emit now.
            process.stdout.write(renderMarkdownForTerminal(event.result.finalPlan))
          }
          process.stdout.write('\n\n')
          console.log(heavyDivider())
          console.log(bold('  📜 Final Plan') + dim(` · synthesized by ${providerColor(event.result.judge, event.result.judge)} · ${formatElapsed(event.result.durationMs)}`))
          console.log(heavyDivider())
          break
        }
      }
    }

    try {
      const result = await orchestrator.run(
        { task, context: opts.context },
        onProgress,
        ac.signal,
      )

      console.log()
      console.log(dim('Total debate time: ') + cyan(formatElapsed(result.totalDurationMs)))

      const { writeFileSync } = await import('fs')
      if (opts.output) {
        writeFileSync(opts.output, JSON.stringify(result, null, 2), 'utf-8')
        console.log('  ' + checkmark() + ' full debate JSON → ' + cyan(opts.output))
      }
      if (opts.planOut) {
        writeFileSync(opts.planOut, result.rounds.r4_judgment.finalPlan, 'utf-8')
        console.log('  ' + checkmark() + ' final plan markdown → ' + cyan(opts.planOut))
      }
      console.log()
      showCursor()
    } catch (err) {
      dashboard.finalize()
      showCursor()
      console.error('\n' + cross() + ' ' + red((err as Error).message))
      process.exit(1)
    }
  })

// ── pj login ────────────────────────────────────────────────────────────────

program
  .command('login <provider>')
  .description('Authenticate a provider (claude | codex). For oai, use `pj config set oai_api_key <key>`.')
  .action(async (provider: string) => {
    if (provider === 'claude') {
      console.log('\n' + bold('Starting Claude OAuth flow') + '...')
      console.log(dim('A browser window will open. If it does not, use the manual URL below.') + '\n')

      try {
        await startClaudeOAuthFlow(
          (url) => {
            try { execSync(`open "${url}"`) } catch { /* macOS only */ }
          },
          (url) => {
            console.log(dim('Manual login URL:'))
            console.log('  ' + cyan(url))
            console.log()
          },
        )
        console.log('\n' + checkmark() + ' ' + green('Claude authenticated.'))
      } catch (err) {
        console.error('\n' + cross() + ' Claude login failed: ' + red((err as Error).message))
        process.exit(1)
      }
    } else if (provider === 'codex') {
      console.log('\n' + bold('Starting Codex (ChatGPT) OAuth flow') + '...')

      const { authUrl } = generateAuthUrl()
      console.log(dim('Opening browser...'))
      console.log('\n' + dim('Login URL (if browser does not open):'))
      console.log('  ' + cyan(authUrl))
      console.log()

      try {
        execSync(`open "${authUrl}"`)
      } catch { /* macOS only */ }

      await new Promise<void>((resolve, reject) => {
        startCallbackListener(({ tokens, error }) => {
          if (error) {
            console.error('\n' + cross() + ' Codex login failed: ' + red(error))
            reject(new Error(error))
          } else if (tokens) {
            console.log('\n' + checkmark() + ' ' + green(`Codex authenticated as ${tokens.email}`))
            resolve()
          }
        })
      })
    } else {
      console.error(cross() + ` Unknown provider: ${provider}. Use: claude | codex`)
      console.error(dim('For the third slot (OpenAI-compatible):'))
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

    console.log()
    console.log(bold('Provider status'))
    console.log(divider())

    // Claude
    if (claude) {
      const flags = [
        config.claude_web_search ? cyan('+web') : '',
        config.claude_agent ? magenta('+agent') : '',
      ].filter(Boolean).join(' ')
      console.log(`  ${checkmark()} ${providerTag('claude')} ${green('authenticated')}  ${dim('model=')}${config.claude_model ?? 'claude-opus-4-7'}${flags ? '  ' + flags : ''}`)
    } else {
      console.log(`  ${cross()} ${providerTag('claude')} ${red('not authenticated')}  ${dim('→ pj login claude')}`)
    }

    // Codex
    if (codex) {
      const flags = [
        config.codex_web_search ? cyan('+web') : '',
        config.codex_agent ? magenta('+agent') : '',
      ].filter(Boolean).join(' ')
      console.log(`  ${checkmark()} ${providerTag('codex')} ${green(codex.email)}  ${dim('model=')}${config.codex_model ?? 'gpt-5.4'}${flags ? '  ' + flags : ''}`)
    } else {
      console.log(`  ${cross()} ${providerTag('codex')} ${red('not authenticated')}  ${dim('→ pj login codex')}`)
    }

    // OAI
    if (oaiKey) {
      const label = getOAIDisplayName()
      const model = getOAIModel()
      const base = getOAIBaseUrl()
      const web = (config.oai_web_search ?? config.openrouter_web_search) ? cyan('+web') : ''
      const agent = (config.oai_agent ?? config.openrouter_agent) ? magenta('+agent') : ''
      const flags = [web, agent].filter(Boolean).join(' ')
      console.log(`  ${checkmark()} ${providerTag('oai')} ${green(label)}  ${dim('model=')}${model}${flags ? '  ' + flags : ''}`)
      console.log(`  ${' '.repeat(4)}${dim('base_url: ')}${dim(base)}`)
    } else {
      console.log(`  ${cross()} ${providerTag('oai')} ${red('not set')}  ${dim('→ pj config set oai_api_key <key>')}`)
      console.log(`  ${' '.repeat(4)}${dim('          then:')} pj config preset ${dim('<deepseek|kimi|glm|qwen|...>')}`)
    }

    console.log()
    console.log(kv('judge', yellow(config.default_judge ?? 'rotate')))
    console.log()
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
          console.error(cross() + ` Unknown config key: ${key}`)
          console.error(dim('Allowed keys: ') + ALLOWED_CONFIG_KEYS.join(', '))
          process.exit(1)
        }
        if (BOOLEAN_CONFIG_KEYS.has(key)) {
          setConfigValue(key as any, value === 'true' || value === '1')
        } else {
          setConfigValue(key as any, value)
        }
        console.log(checkmark() + ' Set ' + bold(key))
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
        // Pretty-print: heading + two-column dim-key / colored-value
        console.log()
        console.log(bold('Current config') + dim(' (~/.triptych/config.json)'))
        console.log(divider())
        const rows = Object.entries(safe)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
        const keyWidth = Math.min(32, Math.max(14, ...rows.map(([k]) => k.length)) + 2)
        for (const [k, v] of rows) {
          const rendered =
            typeof v === 'boolean' ? (v ? green('true') : red('false')) :
            typeof v === 'number' ? yellow(String(v)) :
            typeof v === 'string' ? cyan(v) :
            dim(JSON.stringify(v))
          console.log('  ' + dim(k.padEnd(keyWidth)) + rendered)
        }
        console.log()
      }),
  )
  .addCommand(
    new Command('preset')
      .argument('[name]', 'Preset name (omit to list available presets)')
      .description('Apply a built-in preset (base_url + default model) for a popular OpenAI-compatible provider')
      .option('--keep-model', 'Keep the currently-configured oai_model instead of switching to the preset default')
      .action((name: string | undefined, opts: { keepModel?: boolean }) => {
        if (!name) {
          console.log()
          console.log(bold('Available presets') + dim('  (pj config preset <name>)'))
          console.log(divider())
          const nameW = Math.max(12, ...OAI_PRESETS.map(p => p.name.length))
          const labelW = Math.max(18, ...OAI_PRESETS.map(p => p.display_name.length))
          const urlW = Math.max(36, ...OAI_PRESETS.map(p => p.base_url.length))
          for (const p of OAI_PRESETS) {
            console.log(
              '  ' +
              yellow(p.name.padEnd(nameW)) + '  ' +
              p.display_name.padEnd(labelW) + '  ' +
              dim(p.base_url.padEnd(urlW)) + '  ' +
              cyan(p.default_model),
            )
          }
          console.log()
          console.log(dim(`Default (no preset applied): ${DEFAULT_OAI_BASE_URL}  model=${DEFAULT_OAI_MODEL}`))
          console.log()
          console.log(dim('After selecting a preset, set your API key:'))
          console.log('  ' + cyan('pj config set oai_api_key <your-key>'))
          console.log()
          return
        }
        try {
          const preset = applyOAIPreset(name, { overrideModel: !opts.keepModel })
          console.log()
          console.log(checkmark() + ` Applied preset ${bold(preset.name)}  ${dim('(' + preset.display_name + ')')}`)
          console.log(kv('base_url', cyan(preset.base_url)))
          console.log(kv('model',    cyan(opts.keepModel ? getOAIModel() : preset.default_model)))
          const key = getOAIKey()
          if (!key) {
            console.log()
            console.log(dim('Next: ') + cyan('pj config set oai_api_key <your-key>'))
          }
          console.log()
        } catch (err) {
          console.error(cross() + ' ' + red((err as Error).message))
          process.exit(1)
        }
      }),
  )
  .addCommand(
    new Command('presets')
      .description('List all built-in presets (alias of `config preset`)')
      .action(() => {
        for (const p of OAI_PRESETS) {
          console.log(yellow(p.name.padEnd(14)) + '  ' + p.display_name.padEnd(26) + '  ' + dim(p.base_url))
          console.log(' '.repeat(14) + '  ' + dim('default model: ') + cyan(p.default_model))
        }
      }),
  )

program.parse(process.argv)
