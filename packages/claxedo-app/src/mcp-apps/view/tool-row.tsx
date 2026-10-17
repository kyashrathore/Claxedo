import { createEffect, createMemo, Match, on, Switch, type JSX } from "solid-js"
import type { AgentToolPart } from "@claxedo/agent-runtime-contract"
import { DEFAULT_APP_HEIGHT } from "../model"
import { appDocumentOf, appFactsOf } from "../part"
import type { AppPromptSend } from "../requests"
import { useMcpAppSession } from "../store"
import { McpAppFrame } from "./frame"
import { AppLoadingNotice } from "./loading-notice"
import "./mcp-app.css"

export type McpAppToolRowProps = {
  readonly part: AgentToolPart
  readonly loadBody?: (part: AgentToolPart) => void
  readonly openLink: (target: Element, href: string) => boolean
  readonly sendPrompt?: AppPromptSend
  readonly fallback: JSX.Element
}

export function McpAppToolRow(props: McpAppToolRowProps): JSX.Element {
  const session = useMcpAppSession()
  const facts = createMemo(() => appFactsOf(props.part))
  const appDocument = createMemo(() => appDocumentOf(props.part))
  const readyApp = createMemo(() => {
    const current = appDocument()
    const appFacts = facts()
    return current.kind === "ready" && appFacts ? { html: current.html, facts: appFacts } : undefined
  })
  const pending = createMemo(() => facts() !== undefined && appDocument().kind === "pending")
  createEffect(on(pending, (isPending) => {
    if (isPending) props.loadBody?.(props.part)
  }))
  const placeholderHeight = () => session?.heights.read(props.part.id) ?? DEFAULT_APP_HEIGHT
  return (
    <Switch fallback={props.fallback}>
      <Match when={pending()}>
        <div data-component="mcp-app" data-display-mode="inline" data-border="frame" style={{ "--mcp-app-height": `${placeholderHeight()}px` }}>
          <div data-slot="mcp-app-placeholder" />
          <AppLoadingNotice />
        </div>
      </Match>
      <Match when={readyApp()}>
        {(app) => <McpAppFrame html={app().html} facts={app().facts} part={props.part} session={session} openLink={props.openLink} sendPrompt={props.sendPrompt} />}
      </Match>
    </Switch>
  )
}
