// Fixture companion: neither a declared effort enum nor an --effort alternation
// in its usage text. Nothing can be inferred, so the probe must be ambiguous.
function printUsage() {
  console.log(["Usage:", "  node c.mjs task [prompt]"].join("\n"));
}

printUsage();
