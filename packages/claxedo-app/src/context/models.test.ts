import { describe, expect, test } from "bun:test"
import { firstBy, flat, groupBy, mapValues, pipe, values } from "remeda"

describe("models 'latest' family grouping", () => {
  // The `latest` memo lives inside the ModelsProvider context closure (wired to
  // `useProviders()`), so it isn't independently exported/callable here. Pin the
  // fix at the source level: it must key by `x.family ?? x.id`, not bare
  // `x.family` — remeda's `groupBy` silently drops items whose callback returns
  // `undefined` instead of bucketing them (documented in `groupBy.d.ts`), so any
  // model missing an (optional) `family` would otherwise vanish from
  // "latest"/auto-visibility entirely.
  test("groups by family with an id fallback so undefined-family models aren't dropped", async () => {
    const source = await Bun.file(new URL("./models.tsx", import.meta.url)).text()
    expect(source).toMatch(/groupBy\(\(x\) => x\.family \?\? x\.id\)/)
  })

  // Demonstrates the underlying remeda contract the fix relies on: without the
  // `?? x.id` fallback, models with no `family` are excluded from every group
  // (not deduped to one survivor), reproducing the pre-fix bug.
  test("reproduces the pre-fix bug: a bare family key drops undefined-family models entirely", () => {
    type Model = { id: string; family?: string; release_date: string; provider: { id: string } }
    const models: Model[] = [
      { id: "model-a", release_date: "2026-06-01", provider: { id: "p1" } },
      { id: "model-b", release_date: "2026-06-02", provider: { id: "p1" } },
    ]

    const buggy = pipe(
      models,
      groupBy((x) => x.family), // the original (buggy) key selector
      values(),
      (groups) =>
        groups.flatMap((g) => {
          const first = firstBy(g, [(x) => x.release_date, "desc"])
          return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
        }),
    )
    expect(buggy).toEqual([])

    const fixed = pipe(
      models,
      groupBy((x) => x.family ?? x.id),
      values(),
      (groups) =>
        groups.flatMap((g) => {
          const first = firstBy(g, [(x) => x.release_date, "desc"])
          return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
        }),
    )
    expect(fixed.map((x) => x.modelID).sort()).toEqual(["model-a", "model-b"])
  })
})
