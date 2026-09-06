/**
 * Diagnostic: can plain Node import the unpatched pinned SDK?
 *
 * The published `dist/` uses extensionless relative ESM specifiers, which Node
 * ESM rejects, so this reports KNOWN-BLOCKER today and exits 0 either way. The
 * product runs the patched install instead; never work around this by
 * deep-importing `dist/internal/host`, the unexported raw-fetch host.
 *
 *   node node-loadability.mjs
 */
const outcome = await import("@opencode-ai/sdk").then(
  (module) => ({ ok: true, hasCreate: typeof module.OpenCode?.create === "function" }),
  (error) => ({ ok: false, code: error?.code, message: String(error?.message ?? error).split("\n")[0] }),
)

if (outcome.ok) {
  console.log("PASS  §2  plain Node can import the pinned SDK")
  console.log(`INFO  §2  OpenCode.create present = ${outcome.hasCreate}`)
  console.log("\nUpstream now loads under plain Node. Update the contract doc §2 and")
  console.log("re-check whether the install patches are still needed.")
  process.exit(0)
}

console.log("KNOWN-BLOCKER  §2  plain Node cannot import the pinned SDK")
console.log(`      code:    ${outcome.code}`)
console.log(`      message: ${outcome.message}`)
console.log("\nExpected today. The product ships the patched install described in")
console.log("patches/README.opencode-node.md instead of the unpatched package.")
console.log("Never resolve this by deep-importing dist/internal (the unexported raw-fetch host).")
process.exit(0)
