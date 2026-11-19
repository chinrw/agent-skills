---
name: delegate-tasks
description: Delegate parallel tasks to available agents and use verified results to dispatch follow-up work in the current conversation. Explicit invocation only.
disable-model-invocation: true
---

# Delegate tasks

Use this workflow when the user explicitly invokes `delegate-tasks`. The current
conversation owns the goal, scope, and final decisions. Delegate work that can
produce a result with a clear acceptance condition. Handle tightly coupled work
in the current conversation when splitting it would add coordination overhead.

## Dispatch ready work

- Use the current runtime's native agents when they meet the task's needs. Use
  an authorized external agent when the assignment calls for a different runtime
  or toolset. If pi is selected, use the `pi-headless` skill for launch and session
  handling. Honor required model, reasoning, and access settings. Surface
  unavailable requirements before assigning work that depends on them.
- Give each agent the objective, relevant evidence and user decisions, working
  location, permitted actions, and acceptance criteria. Share context within
  the chosen agent's authorization. Ask for an outcome, evidence or artifact
  paths, checks performed, and any remaining work.
- Start independent assignments together when the runtime supports it. Track
  each assignment's handle, dependencies, and expected result in the current
  conversation. Keep concurrent writes in disjoint files or isolated workspaces.

## Continue as results arrive

- For native subagents, use the runtime's completion notifications or native
  wait-for-any operation. For external processes, use the batch script below.
  When the channels are separate, use bounded waits and check each channel
  between waits. If the requested concurrency is
  unavailable, report the limitation and continue the parts that can proceed.
- Check each returned result against its acceptance criteria and underlying
  evidence. Dispatch a newly unblocked task as soon as its prerequisites are
  verified and a slot is available, even while unrelated tasks are running.
  Use the verified result as input to the new assignment. Reuse an idle agent
  when its existing context helps.
- Apply the user's latest decisions before dispatching follow-ups. Treat agent
  suggestions as evidence for the current conversation to evaluate. If a
  writer is replaced or retried, confirm that the earlier writer has stopped.

Finish when the required results have been verified and their assignments have
ended. Tell the user what was delivered, what was verified, and what still
needs attention.

## Wait for external processes

For external commands, start [wait-any.mts](scripts/wait-any.mts) once for the batch with Node.js 24 or later.

```sh
node /path/to/delegate-tasks/scripts/wait-any.mts /path/to/new-batch
```

Use a managed process with writable stdin and streaming stdout. If the shell
requires a PTY for later writes, allocate one and run `stty -echo` before
launching the script so the terminal emits only runner events. Send one JSON
object per line and keep stdin open for follow-ups. For example, these requests
start two commands in the given workspace.

```jsonl
{"id":"revision","argv":["git","rev-parse","HEAD"],"cwd":"/path/to/workspace"}
{"id":"tests","argv":["python3","-m","unittest"],"cwd":"/path/to/workspace"}
```

Each accepted request emits `started` with the ID, PID, and separate stdout
and stderr paths. As soon as a command exits, the script emits `exited` with
its ID and return code. Read that command's logs and verify its result. For
example, when the revision is available, submit a follow-up using that exact
revision while the tests continue. The caller controls how many jobs to admit.

Pass arguments as strings and changes of directory through `cwd`. Use a fresh
ID for each attempt. A rejected request emits `rejected` with its error and
leaves other jobs running. Use foreground commands that exit when their work
is done. The script tracks process exit. The caller checks the agent's own
completion evidence.

After the final dispatch, send `{"op":"close"}` or close stdin. Read the
remaining events through runner exit. On POSIX, interrupting the runner with
SIGINT or SIGTERM kills the process groups of its still-running commands.
