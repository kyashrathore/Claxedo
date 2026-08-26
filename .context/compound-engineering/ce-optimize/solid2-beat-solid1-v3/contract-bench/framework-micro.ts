#!/usr/bin/env bun
// Framework-isolated paired benchmark: the SAME workloads, modeled on this
// app's real hot-path shapes, run against solid-js 1.9.12 and solid-js
// 2.0.0-rc.1. No application code, so no version-drift confound — this
// measures the framework plus the idiom the migration adopted, nothing else.
//
//   bun framework-micro.ts <solidPkgDir> <label>
//
//   bun framework-micro.ts /home/user/claxedo-solid1/node_modules/solid-js solid1
//   bun framework-micro.ts <path-to-solid2 pkg> solid2
//
// Run each arm in its own process (module registries must not mix).
//
// Workloads (each mirrors a measured app hot path):
//   selection : N rows, one active row, M selection changes.
//               Solid 1 idiom: per-row createMemo(activeId() === id) — what the
//               pre-migration app actually shipped.
//               Solid 1 native: createSelector (its own O(1) primitive), for
//               fairness to the framework rather than to the old app code.
//               Solid 2 idiom: createProjection keyed by id (what we shipped).
//   fanout    : one signal observed by N effects, M updates (rail shape).
//   listgrow  : store-held list appended M times, with a downstream memo
//               reading length (streaming timeline shape).
// Metrics: wall-clock ms per workload (median of R repeats) and retained
// JS heap delta after Bun.gc (rough, but identical methodology per arm).
import path from "node:path"

const PKG = process.argv[2]
const LABEL = process.argv[3] ?? "arm"
if (!PKG) throw new Error("usage: bun framework-micro.ts <solidPkgDir> <label>")

const BUILD = process.env.SOLID_BUILD ?? "solid.js"
const mod = await import(path.join(PKG, "dist", BUILD))
const {
  createRoot,
  createSignal,
  createMemo,
  createEffect,
  createSelector, // Solid 1 only
  createProjection, // Solid 2 only
  flush, // Solid 2 only
} = mod as any
const isSolid2 = typeof createProjection === "function"
const settle = () => {
  if (typeof flush === "function") flush()
}

const N = Number(process.env.BENCH_N ?? 2000) // rows / effects
const M = 500 // updates
const R = 7 // repeats per workload

const gcHeap = () => {
  ;(globalThis as any).Bun?.gc?.(true)
  ;(globalThis as any).Bun?.gc?.(true)
  return process.memoryUsage().heapUsed / 1048576
}

type Result = { ms: number; retainedMiB: number }

function timeWorkload(run: () => () => void): Result {
  const before = gcHeap()
  const start = performance.now()
  const dispose = run()
  const ms = performance.now() - start
  const during = gcHeap()
  dispose()
  settle()
  return { ms, retainedMiB: during - before }
}

// ── selection ────────────────────────────────────────────────────────────────
function selectionSolid1Memo(): () => void {
  return createRoot((dispose: () => void) => {
    const [activeId, setActiveId] = createSignal("row-0")
    let live = 0
    for (let i = 0; i < N; i++) {
      const id = `row-${i}`
      const isActive = createMemo(() => activeId() === id)
      createEffect(() => {
        isActive()
        live++
      })
    }
    settle()
    for (let m = 0; m < M; m++) {
      setActiveId(`row-${m % N}`)
      settle()
    }
    if (live < 0) throw new Error("unreachable")
    return dispose
  })
}

function selectionSolid1Native(): () => void {
  return createRoot((dispose: () => void) => {
    const [activeId, setActiveId] = createSignal("row-0")
    const isSelected = createSelector(activeId)
    let live = 0
    for (let i = 0; i < N; i++) {
      const id = `row-${i}`
      createEffect(() => {
        isSelected(id)
        live++
      })
    }
    settle()
    for (let m = 0; m < M; m++) {
      setActiveId(`row-${m % N}`)
      settle()
    }
    if (live < 0) throw new Error("unreachable")
    return dispose
  })
}

function selectionSolid2Memo(): () => void {
  const harness = createRoot((dispose: () => void) => {
    const [activeId, setActiveId] = createSignal("row-0")
    let live = 0
    for (let i = 0; i < N; i++) {
      const id = `row-${i}`
      const isActive = createMemo(() => activeId() === id)
      createEffect(
        () => isActive(),
        () => {
          live++
        },
      )
    }
    return { dispose, setActiveId, alive: () => live }
  })
  settle()
  for (let m = 0; m < M; m++) {
    harness.setActiveId(`row-${m % N}`)
    settle()
  }
  if (harness.alive() < 0) throw new Error("unreachable")
  return harness.dispose
}

function selectionSolid2KeySelector(): () => void {
  // The hand-built O(1) selector (packages/ui/src/hooks/create-key-selector):
  // Map of lazy per-key signals + a split effect flipping exactly two keys.
  const { getObserver, onCleanup, untrack } = mod as any
  const harness = createRoot((dispose: () => void) => {
    const [activeId, setActiveId] = createSignal("row-0")
    type Entry = { get: () => boolean; set: (v: boolean) => void; refs: number }
    const entries = new Map<string, Entry>()
    createEffect(
      () => activeId(),
      (next: string | undefined, prev: string | undefined) => {
        if (next === prev) return
        if (prev !== undefined) entries.get(prev)?.set(false)
        if (next !== undefined) entries.get(next)?.set(true)
      },
    )
    const isSelected = (key: string) => {
      let e = entries.get(key)
      if (!e) {
        const [get, set] = createSignal(untrack(activeId) === key)
        e = { get, set, refs: 0 }
        entries.set(key, e)
      }
      if (getObserver()) {
        const t = e
        t.refs++
        onCleanup(() => {
          t.refs--
          if (t.refs === 0 && entries.get(key) === t) entries.delete(key)
        })
      }
      return e.get()
    }
    let live = 0
    for (let i = 0; i < N; i++) {
      const id = `row-${i}`
      createEffect(
        () => isSelected(id),
        () => {
          live++
        },
      )
    }
    return { dispose, setActiveId, alive: () => live }
  })
  settle()
  for (let m = 0; m < M; m++) {
    harness.setActiveId(`row-${m % N}`)
    settle()
  }
  if (harness.alive() < 0) throw new Error("unreachable")
  return harness.dispose
}

function selectionSolid2Projection(): () => void {
  const harness = createRoot((dispose: () => void) => {
    const [activeId, setActiveId] = createSignal("row-0")
    const selected = createProjection((draft: Record<string, boolean>) => {
      const id = activeId()
      for (const key of Object.keys(draft)) if (key !== id) delete draft[key]
      if (id) draft[id] = true
    }, {})
    let live = 0
    for (let i = 0; i < N; i++) {
      const id = `row-${i}`
      createEffect(
        () => !!selected[id],
        () => {
          live++
        },
      )
    }
    return { dispose, setActiveId, alive: () => live }
  })
  settle()
  for (let m = 0; m < M; m++) {
    harness.setActiveId(`row-${m % N}`)
    settle()
  }
  if (harness.alive() < 0) throw new Error("unreachable")
  return harness.dispose
}

// ── fanout ───────────────────────────────────────────────────────────────────
function fanout(): () => void {
  const harness = createRoot((dispose: () => void) => {
    const [tick, setTick] = createSignal(0)
    let live = 0
    for (let i = 0; i < N; i++) {
      if (isSolid2) {
        createEffect(
          () => tick(),
          () => {
            live++
          },
        )
      } else {
        createEffect(() => {
          tick()
          live++
        })
      }
    }
    return { dispose, setTick, alive: () => live }
  })
  settle()
  for (let m = 0; m < M; m++) {
    harness.setTick(m)
    settle()
  }
  if (harness.alive() < 0) throw new Error("unreachable")
  return harness.dispose
}

// ── listgrow ─────────────────────────────────────────────────────────────────
function listgrow(): () => void {
  const harness = createRoot((dispose: () => void) => {
    const [list, setList] = createSignal<{ id: number; text: string }[]>([])
    const count = createMemo(() => list().length)
    const last = createMemo(() => list()[list().length - 1]?.text ?? "")
    let observed = 0
    if (isSolid2) {
      createEffect(
        () => [count(), last()] as const,
        () => {
          observed++
        },
      )
    } else {
      createEffect(() => {
        count()
        last()
        observed++
      })
    }
    return { dispose, setList, alive: () => observed }
  })
  settle()
  for (let m = 0; m < M; m++) {
    harness.setList((prev: any[]) => [...prev, { id: m, text: `message ${m} ${"x".repeat(64)}` }])
    settle()
  }
  if (harness.alive() < 0) throw new Error("unreachable")
  return harness.dispose
}

// ── run ──────────────────────────────────────────────────────────────────────
const workloads: Array<[string, () => () => void]> = []
if (isSolid2) {
  workloads.push(["selection(per-row memo)", selectionSolid2Memo])
  workloads.push(["selection(keySelector)", selectionSolid2KeySelector])
  workloads.push(["selection(projection)", selectionSolid2Projection])
} else {
  workloads.push(["selection(per-row memo)", selectionSolid1Memo])
  if (typeof createSelector === "function") workloads.push(["selection(createSelector)", selectionSolid1Native])
}
workloads.push(["fanout", fanout], ["listgrow", listgrow])

console.log(`[${LABEL}] solid ${isSolid2 ? "2 (projection/split-effect idioms)" : "1 (memo/effect idioms)"}  N=${N} M=${M} repeats=${R}`)
for (const [name, run] of workloads) {
  const times: number[] = []
  const heaps: number[] = []
  run()() // warmup, discarded
  for (let r = 0; r < R; r++) {
    const { ms, retainedMiB } = timeWorkload(run)
    times.push(ms)
    heaps.push(retainedMiB)
  }
  times.sort((a, b) => a - b)
  heaps.sort((a, b) => a - b)
  const med = (xs: number[]) => xs[Math.floor(xs.length / 2)]
  console.log(
    `[${LABEL}] ${name.padEnd(26)} median ${med(times).toFixed(1).padStart(7)} ms | live-graph heap ${med(heaps)
      .toFixed(1)
      .padStart(6)} MiB`,
  )
}
