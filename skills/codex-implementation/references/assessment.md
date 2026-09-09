## Collect, settle, and complete

`status ATTEMPT` observes the exact job. `result ATTEMPT` refuses active jobs,
checks the stored result's identity and terminal status, and records the complete
source snapshot before and after collection. Neither command approves the work.

`cancel ATTEMPT` records a request, then requires fresh lifecycle observations.
The inspected plugin marks a job cancelled even if its interrupt request fails.
A cancelled marker or launcher exception therefore does not establish a terminal
server turn. The helper retains the lock in those cases. Preserve the record,
inspect the actual server turn and processes, and report unresolved termination;
do not start another writer or infer safety from a quiet log.
Use the controlled recovery operations below when an independent host interface
can establish the missing terminal facts.

After collecting a terminal result, generate a new assessment draft:

```bash
node "$CODEX_IMPLEMENTATION_SKILL_DIR/scripts/task.mjs" assessment-template "$ATTEMPT_DIR"
```

The returned file contains exact IDs and the collected source snapshot. Required
criteria and independent verification start as NOT RUN; process termination
starts false and evidence strings are empty. Generation cannot approve work.
Fill only facts established by the controller's actual observations and tests.
The helper refuses to overwrite an existing explicit output path.

If generated before terminal collection, the draft may contain unknown IDs or
an unverified current snapshot. Regenerate after collecting the terminal result.
Do not copy old PASS values onto a new source snapshot. Optional skipped checks
still need their status and reason in the final report.

- `settle ATTEMPT ASSESSMENT_JSON` verifies current terminal/source identity and
  the controller's process-termination evidence, then releases this attempt's
  workspace lock. It does not require all criteria to pass or declare completion.
  Use it before a correction in a new thread.
- `complete ATTEMPT ASSESSMENT_JSON` additionally requires a successful task,
  exactly one evidence-backed PASS for each assigned criterion, and independent
  verification PASS. It rereads the exact result and rejects source drift.

The helper validates records and bindings; it cannot independently establish
the truth of controller-supplied lifecycle or test evidence. Inspect real task
and process state before making those assertions. An ordinary `failed` job
without a returned terminal turn result remains unknown for writer release.
