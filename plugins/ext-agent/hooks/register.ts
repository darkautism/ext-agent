import type { EngineInterface, Register, StreamHook, TurnStepChunk } from 'claude-code'

/**
 * ext-agent: adds the Agent tool's `ext-agent:worker` type, whose turns run
 * pi or opencode instead of a Claude model. The built-in agent types stay
 * available unless the `blockBuiltin` option is on, in which case they are
 * hidden from the model and refused with a message saying how to dispatch
 * instead.
 *
 * Each tool call pi / opencode makes becomes one of the worker's own tool
 * calls (Bash, Read, Write, Edit), answered here with what the CLI already
 * got, so the subagent view groups them as it does any agent's ("Ran 3
 * commands"). What the transcript keeps of each result is clipped, and a long
 * worker's transcript is compacted here without asking any model.
 */

const TYPE = 'ext-agent:worker'
const HEADER = /^[ \t]*(model|cwd|worktree)[ \t]*:[ \t]*(\S.*?)[ \t]*$/i
/** How much of a tool's output the worker's transcript keeps. */
const KEPT = 1500
/** Messages of a worker's transcript kept when it is compacted. */
const KEEP_MESSAGES = 80

type Config = { blockBuiltin: boolean; defaultModel: string; worktreeLayout: 'claude' | 'sibling' }
let config: Config = { blockBuiltin: false, defaultModel: 'pi', worktreeLayout: 'claude' }

const usage = (why: string) =>
  `${why}\n\n` +
  `Dispatch external agents with Agent(subagent_type: "${TYPE}"); the prompt may open with:\n` +
  `  model: pi[:<provider>/<model>[:off|minimal|low|medium|high|xhigh]]   (pi's own default when no model is named)\n` +
  `  model: opencode[:<provider/model[#variant]>]                      (\`opencode models\` lists them)\n` +
  `  cwd: <absolute path>                                              (default: the session's directory)\n` +
  `  worktree: <name>   (or isolation: "worktree") runs in a git worktree of that name, made or reused\n` +
  `The default model is "${config.defaultModel}". Give the Agent a \`name\` to continue its session later.` +
  (config.blockBuiltin ? '\nBuilt-in subagent types are disabled by this plugin\'s blockBuiltin option.' : '')

const isWorker = (type: string) => type === TYPE

const clip = (text: string, max = KEPT) =>
  text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters kept by the CLI only)`

type Header = { model?: string; cwd?: string; worktree?: string; body: string }

/** Takes the `model:` / `cwd:` / `worktree:` lines off the top of a prompt. */
function headerOf(text: string): Header {
  const lines = text.replace(/^\s*\n/, '').split('\n')
  const out: Header = { body: '' }
  while (lines.length > 0) {
    const m = lines[0].match(HEADER)
    if (!m) break
    out[m[1].toLowerCase() as 'model' | 'cwd' | 'worktree'] = m[2]
    lines.shift()
  }
  out.body = lines.join('\n').trim()
  return out
}

/** `model` is absent when the CLI is left to pick its own default. */
type Spec = { cli: 'pi' | 'opencode'; model?: string }

let opencodeModels: Promise<Set<string>> | undefined

/** `pi`, `pi:<model>`, `opencode` or `opencode:<model>`, checked. */
async function specOf($: EngineInterface, model = config.defaultModel): Promise<Spec | { error: string }> {
  const m = model.trim().match(/^(pi|opencode)(?::(\S+))?$/)
  if (!m) return { error: `Model "${model}" is not "pi[:<model>]" or "opencode[:<model>]".` }
  const [, cli, name] = m
  if (cli === 'pi') {
    if (name !== undefined && !/^[\w.\-]+\/[\w.\-:/]+$/.test(name) && !/^[\w.\-]+$/.test(name)) return { error: `Unusable pi model "${name}".` }
    return { cli: 'pi', model: name }
  }
  if (name === undefined) return { cli: 'opencode' }
  opencodeModels ??= $.process
    .run(['opencode', 'models'])
    .then(({ stdout }) => new Set(stdout.split('\n').map((l) => l.trim()).filter(Boolean)))
  const known = await opencodeModels
  if (known.has(name.split('#')[0])) return { cli: 'opencode', model: name }
  opencodeModels = undefined
  return { error: `Unknown opencode model "${name}".` }
}

/**
 * argv run from `dir`: the engine's own `cwd` option does not reach what
 * pi / opencode read as their directory, so a shell changes into it first.
 */
const inDir = (dir: string, argv: string[]) => ['/bin/sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', dir, ...argv]

/**
 * argv run from `dir` in a process group of its own, which the shell takes
 * down whole when the engine ends it (TaskStop, an interrupt), so no tool the
 * CLI started outlives the worker.
 */
const supervised = (dir: string, argv: string[]) => [
  '/bin/sh', '-c',
  'cd "$1" && shift; set -m; "$@" & pid=$!; trap "kill -TERM -$pid 2>/dev/null; exit 143" TERM INT HUP; wait $pid',
  'sh', dir, ...argv,
]

/**
 * The session a worker's earlier turn left, by its title. Listed through a
 * standalone server as the run itself is: the background service can hold a
 * stale idea of which project a directory is, and would not find it.
 */
async function opencodeSession($: EngineInterface, cwd: string, title: string) {
  const { stdout } = await $.process.run(inDir(cwd, ['opencode', 'session', 'list', '--standalone', '--format', 'json']))
  try {
    const sessions = JSON.parse(stdout) as { id: string; title?: string }[]
    return sessions.find((s) => s.title === title)?.id
  } catch {
    return undefined
  }
}

/**
 * A worktree for a `worktree:` line. Laid out as Claude Code's own are (the
 * default): `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`, off
 * what the `worktree.baseRef` setting says (`fresh`, the default: the remote's
 * default branch; `head`: the current HEAD). With the `sibling` layout:
 * `<repo>-wt/<name>` beside the repository on `wip/<name>`, off `main`.
 * An existing worktree or branch of that name is reused.
 */
async function worktreeOf($: EngineInterface, cwd: string, label: string) {
  const git = (...argv: string[]) => $.process.run(['git', '-C', cwd, ...argv])
  const top = await git('rev-parse', '--show-toplevel')
  if (top.exitCode !== 0) return { error: `${cwd} is not in a git repository` }
  const repo = top.stdout.trim()
  const sibling = config.worktreeLayout === 'sibling'
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'worker'
  const path = sibling ? `${repo}-wt/${slug}` : `${repo}/.claude/worktrees/${slug}`
  const branch = sibling ? `wip/${slug}` : `worktree-${slug}`
  // Forget worktrees whose directories were deleted, so their paths and
  // branches can be used again.
  await git('worktree', 'prune')
  const listed = await git('worktree', 'list', '--porcelain')
  if (listed.stdout.split('\n').includes(`worktree ${path}`)) return { path }
  const exists = await git('rev-parse', '--verify', '-q', `refs/heads/${branch}`)
  let argv: string[]
  if (exists.exitCode === 0) argv = [path, branch]
  else {
    let base: string | undefined
    if (sibling) {
      if ((await git('rev-parse', '--verify', '-q', 'main')).exitCode === 0) base = 'main'
    } else if (((await $.settings.read()) as { worktree?: { baseRef?: string } }).worktree?.baseRef !== 'head') {
      const remote = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
      if (remote.exitCode === 0) base = remote.stdout.trim()
    }
    argv = ['-b', branch, path, ...(base ? [base] : [])]
  }
  const added = await git('worktree', 'add', '-q', ...argv)
  if (added.exitCode !== 0) return { error: added.stderr.trim() || `git worktree add exited ${added.exitCode}` }
  return { path }
}

/**
 * An Agent call's arguments with a `model` the schema would refuse
 * (`pi…`, `opencode…`) moved into the prompt's `model:` line, so the
 * engine's validation sees a call it accepts. Unparseable JSON passes as is.
 */
function movedModel(json: string) {
  let input: Record<string, unknown>
  try { input = JSON.parse(json) } catch { return json }
  const model = input.model
  if (typeof model !== 'string' || !/^(pi|opencode)(:|$)/.test(model)) return json
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const rest = prompt.replace(/^\s*model[ \t]*:.*(\n|$)/i, '')
  const { model: _, ...kept } = input
  return JSON.stringify({ ...kept, prompt: `model: ${model}\n${rest}` })
}

// ---------------------------------------------------------------------------
// A run: one CLI process answering one turn of a worker, read piece by piece
// by whichever dispatch is waiting on it (a step, or a tool call's result).

type Call = { name: 'Bash' | 'Read' | 'Write' | 'Edit'; input: Record<string, unknown> }
type Event = { kind: 'show'; text: string } | ({ kind: 'tool'; id: string } & Call)
type Outcome = { output: string; isError: boolean }

type Run = {
  spec: Spec
  stream: AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, { code: number | null; signal: string | null }>
  events: Event[]
  calls: Map<string, Call>
  outcomes: Map<string, Outcome>
  /** The CLI's own id for each call, to ours. */
  ids: Map<string, string>
  buffer: string
  stderr: string
  error: string
  answered: string
  answer: string
  current: string
  texts: Map<string, string>
  lastMessage: string
  ended?: string
}

const runs = new Map<string, Run>()
const ours = new Set<string>()
/** The header each worker was spawned with, past the 4096 messages a read returns. */
const spawned = new Map<string, Header>()
let serial = 0

/** One of the worker's own tool calls standing for a CLI's. */
function callOf(tool: string, args: Record<string, any> = {}): Call {
  const path = String(args.path ?? args.filePath ?? args.file_path ?? '')
  switch (tool.toLowerCase()) {
    case 'bash':
    case 'shell':
      return { name: 'Bash', input: { command: String(args.command ?? '') } }
    case 'read':
      return { name: 'Read', input: { file_path: path, ...(args.offset ? { offset: args.offset } : {}), ...(args.limit ? { limit: args.limit } : {}) } }
    case 'write':
      return { name: 'Write', input: { file_path: path, content: clip(String(args.content ?? ''), 400) } }
    case 'edit': {
      const first = Array.isArray(args.edits) ? args.edits[0] ?? {} : args
      return {
        name: 'Edit',
        input: {
          file_path: path,
          old_string: clip(String(first.oldText ?? first.oldString ?? ''), 400),
          new_string: clip(String(first.newText ?? first.newString ?? ''), 400),
        },
      }
    }
    default:
      return { name: 'Bash', input: { command: clip(`${tool} ${JSON.stringify(args)}`, 400) } }
  }
}

/** A CLI's tool output as the worker's own tool records a result. */
function resultOf(call: Call, output: string): unknown {
  const kept = clip(output)
  const file_path = String(call.input.file_path ?? '')
  switch (call.name) {
    case 'Bash':
      return { stdout: kept, stderr: '', interrupted: false }
    case 'Read': {
      const numLines = kept.split('\n').length
      return { type: 'text', file: { filePath: file_path, content: kept, numLines, startLine: Number(call.input.offset ?? 1), totalLines: numLines } }
    }
    case 'Write':
      return { type: 'create', filePath: file_path, content: '', structuredPatch: [], originalFile: null }
    case 'Edit':
      return {
        filePath: file_path, oldString: call.input.old_string, newString: call.input.new_string,
        originalFile: null, structuredPatch: [], userModified: false, replaceAll: false,
      }
  }
}

const textOf = (content: unknown) =>
  Array.isArray(content) ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('') : String(content ?? '')

function called(run: Run, cliId: string, tool: string, args: Record<string, any>) {
  const id = `toolu_ext_${Date.now().toString(36)}_${(serial++).toString(36)}`
  const call = callOf(tool, args)
  ours.add(id)
  run.ids.set(cliId, id)
  run.calls.set(id, call)
  run.events.push({ kind: 'tool', id, ...call })
  return id
}

/** Reads the CLI's next piece of output into the run's events and outcomes. */
async function pull(run: Run) {
  const piece = await run.stream.next()
  if (piece.done) {
    const { code, signal } = piece.value
    if (run.spec.cli === 'pi' && run.current.trim()) run.answer = run.current
    if (run.spec.cli === 'opencode') run.answer = run.texts.get(run.lastMessage) ?? ''
    run.ended = `exit ${code ?? signal}`
    return
  }
  if (piece.value.stream === 'stderr') {
    run.stderr = (run.stderr + piece.value.text).slice(-4000)
    return
  }
  run.buffer += piece.value.text
  const lines = run.buffer.split('\n')
  run.buffer = lines.pop() ?? ''
  for (const line of lines) {
    let ev: any
    try { ev = JSON.parse(line) } catch { continue }
    const show = (text: string) => text && run.events.push({ kind: 'show', text })
    if (run.spec.cli === 'pi') {
      const d = ev.type === 'message_update' ? ev.assistantMessageEvent : undefined
      if (ev.type === 'message_start' && ev.message?.role === 'assistant') run.current = ''
      if (d?.type === 'text_delta') { run.current += d.delta ?? ''; show(d.delta ?? '') }
      if (ev.type === 'tool_execution_start') called(run, ev.toolCallId, ev.toolName, ev.args)
      if (ev.type === 'tool_execution_end') {
        const id = run.ids.get(ev.toolCallId)
        if (id) run.outcomes.set(id, { output: textOf(ev.result?.content), isError: ev.isError === true })
      }
      if (ev.type === 'turn_end') {
        const m = ev.message ?? {}
        if (m.provider && m.model) run.answered = `${m.provider}/${m.model}`
        if (m.errorMessage) { run.error = m.errorMessage; show(`\n✗ ${m.errorMessage}\n`) }
        if (run.current.trim()) run.answer = run.current
        run.current = ''
      }
    } else {
      const p = ev.part ?? {}
      if (ev.type === 'tool_use') {
        const id = called(run, p.callID ?? p.id ?? String(serial), p.tool ?? 'tool', p.state?.input ?? {})
        const failed = p.state?.status === 'error'
        run.outcomes.set(id, { output: String((failed ? p.state?.error : p.state?.output) ?? ''), isError: failed })
      }
      if (ev.type === 'text' && typeof p.text === 'string') {
        run.lastMessage = p.messageID
        run.texts.set(p.messageID, (run.texts.get(p.messageID) ?? '') + p.text)
        show(`${p.text}\n`)
      }
      if (ev.type === 'error') { run.error = JSON.stringify(ev.error ?? ev).slice(0, 500); show(`✗ ${run.error}\n`) }
    }
  }
}

function stop(agentId: string) {
  const run = runs.get(agentId)
  runs.delete(agentId)
  void run?.stream.return(undefined as never).catch(() => {})
}

/** Why a run ended with no answer, short: the error, else stderr's last lines. */
function failureOf(run: Run) {
  const stderr = run.stderr
    .split('\n')
    .filter((l) => l.trim() && !/^\[\d+\][+-]?\s+(Done|Exit|Terminated|Killed)/.test(l))
    .slice(-6)
    .join('\n')
  return `ext-agent: ${run.spec.cli} (${run.spec.model ?? 'default model'}) ended without an answer (${run.ended}).` +
    (run.error ? `\n${run.error}` : '') + (stderr ? `\n${stderr}` : '')
}

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  config = {
    blockBuiltin: options.blockBuiltin === true,
    defaultModel: String(options.defaultModel || 'pi'),
    worktreeLayout: options.worktreeLayout === 'sibling' ? 'sibling' : 'claude',
  }

  if (config.blockBuiltin) on('agent.offer', ($, e, next) => (e.provider.plugin === 'ext-agent' ? next(e) : { isOffered: false }))

  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const described = await next(e)
    return {
      ...described,
      description:
        `${described.description}\n\n` +
        `ext-agent: subagent_type "${TYPE}" runs the task in pi or opencode instead of a Claude model. Its \`model\` takes ` +
        `"pi[:<provider>/<model>[:<thinking>]]" or "opencode[:<provider/model[#variant]>]" (\`opencode models\` lists them); ` +
        `Claude model names do nothing for it. The default is "${config.defaultModel}".` +
        (config.blockBuiltin ? ' It is the only subagent_type allowed.' : ''),
    }
  })

  // The model's Agent calls, rewritten before the engine parses them: the
  // arguments of each Agent block are held until the block ends, then passed
  // on as one piece with a pi / opencode `model` moved into the prompt.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* workerStep($, e, next)
    const held = new Map<number, string>()
    const stream = next(e)
    const flush = function* () {
      for (const [index, json] of held) yield { kind: 'input', index, json: movedModel(json) } as TurnStepChunk
      held.clear()
    }
    for await (const chunk of stream) {
      if (chunk.kind === 'tool' && chunk.name === 'Agent') held.set(chunk.index, '')
      else if (chunk.kind === 'input' && held.has(chunk.index)) {
        held.set(chunk.index, held.get(chunk.index) + chunk.json)
        continue
      } else yield* flush()
      yield chunk
    }
    yield* flush()
    const result = await stream.result
    return {
      ...result,
      toolUses: result.toolUses.map((use) =>
        use.name === 'Agent' ? { ...use, input: JSON.parse(movedModel(JSON.stringify(use.input))) } : use,
      ),
    }
  })

  on('tool.call', async ($, e, next) => {
    if (!ours.has(e.tool_use_id)) return next(e)
    ours.delete(e.tool_use_id)
    const run = e.agentId === undefined ? undefined : runs.get(e.agentId)
    if (run === undefined) return { deny: 'ext-agent: the worker that made this call is gone.' }
    const onAbort = () => stop(e.agentId as string)
    next.signal.addEventListener('abort', onAbort)
    try {
      while (!run.outcomes.has(e.tool_use_id) && run.ended === undefined) await pull(run)
    } finally {
      next.signal.removeEventListener('abort', onAbort)
    }
    const outcome = run.outcomes.get(e.tool_use_id)
    const call = run.calls.get(e.tool_use_id)
    if (outcome === undefined || call === undefined) return { deny: `${run.spec.cli} ended before this call finished.` }
    if (outcome.isError) return { deny: clip(outcome.output || 'failed') }
    return { result: resultOf(call, outcome.output) as never }
  })

  // A worker's transcript mirrors every step of pi / opencode, so a long task
  // outgrows the context window and the CLI ends the agent with "Prompt is too
  // long". No model is asked to summarise it: the hook drops the middle itself.
  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const agent = (await $.agent.list()).find((a) => a.id === e.agentId)
    if (agent === undefined || !isWorker(agent.type)) return next(e)
    const m = e.messages
    // The tail starts on an assistant message, so a tool_use keeps its result.
    let cut = Math.max(m.length - KEEP_MESSAGES, 1)
    while (cut < m.length && m[cut].role !== 'assistant') cut++
    if (cut <= 1 || cut >= m.length) return { skip: 'ext-agent: the worker transcript is already short.' }
    const isTask = (x: (typeof m)[number]) => x.role === 'user' && x.text !== '' && !x.toolResults?.length
    const task = m.findLastIndex(isTask)
    const dropped = m.slice(1, cut).filter((_, i) => i + 1 !== task)
    const calls = dropped.reduce((n, x) => n + x.toolUses.length, 0)
    const note = {
      role: 'assistant' as const,
      toolUses: [],
      text: `ext-agent: ${dropped.length} earlier messages (${calls} tool calls) were dropped from this transcript to keep it within the context window. The pi / opencode session still holds the full history.`,
    }
    return { messages: [m[0], ...(task > 0 && task < cut ? [m[task]] : []), note, ...m.slice(cut)] }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = e.subagent_type ?? 'general-purpose'
    if (!isWorker(type)) return config.blockBuiltin ? { deny: usage(`subagent_type "${type}" is not allowed.`) } : next(e)
    const header = headerOf(e.prompt)
    const spec = await specOf($, header.model)
    if ('error' in spec) return { deny: usage(spec.error) }
    if (e.isolation !== 'worktree') return next(e)

    // The engine's worktree is the subagent's cwd, which pi / opencode never
    // see; the worker makes its own from a `worktree:` line instead. Only the
    // prompt changes here, so a call that passes through again is the same.
    const lines = [
      `model: ${header.model ?? config.defaultModel}`,
      ...(header.cwd ? [`cwd: ${header.cwd}`] : []),
      `worktree: ${header.worktree ?? e.name ?? e.description}`,
      '',
      header.body,
    ]
    return next({ ...e, isolation: undefined, prompt: lines.join('\n') })
  })
}

/** Starts the CLI for a worker's turn, or says why it cannot. */
async function started($: EngineInterface, agentId: string, name: string): Promise<Run | string> {
  // The newest user message is the task: the spawn's prompt, or a SendMessage.
  // Its model, cwd and worktree are the spawn's unless it names its own.
  const messages = await $.session.messages({ agentId })
  if ('deny' in messages) return `ext-agent: cannot read this agent's prompt (${messages.deny}).`
  const headers = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
    .filter(Boolean)
    .map(headerOf)
  const first = spawned.get(agentId) ?? headers[0] ?? { body: '' }
  spawned.set(agentId, first)
  const header = headers.at(-1) ?? { body: '' }
  header.model ??= first.model
  header.cwd ??= first.cwd
  header.worktree ??= first.worktree
  const spec = await specOf($, header.model)
  if ('error' in spec) return `ext-agent: ${usage(spec.error)}`
  if (!header.body) return 'ext-agent: the prompt is empty.'

  let cwd = header.cwd ?? (await $.session.cwd())
  if ((await $.process.run(['test', '-d', cwd])).exitCode !== 0) return `ext-agent: cwd "${cwd}" does not exist.`
  if (header.worktree) {
    const made = await worktreeOf($, cwd, header.worktree)
    if ('error' in made) return `ext-agent: worktree "${header.worktree}" failed: ${made.error}`
    cwd = made.path
  }
  const key = `ext-${name.replace(/[^A-Za-z0-9_-]/g, '-')}`
  let argv: string[]
  if (spec.cli === 'pi') {
    argv = ['pi', '-p', '--mode', 'json', ...(spec.model ? ['--model', spec.model] : []), '--session-id', key, header.body]
  } else {
    const session = await opencodeSession($, cwd, key)
    argv = ['opencode', 'run', '--standalone', '--auto', '--format', 'json', ...(spec.model ? ['--model', spec.model] : []), '--title', key,
      ...(session ? ['--session', session] : []), header.body]
  }
  const run: Run = {
    spec, stream: $.process.spawn({ argv: supervised(cwd, argv) }),
    events: [{ kind: 'show', text: `${spec.cli} ${spec.model ?? '(default model)'} in ${cwd}\n` }],
    calls: new Map(), outcomes: new Map(), ids: new Map(),
    buffer: '', stderr: '', error: '', answered: spec.model ?? spec.cli, answer: '', current: '', texts: new Map(), lastMessage: '',
  }
  runs.set(agentId, run)
  return run
}

/**
 * A worker's step: the CLI's output up to its next tool call (the step ends
 * calling the matching tool) or to its end (the step ends with its answer).
 */
const workerStep: StreamHook<'turn.step'> = async function* ($, e, next) {
  if (e.agentId === undefined) return yield* next(e)
  const agentId = e.agentId
  const agent = (await $.agent.list()).find((a) => a.id === agentId)
  if (agent === undefined || !isWorker(agent.type)) return yield* next(e)

  const finish = async function* (answer: string) {
    yield { kind: 'text', index: 1, text: answer } as TurnStepChunk
    yield { kind: 'stop', stopReason: 'end_turn', usage: null } as TurnStepChunk
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn' as const, usage: null }
  }

  let run = runs.get(agentId)
  if (e.index === 0 || run === undefined) {
    stop(agentId)
    const made = await started($, agentId, agent.name ?? agent.id)
    if (typeof made === 'string') return yield* finish(made)
    run = made
  }

  const onAbort = () => stop(agentId)
  next.signal.addEventListener('abort', onAbort)
  try {
    for (;;) {
      const ev = run.events.shift()
      if (ev === undefined) {
        if (run.ended !== undefined) break
        await pull(run)
        continue
      }
      if (ev.kind === 'show') {
        yield { kind: 'thinking', index: 0, text: ev.text } as TurnStepChunk
        continue
      }
      yield { kind: 'tool', index: 1, id: ev.id, name: ev.name } as TurnStepChunk
      yield { kind: 'input', index: 1, json: JSON.stringify(ev.input) } as TurnStepChunk
      yield { kind: 'stop', stopReason: 'tool_use', usage: null } as TurnStepChunk
      return {
        turnId: e.turnId, index: e.index, answer: '',
        toolUses: [{ name: ev.name, input: ev.input }], stopReason: 'tool_use' as const, usage: null,
      }
    }
  } finally {
    next.signal.removeEventListener('abort', onAbort)
  }

  runs.delete(agentId)
  if (run.answer.trim()) return yield* finish(`${run.answer.trim()}\n\n— answered by ${run.spec.cli}, ${run.answered}`)
  return yield* finish(failureOf(run))
}
