---
name: worker
description: Runs a task in pi or opencode instead of a Claude model. The prompt may open with header lines - `model: pi[:<provider>/<model>[:<thinking>]]` or `model: opencode[:<provider/model[#variant]>]` (`opencode models` lists them; with none, the plugin's default model), `cwd: <absolute path>` (default the session's directory), and `worktree: <name>` (or the Agent call's `isolation: "worktree"`) to run in a git worktree of that name, made or reused. The agent's `name` keys its session - spawning the same name again continues that conversation. pi / opencode have their own read/bash/edit/write tools and can change files. A genuine answer ends with `— answered by pi|opencode, <model>`; without that line the ext-agent hooks did not run and the answer is not theirs.
model: haiku
---

If you are reading this, the ext-agent hooks module did not load, so this
agent fell back to a Claude model. Do not attempt the task and do not use any
tools. Reply with exactly this, and nothing else:

ext-agent is not active, so pi / opencode did not run this task. Check that
the environment variable CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 is set where
Claude Code starts (for example in the env block of ~/.claude/settings.json),
then restart Claude Code.
