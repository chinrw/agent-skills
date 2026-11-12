---
name: pi-headless
description: >-
  Run the pi coding agent directly in headless mode for an authorized delegated
  task, with selectable model and reasoning effort, saved sessions, progress
  collection, and exact-session continuation. Use when asked to invoke pi from
  another agent or a script, or to diagnose a headless pi invocation.
---

# Pi headless

Invoke the installed `pi` CLI for the delegated task. The caller supplies the
scope and verifies the result. A new pi process does not inherit the caller's
conversation, model, effort, or sandbox permissions.

## Prepare the handoff

Prepare the assignment in the controlling conversation, where the user's
corrections and decisions are available. For work that depends on conversation
history or prior investigation, follow [the handoff workflow](references/handoff.md)
before dispatch. Write `HANDOFF.md` with the task state, acceptance criteria,
constraints and decisions, source evidence, outstanding writers, authorization,
gaps, and first action. Keep `task.md` as the short instruction to execute it.
A self-contained question can put all needed context directly in `task.md`.

On the same host, use accessible workspace and evidence paths. For a recipient
without that access, the handoff workflow routes to `context-bundle` for a
verified portable archive. Check inputs from the recipient's environment before
launching; partial context must remain explicit.

## Prepare the runtime

Resolve the installed executable and read `pi --help`. Prefer its interface and
bundled documentation when online examples describe a different version. Check
these inputs before launching:

- **Working directory:** launch in the actual target workspace. It controls
  project instructions, configuration, relative file inputs, and session lookup.
- **Model:** honor the requested provider and model. Use an exact
  `--model provider/model-id`, or `--provider provider --model model-id`.
  Resolve available IDs with `pi --list-models` when needed; fuzzy matches can
  select a different model or provider.
- **Effort:** map the requested reasoning effort to `--thinking`, not an invented
  `--effort` flag. The inspected CLI accepts `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, and `max`; confirm support in the installed version.
  `--thinking` overrides a `:level` model suffix. Pi may clamp the value to the
  model's capabilities, so record requested and observed settings separately.
- **Defaults:** when model or effort is unspecified, omit that override and use
  pi's configured or resumed-session value. Do not assume it matches the caller.
  Keep explicit choices on continuation, including intentional model changes.
- **Credentials and writable state:** reuse the configured provider credentials.
  If readiness needs checking, use `pi auth check --provider NAME --json` when
  supported. Keep credentials out of command arguments and logs. Pi may write
  locks or session state under its configuration directory even for CLI startup.
  Resolve host sandbox denials through the host's approval mechanism.

Keep normal instructions and permission extensions loaded. `--approve` trusts
project resources; it does not grant operating-system permissions. Diagnose a
trust or extension failure before changing those controls. `--offline` suppresses
startup network refreshes; it still allows model requests and is useful when the
installed catalogs are sufficient.

## Launch one invocation

Use `--print` for final text only, or `--mode json` for structured progress and
failure inspection. JSON mode is one invocation that exits after its prompts;
RPC is a long-lived protocol. Use the shell tool's managed background execution
for a long invocation and retain its process handle.

Create a fresh attempt directory outside the target source tree. Save the task,
launch arguments, canonical cwd, baseline revision, session identity, and logs
there. An attempt directory needs to survive for as long as continuation or
handoff is required; `/tmp` is suitable only for disposable runs.

The following Bash example assumes `workspace`, `attempt_dir`, and `task_id`
are set, and `HANDOFF.md` and `task.md` already exist. `task_id` is unique. Set
`pi_model` and `pi_effort` only for requested overrides; unset values preserve
pi's defaults.

```bash
cd -- "$workspace" || exit 1
mkdir -p -- "$attempt_dir/sessions"
pi_args=(--mode json --session-dir "$attempt_dir/sessions"
         --session-id "$task_id")
if [[ -n ${pi_model:-} ]]; then
  pi_args+=(--model "$pi_model")
fi
if [[ -n ${pi_effort:-} ]]; then
  pi_args+=(--thinking "$pi_effort")
fi
if pi "${pi_args[@]}" "@$attempt_dir/HANDOFF.md" "@$attempt_dir/task.md" \
    > "$attempt_dir/events.jsonl" 2> "$attempt_dir/stderr.log"; then
  pi_exit=0
else
  pi_exit=$?
fi
printf '%s\n' "$pi_exit" > "$attempt_dir/exit-code"
```

Omit the `HANDOFF.md` argument for a self-contained question without that file.
Run array examples with Bash when the host uses another shell. File arguments
avoid shell expansion of prompt contents. Pass an argument vector when using a
process API rather than assembling an interpolated command string.

For a task limited to file inspection, add `--tools read,grep,find,ls` and
`--exclude-tools 'mcp__*'` when supported. A plain `--tools` allowlist alone can
retain MCP tools. Tool selection restricts model calls; it is not a filesystem
sandbox and does not constrain extension startup code. Implementation tasks
need the tools and existing permission controls appropriate to their scope.

## Collect and verify

Keep stdout and stderr separate. JSON output is an LF-delimited event stream,
not a single JSON result. Consume the stream continuously, or redirect it to a
file as above, so pipe backpressure cannot stall pi.

For the inspected interface:

1. Verify the initial `session` header's ID and cwd against the assignment.
   Record the exact persisted session file. Inspect session model/thinking
   entries and assistant-message metadata for observed settings; leave values
   unknown when the runtime does not expose them.
2. Wait through `agent_settled` and the one-shot process's exit. `agent_end`
   closes one low-level run and can precede retries or recovery. A shell-tool
   timeout or quiet log does not establish that the process stopped.
3. Read the final assistant `message_end`, stderr, and relevant tool results.
   JSON mode can exit zero with an assistant error or abort. An aborted run,
   final `stopReason` of `error`, `aborted`, or `length`, or missing terminal
   evidence requires inspection rather than a success report. Earlier errors
   may have recovered; assess the final outcome.
4. Check every handoff acceptance criterion against the actual files, diff,
   and requested verification evidence. A final message or settled process
   establishes neither correct implementation nor completed deliverables. Report passed, failed, and unrun checks separately.

If cancellation is necessary, use the saved process handle and confirm that
pi and any task-started workers have ended before restarting a writer. Preserve
partial output and changes when termination or completion remains uncertain.

## Continue the exact session

Wait for the previous invocation and its workers to finish before continuing.
Carry new user corrections, changed inputs, and remaining acceptance criteria
in `follow-up.md`. Attach an updated handoff if its state changes, retaining the
version used for each invocation. Use the recorded absolute session file, the
same workspace, and fresh log names:

```bash
pi --mode json --session "$session_file" \
  --model "$pi_model" --thinking "$pi_effort" \
  "@$attempt_dir/follow-up.md" \
  > "$attempt_dir/follow-up.events.jsonl" \
  2> "$attempt_dir/follow-up.stderr.log"
```

Omit an override when it was not requested; capture this invocation's exit code
as for the first run. Resuming uses the session's recorded cwd, which can differ
from the launching shell's cwd. Verify it before allowing edits. `--continue`
selects the latest session for a directory, and bare `--resume` opens a picker;
neither identifies an exact delegated task. `--no-session` suits disposable
questions whose history will not be needed.

When the user needs live steering or repeated messages to one running process,
read the installed RPC documentation and use `--mode rpc`. Subscribe before
sending a prompt, correlate command IDs, wait for `agent_settled`, then close
stdin and collect the process. A successful prompt response only acknowledges
acceptance. RPC does not accept `@file` positional inputs; send task text in
the JSON command. Handle required extension UI requests or report the blocker.

## References

Consult the installed version first. These upstream sources explain the
interfaces and informed this workflow:

- [CLI integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md)
  distinguishes one-shot execution, JSON failures, and RPC completion.
- [CLI options](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)
  documents model selection, thinking levels, sessions, and tool filtering.
- [JSON events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)
  defines event framing and terminal evidence.
- [pi-multi-agent-skill](https://github.com/milanglacier/pi-multi-agent-skill)
  provides a separate job-manager approach when persistent background jobs
  and steering justify an additional runner. Its helper commands are not pi
  CLI flags.
