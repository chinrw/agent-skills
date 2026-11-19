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

- Use the runtime's completion notifications or wait for any running task when
  supported. On a runtime with separate completion channels, use bounded waits
  and check each channel between waits. If the requested concurrency is
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
