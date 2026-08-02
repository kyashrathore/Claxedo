import type { OutboundChunk } from "../envelope"
import { sanitizeChannelText, type ChannelTextMinimizationOptions } from "../core/data-minimization"
import { channelRetryDelayMs, type RetryAfterMs } from "./backpressure"

export type ChatSdkMessageHandle = {
  edit?: (text: string) => Promise<unknown> | unknown
}

export type ChatSdkApprovalCard = {
  title: string
  body: string
  actions: {
    label: string
    value: string
    data: {
      token: string
      approved: boolean
    }
  }[]
}

export type ChatSdkThread = {
  /**
   * Chat SDK threads accept a plain string OR an `AsyncIterable<string>` of
   * text deltas — the SDK routes iterables to the adapter's native stream
   * implementation (Telegram/Slack/etc.) with a post+edit fallback.
   */
  post: (text: string | AsyncIterable<string>) => Promise<ChatSdkMessageHandle | unknown> | ChatSdkMessageHandle | unknown
  postCard?: (card: ChatSdkApprovalCard) => Promise<ChatSdkMessageHandle | unknown> | ChatSdkMessageHandle | unknown
}

type TextStream = {
  push: (delta: string) => void
  end: () => void
  /** Resolves when the SDK finishes rendering the stream (post promise). */
  done: Promise<unknown>
  /** Full text pushed so far — used for diffing and for failure recovery. */
  text: string
  failed: boolean
}

type RenderState = {
  posted?: ChatSdkMessageHandle
  lastEditAt: number
  pending?: {
    body: string
    fallback: string
    chunk: OutboundChunk
  }
  timer?: ReturnType<typeof setTimeout>
  /** Active SDK-native text stream for the current run, if any. */
  stream?: TextStream
  /** True once any streamed text was rendered (suppresses noisy statuses). */
  streamedText: boolean
}

type ReliablePostOptions = {
  attempts?: number
  retryDelayMs?: number
  retryAfterMs?: RetryAfterMs
  fallbackOnExhaustion?: boolean
}

function handle(input: unknown): ChatSdkMessageHandle | undefined {
  if (!input || typeof input !== "object") return
  const row = input as { edit?: unknown }
  return typeof row.edit === "function" ? row as ChatSdkMessageHandle : undefined
}

/**
 * Start an SDK-native text stream on the thread: `thread.post(iterable)` hands
 * delta rendering to the platform adapter (Telegram draft-edit streaming,
 * Slack native streaming, …) with the SDK's own post+edit fallback. Deltas are
 * pushed as runtime events arrive; `end()` closes the stream and `done`
 * settles when the SDK finishes rendering.
 */
function startTextStream(thread: ChatSdkThread): TextStream {
  const queue: string[] = []
  let notify: (() => void) | undefined
  let ended = false
  const iterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) yield queue.shift()!
        if (ended) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
        notify = undefined
      }
    },
  }
  const stream: TextStream = {
    text: "",
    failed: false,
    push(delta: string) {
      if (ended) return
      stream.text += delta
      queue.push(delta)
      notify?.()
    },
    end() {
      ended = true
      notify?.()
    },
    done: Promise.resolve(),
  }
  stream.done = Promise.resolve(thread.post(iterable)).catch(() => {
    stream.failed = true
  })
  return stream
}

export function channelChunkText(chunk: OutboundChunk) {
  if (chunk.kind === "text") return chunk.text
  if (chunk.kind === "approval") {
    // No "reply approve <token>" instruction: the decision comes from the card
    // buttons this body is attached to, or from the judge reading a natural
    // reply. Printing a token to retype would resurrect the parsed-text path.
    //
    // The requestee IS named: in a group everyone can see the buttons but only
    // one person's press counts, so someone else pressing gets a refusal. Say
    // who up front rather than letting them find out by being rejected.
    const awaiting = chunk.request.requestee
      ? `\nWaiting on ${chunk.request.requestee} to answer.`
      : ""
    return `Approval required for ${chunk.request.tool}: ${chunk.request.summary}${awaiting}`
  }
  const suffix = chunk.appUrl ? `\nOpen: ${chunk.appUrl}` : ""
  if (chunk.phase === "creating") return `Creating session${chunk.sessionId ? ` ${chunk.sessionId}` : ""}.${suffix}`
  if (chunk.phase === "running") return `Session${chunk.sessionId ? ` ${chunk.sessionId}` : ""} is running.${suffix}`
  if (chunk.phase === "done") return `Session${chunk.sessionId ? ` ${chunk.sessionId}` : ""} finished.${suffix}`
  return `Session${chunk.sessionId ? ` ${chunk.sessionId}` : ""} failed.${suffix}`
}

export function channelChunkFallbackText(chunk: OutboundChunk, body: string) {
  return chunk.kind === "status" && chunk.appUrl ? `Run status changed. Open: ${chunk.appUrl}` : body
}

function reliable(chunk: OutboundChunk) {
  return chunk.kind === "status" || (chunk.kind === "text" && chunk.final)
}

async function delay(ms: number) {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function postWithFallback(thread: ChatSdkThread, body: string, fallback: string, options: ReliablePostOptions = {}) {
  const attempts = Math.max(1, options.attempts ?? 1)
  const retryDelayMs = options.retryDelayMs ?? 0
  for (const index of Array.from({ length: attempts }).keys()) {
    try {
      return await thread.post(body)
    } catch (error) {
      if (index < attempts - 1) {
        await delay(channelRetryDelayMs({
          error,
          attempt: index,
          retryDelayMs,
          retryAfterMs: options.retryAfterMs,
        }))
      }
    }
  }
  if (options.fallbackOnExhaustion === false || fallback === body) return
  return await thread.post(fallback)
}

/**
 * Post an approval prompt as a native card.
 *
 * There is deliberately NO text downgrade. A channel that advertises
 * `postCard` and then fails has a delivery problem, and quietly printing
 * "reply approve <token>" instead would reintroduce the text-parsing path this
 * design removed. Retries through the shared backoff, then throws — the caller
 * surfaces it and the prompt stays pending rather than silently changing the
 * rules the human is answering under.
 *
 * A channel with no `postCard` at all (WhatsApp/Baileys) has no human approval
 * surface; approvals there are decided by the judge in `ChannelCore`, and the
 * prompt is never rendered.
 */
async function postApproval(thread: ChatSdkThread, chunk: Extract<OutboundChunk, { kind: "approval" }>, body: string, options: {
  attempts?: number
  retryDelayMs?: number
  retryAfterMs?: RetryAfterMs
} = {}) {
  if (!thread.postCard) {
    throw new Error("Approval prompts require a channel with interactive card support.")
  }
  const attempts = Math.max(1, options.attempts ?? 3)
  const card: ChatSdkApprovalCard = {
    title: `Approval required: ${chunk.request.tool}`,
    body,
    actions: [{
      label: "Approve",
      value: "approve",
      data: { token: chunk.request.token ?? chunk.request.callId, approved: true },
    }, {
      label: "Deny",
      value: "deny",
      data: { token: chunk.request.token ?? chunk.request.callId, approved: false },
    }],
  }
  let last: unknown
  for (const index of Array.from({ length: attempts }).keys()) {
    try {
      return await thread.postCard(card)
    } catch (error) {
      last = error
      if (index < attempts - 1) {
        await delay(channelRetryDelayMs({
          error,
          attempt: index,
          retryDelayMs: options.retryDelayMs ?? 100,
          retryAfterMs: options.retryAfterMs,
        }))
      }
    }
  }
  throw last instanceof Error ? last : new Error("Failed to post approval card.")
}

export function createChatSdkRenderer(thread: ChatSdkThread, options: {
  editInPlace?: boolean
  editCadenceMs?: number
  postAttempts?: number
  retryDelayMs?: number
  retryAfterMs?: RetryAfterMs
  dataMinimization?: ChannelTextMinimizationOptions
  /**
   * Stream assistant text through `thread.post(AsyncIterable<string>)` so the
   * platform adapter's NATIVE streaming renders it (default). Set false to
   * keep the legacy manual accumulate+edit path.
   */
  nativeStreaming?: boolean
} = {}) {
  const state: RenderState = { lastEditAt: 0, streamedText: false }
  const nativeStreaming = options.nativeStreaming !== false

  const renderNow = async (chunk: OutboundChunk, body: string, fallback: string) => {
    if (options.editInPlace && state.posted?.edit && chunk.kind !== "approval") {
      try {
        await state.posted.edit(body)
        state.lastEditAt = Date.now()
        return
      } catch {
        if (chunk.kind !== "text" || !chunk.final) return
      }
    }
    state.posted = handle(await (chunk.kind === "approval"
      ? postApproval(thread, chunk, body, {
        attempts: options.postAttempts ?? 3,
        retryDelayMs: options.retryDelayMs ?? 100,
        ...(options.retryAfterMs ? { retryAfterMs: options.retryAfterMs } : {}),
      })
      : postWithFallback(thread, body, fallback, reliable(chunk)
        ? { attempts: options.postAttempts ?? 3, retryDelayMs: options.retryDelayMs ?? 100, retryAfterMs: options.retryAfterMs }
        : { fallbackOnExhaustion: false }))) ?? state.posted
    state.lastEditAt = Date.now()
  }

  const flushPending = async () => {
    const pending = state.pending
    if (!pending) return
    state.pending = undefined
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    await renderNow(pending.chunk, pending.body, pending.fallback)
  }

  const queue = (chunk: OutboundChunk, body: string, fallback: string) => {
    const cadence = options.editCadenceMs ?? 0
    if (!cadence || chunk.kind !== "text" || chunk.final || !options.editInPlace || !state.posted?.edit) return false
    const wait = Math.max(0, cadence - (Date.now() - state.lastEditAt))
    if (wait === 0) return false
    state.pending = { body, fallback, chunk }
    if (!state.timer) {
      state.timer = setTimeout(() => {
        flushPending().catch(() => {})
      }, wait)
    }
    return true
  }

  // --- SDK-native streaming path -----------------------------------------

  /** Feed accumulated text into the live stream as a delta; restart on rewrite. */
  const streamText = async (body: string) => {
    if (state.stream?.failed) {
      // The SDK stream died mid-run; recover by falling back to a plain post
      // of the full accumulated text on the final chunk (handled there).
      state.stream = undefined
    }
    if (state.stream && !body.startsWith(state.stream.text)) {
      // Sanitization or part-rewrites changed already-streamed text: close the
      // current stream and start over with the full body.
      state.stream.end()
      await state.stream.done
      state.stream = undefined
    }
    state.stream ??= startTextStream(thread)
    const delta = body.slice(state.stream.text.length)
    if (delta) {
      state.stream.push(delta)
      state.streamedText = true
    }
  }

  /** Close the live stream; if it failed, salvage the text with a plain post. */
  const finishStream = async () => {
    const stream = state.stream
    if (!stream) return
    state.stream = undefined
    stream.end()
    await stream.done
    if (stream.failed && stream.text) {
      await postWithFallback(thread, stream.text, stream.text, {
        attempts: options.postAttempts ?? 3,
        retryDelayMs: options.retryDelayMs ?? 100,
        retryAfterMs: options.retryAfterMs,
      })
    }
  }

  return async (chunk: OutboundChunk) => {
    const body = sanitizeChannelText(channelChunkText(chunk), options.dataMinimization)
    const fallback = sanitizeChannelText(
      channelChunkFallbackText(chunk, body),
      options.dataMinimization,
    )
    if (nativeStreaming) {
      if (chunk.kind === "text" && !chunk.final) {
        await streamText(body)
        return
      }
      if (chunk.kind === "text" && chunk.final) {
        // Final chunk (link/failure summary) is a SEPARATE message — it must
        // never replace the streamed answer (the old edit-in-place path
        // overwrote the whole reply with "Open: …").
        await finishStream()
        await postWithFallback(thread, body, fallback, {
          attempts: options.postAttempts ?? 3,
          retryDelayMs: options.retryDelayMs ?? 100,
          retryAfterMs: options.retryAfterMs,
        })
        return
      }
      if (chunk.kind === "status") {
        // Once text is streaming, transient statuses are noise; only surface
        // failures. Pre-stream statuses ("creating") keep the legacy path so
        // the ack still lands (and can be edited in place).
        if (state.streamedText && chunk.phase !== "failed") return
        if (chunk.phase === "failed") await finishStream()
      }
      if (chunk.kind === "approval") {
        await renderNow(chunk, body, fallback)
        return
      }
    }
    if (chunk.kind !== "text" || chunk.final) await flushPending()
    if (queue(chunk, body, fallback)) return
    await renderNow(chunk, body, fallback)
  }
}
