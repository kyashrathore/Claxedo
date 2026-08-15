/**
 * The session view — deliberately grammar-shaped.
 *
 * Every construct here maps 1:1 onto the closed view grammar from the
 * dual-target plan (sub-plan 03): `<For>` over pre-derived rows, `<Show>` on
 * row fields, dispatch of named messages. No logic beyond mapping — the fold
 * in `core/update.ts` owns all derivation, which is what will let the same
 * definition compile through the Native SDK path.
 */

import { For, Show, createMemo } from "solid-js"
import type { SessionModel, SessionMsg, TimelineRow } from "../core/model"
import { renderMarkdown } from "./markdown"
import { Composer } from "./composer"

type Dispatch = (msg: SessionMsg) => void

export function SessionView(props: { model: SessionModel; dispatch: Dispatch }) {
  return (
    <div class="session">
      <header class="session-header">
        <div class="session-title">{props.model.title ?? props.model.sessionId}</div>
        <div class={`pill status-${props.model.status}`}>{props.model.status}</div>
        <div class={`pill connection-${props.model.connection}`}>{props.model.connection}</div>
      </header>
      <main class="timeline" data-testid="timeline">
        <For each={props.model.rows}>{(row) => <Row row={row} />}</For>
        <Show when={props.model.rows.length === 0}>
          <div class="empty">No messages yet — say something below.</div>
        </Show>
      </main>
      <Composer model={props.model} dispatch={props.dispatch} />
    </div>
  )
}

function Row(props: { row: TimelineRow }) {
  const row = () => props.row
  switch (props.row.kind) {
    case "user":
      return <div class="row user" data-row="user">{(row() as Extract<TimelineRow, { kind: "user" }>).text}</div>
    case "assistant":
    case "thinking":
      return <MarkdownRow row={row() as Extract<TimelineRow, { kind: "assistant" | "thinking" }>} />
    case "tool":
      return <ToolRow row={row() as Extract<TimelineRow, { kind: "tool" }>} />
    case "notice": {
      const notice = row() as Extract<TimelineRow, { kind: "notice" }>
      return <div class={`row notice severity-${notice.severity}`} data-row="notice">{notice.message}</div>
    }
    case "plan": {
      const plan = () => props.row as Extract<TimelineRow, { kind: "plan" }>
      return (
        <details class="row plan" open data-row="plan">
          <summary>Proposed plan{plan().complete ? "" : " (streaming…)"}</summary>
          <div class="markdown" innerHTML={renderMarkdown(plan().markdown)} />
        </details>
      )
    }
    case "todos": {
      const todos = () => (props.row as Extract<TimelineRow, { kind: "todos" }>).todos
      return (
        <div class="row todos" data-row="todos">
          <For each={todos()}>{(todo) => (
            <div class={`todo todo-${todo.status}`}>
              <span class="todo-marker" />
              {todo.description}
            </div>
          )}</For>
        </div>
      )
    }
  }
}

function MarkdownRow(props: { row: Extract<TimelineRow, { kind: "assistant" | "thinking" }> }) {
  // Memoized per markdown string: a token delta re-parses THIS row only.
  const html = createMemo(() => renderMarkdown(props.row.markdown))
  return (
    <Show
      when={props.row.kind === "assistant"}
      fallback={
        <details class="row thinking" data-row="thinking">
          <summary>Thinking{props.row.streaming ? "…" : ""}</summary>
          <div class="markdown" innerHTML={html()} />
        </details>
      }
    >
      {/* class, not classList: Solid 2 removed classList and silently ignores it. */}
      <div class={`row assistant${props.row.streaming ? " streaming" : ""}`} data-row="assistant">
        <div class="markdown" innerHTML={html()} />
        <Show when={props.row.streaming}>
          <span class="cursor" />
        </Show>
      </div>
    </Show>
  )
}

function ToolRow(props: { row: Extract<TimelineRow, { kind: "tool" }> }) {
  return (
    <div class={`row tool tool-${props.row.status}`} data-row="tool">
      <span class="tool-status" />
      <span class="tool-name">{props.row.name}</span>
      <Show when={props.row.summary}>
        <span class="tool-summary">{props.row.summary}</span>
      </Show>
      <Show when={props.row.error}>
        <span class="tool-error">{props.row.error}</span>
      </Show>
    </div>
  )
}

