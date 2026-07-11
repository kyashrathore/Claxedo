import { describe, expect, test } from "bun:test"
import type { QueryClient } from "@tanstack/solid-query"
import type { UsageLimitsSnapshot } from "../../utils/usage-limits-api"
import { USAGE_LIMITS_QUERY_KEY, writeUsageLimitsSnapshot } from "./usage-limits-cache"

// The single sanctioned writer for the usage-limits query-cache family.

describe("writeUsageLimitsSnapshot", () => {
  test("writes the snapshot to the shared usage-limits query key", () => {
    const calls: Array<{ key: unknown; data: unknown }> = []
    const queryClient: Pick<QueryClient, "setQueryData"> = {
      setQueryData: (key, data) => {
        calls.push({ key, data })
        return data
      },
    }
    // as-any: opaque snapshot stand-in; the writer only forwards it to setQueryData.
    const snapshot = { updatedAt: 123 } as unknown as UsageLimitsSnapshot

    writeUsageLimitsSnapshot(queryClient, snapshot)

    expect(calls).toEqual([{ key: USAGE_LIMITS_QUERY_KEY, data: snapshot }])
  })
})
