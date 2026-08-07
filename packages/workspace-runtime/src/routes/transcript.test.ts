import { expect, test } from "bun:test"
import { Hono } from "hono"
import { TranscriptRoutes } from "./transcript"
import { createWorkspaceRuntimeApp } from "../server"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"

test("transcript endpoint returns typed resolution without exposing bindings", async () => {
  const app = new Hono()
  app.route("/api/wr/subagent-transcripts", TranscriptRoutes({
    workspaceId: "workspace-a",
    resolver: {
      async open(input) {
        expect(input).toEqual({
          workspaceId: "workspace-a",
          parentSessionId: "parent-a",
          handle: "opaque-handle",
        })
        return { state: "ready", messages: [{ type: "text", text: "hello" }] }
      },
    },
  }))

  const response = await app.request("http://localhost/api/wr/subagent-transcripts/opaque-handle?parentSessionId=parent-a")

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ state: "ready", messages: [{ type: "text", text: "hello" }] })
})

test("workspace runtime mounts a host-supplied transcript resolver", async () => {
  const runtime = createWorkspaceRuntimeApp({
    exposure: loopbackWorkspaceRuntimeExposure(),
    transcripts: {
      workspaceId: "workspace-a",
      resolver: {
        async open() {
          return { state: "empty", messages: [] }
        },
      },
    },
  })

  const response = await runtime.app.request(
    "http://localhost/api/wr/subagent-transcripts/opaque-handle?parentSessionId=parent-a",
  )
  runtime.dispose()

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ state: "empty", messages: [] })
})
