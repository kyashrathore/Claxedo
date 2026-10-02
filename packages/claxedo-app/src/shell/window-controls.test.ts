/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { trackMacWindowControls } from "./window-controls"

function fakeBridge(initial: Promise<boolean>) {
  const listeners = new Set<(fullscreen: boolean) => void>()
  return {
    listeners,
    emit: (fullscreen: boolean) => listeners.forEach((listener) => listener(fullscreen)),
    bridge: {
      getWindowFullscreen: () => initial,
      onFullscreenChange: (listener: (fullscreen: boolean) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}

test("window controls: a browser or a non-mac desktop has none", () => {
  createRoot((dispose) => {
    expect(trackMacWindowControls(undefined, true)()).toBe(false)
    expect(trackMacWindowControls(fakeBridge(Promise.resolve(false)).bridge, false)()).toBe(false)
    dispose()
  })
})

test("window controls: the mac desktop has them until it enters fullscreen", () => {
  const fake = fakeBridge(Promise.resolve(false))
  const dispose = createRoot((dispose) => {
    const shown = trackMacWindowControls(fake.bridge, true)
    expect(shown()).toBe(true)
    fake.emit(true)
    expect(shown()).toBe(false)
    fake.emit(false)
    expect(shown()).toBe(true)
    return dispose
  })
  dispose()
  expect(fake.listeners.size).toBe(0)
})

test("window controls: a window opened in fullscreen starts without them", async () => {
  const fake = fakeBridge(Promise.resolve(true))
  await createRoot(async (dispose) => {
    const shown = trackMacWindowControls(fake.bridge, true)
    await Promise.resolve()
    expect(shown()).toBe(false)
    dispose()
  })
})

test("window controls: a fullscreen change that lands first wins over the slower initial read", async () => {
  let resolve: (fullscreen: boolean) => void = () => undefined
  const fake = fakeBridge(new Promise((done) => (resolve = done)))
  await createRoot(async (dispose) => {
    const shown = trackMacWindowControls(fake.bridge, true)
    fake.emit(true)
    resolve(false)
    await Promise.resolve()
    expect(shown()).toBe(false)
    dispose()
  })
})
