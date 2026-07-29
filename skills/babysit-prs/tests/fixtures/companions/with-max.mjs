// Fixture companion: a future build that accepts `max`.
// The skill must then use `max` with no rewrite.
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node c.mjs task [--background] [--write] [--effort <none|minimal|low|medium|high|xhigh|max>] [prompt]"
    ].join("\n")
  );
}

printUsage();
void VALID_REASONING_EFFORTS;
