import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"

const h = vi.hoisted(() => ({
  list: vi.fn(async () => {}),
}))

vi.mock("@/app/providers/file", () => ({
  useFile: () => ({
    normalize: (path: string) => path,
    tree: {
      state: () => undefined,
      children: () => [],
      expand: vi.fn(),
      collapse: vi.fn(),
      list: h.list,
    },
  }),
}))

vi.mock("@/ui/controls/claxedo-icon", () => ({
  ClaxedoIcon: () => <span />,
  ClaxedoIconV2: () => <span />,
}))

import FileTree from "./file-tree"

afterEach(() => {
  cleanup()
  h.list.mockClear()
})

describe("FileTree hydration", () => {
  test("retains an inactive tree without reading, then hydrates when activated", async () => {
    const [enabled, setEnabled] = createSignal(false)
    render(() => <FileTree path="" enabled={enabled()} />)

    await Promise.resolve()
    expect(h.list).not.toHaveBeenCalled()

    setEnabled(true)
    await waitFor(() => expect(h.list).toHaveBeenCalledOnce())
    expect(h.list).toHaveBeenCalledWith("")
  })
})
