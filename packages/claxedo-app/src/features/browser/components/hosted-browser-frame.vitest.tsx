import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { BrowserPaneProvider } from "../store/browser-pane-context"
import { HostedBrowserFrame } from "./hosted-browser-frame"

afterEach(cleanup)

describe("hosted browser frame", () => {
  test("renders an external source inside a fully sandboxed iframe", () => {
    const view = render(() => (
      <BrowserPaneProvider paneId="hosted-browser" initialUrl="https://cdn.example.com/source.png">
        <HostedBrowserFrame url="https://cdn.example.com/source.png" />
      </BrowserPaneProvider>
    ))
    const frame = view.getByTitle("External source preview")

    expect(frame).toHaveAttribute("src", "https://cdn.example.com/source.png")
    expect(frame).toHaveAttribute("sandbox", "")
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
  })
})
