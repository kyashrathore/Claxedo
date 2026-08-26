import { createEffect } from "solid-js"
/**
 * Claxedo SessionContextTab resolves session params from the
 * Workbench-owned SessionParamsProvider.
 */

import { createMemo, lazy, onCleanup, untrack, For, Show, Loading } from "solid-js"
import type { JSX } from "@solidjs/web"
import { Dynamic } from "@solidjs/web"
import { useQuery } from "@tanstack/solid-query"
import { useLayout } from "@/features/session/app-ports"
import { checksum } from "@/lib/encode"
import { findLast } from "@/lib/array"
import { same } from "@/lib/same"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
// NOT `File`/`Markdown` from "@/ui/session-kit": this tab is in the eager main
// chunk (session-screen.tsx stays eager by design), and the session-kit barrel
// statically pulls @pierre/diffs + shiki. The File render edge goes through the
// app's FileComponentProvider (app.tsx supplies the lazy File), and Markdown
// crosses the loadMarkdownComponent() dynamic boundary.
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { loadMarkdownComponent } from "@/ui/session-kit-loaders"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/platform/i18n/provider"
import { useProviders } from "@/features/session/app-ports"
import { getSessionContextMetrics } from "@/features/session/ui/components/session-context-metrics"
import {
  estimateSessionContextBreakdown,
  type SessionContextBreakdownKey,
} from "@/features/session/ui/components/session-context-breakdown"
import { createSessionContextFormatter } from "@/features/session/ui/components/session-context-format"
import { useSessionParams } from "@/features/session/providers/session-params"
import { createActiveConversationSnapshot } from "../../conversation/conversation-registry"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "../../data/sync/queries"
import { sessionViewKey } from "@/platform/identity/session-view-key"
import { createActivePaneProjection } from "../../store/active-pane-projection"
import { parkedPaneQueryOptions } from "../../store/pane-query-observer"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

const LazyMarkdown = lazy(() => loadMarkdownComponent().then((Markdown) => ({ default: Markdown })))

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  // The lazy File the app shell registered on FileComponentProvider (app.tsx);
  // same render edge the review surface uses. Props are identical to the
  // session-ui File component this used to import statically.
  const File = useFileComponent()
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <Dynamic
      component={File}
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: Message
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.role} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time?.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []

export function SessionContextTab() {
  const sessionParams = useSessionParams()
  const layout = useLayout()
  const language = useLanguage()
  const providers = useProviders()
  const paneActive = () => sessionParams.active?.() ?? true

  const sessionId = createMemo(() => sessionParams.sessionId())
  const directory = createMemo(() => sessionParams.directory())

  const sessionKey = createMemo(() => {
    const dir = directory()
    const id = sessionId()
    return sessionViewKey({ directory: dir, sessionId: id })
  })
  const view = createMemo(() => layout.view(sessionKey))
  const directorySessionCacheQuery = useQuery(() => {
    if (!paneActive())
      return parkedPaneQueryOptions<DirectorySessionCacheValue>("session-context-directory", "inactive")
    return directorySessionCacheQueryOptions({ directory: directory() })
  })
  const sourceInfo = createMemo(() => {
    const id = sessionId()
    return id ? directorySessionCacheQuery.data?.session.find((session) => session.id === id) : undefined
  })
  const info = createActivePaneProjection({
    active: paneActive,
    read: sourceInfo,
    initial: undefined as ReturnType<typeof sourceInfo>,
  })

  const conversation = createActiveConversationSnapshot({
    directory,
    sessionID: sessionId,
    active: sessionParams.active,
  })

  const messages = createMemo(() => (conversation()?.messages as Message[]) ?? emptyMessages, {
    equals: same,
    loadingValue: emptyMessages,
  })

  const userMessages = createMemo(() => messages().filter((m) => m.role === "user") as UserMessage[], {
    equals: same,
    loadingValue: emptyUserMessages,
  })

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    { equals: same, loadingValue: emptyUserMessages },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const readProviders = () => Array.from(providers.all().values())
  const activeProviders = createActivePaneProjection({
    active: paneActive,
    read: readProviders,
    initial: [] as ReturnType<typeof readProviders>,
  })
  const metrics = createMemo(() => getSessionContextMetrics(messages(), activeProviders()))
  const ctx = createMemo(() => metrics().context)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const cost = createMemo(() => {
    return usd().format(metrics().totalCost)
  })

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const breakdown = createMemo(() => {
    // Exactly the reads that change the estimate. `conversation()` — the whole
    // parts map — is deliberately NOT one of them: it churns on every streamed
    // part, and re-estimating the breakdown there was the expensive read this
    // memo exists to avoid. Everything else runs untracked.
    void [ctx()?.message?.id, ctx()?.input, messages().length, systemPrompt()]
    return untrack(() => {
      const c = ctx()
      const snapshot = conversation()
      if (!c?.input || !snapshot) return []
      return estimateSessionContextBreakdown({
        messages: messages(),
        parts: snapshot.parts as Record<string, Part[] | undefined>,
        input: c.input,
        systemPrompt: systemPrompt(),
      })
    })
  })

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const stats = [
    { label: "context.stats.session", value: () => info()?.title ?? sessionId() ?? "—" },
    { label: "context.stats.messages", value: () => counts().all.toLocaleString(language.intl()) },
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.limit", value: () => formatter().number(ctx()?.limit) },
    { label: "context.stats.totalTokens", value: () => formatter().number(ctx()?.total) },
    { label: "context.stats.usage", value: () => formatter().percent(ctx()?.usage) },
    { label: "context.stats.inputTokens", value: () => formatter().number(ctx()?.input) },
    { label: "context.stats.outputTokens", value: () => formatter().number(ctx()?.output) },
    { label: "context.stats.reasoningTokens", value: () => formatter().number(ctx()?.reasoning) },
    {
      label: "context.stats.cacheTokens",
      value: () => `${formatter().number(ctx()?.cacheRead)} / ${formatter().number(ctx()?.cacheWrite)}`,
    },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.stats.totalCost", value: cost },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time?.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message?.time?.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let restoreFrame: number | undefined
  let pending: { x: number; y: number } | undefined
  const getParts = (id: string) => (conversation()?.parts[id] ?? []) as Part[]

  const restoreScroll = () => {
    if (!paneActive()) return
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    () => [paneActive(), messages().length] as const,
    ([active]) => {
      if (!active) return
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = undefined
        restoreScroll()
      })
      return () => {
        if (restoreFrame === undefined) return
        cancelAnimationFrame(restoreFrame)
        restoreFrame = undefined
      }
    },
    { defer: true },
  )

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  return (
    <ScrollView
      class="@container h-full pb-10"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 flex flex-col gap-10">
        <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
          <For each={stats}>
            {(stat) => <Stat label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />}
          </For>
        </div>

        <Show when={breakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.breakdown.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={breakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": BREAKDOWN_COLOR[segment.key],
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={breakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                    <div>{breakdownLabel(segment.key)}</div>
                    <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
                  </div>
                )}
              </For>
            </div>
            <div class="hidden text-11-regular text-text-weaker">{language.t("context.breakdown.note")}</div>
          </div>
        </Show>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.systemPrompt.title")}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
                <Loading fallback={null}>
                  <LazyMarkdown text={prompt()} class="text-12-regular" />
                </Loading>
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion multiple>
            <For each={messages()}>
              {(message) => (
                <RawMessage message={message} getParts={getParts} onRendered={restoreScroll} time={formatter().time} />
              )}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}
