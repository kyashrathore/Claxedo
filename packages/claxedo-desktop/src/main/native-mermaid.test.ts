import { describe, expect, test } from "bun:test"
import { createNativeMermaidRenderer } from "./native-mermaid"

describe("native Mermaid renderer", () => {
  test("returns one complete SVG document", async () => {
    const render = createNativeMermaidRenderer(process.execPath, {
      args: ["-e", `process.stdout.write('<svg xmlns="http://www.w3.org/2000/svg"></svg>')`],
    })

    expect(render).toBeDefined()
    await expect(render!("flowchart LR\nA-->B")).resolves.toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    )
  })

  test("sends the active renderer theme to the native backend", async () => {
    const render = createNativeMermaidRenderer(process.execPath, {
      args: [
        "-e",
        "let input='';process.stdin.on('data',chunk=>input+=chunk).on('end',()=>{const request=JSON.parse(input);process.stdout.write(`<svg data-theme=\"${request.theme.primaryColor}\"></svg>`)})",
      ],
    })

    await expect(render!("flowchart LR\nA-->B", { primaryColor: "#123456" })).resolves.toBe(
      '<svg data-theme="#123456"></svg>',
    )
  })

  test("rejects non-SVG output", async () => {
    const render = createNativeMermaidRenderer(process.execPath, {
      args: ["-e", "process.stdout.write('not svg')"],
    })

    await expect(render!("flowchart LR\nA-->B")).rejects.toThrow("invalid SVG")
  })

  test("bounds source size and process lifetime", async () => {
    const render = createNativeMermaidRenderer(process.execPath, {
      args: ["-e", "await Bun.sleep(1000)"],
      timeoutMs: 25,
    })

    await expect(render!("x".repeat(256 * 1024 + 1))).rejects.toThrow("source exceeds")
    await expect(render!("flowchart LR\nA-->B")).rejects.toThrow("exceeded 25 ms")
  })
})
