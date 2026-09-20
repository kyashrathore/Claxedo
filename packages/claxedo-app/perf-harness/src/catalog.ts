import { readdir } from "node:fs/promises"
import path from "node:path"
import { FLOWS } from "./flows"
import { harnessRoot } from "./storage"

export type CatalogEntry = {
  id: string
  owner: string
  kind: "measurement" | "regression" | "probe" | "framework"
  entrypoint: string
  purpose: string
}

/** Discovery only. Package owners retain their runtime, evidence, and acceptance policy. */
export const PERFORMANCE_CATALOG: CatalogEntry[] = [
  ...FLOWS.map((flow): CatalogEntry => ({ id: `browser/${flow.id}`, owner: "claxedo-app/perf-harness", kind: "measurement",
    entrypoint: `bun src/cli.ts run --scenario ${flow.id} --suite renderer`, purpose: flow.name })),
  { id: "browser/diagnostics", owner: "claxedo-app/perf-harness", kind: "measurement", entrypoint: "bun run ci:diagnostics", purpose: "Counterbalanced ABBA diagnostics overhead with fixed acceptance and required causal evidence" },
  { id: "browser/memory", owner: "claxedo-app/perf-harness", kind: "measurement", entrypoint: "bun src/cli.ts memory --iterations 5", purpose: "Forced-GC retention and visit slope; source stability, settlement and cleanup required" },
  { id: "desktop/internal", owner: "claxedo-app/perf-harness", kind: "framework", entrypoint: "src/agent-app-benchmark.ts", purpose: "Packaged agent-app profiles; independent typed samples, clocks and validity" },
  { id: "desktop/public", owner: "claxedo-app/perf-harness", kind: "framework", entrypoint: "src/public-agent-app-driver.ts", purpose: "Pinned public framework adapter; framework owns order, resources and scoring" },
  { id: "desktop/public-cli", owner: "claxedo-app/perf-harness", kind: "framework", entrypoint: "bun run public-benchmark -- <framework arguments>", purpose: "Runs the installed framework CLI after verifying it is the pinned commit" },
  { id: "desktop/startup", owner: "claxedo-desktop", kind: "measurement", entrypoint: "bun run perf:startup", purpose: "Packaged Electron startup clock" },
  { id: "desktop/account-port", owner: "claxedo-desktop", kind: "measurement", entrypoint: "bun run perf:account-port", purpose: "Account boundary latency microbenchmark" },
  { id: "desktop/diagnostics", owner: "claxedo-desktop", kind: "regression", entrypoint: "bun run test:diagnostics-release", purpose: "Production process collection, transport, privacy and dependency tests" },
  { id: "desktop/diagnostics-smoke", owner: "claxedo-desktop", kind: "measurement", entrypoint: "bun run smoke:diagnostics:packaged", purpose: "Real packaged diagnostics process lifecycle" },
  { id: "app/retention", owner: "claxedo-app", kind: "regression", entrypoint: "bun run test:performance", purpose: "Timeline identity, workbench mount retention and reactivity" },
  { id: "app/recorder", owner: "claxedo-app", kind: "regression", entrypoint: "bun test --conditions=browser --preload ./happydom.ts src/platform/performance/session-perf.test.ts", purpose: "Bounded recorder storage, User Timing cleanup and recorder isolation" },
  { id: "app/diagnostics", owner: "claxedo-app", kind: "regression", entrypoint: "bun run test:diagnostics-release", purpose: "Diagnostics UI, data and transport contracts" },
  { id: "runtime/store", owner: "workspace-runtime", kind: "regression", entrypoint: "bun run test:performance", purpose: "RuntimeStore cold/hot persistence cost" },
  { id: "relay/load", owner: "workspace-relay", kind: "measurement", entrypoint: "bench/RUNBOOK.md", purpose: "Relay throughput and tail latency; local, multi-tunnel and deployed targets" },
  { id: "server/live-sync", owner: "claxedo-server", kind: "measurement", entrypoint: "scripts/bench/live-sync-capacity.ts", purpose: "Live sync capacity across scoped clients" },
]

export async function performanceCatalog(): Promise<CatalogEntry[]> {
  const probes = (await readdir(path.join(harnessRoot, "probes"))).filter((name) => name.endsWith(".ts")).sort()
  return [...PERFORMANCE_CATALOG, ...probes.map((name): CatalogEntry => ({
    id: `probe/${name.replace(/\.ts$/, "")}`, owner: "claxedo-app/perf-harness", kind: "probe",
    entrypoint: `probes/${name}`, purpose: "Attribution experiment; not a release gate or baseline producer",
  }))]
}
