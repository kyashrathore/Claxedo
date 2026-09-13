import { expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { startScriptedModelServer } from "./scripted-model-server"

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
