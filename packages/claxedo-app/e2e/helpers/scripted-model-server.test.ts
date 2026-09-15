import { expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { startScriptedModelServer } from "./scripted-model-server"

type ObservedStreamFrame = {
  type: string
  sequence_number?: number
  delta?: string | { type: string; text?: string }
  response?: { output: Array<{ content: Array<{ text: string }> }> }
}

test("scripted text preserves Markdown and is consumed only by its matching prompt", async () => {
  const server = await startScriptedModelServer()
  const text = "Image ready\n\n![QA shapes](file:///tmp/qa-shapes.png)"
  const request = async (prompt: string) => {
    return new Promise<string>((resolve, reject) => {
      const req = httpRequest(`${server.v1Url}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
      }, (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => { body += chunk })
        response.on("error", reject)
        response.on("end", () => {
          try {
            expect(response.statusCode).toBe(200)
            resolve(JSON.parse(body).content[0].text)
          } catch (error) { reject(error) }
        })
      })
      req.on("error", reject)
      req.end(JSON.stringify({ model: "test", max_tokens: 128, messages: [{ role: "user", content: prompt }] }))
    })
  }
  try {
    server.scriptText({ marker: "IMAGE_REQUEST", text })
    expect(await request("Unrelated request")).toBe("ok")
    expect(await request("IMAGE_REQUEST")).toBe(text)
    expect(await request("IMAGE_REQUEST")).toBe("ok")
  } finally {
    await server.close()
  }
})

test("Auto classifier replies are opt-in, command-scoped, and cleared between journeys", async () => {
  const server = await startScriptedModelServer()
  const command = "node '/tmp/controlled-workload.cjs'"
  const request = async (texts: string[]) => {
    return new Promise<{ content: Array<{ type: string; text?: string; name?: string }> }>((resolve, reject) => {
      const req = httpRequest(`${server.v1Url}/messages`, { method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => { body += chunk })
        response.on("error", reject)
        response.on("end", () => {
          try {
            expect(response.statusCode).toBe(200)
            resolve(JSON.parse(body))
          } catch (error) { reject(error) }
        })
      })
      req.on("error", reject)
      req.end(JSON.stringify({ model: "test", max_tokens: 128, messages: [{ role: "user", content: texts.map((text) => ({ type: "text", text })) }] }))
    })
  }
  const classify = (value: string) => request([JSON.stringify({ Bash: value }), "Respond with <severity>N</severity> ONLY."])
  try {
    expect((await classify(command)).content[0].text).toBe("ok")
    server.scriptTool({ name: "Bash", input: { command }, whenPromptIncludes: "WORK", autoModeSeverity: 0 })
    expect((await request(["WORK"])).content[0]).toMatchObject({ type: "tool_use", name: "Bash" })
    expect((await classify(command)).content[0].text).toBe("<severity>0</severity>")
    expect((await classify("node '/tmp/another-workload.cjs'")).content[0].text).toBe("ok")
    server.resetCounts()
    expect((await classify(command)).content[0].text).toBe("ok")
  } finally {
    await server.close()
  }
})

for (const dialect of ["messages", "responses"] as const) {
  test(`${dialect} text pacing delivers partial deltas before the terminal event`, async () => {
    const server = await startScriptedModelServer()
    const text = "ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF HOTEL"
    server.scriptText({ marker: "PACED_REPLY", text })
    server.setTextStreamPacing({ chunks: 4, delayMs: 80 })
    try {
      const events = await new Promise<Array<{ value: ObservedStreamFrame; at: number }>>((resolve, reject) => {
        const req = httpRequest(`${server.v1Url}/${dialect}`, {
          method: "POST", headers: { "content-type": "application/json" },
        }, response => {
          let pending = ""
          const events: Array<{ value: ObservedStreamFrame; at: number }> = []
          response.setEncoding("utf8")
          response.on("data", chunk => {
            pending += chunk
            let end: number
            while ((end = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, end)
              pending = pending.slice(end + 2)
              const data = frame.split("\n").find(line => line.startsWith("data: "))
              if (data) events.push({ value: JSON.parse(data.slice(6)), at: performance.now() })
            }
          })
          response.on("error", reject)
          response.on("end", () => resolve(events))
        })
        req.on("error", reject)
        req.end(JSON.stringify(dialect === "messages"
          ? { model: "test", stream: true, max_tokens: 128, messages: [{ role: "user", content: "PACED_REPLY" }] }
          : { model: "test", stream: true, input: "PACED_REPLY" }))
      })
      const deltas = events.filter(({ value }) => dialect === "messages"
        ? value.type === "content_block_delta" && typeof value.delta === "object" && value.delta.type === "text_delta"
        : value.type === "response.output_text.delta")
      expect(deltas).toHaveLength(4)
      expect(deltas.map(({ value }) => typeof value.delta === "object" ? value.delta.text : value.delta).join("")).toBe(text)
      expect(deltas.at(-1)!.at - deltas[0].at).toBeGreaterThanOrEqual(180)
      expect(events.at(-1)!.value.type).toBe(dialect === "messages" ? "message_stop" : "response.completed")
      if (dialect === "responses") {
        expect(events.map(({ value }) => value.sequence_number)).toEqual(events.map((_, index) => index))
        expect(events.at(-1)!.value.response!.output[0].content[0].text).toBe(text)
      }
    } finally {
      await server.close()
    }
  })
}
