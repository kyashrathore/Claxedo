import type { ModelSelection, SDKMessage } from "@cursor/sdk"
import { Log } from "../../log"
import type { SessionTitleRequest } from "../../title-generation"

const log = Log.create({ service: "cursor-title" })

type TitleRun = {
  stream(): AsyncGenerator<SDKMessage, void>
  wait(): Promise<unknown>
  cancel(): Promise<void>
}

type TitleAgent = {
  agentId: string
  send(message: string, options?: { model?: ModelSelection; local?: { force?: boolean } }): Promise<TitleRun>
  close(): void
}

export type CursorTitleInput = {
  request: SessionTitleRequest
  createAgent(): Promise<TitleAgent>
  model?: ModelSelection
}

/**
 * A local Cursor agent never names itself (only cloud agents do), so the
 * title is one send on a throwaway local agent: the session's own agent
 * would record the exchange in its transcript. The SDK has no rename, so
 * nothing is written back.
 */
export async function generateCursorTitle(input: CursorTitleInput): Promise<string | null> {
  let agent: TitleAgent | undefined
  try {
    agent = await input.createAgent()
    const run = await agent.send(`${input.request.system}\n\n${input.request.user}`, {
      ...(input.model ? { model: input.model } : {}),
      local: { force: false },
    })
    const onAbort = () => void run.cancel().catch(() => {})
    input.request.signal.addEventListener("abort", onAbort, { once: true })
    try {
      let reply = ""
      for await (const message of run.stream()) {
        if (message.type !== "assistant") continue
        for (const block of message.message.content) if (block.type === "text") reply += block.text
      }
      await run.wait()
      return input.request.signal.aborted ? null : reply
    } finally {
      input.request.signal.removeEventListener("abort", onAbort)
    }
  } catch (error) {
    log.warn("Cursor title run failed", { error: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    agent?.close()
  }
}
