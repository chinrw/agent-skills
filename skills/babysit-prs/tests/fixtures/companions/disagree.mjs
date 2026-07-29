// Fixture companion: the declared enum and the usage text disagree.
// The probe must refuse to guess and mark the capability set ambiguous, which
// blocks Codex-dependent remote writes.
const VALID_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node c.mjs task [--effort <none|minimal|low|medium|high|xhigh>] [prompt]"
    ].join("\n")
  );
}

printUsage();
void VALID_REASONING_EFFORTS;
