import { chromium } from "playwright-core"
import { startApp, stopApp } from "./browser-runner"
import { environmentProfile } from "./environment-profile"
import { detachedNodes, memoryRecords, runMemorySweep } from "./memory-runner"
import { compareToBaseline, currentCommit, readBaselineFor, writeBaselineFor } from "./baseline-store"
import { stackLabel } from "./stacks"
import path from "node:path"
import { reportsRoot, writeJson } from "./storage"

const MB = 1024 * 1024

/** First vs last entry count per query-key family, worst growth first. */
function familyRows(sweep: { samples: Array<{ families: Record<string, number> }> }) {
  const first = sweep.samples[0]?.families ?? {}
  const last = sweep.samples.at(-1)?.families ?? {}
  return Object.keys({ ...first, ...last })
    .map((family) => ({ family, from: first[family] ?? 0, to: last[family] ?? 0 }))
    .sort((a, b) => (b.to - b.from) - (a.to - a.from))
    .map((row) => `| ${row.family} | ${row.from} | ${row.to} | ${row.to - row.from >= 0 ? "+" : ""}${row.to - row.from} |`)
}

/**
 * Drive the memory lane and render its verdict.
 *
 * The verdict is about SHAPE, not size. "How much memory does it use" has no
 * useful answer — it depends on what the user did — whereas "does repeating the
 * same action forever cost anything" is answerable and is what a ceiling
 * promises. So the number that matters is the tail slope, and the plateau is
 * reported next to it as context rather than as the result.
 */
export async function runMemoryLane(options: {
  profile: string
  stack: string
  sessions: number
  accept_baseline: boolean
  headless: boolean
}) {
  const profile = environmentProfile(options.profile)
  const app = await startApp()
  const browser = await chromium.launch({ headless: options.headless, timeout: 30_000, args: ["--js-flags=--expose-gc"] })
  try {
    const sweep = await runMemorySweep({
      browser, app, profile, sessions: options.sessions, sampleEvery: 10,
    })
    const records = memoryRecords(sweep, options.stack, profile.id)
    const baseline = await readBaselineFor({
      profile: profile.id, stack: options.stack, lane: "memory", flow: sweep.flow,
    })
    const comparison = compareToBaseline(records, baseline)
    if (options.accept_baseline) await writeBaselineFor(records, currentCommit())
    // Persist the sweep. The family table is the actionable part and it is the
    // last thing printed, so it is exactly what gets lost to a truncated
    // terminal — and re-running to see it costs another full sweep.
    await writeJson(path.join(reportsRoot, "memory-sweep.json"), {
      flow: sweep.flow, stack: options.stack, profile: profile.id,
      sessions: options.sessions, slopeBytesPerStep: sweep.slopeBytesPerStep,
      plateauBytes: sweep.plateauBytes, samples: sweep.samples,
    })

    const rows = sweep.samples.map((item) =>
      `| ${item.step} | ${(item.heapBytes / MB).toFixed(1)} | ${item.domNodes} | ${detachedNodes(item)} | ` +
      `${item.listeners} | ${item.queries} | ${item.cachedSessions} |`)
    const firstSample = sweep.samples[0]!
    const lastSample = sweep.samples.at(-1)!
    const detachedGrowth = detachedNodes(lastSample) - detachedNodes(firstSample)
    const listenerGrowth = lastSample.listeners - firstSample.listeners
    // Did the sweep actually exercise the app? The false pass this lane exists
    // to avoid looks like every counter frozen at its boot value.
    //
    // Judged on PEAK query count, not on `cachedSessions` first-vs-last: that
    // counter is deliberately bounded, so a working ceiling drives it back DOWN
    // by the end of a sweep. Reading its fall as "nothing accumulated" fired
    // this caveat on a run whose query cache had grown from 173 to 388.
    const peakQueries = Math.max(...sweep.samples.map((item) => item.queries))
    const accumulated = peakQueries > sweep.samples[0]!.queries
    return [
      `# Memory lane — ${sweep.flow}`,
      "",
      `Stack: ${stackLabel(options.stack)}  ·  Machine: ${profile.label}  ·  ${options.sessions} session visits`,
      "",
      "Verdict is the TAIL SLOPE: retained bytes per additional visit once startup is past.",
      "A plateau means the ceilings hold; steady growth means they do not, whatever the absolute number.",
      "",
      `**Tail slope: ${(sweep.slopeBytesPerStep / 1024).toFixed(1)} kB per visit**  ·  plateau ${(sweep.plateauBytes / MB).toFixed(1)} MB`,
      "",
      accumulated
        ? ""
        : "> Caveat: `cachedSessions` never rose, so this sweep did not accumulate per-session state. Read the slope as unproven, not as a plateau.",
      "",
      detachedGrowth > sweep.samples.length
        ? `**Detached DOM +${detachedGrowth} nodes, listeners +${listenerGrowth}** — nodes removed from the ` +
          "document but still referenced, so never collected. This is invisible to anything the page can " +
          "measure about itself; naming the retainer needs a heap snapshot."
        : "",
      "",
      "| visit | heap (MB) | attached | detached | listeners | queries | cachedSessions |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      "Query-cache entries by key family, first sample vs last — growth here names the structure:",
      "",
      "| family | first | last | delta |",
      "| --- | ---: | ---: | ---: |",
      ...familyRows(sweep),
      "",
      "| Metric | Baseline | Current | Verdict |",
      "| --- | ---: | ---: | --- |",
      ...comparison.map((item) =>
        `| ${item.metric} | ${item.baseline === undefined ? "—" : (item.baseline / MB).toFixed(1) + " MB"} | ` +
        `${item.current === undefined ? "absent" : (item.current / MB).toFixed(1) + " MB"} | ${item.verdict} |`),
    ].join("\n")
  } finally {
    await browser.close().catch(() => undefined)
    await stopApp(app).catch(() => undefined)
  }
}
