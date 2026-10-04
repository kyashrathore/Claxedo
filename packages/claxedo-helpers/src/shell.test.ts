import { describe, expect, test } from "bun:test"
import { shellQuote } from "./shell"

describe("shellQuote", () => {
  test("the shell reads back exactly what went in", async () => {
    for (const value of ["plain", "a b", "it's", "$HOME", "`id`", "a\nb", "*", "\\", "''"]) {
      const proc = Bun.spawn(["sh", "-c", `printf %s ${shellQuote(value)}`], { stdout: "pipe" })
      expect(await new Response(proc.stdout).text()).toBe(value)
    }
  })

  test("double quoting survives one round of re-evaluation", async () => {
    const value = "it's $HOME"
    const proc = Bun.spawn(["sh", "-c", `sh -c ${shellQuote(`printf %s ${shellQuote(value)}`)}`], {
      stdout: "pipe",
    })
    expect(await new Response(proc.stdout).text()).toBe(value)
  })
})
