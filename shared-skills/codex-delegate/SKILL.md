---
name: codex-delegate
description: Use in Antigravity when planning needs information from a file Codex should try to read, when a task needs an actual read or write check at a specified path, or when Codex should implement and test Antigravity's plan.
---

# Delegate to Codex

Antigravity owns the plan and acceptance criteria. Give Codex a self-contained task with the working directory, the information or change needed, the permitted scope, and the evidence to return. Keep a planning request read-only.

Run the installed CLI from the terminal. For a read, use the following form with the task supplied on stdin. For an authorized write check or implementation, use `workspace-write` in place of `read-only`. Use the project's existing Codex configuration for model selection.

```sh
codex exec -C "$workspace" -s read-only - <<'TASK'
Read the specified file and answer the planning question with its source location.
TASK
```

Replace the sample task with the actual path and question or plan. Wait for the command to finish and inspect its exit status and final answer. If the terminal returns a running job, follow that job to completion. Report startup or authentication failures as an unperformed check. Respect access restrictions in both agents' environments.

- **Read for planning.** Ask Codex to open the file and return the fact needed, with a path and relevant line or excerpt. If the read fails, return the attempted path and error. Use the result to continue planning.
- **Check directory writes.** Ask Codex to create a unique temporary file in the authorized directory, write a marker, read it back, and remove the file. Return the path, verification result, and cleanup status. Limit the conclusion to the operation tested.
- **Implement a plan.** When implementation is authorized, pass the agreed steps, affected paths, constraints, and acceptance checks. Ask Codex to edit the workspace, run the checks, and report changes, results, and blockers. Inspect the resulting diff and test evidence where accessible. If acceptance criteria remain unmet, send Codex a focused follow-up with the missing evidence or required correction.
