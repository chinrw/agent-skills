// Fixture companion: declared enum stops at xhigh.
// Mirrors the real codex-cli 0.145.0 / companion 1.0.6 installed on this host.
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node c.mjs task [--background] [--write] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]"
    ].join("\n")
  );
}

printUsage();
void VALID_REASONING_EFFORTS;
