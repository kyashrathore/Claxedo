/**
 * §2 gate: can plain Node import the pinned public SDK?
 *
 * As of `@opencode-ai/sdk@0.0.0-beta-18314` the answer is NO. The published
 * `dist/` uses extensionless relative ESM specifiers (`export * as OpenCode
 * from "./opencode"`), which Node ESM rejects. Every shipped Claxedo
 * deployment is Node, so this blocks R2 until a supported build resolves it.
 *
 * This probe is expected to FAIL today. It exists so that the day the upstream
 * package (or our build) fixes it, CI tells us — and so nobody "fixes" it by
 * deep-importing `dist/internal/host`, which Decision 15 forbids.
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
  console.log("\nThe §2 release blocker is resolved. Update the contract doc and")
  console.log("unblock Unit 2 checkpoint 2a.")
  process.exit(0)
}

console.log("KNOWN-BLOCKER  §2  plain Node cannot import the pinned SDK")
console.log(`      code:    ${outcome.code}`)
console.log(`      message: ${outcome.message}`)
console.log("\nExpected today. Resolution path (contract doc §2): produce one")
console.log("working Node bundle via the repo's existing Bun.build pipeline.")
console.log("Do NOT resolve this by deep-importing dist/internal (Decision 15).")
process.exit(0)
