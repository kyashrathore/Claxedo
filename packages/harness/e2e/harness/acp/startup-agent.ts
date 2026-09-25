#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { Readable, Writable } from "node:stream"
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { recordElicitationReceipt } from "./receipts"
import { ACP_SCRIPT_DIR_ENV } from "./script"

const scriptDir = process.env[ACP_SCRIPT_DIR_ENV]
if (!scriptDir) throw new Error(`${ACP_SCRIPT_DIR_ENV} is not set`)

agent()
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    authMethods: [],
  }))
  .onRequest("session/new", async (context) => {
    const response = await context.client.request("elicitation/create", {
      requestId: context.requestId,
      mode: "form",
      message: "Choose before session creation",
      requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    })
    await recordElicitationReceipt(scriptDir, {
      sessionId: "startup", message: "Choose before session creation", action: response.action,
      ...(response.action === "accept" ? { content: response.content } : {}),
    })
    return { sessionId: `scripted-startup-${randomUUID()}` }
  })
  .onRequest("session/prompt", async (context) => {
    await context.client.notify("session/update", { sessionId: context.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Startup answer accepted" } } })
    return { stopReason: "end_turn" }
  })
  .onNotification("session/cancel", () => {})
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ))
