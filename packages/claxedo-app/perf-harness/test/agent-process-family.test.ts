import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  macMemoryHelperPath,
  parseMacMemoryImpact,
  parseProcessTable,
  readPhysFootprint,
  toIdleRows,
  totalPhysFootprintBytes,
  withPhysFootprint,
  type ProcessSnapshot,
} from "../src/agent-process-family"
import { IdleProcessFamilyTracker } from "../src/idle-process-family"

const shippedHelper = join(
  import.meta.dir,
  "../../../claxedo-desktop/resources/diagnostics/macos-memory-impact",
)

const table = parseProcessTable(
  [
    " 101 1 2048 01:02.50 Sun Mar 29 12:34:56 2026 /Applications/Claxedo Dev.app/Contents/MacOS/Claxedo Dev",
    " 102 101 4096 00:01.00 Sun Mar 29 12:34:56 2026 helper --type=renderer",
  ].join("\n"),
)

describe("physical-footprint observation recorded beside summed RSS", () => {
  test("resolves the helper exactly where the product's main process resolves it", () => {
    // src/main/index.ts builds `<resourcesPath>/diagnostics/macos-memory-impact`.
    expect(macMemoryHelperPath("/Apps/Claxedo Dev.app/Contents/MacOS/Claxedo Dev")).toBe(
      "/Apps/Claxedo Dev.app/Contents/Resources/diagnostics/macos-memory-impact",
    )
  })

  test("declines to guess a helper path outside a macOS bundle", () => {
    expect(macMemoryHelperPath("/usr/local/bin/claxedo")).toBeUndefined()
  })

  test("parses the helper's `<pid> <bytes>` contract and rejects anything else", () => {
    const readings = parseMacMemoryImpact("101 195200000\n102 277800000\nnot a reading\n-3 5\n103 x\n")
    expect([...readings]).toEqual([
      [101, 195_200_000],
      [102, 277_800_000],
    ])
  })

  test("a missing helper records nothing instead of failing the sample", async () => {
    expect([...(await readPhysFootprint([101, 102], undefined))]).toEqual([])
    expect([...(await readPhysFootprint([101, 102], "/nonexistent/macos-memory-impact"))]).toEqual([])
    expect([...(await readPhysFootprint([], shippedHelper))]).toEqual([])
  })

  test("reads a real footprint from the shipped helper for this process", async () => {
    // The helper is a build artifact; its absence is a no-op everywhere else in
    // this change, so it must not be a false failure here either.
    if (process.platform !== "darwin" || !existsSync(shippedHelper)) return
    const readings = await readPhysFootprint([process.pid], shippedHelper)
    const bytes = readings.get(process.pid)
    expect(bytes).toBeGreaterThan(0)
    expect(Number.isSafeInteger(bytes)).toBe(true)
  })

  test("attaches readings per process without disturbing any existing field", () => {
    const family = withPhysFootprint(table, new Map([[101, 195_200_000]]))
    expect(family[0]).toEqual({ ...table[0]!, physFootprintBytes: 195_200_000 })
    expect(family[1]).toEqual(table[1]!)
    expect("physFootprintBytes" in family[1]!).toBe(false)
  })

  test("reports a family total only when every member was read", () => {
    expect(totalPhysFootprintBytes(withPhysFootprint(table, new Map([[101, 5]])))).toBeUndefined()
    expect(totalPhysFootprintBytes(withPhysFootprint(table, new Map([[101, 5], [102, 7]])))).toBe(12)
    expect(totalPhysFootprintBytes([])).toBeUndefined()
  })

  test("the gating RSS sum is identical with and without footprint readings", () => {
    // resource.peak_process_family_rss_mib is defined on this sum. The new
    // series must be incapable of reaching it.
    const observe = (family: readonly ProcessSnapshot[]) =>
      new IdleProcessFamilyTracker(101).observe(toIdleRows(family), 1_000)
    const bare = observe(table)
    const annotated = observe(withPhysFootprint(table, new Map([[101, 195_200_000], [102, 277_800_000]])))
    expect(annotated.rssBytes).toBe(bare.rssBytes)
    expect(annotated.rssBytes).toBe(2_048 * 1_024 + 4_096 * 1_024)
    expect(annotated).toEqual(bare)
    expect(toIdleRows(withPhysFootprint(table, new Map([[101, 5]])))).toEqual(toIdleRows(table))
  })

  test("survives an attempt.json round trip as a per-process field", () => {
    const snapshot = {
      at: "2026-08-12T00:00:00.000Z",
      processes: withPhysFootprint(table, new Map([[101, 195_200_000], [102, 277_800_000]])),
    }
    const decoded = JSON.parse(JSON.stringify({ processOwnership: { snapshots: [snapshot] } })) as {
      processOwnership: { snapshots: Array<{ processes: ProcessSnapshot[] }> }
    }
    const processes = decoded.processOwnership.snapshots[0]!.processes
    expect(processes.map((row) => row.physFootprintBytes)).toEqual([195_200_000, 277_800_000])
    expect(processes.map((row) => row.rssBytes)).toEqual([2_048 * 1_024, 4_096 * 1_024])
    expect(totalPhysFootprintBytes(processes)).toBe(473_000_000)
  })
})
