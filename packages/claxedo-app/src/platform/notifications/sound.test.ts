import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_SOUND_ID, playSoundById, soundSrc } from "./sound"

const originalAudio = globalThis.Audio

class FakeAudio {
  static instances: FakeAudio[] = []
  currentTime = 0
  paused = false
  played = false

  constructor(readonly src: string) {
    FakeAudio.instances.push(this)
  }

  play() {
    this.played = true
    return Promise.resolve()
  }

  pause() {
    this.paused = true
  }
}

afterEach(() => {
  FakeAudio.instances.length = 0
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    writable: true,
    value: originalAudio,
  })
})

describe("sound helpers", () => {
  test("the default completion sound resolves to a bundled cross-platform asset", () => {
    expect(soundSrc(DEFAULT_SOUND_ID)).toBeTruthy()
  })

  test("resolves known sound ids and ignores unknown ids", () => {
    expect(soundSrc("ios")).toBeTruthy()
    expect(soundSrc("missing")).toBeUndefined()
  })

  test("plays a sound by id and returns cleanup", async () => {
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      writable: true,
      value: FakeAudio,
    })

    const cleanup = await playSoundById("ios")

    expect(FakeAudio.instances).toHaveLength(1)
    expect(FakeAudio.instances[0]?.played).toBe(true)

    cleanup?.()

    expect(FakeAudio.instances[0]?.paused).toBe(true)
    expect(FakeAudio.instances[0]?.currentTime).toBe(0)
  })

  test("does not create audio for an unknown sound id", async () => {
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      writable: true,
      value: FakeAudio,
    })

    await expect(playSoundById("missing")).resolves.toBeUndefined()

    expect(FakeAudio.instances).toHaveLength(0)
  })
})
