import { useErrorCopy } from "@/composer"
import { For, Show, createUniqueId, onCleanup, onMount } from "solid-js"
import type { AgentQuestion } from "@claxedo/agent-runtime-contract"
import type { AgentRequestReply } from "@/server"
import { DockPrompt } from "@/transcript"
import { Button, IconButton } from "@/ui"
import { useSessionScreenText } from "../text"
import { createDockAction, type DockAction } from "./dock-action"
import { createQuestionAnswers, type QuestionAnswers } from "./question-answers"
import { classifyQuestionKey } from "./question-nav"
import { QuestionCustomOption, QuestionOption } from "./question-option"
import { createRequestReply } from "./request-reply"

function QuestionHeader(props: { answers: QuestionAnswers; busy: boolean }) {
  const t = useSessionScreenText()
  const draft = () => props.answers.draft
  const summary = () =>
    t("sessionScreen.question.progress", { current: Math.min(draft().tab + 1, props.answers.total()), total: props.answers.total() })
  return (
    <>
      <div data-slot="question-header-title" class="ui-question-header-title">{summary()}</div>
      <Show when={draft().collapsed}>
        <div data-slot="question-header-preview" class="ui-question-header-preview">{props.answers.question()?.question}</div>
      </Show>
      <div data-slot="question-header-actions">
        <Show when={props.answers.total() > 1}>
          <div data-slot="question-progress">
            <For each={[...Array(props.answers.total()).keys()]}>
              {(index) => (
                <button
                  type="button"
                  data-slot="question-progress-segment"
                  data-active={index === draft().tab}
                  data-answered={props.answers.answered(index)}
                  disabled={props.busy}
                  onClick={() => props.answers.goTo(index)}
                  aria-label={`${t("sessionScreen.question.questions")} ${index + 1}`}
                />
              )}
            </For>
          </div>
        </Show>
        <IconButton
          data-slot="question-collapse"
          icon="chevron-down"
          size="normal"
          variant="ghost"
          style={{ transform: `rotate(${draft().collapsed ? 180 : 0}deg)` }}
          aria-expanded={!draft().collapsed}
          aria-label={t(draft().collapsed ? "sessionScreen.question.expand" : "sessionScreen.question.collapse")}
          onClick={() => props.answers.collapse()}
        />
      </div>
    </>
  )
}

function QuestionFooter(props: {
  answers: QuestionAnswers
  busy: boolean
  stop: DockAction<"stop">
  onStop?: () => Promise<void>
  onDismiss: VoidFunction
  onNext: VoidFunction
}) {
  const t = useSessionScreenText()
  return (
    <>
      <div data-slot="question-footer-actions">
        <Show when={props.onStop}>
          {(work) => (
            <Button variant="ghost" size="large" disabled={props.busy} onClick={() => void props.stop.run("stop", work())}>
              {t("sessionScreen.action.stop")}
            </Button>
          )}
        </Show>
        <Button variant="ghost" size="large" disabled={props.busy} onClick={props.onDismiss} aria-keyshortcuts="Escape">
          {t("sessionScreen.action.dismiss")}
        </Button>
      </div>
      <div data-slot="question-footer-actions">
        <Show when={props.answers.draft.tab > 0}>
          <Button variant="neutral" size="large" disabled={props.busy} onClick={() => props.answers.back()}>
            {t("sessionScreen.action.back")}
          </Button>
        </Show>
        <Button
          variant={props.answers.last() ? "contrast" : "neutral"}
          size="large"
          disabled={props.busy}
          onClick={props.onNext}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        >
          {t(props.answers.last() ? "sessionScreen.action.submit" : "sessionScreen.action.next")}
        </Button>
      </div>
    </>
  )
}

export function QuestionDock(props: {
  request: AgentQuestion
  onReply: (reply: AgentRequestReply) => Promise<void>
  onStop?: () => Promise<void>
}) {
  const t = useSessionScreenText()
  const errorCopy = useErrorCopy()
  const textId = createUniqueId()
  const reply = createRequestReply(props.onReply)
  const stop = createDockAction<"stop">()
  let customRef: HTMLButtonElement | undefined
  const optionRefs: HTMLButtonElement[] = []
  let frame: number | undefined
  const focusElement = (index: number) => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = undefined
      const target = index === answers.options().length ? customRef : optionRefs[index]
      target?.focus()
    })
  }
  const answers = createQuestionAnswers(() => props.request.questions, focusElement)
  onMount(() => answers.initialFocus())
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  const busy = () => reply.answering() || stop.running()
  const dismiss = () => void reply.reply({ kind: "dismiss" })
  const next = () => {
    if (busy()) return
    if (answers.next() === "submit") void reply.reply({ kind: "question", answers: answers.answers() })
  }
  const keyDown = (event: KeyboardEvent) => {
    if (answers.draft.collapsed) return
    const inOptions = event.target instanceof HTMLElement && !!event.target.closest('[data-slot="question-options"]')
    const action = classifyQuestionKey(event, { editing: answers.draft.editing, inOptions, count: answers.count() })
    if (action.type === "none") return
    event.preventDefault()
    if (action.type === "reject") return dismiss()
    if (action.type === "next") return next()
    if (action.type === "move") return answers.move(action.step)
    answers.focus(action.index)
  }
  return (
    <DockPrompt
      kind="question"
      onKeyDown={keyDown}
      collapsed={answers.draft.collapsed}
      header={<QuestionHeader answers={answers} busy={busy()} />}
      footer={<QuestionFooter answers={answers} busy={busy()} stop={stop} onStop={props.onStop} onDismiss={dismiss} onNext={next} />}
    >
      <Show when={reply.error() ?? stop.error()}>{(error) => <div role="alert" data-slot="question-error" data-error-class={error().class} title={error().message}>{errorCopy(error())}</div>}</Show>
      <div id={textId} data-slot="question-text" class="ui-question-text">{answers.question()?.question}</div>
      <div data-slot="question-hint">{t(answers.multi() ? "sessionScreen.question.multiHint" : "sessionScreen.question.singleHint")}</div>
      <div data-slot="question-options" role={answers.multi() ? "group" : "radiogroup"} aria-labelledby={textId}>
        <For each={answers.options()}>
          {(option, index) => (
            <QuestionOption
              multi={answers.multi()}
              picked={answers.picked(option.label)}
              label={option.label}
              description={option.description}
              disabled={busy()}
              focused={answers.draft.focus === index()}
              ref={(el) => (optionRefs[index()] = el)}
              onFocus={() => answers.setFocus(index())}
              onClick={() => {
                if (!busy()) answers.select(index())
              }}
            />
          )}
        </For>
        <QuestionCustomOption
          multi={answers.multi()}
          picked={answers.customOn()}
          editing={answers.draft.editing}
          focused={answers.draft.focus === answers.options().length}
          disabled={busy()}
          label={t("sessionScreen.question.ownAnswer")}
          placeholder={t("sessionScreen.question.customPlaceholder")}
          value={answers.input()}
          ref={(el) => (customRef = el)}
          onFocus={() => answers.setFocus(answers.options().length)}
          onOpen={() => {
            if (!busy()) answers.customOpen()
          }}
          onToggleMark={() => {
            if (!busy()) answers.customToggle()
          }}
          onInput={(value) => answers.customUpdate(value)}
          onCommit={() => answers.commitCustom()}
          onCancel={() => {
            answers.stopEditing()
            answers.focus(answers.options().length)
          }}
        />
      </div>
    </DockPrompt>
  )
}
