import type { HostedStreamBridge } from "@claxedo/account-contract"
import { ServerError } from "./errors"
import { accountStreamError, reserveAccountEvents } from "./wire/account-stream"

type AccountStreamRun = {
  readonly bridge: HostedStreamBridge
  readonly signal: AbortSignal
  readonly body: ReadableStreamDefaultController<Uint8Array>
  readonly subscriptions: Array<() => void>
  readonly abort: () => void
  streamId?: string
  ended: boolean
}

function closeRemote(run: AccountStreamRun) {
  if (!run.streamId) return
  void run.bridge.streamClose(run.streamId).catch((error) => {
    console.error("The account event stream could not be closed", accountStreamError(error))
  })
}

function finish(run: AccountStreamRun, error?: unknown, cancelled = false) {
  if (run.ended) return
  run.ended = true
  run.signal.removeEventListener("abort", run.abort)
  for (const unsubscribe of run.subscriptions) unsubscribe()
  closeRemote(run)
  if (cancelled) return
  if (error) run.body.error(error)
  else run.body.close()
}

function follow(run: AccountStreamRun) {
  run.subscriptions.push(
    run.bridge.onStreamChunk((payload) => {
      if (!run.ended && payload.streamId === run.streamId) run.body.enqueue(new TextEncoder().encode(payload.text))
    }),
    run.bridge.onStreamEnd((payload) => {
      if (payload.streamId === run.streamId) finish(run)
    }),
    run.bridge.onStreamError((payload) => {
      if (payload.streamId === run.streamId) finish(run, accountStreamError(new Error(payload.message)))
    }),
  )
  run.signal.addEventListener("abort", run.abort, { once: true })
}

async function reserve(run: AccountStreamRun, headers: Headers) {
  try {
    const opened = await reserveAccountEvents(run.bridge, headers)
    run.streamId = opened.streamId
    if (run.ended) return closeRemote(run)
    await run.bridge.streamStart(opened.streamId)
  } catch (error) {
    finish(run, accountStreamError(error))
  }
}

export function accountEventResponse(bridge: HostedStreamBridge, headers: Headers, signal: AbortSignal): Response {
  let run: AccountStreamRun
  const stream = new ReadableStream<Uint8Array>({
    start(body) {
      run = { bridge, signal, body, subscriptions: [], ended: false, abort: () => finish(run, signal.reason ?? new ServerError({ class: "network", message: "The account stream was aborted" })) }
      follow(run)
      if (signal.aborted) run.abort()
      else void reserve(run, headers)
    },
    cancel() {
      finish(run, undefined, true)
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}
