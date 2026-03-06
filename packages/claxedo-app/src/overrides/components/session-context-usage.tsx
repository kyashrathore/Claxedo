import { Match, Show, Switch, createMemo } from "solid-js"
import { Tooltip, type TooltipProps } from "@opencode-ai/ui/tooltip"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { Button } from "@opencode-ai/ui/button"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@opencode-ai/util/encode"

import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { useClaxedoLayout } from "@claxedo/claxedo-ui/context/claxedo-layout"
import { useSessionParams } from "@claxedo/claxedo-ui/context/session-params"
import { sendContextToggle } from "@claxedo/claxedo-ui/context/pane-bus"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  placement?: TooltipProps["placement"]
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const routeParams = useParams()
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in split mode */
  }
  let claxedo: ReturnType<typeof useClaxedoLayout> | undefined
  try {
    claxedo = useClaxedoLayout()
  } catch {
    /* not in claxedo mode */
  }
  const language = useLanguage()

  const sessionId = createMemo(() => sessionParams?.sessionId() ?? routeParams.id)
  const directory = createMemo(() => sessionParams?.directory() ?? (routeParams.dir ? base64Decode(routeParams.dir) : undefined))
  const groupId = createMemo(() => sessionParams?.groupId() ?? claxedo?.split.focusedId())

  const variant = createMemo(() => props.variant ?? "button")
  const messages = createMemo(() => {
    const id = sessionId()
    return id ? (sync.data.message[id] ?? []) : []
  })

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const metrics = createMemo(() => getSessionContextMetrics(messages(), sync.data.provider.all))
  const context = createMemo(() => metrics().context)
  const cost = createMemo(() => usd().format(metrics().totalCost))

  const openContext = () => {
    if (!claxedo) return
    const gid = groupId()
    if (!gid) return

    // Find review-workspace leaf in the active tab of this group and toggle its context tab
    const activeTab = claxedo.select.groupActiveTab(gid)
    if (activeTab) {
      const leaves = claxedo.select.multiPaneLeafView(activeTab.id)
      const reviewLeaf = leaves.find((l) => l.content?.type === "review-workspace")
      if (reviewLeaf && sendContextToggle(reviewLeaf.id, sessionId())) return
    }

    // Fallback: open as a standalone context tab
    const sid = sessionId()
    const dir = directory()
    if (!sid || !dir) return
    const tabs = claxedo.groupTabs(gid)
    const active = tabs.active()
    if (active?.type === "context" && active.sessionId === sid) {
      tabs.close(active.id)
      return
    }
    const id = tabs.addContext(dir, sid, language.t("session.tab.context"))
    if (id) tabs.setActive(id)
  }

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle size={16} strokeWidth={2} percentage={context()?.usage ?? 0} />
    </div>
  )

  const tooltipValue = () => (
    <div>
      <Show when={context()}>
        {(ctx) => (
          <>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{ctx().total.toLocaleString(language.locale())}</span>
              <span class="text-text-invert-base">{language.t("context.usage.tokens")}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{ctx().usage ?? 0}%</span>
              <span class="text-text-invert-base">{language.t("context.usage.usage")}</span>
            </div>
          </>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <span class="text-text-invert-strong">{cost()}</span>
        <span class="text-text-invert-base">{language.t("context.usage.cost")}</span>
      </div>
    </div>
  )

  return (
    <Show when={sessionId()}>
      <Tooltip value={tooltipValue()} placement={props.placement ?? "top"}>
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-6"
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </Tooltip>
    </Show>
  )
}
