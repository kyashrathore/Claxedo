import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import {
  arenaApi,
  type ArenaAgentConfig,
  type ArenaState,
  type ArenaControlRequest,
  type ArenaMessage,
  type ArenaWaveState,
} from "@/features/documents/data/arena-api"
import { pagesApi } from "@/features/documents/data/pages-api"
import { authFetch } from "@/platform/api/api"
import { createArenaSseParser } from "./arena-sse"

type PageArenaDockProps = {
  pageId: string
  directory?: string
  parentSessionId?: string
  mode: "floating" | "side"
  activeWaveId?: string
  onActiveWaveChange?: (id: string) => void
  onWavesChange?: (waves: ArenaWaveState[]) => void
}

type DraftAgent = ArenaAgentConfig

const defaultModel = "opencode/big-pickle"
const pageContextMax = 6000

const defaultAgents: DraftAgent[] = [
  {
    name: "builder",
    role: "implementer",
    duty: "Propose concrete implementation steps and tradeoffs.",
    model: defaultModel,
  },
  {
    name: "critic",
    role: "challenger",
    duty: "Challenge weak assumptions and identify risks.",
    model: defaultModel,
  },
  {
    name: "editor",
    role: "synthesizer",
    duty: "Synthesize converged decisions clearly.",
    model: defaultModel,
  },
]

export function PageArenaDock(props: PageArenaDockProps) {
  const [state, setState] = createSignal<ArenaState>({ arena: null, agents: [], waves: [], messages: [] })
  const [loading, setLoading] = createSignal(true)
  const [starting, setStarting] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [error, setError] = createSignal("")
  const [draft, setDraft] = createSignal("")
  const [agents, setAgents] = createSignal([...defaultAgents])
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [activeWave, setActiveWave] = createSignal("")

  let streamAbort: AbortController | undefined
  let listRef: HTMLDivElement | undefined
  let sendAbort: AbortController | undefined

  const draftKey = () => `claxedo.page.arena.draft.${props.pageId}`
  const waves = createMemo(() => state().waves)
  const latestWave = createMemo(() => waves()[0])
  const arenaStatus = createMemo(() => state().arena?.status || "idle")
  const running = createMemo(() => arenaStatus() === "running" || arenaStatus() === "paused")
  const activeWaveID = createMemo(() => activeWave() || latestWave()?.id || "")
  const hasRunningWave = createMemo(() => waves().some((item) => item.status === "running"))
  const shownMessages = createMemo(() => {
    const waveID = activeWaveID()
    if (!waveID) return state().messages
    return state().messages.filter((item) => item.wave_id === waveID)
  })
  const summary = createMemo(() => {
    const current = waves().find((item) => item.id === activeWaveID()) || latestWave()
    if (!current) return ""
    return `Round ${current.round} · ${current.status}${current.termination ? ` · ${current.termination}` : ""}`
  })
  const activity = createMemo(() => {
    if (!running()) return ""
    const busy = state().agents.filter((item) => item.status === "running")
    if (busy.length === 0) return "Working..."
    return `Working: ${busy.map((item) => `@${item.key}`).join(", ")}`
  })
  const primaryBusy = createMemo(() => sending() || stopping())

  const applyState = (next: ArenaState) => {
    const shouldKeepBottom = !listRef ? true : listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight < 28
    setState(next)
    const current = activeWave()
    const first = next.waves[0]?.id || ""
    let nextActive = current
    if (!nextActive) nextActive = first
    if (nextActive && !next.waves.some((item) => item.id === nextActive)) nextActive = first
    if (nextActive !== current) {
      setActiveWave(nextActive)
      props.onActiveWaveChange?.(nextActive)
    }
    props.onWavesChange?.(next.waves)
    requestAnimationFrame(() => {
      if (!listRef) return
      if (!shouldKeepBottom) return
      listRef.scrollTop = listRef.scrollHeight
    })
  }

  const refresh = async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const next = await arenaApi.state(props.pageId)
      applyState(next)
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  const handleArenaEvent = async (data: string) => {
    try {
      const payload = JSON.parse(data) as { type?: string; state?: ArenaState; message?: ArenaMessage }
      if (payload.state) {
        applyState(payload.state)
        return
      }
      if (payload.type === "arena.message" && payload.message) {
        const next = state()
        applyState({
          ...next,
          messages: [...next.messages, payload.message],
        })
        return
      }
      if (payload.type === "arena.heartbeat") return
      if (payload.type && payload.type.startsWith("arena.")) await refresh(false)
    } catch {
      // ignore malformed stream chunk
    }
  }

  const connect = () => {
    streamAbort?.abort()
    const abort = new AbortController()
    streamAbort = abort
    void (async () => {
      const res = await authFetch(arenaApi.eventsUrl(props.pageId, props.directory), {
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      })
      if (!res.ok) throw new Error(await res.text() || `Request failed: ${res.status}`)
      if (!res.body) throw new Error("Arena stream unavailable")
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const parser = createArenaSseParser()
      while (!abort.signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        for (const data of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          await handleArenaEvent(data)
        }
      }
    })().catch((err) => {
      if (abort.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  const addAgent = () => {
    if (agents().length >= 5) return
    setAgents((list) => [
      ...list,
      {
        name: `agent-${list.length + 1}`,
        role: "participant",
        duty: "Contribute relevant reasoning.",
        model: defaultModel,
      },
    ])
  }

  const removeAgent = (idx: number) => {
    if (agents().length <= 1) return
    setAgents((list) => list.filter((_, i) => i !== idx))
  }

  const updateAgent = (idx: number, patch: Partial<DraftAgent>) => {
    setAgents((list) => list.map((agent, i) => (i === idx ? { ...agent, ...patch } : agent)))
  }

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const startArena = async () => {
    setStarting(true)
    setError("")
    try {
      const next = await arenaApi.start(props.pageId, {
        directory: props.directory,
        parent_session_id: props.parentSessionId,
        config: {
          agents: agents(),
        },
      })
      applyState(next)
      setActiveWave(next.waves[0]?.id || "")
      connect()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const stop = async () => {
    if (stopping()) return
    setStopping(true)
    setError("")
    sendAbort?.abort()
    try {
      const res = await arenaApi.control(props.pageId, { action: "stop" })
      applyState(res.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStopping(false)
    }
  }

  const send = async () => {
    const text = draft().trim()
    if (!text || sending() || running()) return
    setSending(true)
    setError("")
    sendAbort?.abort()
    const abort = new AbortController()
    sendAbort = abort
    try {
      const page_context = await pagesApi
        .get(props.pageId)
        .then((page) => (page.content || "").trim())
        .then((value) => (value.length <= pageContextMax ? value : `${value.slice(0, pageContextMax - 1)}…`))
        .catch(() => "")
      const res = await arenaApi.message(
        props.pageId,
        {
          text,
          ...(page_context ? { page_context } : {}),
        },
        abort.signal,
      )
      setActiveWave(res.wave_id)
      applyState(res.state)
      setDraft("")
    } catch (err) {
      if (abort.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (sendAbort === abort) {
        setSending(false)
        sendAbort = undefined
      }
    }
  }

  const control = async (action: ArenaControlRequest["action"]) => {
    if (action === "stop") {
      await stop()
      return
    }
    setError("")
    try {
      const res = await arenaApi.control(props.pageId, { action })
      applyState(res.state)
      if (action === "retry") {
        const first = res.state.waves[0]?.id
        if (first) setActiveWave(first)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const submit = async () => {
    if (sending() || running()) {
      await stop()
      return
    }
    await send()
  }

  createEffect(() => {
    if (typeof window === "undefined") return
    const saved = window.localStorage.getItem(draftKey())
    if (saved) setDraft(saved)
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(draftKey(), draft())
  })

  createEffect(() => {
    const id = props.activeWaveId?.trim()
    if (!id) return
    if (id === activeWave()) return
    if (!state().waves.some((wave) => wave.id === id)) return
    setActiveWave(id)
  })

  createEffect(() => {
    void refresh().then(() => connect())
  })

  onCleanup(() => {
    streamAbort?.abort()
    sendAbort?.abort()
  })

  const side = () => props.mode === "side"

  return (
    <div classList={{ "notion-arena-dock": true, "notion-arena-dock-side": side(), "notion-arena-dock-floating": !side() }}>
      <Show when={error()}>
        {(message) => <div class="notion-arena-error">{message()}</div>}
      </Show>

      <Show when={loading()}>
        <div class="notion-arena-loading">Loading arena...</div>
      </Show>

      <Show when={!loading() && !state().arena}>
        <div class="notion-arena-setup">
          <div class="notion-arena-setup-label">Members</div>
          <For each={agents()}>
            {(agent, idx) => (
              <div class="notion-arena-member">
                <input
                  class="notion-arena-input"
                  value={agent.name}
                  onInput={(event) => updateAgent(idx(), { name: event.currentTarget.value })}
                  placeholder="name"
                />
                <input
                  class="notion-arena-input"
                  value={agent.role}
                  onInput={(event) => updateAgent(idx(), { role: event.currentTarget.value })}
                  placeholder="role"
                />
                <input
                  class="notion-arena-input"
                  value={agent.duty}
                  onInput={(event) => updateAgent(idx(), { duty: event.currentTarget.value })}
                  placeholder="duty"
                />
                <input
                  class="notion-arena-input"
                  value={agent.model}
                  onInput={(event) => updateAgent(idx(), { model: event.currentTarget.value })}
                  placeholder="provider/model"
                />
                <button type="button" class="notion-arena-btn" onClick={() => removeAgent(idx())}>
                  Remove
                </button>
              </div>
            )}
          </For>
          <div class="notion-arena-actions">
            <button type="button" class="notion-arena-btn" onClick={addAgent} disabled={agents().length >= 5}>
              Add member
            </button>
            <button type="button" class="notion-arena-btn notion-arena-btn-primary" onClick={startArena} disabled={starting()}>
              {starting() ? "Starting..." : "Start Arena"}
            </button>
          </div>
        </div>
      </Show>

      <Show when={!loading() && state().arena}>
        <div class="notion-arena-running">
          <Show when={summary()}>
            {(text) => <div class="notion-arena-wave">{text()}</div>}
          </Show>
          <Show when={activity()}>
            {(text) => <div class="notion-arena-activity">{text()}</div>}
          </Show>

          <div
            class="notion-arena-messages"
            ref={listRef}
          >
            <For each={shownMessages()}>
              {(message) => {
                const meta = message.meta || {}
                const tools = Array.isArray(meta.tools) ? meta.tools : []
                const open = () => !!expanded()[message.id]
                return (
                  <div class="notion-arena-message">
                    <div class="notion-arena-message-head">
                      <span class="notion-arena-who">{message.kind === "user" ? "You" : `@${message.source}`}</span>
                      <Show when={message.kind !== "user"}>
                        <span class="notion-arena-signal">{message.signal}</span>
                      </Show>
                      <Show when={tools.length > 0}>
                        <button type="button" class="notion-arena-inline-btn" onClick={() => toggleExpanded(message.id)}>
                          {open() ? "Hide tools" : `Tools (${tools.length})`}
                        </button>
                      </Show>
                    </div>
                    <div class="notion-arena-text">{message.text}</div>
                    <Show when={open() && tools.length > 0}>
                      <div class="notion-arena-tools">
                        <For each={tools as Array<{ name?: string; status?: string; output?: string }>}>
                          {(tool) => (
                            <div class="notion-arena-tool-item">
                              <div class="notion-arena-tool-title">{tool.name || "tool"} · {tool.status || "done"}</div>
                              <Show when={tool.output}>
                                <div class="notion-arena-tool-output">{tool.output}</div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>

          <div class="notion-arena-controls">
            <button
              type="button"
              class="notion-arena-btn"
              onClick={() => void control(arenaStatus() === "paused" ? "resume" : "pause")}
              disabled={!hasRunningWave()}
            >
              {arenaStatus() === "paused" ? "Resume" : "Pause"}
            </button>
            <button type="button" class="notion-arena-btn" onClick={() => void control("retry")} disabled={running()}>
              Retry
            </button>
          </div>

          <form
            class="notion-arena-composer"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <textarea
              class="notion-arena-textarea"
              value={draft()}
              placeholder="Message arena (use @agent to target)..."
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return
                event.preventDefault()
                void submit()
              }}
            />
            <IconButton
              data-action="arena-submit"
              type="submit"
              disabled={(!draft().trim() && !running()) || primaryBusy()}
              icon={sending() || running() ? "stop" : "arrow-up"}
              variant="primary"
              classList={{ "size-8": true, "notion-arena-submit-busy": primaryBusy() }}
              aria-label={sending() || running() ? "Stop arena run" : "Send to arena"}
            />
          </form>
        </div>
      </Show>
    </div>
  )
}
