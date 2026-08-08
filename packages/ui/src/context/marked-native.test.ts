import { describe, expect, test } from "bun:test"
import { createMarkdownParser } from "./marked"

describe("native Markdown selection", () => {
  test("uses the desktop parser when it succeeds", async () => {
    const parser = createMarkdownParser(async (source) => `<p data-native="true">${source}</p>`)
    await expect(parser.parse("hello")).resolves.toBe('<p data-native="true">hello</p>')
  })

  test("loads the JavaScript parser when the desktop parser fails", async () => {
    const parser = createMarkdownParser(async () => {
      throw new Error("unsupported")
    })
    const html = await parser.parse("# Fallback\n\n[Claxedo](https://claxedo.ai)")
    expect(html).toContain("<h1>Fallback</h1>")
    expect(html).toContain('class="external-link"')
  })

  test("bounds native parsing before requests reach the desktop queue", async () => {
    const releases: Array<() => void> = []
    let calls = 0
    let active = 0
    let peak = 0
    const parser = createMarkdownParser((source) => {
      calls += 1
      active += 1
      peak = Math.max(peak, active)
      return new Promise<string>((resolve) => {
        releases.push(() => {
          active -= 1
          resolve(`<p>${source}</p>`)
        })
      })
    })

    const pending = ["one", "two", "three", "four"].map((source) => parser.parse(source))
    await Bun.sleep(0)
    expect(calls).toBe(2)
    expect(peak).toBe(2)

    releases.shift()?.()
    await Bun.sleep(0)
    expect(calls).toBe(3)

    releases.shift()?.()
    await Bun.sleep(0)
    expect(calls).toBe(4)

    releases.splice(0).forEach((release) => release())
    await expect(Promise.all(pending)).resolves.toEqual([
      "<p>one</p>",
      "<p>two</p>",
      "<p>three</p>",
      "<p>four</p>",
    ])
  })
})
