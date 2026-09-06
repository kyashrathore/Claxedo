import { afterEach, describe, expect, test, vi } from "vitest"

const source = vi.hoisted(() => ({ refreshDirectory: vi.fn(), setFocusedDirectory: vi.fn() }))
vi.mock("@/features/session/app-ports", () => ({ useGlobalSync: () => source }))

import { queryClient } from "@/platform/query/query-client"
import { useDirectorySessionCacheActions } from "./directory-session-cache"

afterEach(() => {
  queryClient.clear()
  vi.clearAllMocks()
})

describe("directory session-cache actions", () => {
  test("defaults speculative ensure to quiet and preserves explicit refresh policy", async () => {
    const actions = useDirectorySessionCacheActions()
    await actions.ensure({ directory: "/ensure" })
    await actions.ensure({ directory: "/ensure-loud", quiet: false })
    await actions.refresh({ directory: "/refresh" })
    await actions.refresh({ directory: "/refresh-quiet", quiet: true })

    expect(source.refreshDirectory.mock.calls).toEqual([
      ["/ensure", undefined, { quiet: true }],
      ["/ensure-loud", undefined, { quiet: false }],
      ["/refresh", undefined, { quiet: undefined }],
      ["/refresh-quiet", undefined, { quiet: true }],
    ])
  })
})
