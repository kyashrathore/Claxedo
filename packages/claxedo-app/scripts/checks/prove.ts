import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { packageRoot } from "./lib/files"

const fixtureChecks = [
  "no-comments",
  "size",
  "v2-only",
  "claxedo-names",
  "adapter-boundary",
  "no-swallowed-errors",
  "no-polling",
  "one-home-per-datum",
  "domain-boundaries",
  "one-owner",
  "no-directory-identity",
  "access-boundary",
  "e2e-hygiene",
  "budget",
]
const fixtures = join(packageRoot, "scripts/checks/fixtures")

type Run = { readonly code: number; readonly lines: readonly string[] }
type Proof = { readonly name: string; readonly ok: boolean; readonly detail: string }

async function main(): Promise<never> {
  const proofs: Proof[] = []
  for (const name of fixtureChecks) proofs.push(...(await proveCheck(name)))
  proofs.push(...(await proveRequiredFlows()))
  for (const proof of proofs) console.log(`${proof.ok ? "ok  " : "FAIL"} ${proof.name}: ${proof.detail}`)
  const failed = proofs.filter((proof) => !proof.ok).length
  console.error(`prove: ${failed} of ${proofs.length} proofs failed`)
  process.exit(failed === 0 ? 0 : 1)
}

async function proveCheck(name: string): Promise<Proof[]> {
  const bad = join(fixtures, name, "bad")
  const good = join(fixtures, name, "good")
  const proofs: Proof[] = []
  const expected = readFileSync(join(bad, "expected.txt"), "utf8").split("\n").filter(Boolean).sort()
  const badRun = await run(["bun", `scripts/checks/${name}.ts`, "--root", bad])
  const reported = [...new Set(badRun.lines.map((line) => line.split(": ")[0] ?? ""))].sort()
  const missing = expected.filter((item) => !reported.includes(item))
  const extra = reported.filter((item) => !expected.includes(item))
  const exact = badRun.code === 1 && missing.length === 0 && extra.length === 0 && expected.length > 0
  const detail = exact ? `exit 1, ${badRun.lines.length} violations at the ${expected.length} expected places` : mismatch(badRun, missing, extra)
  proofs.push({ name: `${name} fails on fixtures/${name}/bad`, ok: exact, detail })
  if (!existsSync(good)) return proofs
  const goodRun = await run(["bun", `scripts/checks/${name}.ts`, "--root", good])
  const clean = goodRun.code === 0 && goodRun.lines.length === 0
  const goodDetail = clean ? "exit 0, no violations" : `exit ${goodRun.code}: ${goodRun.lines.join(" | ")}`
  proofs.push({ name: `${name} passes on fixtures/${name}/good`, ok: clean, detail: goodDetail })
  return proofs
}

function mismatch(badRun: Run, missing: readonly string[], extra: readonly string[]): string {
  const parts = [`exit ${badRun.code}`]
  if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`)
  if (extra.length > 0) parts.push(`unexpected ${extra.join(", ")}`)
  return parts.join("; ")
}

async function proveRequiredFlows(): Promise<Proof[]> {
  const script = "scripts/checks/required-flows.ts"
  const both = await run(["bun", script, "src/transcript/a.tsx", "src/session/list/store.ts"])
  const partial = await run(["bun", script, "--ran", "30", "src/transcript/a.tsx", "src/session/list/store.ts"])
  const complete = await run(["bun", script, "--ran", "30,31", "src/transcript/a.tsx", "src/session/list/store.ts"])
  const untouched = await run(["bun", script, "src/composer/send.ts"])
  return [
    { name: "required-flows lists 30 and 31", ok: both.code === 0 && both.lines.join(",") === "30,31", detail: both.lines.join(",") || "(none)" },
    {
      name: "required-flows fails when 31 did not run",
      ok: partial.code === 1 && partial.lines.length === 1 && partial.lines[0]?.startsWith("src/session/list/store.ts:1") === true,
      detail: `exit ${partial.code}: ${partial.lines.join(" | ")}`,
    },
    { name: "required-flows passes when both ran", ok: complete.code === 0 && complete.lines.length === 0, detail: `exit ${complete.code}` },
    { name: "required-flows needs nothing for an unprotected change", ok: untouched.code === 0 && untouched.lines.length === 0, detail: `exit ${untouched.code}` },
  ]
}

async function run(command: readonly string[]): Promise<Run> {
  const child = Bun.spawn([...command], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" })
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return { code, lines: stdout.split("\n").filter(Boolean) }
}

await main()
