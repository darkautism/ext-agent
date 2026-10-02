# ext-agent

A [Claude Code](https://claude.com/claude-code) plugin that lets the **Agent tool dispatch subagents to
pi or [opencode](https://opencode.ai)** instead of a Claude model.

- Adds one agent type, `ext-agent:worker`. Its turns are run by the `pi` or `opencode` CLI; **no Claude model is
  called for them**, so they cost no Claude tokens.
- Keeps Claude Code's native subagent experience: background runs, the agent's `name`, `SendMessage` to continue a
  session, `TaskStop`, and the live "Ran 3 commands" view of what the worker is doing.
- Built-in subagents (`general-purpose`, `Explore`, …) keep working. Blocking them is an explicit opt-in.
- Optional git worktree per worker, laid out like Claude Code's own.

It is written with Claude Code's function-hooks plugin API; see `plugins/ext-agent/hooks/register.ts`.

## Requirements

- Claude Code with function hooks (developed against 2.1.285), **and the environment variable
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`** (see below).
- `pi` and/or `opencode` on your `PATH`, already logged in to whatever provider you want them to use.
- `git` if you use worktrees. macOS or Linux (the plugin runs `/bin/sh`); Windows is not supported.

## Install

```sh
claude plugin marketplace add darkautism/ext-agent
claude plugin install ext-agent@ext-agent
```

Then **turn on function hooks and restart Claude Code.** Plugins like this one only load when
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set where Claude Code starts. Either export it in your shell profile:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

or put it in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }
}
```

If it is missing, dispatching `ext-agent:worker` falls back to a small Claude model that only tells you the plugin is
not active; it does not run your task.

## Using it

Ask Claude to use it, or call the Agent tool with `subagent_type: "ext-agent:worker"`. The prompt may start with
header lines:

```
model: pi:openai-codex/gpt-6-luna:high
cwd: /path/to/project
worktree: fix-login

Fix the failing login test and run the suite.
```

| Header | Meaning |
| --- | --- |
| `model: pi` / `model: pi:<provider>/<model>[:<thinking>]` | Run `pi`. Bare `pi` lets pi use its own default model. Thinking is `off`, `minimal`, `low`, `medium`, `high` or `xhigh`. |
| `model: opencode` / `model: opencode:<provider/model>[#variant]` | Run `opencode`. The model must appear in `opencode models`. |
| `cwd: <absolute path>` | Directory to work in. Default: the session's directory. |
| `worktree: <name>` | Work in a git worktree of that name, made or reused. The Agent call's `isolation: "worktree"` does the same. |

Give the Agent a `name` to key its session: spawning the same name again, or sending it a message, continues the
same pi / opencode conversation. A genuine answer ends with `— answered by pi|opencode, <model>`.

Run it in the background with the Agent tool's `run_in_background`, as with any subagent.

> **Permissions.** pi and opencode have their own read / bash / edit / write tools and run them **without Claude
> Code's permission prompts** (opencode with `--auto`). A worker can change files and run commands in its directory.
> Use a worktree, or a directory you are happy for it to edit.

## Configuration

Set these in Claude Code's plugin config menu (each option is a row there), or in `settings.json` under
`pluginConfigs`, keyed by the plugin id (`ext-agent@ext-agent` for the install above). A change reloads the plugin.

| Option | Default | |
| --- | --- | --- |
| `blockBuiltin` | `false` | `false`: `ext-agent:worker` is added next to the built-in agent types. `true`: only `ext-agent:worker` can be dispatched; built-in types are hidden from the model and refused with a message saying how to dispatch instead. |
| `defaultModel` | `pi` | Used when an Agent call names no `model:`. Same syntax as the header, e.g. `pi:openai-codex/gpt-6-luna:high`. |
| `worktreeLayout` | `claude` | `claude`: `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`, as Claude Code does; a new branch starts from the remote's default branch, or from the current `HEAD` if the `worktree.baseRef` setting is `head`. `sibling`: `<repo>-wt/<name>` beside the repo on branch `wip/<name>`, off `main`. |

An existing worktree or branch of the same name is reused, not recreated.

Example, blocking built-in agents and using a fixed pi model:

```json
{
  "pluginConfigs": {
    "ext-agent@ext-agent": {
      "options": { "blockBuiltin": true, "defaultModel": "pi:openai-codex/gpt-6-luna:high" }
    }
  }
}
```

## How it works

The plugin hooks the Agent tool and the worker's model loop:

- When a worker takes a turn, the plugin starts `pi -p --mode json` (or `opencode run --format json`) in the worker's
  directory, in its own process group so `TaskStop` or an interrupt takes down everything the CLI started.
- Each tool call the CLI makes is replayed as one of the worker's own tool calls (`Bash`, `Read`, `Write`, `Edit`)
  answered with what the CLI already got, so Claude Code's subagent view shows it like any other agent's activity.
  The transcript keeps at most 1500 characters of each result.
- The CLI's final text becomes the worker's answer.
- A long worker's transcript would eventually pass the context window and end the agent with "Prompt is too long", so
  when Claude Code compacts a worker, the plugin drops the middle of the transcript itself (keeping the task and the
  last 80 messages) without asking any model. The full history stays in pi's / opencode's own session.

## What it sends, runs and decides

**Network.** The plugin itself makes no network calls and sends nothing anywhere. The `pi` / `opencode` process it
starts receives the task prompt (your header lines stripped) and reads and writes files in the worker's directory;
what that process sends to its model provider is up to its own configuration, not this plugin. For an opencode model,
the plugin runs `opencode models` once to check the name.

**What it reads.** For each worker turn the plugin reads that worker's *own* transcript (`$.session.messages({ agentId })`),
not the main conversation, to find the newest task message and its `model:` / `cwd:` / `worktree:` header lines. It
strips `<system-reminder>` blocks and hands only the task text to the `pi` / `opencode` process as its prompt. When a
worker is compacted (`session.compact`), it reads that worker's transcript to drop the middle of it. It reads Claude
Code's merged settings only for the `worktree.baseRef` value, and the plugin's own options. It reads no files itself;
files are read and written by the `pi` / `opencode` process you started.

**Programs it runs.** Everything goes through two Claude Code calls: `$.process.run(argv)` starts a program with the
given argument list, waits for it to finish and returns its output (used for the short `git`, `test` and
`opencode models` commands below); `$.process.spawn({ argv })` starts a program with the given argument list and
streams its output while it runs (used only for the `pi` / `opencode` agent process, wrapped in the fixed `/bin/sh`
script below). Neither call is given a shell string built from your input. The argument lists are assembled in
`hooks/register.ts` from fixed program names plus the values you pass (model, directory, prompt), each as its own
argument; the table lists every command shape:

| Program | Why |
| --- | --- |
| `pi` or `opencode` | The agent itself: `pi -p --mode json [--model <m>] --session-id <key> <prompt>`, or `opencode run --standalone --auto --format json [--model <m>] --title <key> [--session <id>] <prompt>`. |
| `opencode models`, `opencode session list --standalone --format json` | Validate an opencode model name; find the opencode session of a worker being continued. |
| `/bin/sh` | A fixed wrapper `cd "$1" && shift; set -m; "$@" & …` that changes into the worker's directory and runs the CLI in its own process group, so `TaskStop` or an interrupt stops everything the CLI started. The directory and the CLI's arguments are passed as separate arguments, not spliced into the script. |
| `test -d <cwd>` | Check the `cwd:` header names a directory. |
| `git rev-parse`, `git worktree list`, `git worktree prune`, `git symbolic-ref`, `git worktree add` | Only for `worktree:` / `isolation: "worktree"`: find the repo, reuse or create the worktree and its branch. |

It also reads Claude Code's merged settings once per worktree creation, only for the `worktree.baseRef` value.

**Hooks and what they decide.**

| Hook | What it decides, and when |
| --- | --- |
| `agent.offer` | Only when `blockBuiltin` is on: hides every agent type not provided by this plugin from the model. Otherwise not registered. |
| `tool.describe` (Agent) | Appends a short note about `ext-agent:worker` and its `model` syntax to the Agent tool's description. |
| `turn.step` | On the main conversation: if an Agent call's `model` is `pi…` or `opencode…` (which the Agent tool's schema would refuse), moves it into the prompt's `model:` header line. On a worker's own loop: runs the CLI instead of asking a Claude model (see below). Other loops pass through unchanged. |
| `tool.call` (Agent) | Only when `blockBuiltin` is on: refuses a `subagent_type` other than `ext-agent:worker` with a usage message. For `ext-agent:worker` with `isolation: "worktree"`: removes `isolation` and writes a `worktree:` header into the prompt instead, because the engine's own worktree does not reach the CLI. Everything else passes to the next hook unchanged. |
| `tool.call` (the worker's own `Bash`, `Read`, `Write`, `Edit`) | Stands in for these tools **only for calls this plugin itself created** to mirror what pi / opencode already did: it waits for the CLI's result and returns it. Any other tool call, from any agent, passes to the next hook unchanged. |
| `session.compact` | Only for a worker's own transcript: drops the middle of it without asking a model (see How it works). Any other compaction passes through unchanged. |

The plugin never answers a permission check: Claude Code's own permission rules decide for everything it does not
create. The mirrored `Bash`/`Read`/`Write`/`Edit` calls are answered from the CLI's output and execute nothing in
Claude Code.

**Tool input it changes:** only the Agent tool's call (the `model` and `isolation` fields described above).

## Limits

- Only the Claude Code side is managed. pi and opencode have their own context limits and compaction; a very long
  worker session can be rejected by the provider ("Bad Request"). Start a new `name` for a fresh session.
- The model you name must be one your pi / opencode is set up to use.
- The worker's tool calls in the subagent view are a summary: long file contents and diffs are clipped.

## Troubleshooting

- *The agent answers "ext-agent is not active"*: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is not set where Claude Code
  started, or Claude Code was not restarted after you set it.
- *"Unknown opencode model"*: the name is not in `opencode models`.
- *"ended without an answer"*: the CLI exited without a reply; the message includes its error or last stderr lines
  (often an authentication or provider error).
- Check the plugin loads: `claude plugin validate plugins/ext-agent`.

## License

MIT
