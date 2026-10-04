import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { installDownloadedUpdate } from "./update-install"

/** electron-updater's `autoUpdater` always carries its own `error` listener, so an emit never throws. */
class FakeUpdater extends EventEmitter {
  constructor(private readonly outcome: "installs" | "throws" | "reports") {
    super()
    this.on("error", () => {})
  }

  quitAndInstall = () => {
    if (this.outcome === "throws") throw new Error("no update filepath provided")
    if (this.outcome === "reports") this.emit("error", new Error("the installer could not start"))
  }
}

function install(outcome: "installs" | "throws" | "reports") {
  const relaunched: unknown[] = []
  const updater = new FakeUpdater(outcome)
  installDownloadedUpdate(updater, (error) => relaunched.push(error))
  return { updater, relaunched }
}

describe("installing a downloaded update", () => {
  test("an install that starts leaves the quit to the updater", () => {
    expect(install("installs").relaunched).toEqual([])
  })

  test("an install that throws relaunches this build once", () => {
    expect(install("throws").relaunched).toHaveLength(1)
  })

  test("an install the updater reports as failed relaunches this build once", () => {
    const { updater, relaunched } = install("reports")
    updater.emit("error", new Error("a later failure"))
    expect(relaunched).toHaveLength(1)
  })
})
