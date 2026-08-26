import { render, waitFor } from "@solidjs/testing-library"
import { createSignal, flush } from "solid-js"
import { describe, expect, test, vi } from "vitest"
import { syncBrowserPaneUrl } from "./browser-pane-navigation"

describe("browser pane URL synchronization", () => {
  test("queues navigation until registration and honors a same-URL request with a newer version", async () => {
    const navigate = vi.fn(async () => ({ ok: true }))
    let request!: (url: string, version: number) => void
    let setCurrentUrl!: (url: string) => void
    let markReady!: () => void

    render(() => {
      const [url, setUrl] = createSignal<string>()
      const [version, setVersion] = createSignal<number>()
      const [currentUrl, setCurrent] = createSignal("about:blank")
      request = (next, nextVersion) => {
        setUrl(next)
        setVersion(nextVersion)
      }
      setCurrentUrl = setCurrent
      markReady = syncBrowserPaneUrl(url, version, currentUrl, navigate)
      return null
    })

    request("https://cdn.example.com/source.png", 1)
    expect(navigate).not.toHaveBeenCalled()
    markReady()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://cdn.example.com/source.png"))

    navigate.mockClear()
    setCurrentUrl("https://example.com/other-page")
    flush()
    expect(navigate).not.toHaveBeenCalled()
    request("https://cdn.example.com/source.png", 2)
    flush()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://cdn.example.com/source.png"))
  })
})
