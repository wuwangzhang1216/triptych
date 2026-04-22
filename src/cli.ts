#!/usr/bin/env bun

import { Command } from 'commander'
import { execSync } from 'child_process'
import {
  applyOAIPreset,
  DEFAULT_OAI_BASE_URL,
  DEFAULT_OAI_MODEL,
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
  accent,
  bold,
  dim,
  err,
  formatElapsed,
  GLYPH,
  hr,
  IS_TTY,
  ok,
  padRight,
  phaseBanner,
  providerName,
  renderMarkdownForTerminal,
  sep,
  showCursor,
  termWidth,
  tint,
  warn,
} from './cli/ui.js'

const program = new Command()
  .name('triptych')
  .description('Three-model planning debate: Claude × Codex × any OpenAI-compatible model. Aliased as `pj`.')
  .version('0.2.0')
  .action(async () => {
    // No subcommand → launch the interactive TUI (Claude-Code-style shell).
    const { startTUI } = await import('./cli/tui.js')
    startTUI()
  })

function installSigintHandler(ac: AbortController, dashboard?: Dashboard): void {
  process.on('SIGINT', () => {
    ac.abort()
    if (dashboard) {
      dashboard.failAllRunning('aborted')
      dashboard.finalize()
    }
    showCursor()
    process.stderr.write('\n  ' + warn('aborted') + '\n\n')
    process.exit(130)
  })
}

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

/** Coloured provider token for inline prose like headers and banners. */
function providerToken(name: ProviderName): string {
  return tint(name, providerName(name))
}

// ── pj run ──────────────────────────────────────────────────────────────────

program
  .command('run <task>')
  .description('Run a full planning debate on the given task')
  .option('-c, --context <text>', 'Additional context for the task')
  .option('--judge <strategy>', 'Judge strategy: rotate|claude|codex|oai|vote', 'rotate')
  .option('--providers <list>', 'Comma-separated providers to use', 'claude,codex,oai')
  .option('--no-stream', 'Suppress the final-plan stream (judge output is still saved if --plan-out is passed)')
  .option('-v, --verbose', "Show every model's output as it streams")
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
    const judgeStrategy = normalizeJudgeStrategy(opts.judge)

    // Auth check up front
    for (const p of allProviders) {
      if (!selectedNames.includes(p.name)) continue
      if (!(await p.isAuthenticated())) {
        process.stderr.write('\n  ' + err('×') + ' ' + tint(p.name, providerName(p.name)) + err(' not authenticated') + '\n')
        if (p.name === 'oai') {
          process.stderr.write('    ' + dim('pj config set oai_api_key <key>') + '\n')
          process.stderr.write('    ' + dim('pj config preset <deepseek|kimi|glm|qwen|…>') + '\n\n')
        } else {
          process.stderr.write('    ' + dim(`pj login ${p.name}`) + '\n\n')
        }
        process.exit(1)
      }
    }

    const options: DebateOptions = {
      providers: selectedNames,
      judge: judgeStrategy,
      verbose: opts.verbose,
    }
    const orchestrator = new Orchestrator(allProviders, options)

    // ── Header ──
    const providerList = selectedNames.map(providerToken).join(sep)
    console.log()
    console.log('  ' + bold('triptych') + dim('  ' + (program.version() ?? '')) + '   ' + providerList + dim('   judge: ') + accent(judgeStrategy))
    console.log(hr())
    console.log()
    console.log('  ' + dim('task'))
    console.log('  ' + task.split('\n').join('\n  '))
    if (opts.context) {
      console.log()
      console.log('  ' + dim('context'))
      console.log('  ' + opts.context.split('\n').join('\n  '))
    }
    console.log()

    const dashboard = new Dashboard()
    const ac = new AbortController()
    installSigintHandler(ac, dashboard)

    const useDashboard = !opts.verbose

    // Verbose-mode streaming state
    let vStreamKey = ''
    function vStreamOpen(key: string, header: string): void {
      if (vStreamKey === key) return
      if (vStreamKey) process.stdout.write('\n\n')
      vStreamKey = key
      process.stdout.write('  ' + header + '\n  ')
    }
    function vStreamClose(): void {
      if (vStreamKey) {
        process.stdout.write('\n\n')
        vStreamKey = ''
      }
    }

    // Accumulate R4 text so we can render it as coloured markdown after the
    // judge finishes — streaming raw markdown mid-run is unreadable.
    let r4Buffer = ''
    let r4StartedAt = 0

    const onProgress = (event: ProgressEvent) => {
      switch (event.phase) {
        // ── R0 / R1 / R3: per-provider rows ─────────────────────────────────
        case 'r0_start':
        case 'r1_start':
        case 'r3_start': {
          vStreamClose()
          const phase = event.phase.slice(0, 2) as 'r0' | 'r1' | 'r3'
          console.log(phaseBanner(phase))
          if (useDashboard) {
            dashboard.reset()
            dashboard.start()
            for (const p of event.providers) dashboard.addRow(p, tint(p, providerName(p)))
          }
          break
        }
        case 'r0_stream':
        case 'r1_stream':
        case 'r3_stream': {
          if (useDashboard) {
            if (event.chunk.type === 'text') dashboard.incrementChars(event.provider, event.chunk.text.length)
            else if (event.chunk.type === 'done') dashboard.markDone(event.provider, event.chunk.fullText.length)
          } else if (opts.stream && event.chunk.type === 'text') {
            const phase = event.phase.slice(0, 2).toUpperCase()
            const header = dim(phase) + '  ' + tint(event.provider, providerName(event.provider))
            vStreamOpen(`${phase}:${event.provider}`, header)
            process.stdout.write(event.chunk.text.replace(/\n/g, '\n  '))
          }
          break
        }
        case 'r0_done':
        case 'r1_done':
        case 'r3_done': {
          if (useDashboard) dashboard.finalize()
          else vStreamClose()
          console.log()
          break
        }

        // ── R2: N×(N-1) reviewer → target pairs ─────────────────────────────
        case 'r2_start': {
          vStreamClose()
          console.log(phaseBanner('r2', `${event.pairs.length} pairs`))
          if (useDashboard) {
            dashboard.reset()
            dashboard.start()
            for (const { reviewer, target } of event.pairs) {
              const key = `${reviewer}→${target}`
              const label = tint(reviewer, providerName(reviewer)) + ' ' + GLYPH.rightArrow + ' ' + tint(target, providerName(target))
              dashboard.addRow(key, label)
            }
          }
          break
        }
        case 'r2_stream': {
          const key = `${event.reviewer}→${event.target}`
          if (useDashboard) {
            if (event.chunk.type === 'text') dashboard.incrementChars(key, event.chunk.text.length)
            else if (event.chunk.type === 'done') dashboard.markDone(key, event.chunk.fullText.length)
          } else if (opts.stream && event.chunk.type === 'text') {
            const header = dim('R2') + '  ' + tint(event.reviewer, providerName(event.reviewer)) + ' ' + GLYPH.rightArrow + ' ' + tint(event.target, providerName(event.target))
            vStreamOpen(`R2:${key}`, header)
            process.stdout.write(event.chunk.text.replace(/\n/g, '\n  '))
          }
          break
        }
        case 'r2_done': {
          if (useDashboard) dashboard.finalize()
          else vStreamClose()
          console.log()
          break
        }

        // ── R4: always use a dashboard row (even in verbose) because the
        //       rendered markdown is the real deliverable and it's shown
        //       below with proper coloring after the stream completes.
        case 'r4_start': {
          vStreamClose()
          console.log(phaseBanner('r4', `judge: ${providerToken(event.judge)}`))
          dashboard.reset()
          dashboard.start()
          dashboard.addRow('judge', tint(event.judge, providerName(event.judge)))
          r4Buffer = ''
          r4StartedAt = Date.now()
          break
        }
        case 'r4_stream': {
          if (event.chunk.type === 'text') {
            r4Buffer += event.chunk.text
            dashboard.incrementChars('judge', event.chunk.text.length)
          } else if (event.chunk.type === 'done') {
            dashboard.markDone('judge', event.chunk.fullText.length)
          }
          break
        }
        case 'r4_done': {
          dashboard.finalize()
          console.log()
          if (opts.stream) {
            // Pretty-render the final plan inline.
            console.log(hr())
            console.log()
            process.stdout.write(renderMarkdownForTerminal(event.result.finalPlan))
            process.stdout.write('\n\n')
            console.log(hr())
          }
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

      // Footer
      const parts: string[] = []
      parts.push(dim('total ') + accent(formatElapsed(result.totalDurationMs)))
      parts.push(dim('judge ') + providerToken(result.rounds.r4_judgment.judge))

      const { writeFileSync } = await import('fs')
      if (opts.output) {
        writeFileSync(opts.output, JSON.stringify(result, null, 2), 'utf-8')
        parts.push(dim('saved ') + ok(opts.output))
      }
      if (opts.planOut) {
        writeFileSync(opts.planOut, result.rounds.r4_judgment.finalPlan, 'utf-8')
        parts.push(dim('plan ') + ok(opts.planOut))
      }
      console.log()
      console.log('  ' + parts.join(sep))
      console.log()
      showCursor()
      // Silence unused warnings when r4StartedAt isn't read after refactors.
      void r4StartedAt
    } catch (e) {
      dashboard.failAllRunning((e as Error).message || 'phase failed')
      dashboard.finalize()
      showCursor()
      console.error()
      console.error('  ' + err('×') + '  ' + err((e as Error).message))
      console.error()
      process.exit(1)
    }
  })

// ── pj login ────────────────────────────────────────────────────────────────

program
  .command('login <provider>')
  .description('Authenticate a provider (claude | codex). For oai, use `pj config set oai_api_key <key>`.')
  .action(async (provider: string) => {
    if (provider === 'claude') {
      console.log()
      console.log('  ' + bold('claude login') + dim('  browser-based OAuth'))
      console.log()
      try {
        await startClaudeOAuthFlow(
          (url) => { try { execSync(`open "${url}"`) } catch { /* macOS only */ } },
          (url) => {
            console.log('  ' + dim('manual url'))
            console.log('  ' + accent(url))
            console.log()
          },
        )
        console.log('  ' + ok('✓') + '  claude authenticated')
        console.log()
      } catch (e) {
        console.error('  ' + err('×') + '  claude login failed: ' + err((e as Error).message))
        process.exit(1)
      }
    } else if (provider === 'codex') {
      console.log()
      console.log('  ' + bold('codex login') + dim('  browser-based OAuth'))
      console.log()
      const { authUrl } = generateAuthUrl()
      console.log('  ' + dim('manual url'))
      console.log('  ' + accent(authUrl))
      console.log()
      try { execSync(`open "${authUrl}"`) } catch { /* macOS only */ }

      await new Promise<void>((resolve, reject) => {
        startCallbackListener(({ tokens, error }) => {
          if (error) {
            console.error('  ' + err('×') + '  codex login failed: ' + err(error))
            reject(new Error(error))
          } else if (tokens) {
            console.log('  ' + ok('✓') + '  codex authenticated  ' + dim(tokens.email))
            console.log()
            resolve()
          }
        })
      })
    } else {
      console.error('  ' + err('×') + '  unknown provider: ' + provider)
      console.error('  ' + dim('use: claude | codex'))
      console.error('  ' + dim('for the third slot (OpenAI-compatible):'))
      console.error('    pj config set oai_api_key <key>')
      console.error('    pj config preset <deepseek|kimi|glm|qwen|…>')
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
    console.log('  ' + bold('triptych') + dim(' · status'))
    console.log(hr())

    // Aligned rows: glyph / tag / detail / flags
    const providersCol = 8  // max "claude" = 6, "codex" = 5, "oai" = 3 → padded to 8

    const rows: Array<{ name: ProviderName; ok: boolean; detail: string; flags: string }> = [
      {
        name: 'claude',
        ok: claude !== null,
        detail: claude ? dim('model ') + (config.claude_model ?? 'claude-opus-4-7') : dim('pj login claude'),
        flags: [
          config.claude_web_search ? accent('web') : '',
          config.claude_agent ? warn('agent') : '',
        ].filter(Boolean).join(sep),
      },
      {
        name: 'codex',
        ok: codex !== null,
        detail: codex
          ? `${dim('model ')}${config.codex_model ?? 'gpt-5.4'}${sep}${dim(codex.email)}`
          : dim('pj login codex'),
        flags: [
          config.codex_web_search ? accent('web') : '',
          config.codex_agent ? warn('agent') : '',
        ].filter(Boolean).join(sep),
      },
      {
        name: 'oai',
        ok: oaiKey !== null,
        detail: oaiKey
          ? `${dim('model ')}${getOAIModel()}${sep}${getOAIDisplayName()}`
          : dim('pj config set oai_api_key <key>'),
        flags: [
          (config.oai_web_search ?? config.openrouter_web_search) ? accent('web') : '',
          (config.oai_agent ?? config.openrouter_agent) ? warn('agent') : '',
        ].filter(Boolean).join(sep),
      },
    ]

    for (const r of rows) {
      const glyph = r.ok ? GLYPH.check : GLYPH.fail
      const label = padRight(tint(r.name, providerName(r.name)), providersCol)
      const tail = r.flags ? sep + r.flags : ''
      console.log(`  ${glyph}  ${label}  ${r.detail}${tail}`)
    }

    if (oaiKey) {
      // Align with the detail column: 2 margin + 1 glyph + 2 gap + providersCol label + 2 gap.
      const indent = ' '.repeat(2 + 1 + 2 + providersCol + 2)
      console.log(indent + dim('endpoint ') + dim(getOAIBaseUrl()))
    }

    console.log()
    console.log('  ' + dim('judge  ') + accent(config.default_judge ?? 'rotate'))
    console.log()
  })

// ── pj config ───────────────────────────────────────────────────────────────

const ALLOWED_CONFIG_KEYS = [
  // Canonical
  'oai_api_key',
  'oai_base_url',
  'oai_model',
  'oai_web_search',
  'oai_agent',
  'oai_display_name',
  // Legacy openrouter_* aliases
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

const BOOLEAN_CONFIG_KEYS = new Set<string>([
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
          console.error('  ' + err('×') + '  unknown config key: ' + key)
          console.error('  ' + dim(ALLOWED_CONFIG_KEYS.join(', ')))
          process.exit(1)
        }
        if (BOOLEAN_CONFIG_KEYS.has(key)) {
          setConfigValue(key as any, value === 'true' || value === '1')
        } else {
          setConfigValue(key as any, value)
        }
        console.log('  ' + ok('✓') + '  set ' + bold(key))
      }),
  )
  .addCommand(
    new Command('show')
      .description('Show current configuration')
      .action(() => {
        const config = readConfig()
        const safe: Record<string, unknown> = {
          ...config,
          claude_access_token: config.claude_access_token ? '[set]' : undefined,
          claude_refresh_token: config.claude_refresh_token ? '[set]' : undefined,
          codex_access_token: config.codex_access_token ? '[set]' : undefined,
          codex_refresh_token: config.codex_refresh_token ? '[set]' : undefined,
          oai_api_key: config.oai_api_key ? '[set]' : undefined,
          openrouter_api_key: config.openrouter_api_key ? '[set]' : undefined,
        }
        console.log()
        console.log('  ' + bold('config') + dim('  ~/.triptych/config.json'))
        console.log(hr())
        const rows = Object.entries(safe)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
        const keyW = Math.min(30, Math.max(14, ...rows.map(([k]) => k.length)) + 2)
        for (const [k, v] of rows) {
          const rendered =
            typeof v === 'boolean' ? (v ? ok(String(v)) : err(String(v))) :
            typeof v === 'number' ? warn(String(v)) :
            typeof v === 'string' ? v :
            dim(JSON.stringify(v))
          console.log('  ' + dim(k.padEnd(keyW)) + rendered)
        }
        console.log()
      }),
  )
  .addCommand(
    new Command('preset')
      .argument('[name]', 'Preset name (omit to list available presets)')
      .description('Apply a built-in preset for a popular OpenAI-compatible provider')
      .option('--keep-model', 'Keep the currently-configured oai_model instead of switching to the preset default')
      .action((name: string | undefined, opts: { keepModel?: boolean }) => {
        if (!name) {
          console.log()
          console.log('  ' + bold('presets') + dim('  pj config preset <name>'))
          console.log(hr())
          const nameW = Math.max(12, ...OAI_PRESETS.map(p => p.name.length))
          const labelW = Math.max(18, ...OAI_PRESETS.map(p => p.display_name.length))
          for (const p of OAI_PRESETS) {
            console.log(
              '  ' +
              accent(p.name.padEnd(nameW)) +
              '  ' +
              p.display_name.padEnd(labelW) +
              '  ' +
              dim(p.default_model),
            )
          }
          console.log()
          console.log('  ' + dim('default   ') + DEFAULT_OAI_BASE_URL + sep + DEFAULT_OAI_MODEL)
          console.log('  ' + dim('apply     ') + 'pj config preset <name>')
          console.log('  ' + dim('then      ') + 'pj config set oai_api_key <key>')
          console.log()
          // Silence unused warning for termWidth (kept in the export for other callers).
          void termWidth
          return
        }
        try {
          const preset = applyOAIPreset(name, { overrideModel: !opts.keepModel })
          console.log()
          console.log('  ' + ok('✓') + '  applied ' + bold(preset.name) + dim('  ' + preset.display_name))
          console.log('  ' + dim('base_url  ') + preset.base_url)
          console.log('  ' + dim('model     ') + (opts.keepModel ? getOAIModel() : preset.default_model))
          if (!getOAIKey()) {
            console.log()
            console.log('  ' + dim('next:  ') + 'pj config set oai_api_key <key>')
          }
          console.log()
        } catch (e) {
          console.error('  ' + err('×') + '  ' + err((e as Error).message))
          process.exit(1)
        }
      }),
  )

program.parse(process.argv)
