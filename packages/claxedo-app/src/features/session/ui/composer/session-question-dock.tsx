import { For, Show, createMemo, createUniqueId, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@/ui/session-kit"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import type {
  AgentQuestion as QuestionRequest,
  AgentQuestionAnswer as QuestionAnswer,
} from "@claxedo/agent-runtime-contract"
import { useLanguage } from "@/platform/i18n/provider"
import { useSDK } from "@/features/session/app-ports"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { dispatchSessionRequestsEvent } from "@/features/session/store/session-status-dispatcher"
import { Persist, persisted, removePersisted } from "@/platform/persistence/persist"
import {
  clampFocus,
  classifyQuestionKey,
  focusIndexForTab,
  isAnswered,
  mergeCustomAnswer,
  questionPromptMaxHeight,
} from "./session-question-dock-nav"

function Mark(props: { multi: boolean; picked: boolean; onClick?: (event: MouseEvent) => void }) {
  return (
    <span data-slot="question-option-check" aria-hidden="true" onClick={props.onClick}>
      <span data-slot="question-option-box" class="ui-question-option-box" data-type={props.multi ? "checkbox" : "radio"} data-picked={props.picked}>
        <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" class="ui-question-option-radio-dot" />}>
          <Icon name="check-small" size="small" />
        </Show>
      </span>
    </span>
  )
}

function Option(props: {
  multi: boolean
  picked: boolean
  label: string
  description?: string
  disabled: boolean
  focused: boolean
  ref?: (el: HTMLButtonElement) => void
  onFocus?: VoidFunction
  onClick: VoidFunction
}) {
  return (
    <button
      type="button"
      ref={props.ref}
      data-slot="question-option"
      data-picked={props.picked}
      role={props.multi ? "checkbox" : "radio"}
      aria-checked={props.picked}
      // Roving tabindex: only the focused option is in the Tab order; arrow keys
      // move focus within the group (see `nav`/`move`). One Tab stop for the
      // whole radiogroup/group, matching the WAI-ARIA radio-group pattern.
      tabindex={props.focused ? 0 : -1}
      disabled={props.disabled}
      onFocus={props.onFocus}
      onClick={props.onClick}
    >
      <Mark multi={props.multi} picked={props.picked} />
      <span data-slot="question-option-main">
        <span data-slot="option-label">{props.label}</span>
        <Show when={props.description}>
          <span data-slot="option-description">{props.description}</span>
        </Show>
      </span>
    </button>
  )
}

export const SessionQuestionDock: Component<{
  request: QuestionRequest
  onSubmit: () => void
  onStop?: () => Promise<unknown>
}> = (props) => {
  const sdk = useSDK()
  const language = useLanguage()
  const questionTextId = createUniqueId()

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const draftTarget = Persist.serverSession(sdk.url, sdk.directory, props.request.sessionID, `question:${props.request.id}`)
  const [store, setStore, , draftReady] = persisted(draftTarget, createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    customOn: [] as boolean[],
  }))
  const [ui, setUI] = createStore({ editing: false, focus: 0, collapsed: false })

  let root: HTMLDivElement | undefined
  let customRef: HTMLButtonElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let focusFrame: number | undefined

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const on = createMemo(() =>  store.customOn[store.tab])
  const multi = createMemo(() => question()?.multiple === true)
  const count = createMemo(() => options().length + 1)

  const summary = createMemo(() => {
    const n = Math.min(store.tab + 1, total())
    return language.t("session.question.progress", { current: n, total: total() })
  })

  const customLabel = () => language.t("ui.messagePart.option.typeOwnAnswer")
  const customPlaceholder = () => language.t("ui.question.custom.placeholder")

  const last = createMemo(() => store.tab >= total() - 1)

  const customUpdate = (value: string, selected: boolean = on()) => {
    const previous = input()

    setStore("custom", store.tab, value)
    if (!selected) return

    setStore("answers", store.tab, (current = []) =>
      mergeCustomAnswer({ multi: multi(), current, previous, next: value }),
    )
  }

  const measure = () => {
    if (!root) return

    const scroller = document.querySelector(".scroll-view__viewport")
    const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
    const top =
      head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0

    const dock = root.closest('[data-component="session-prompt-dock"]')
    if (!(dock instanceof HTMLElement)) return
    // Present only while the pane floats its session (session-presentation.css).
    const floatingArea = root.closest(".session-floating-root")

    const max = questionPromptMaxHeight({
      stickyHeadBottom: top,
      dock: dock.getBoundingClientRect(),
      root: root.getBoundingClientRect(),
      floatingArea: floatingArea?.getBoundingClientRect(),
    })
    if (max === undefined) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }
    root.style.setProperty("--question-prompt-max-height", `${max}px`)
  }

  const clamp = (i: number) => clampFocus(i, count())

  const pickFocus = (tab: number = store.tab) =>
    focusIndexForTab({
      options: questions()[tab]?.options ?? [],
      answers: store.answers[tab],
      customOn: store.customOn[tab],
    })

  const focus = (i: number) => {
    const next = clamp(i)
    setUI("focus", next)
    if (ui.editing || ui.collapsed) return
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      const el = next === options().length ? customRef : optsRef[next]
      el?.focus()
    })
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
      })
    }

    update()

    makeEventListener(window, "resize", update)

    const dock = root?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })

    focus(pickFocus())
  })

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
  })

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message, variant: "error" })
  }

  const clearQuestionRequest = () => {
    dispatchSessionRequestsEvent({
      event: {
        type: "session.requests",
        source: "optimistic",
        sessionID: props.request.sessionID,
        requests: (previous) => ({
          permissions: previous?.permissions ?? [],
          questions: (previous?.questions ?? []).filter((item) => item.id !== props.request.id),
        }),
      },
    })
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (answers: QuestionAnswer[]) => sdk.client.question.reply({ requestID: props.request.id, answers }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      void removePersisted(draftTarget)
      clearQuestionRequest()
    },
    onError: fail,
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () => sdk.client.question.reject({ requestID: props.request.id }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      void removePersisted(draftTarget)
      clearQuestionRequest()
    },
    onError: fail,
  }))

  const stopMutation = useMutation(() => ({
    mutationFn: () => props.onStop!(),
    onSuccess: () => {
      void removePersisted(draftTarget)
    },
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending || stopMutation.isPending)

  const stop = () => {
    if (!props.onStop || sending()) return
    stopMutation.mutate()
  }

  const reply = (answers: QuestionAnswer[]) => {
    if (sending()) return
    replyMutation.mutate(answers)
  }

  const reject = () => {
    if (sending()) return
    rejectMutation.mutate()
  }

  const submit = () => void reply(questions().map((_, i) => store.answers[i] ?? []))

  const answered = (i: number) =>
    isAnswered({ answers: store.answers[i], customOn: store.customOn[i], custom: store.custom[i] })

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setUI("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  const customToggle = () => {
    if (sending()) return
    setUI("focus", options().length)

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setUI("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setUI("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setUI("editing", false)
    focus(options().length)
  }

  const customOpen = () => {
    if (sending()) return
    setUI("focus", options().length)
    if (!on()) setStore("customOn", store.tab, true)
    setUI("editing", true)
    customUpdate(input(), true)
  }

  const move = (step: number) => {
    if (ui.editing || sending()) return
    focus(ui.focus + step)
  }

  const nav = (event: KeyboardEvent) => {
    if (ui.collapsed) return
    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    const action = classifyQuestionKey(event, {
      editing: ui.editing,
      inOptions: target instanceof HTMLElement,
      count: count(),
    })

    switch (action.type) {
      case "reject":
        event.preventDefault()
        void reject()
        return
      case "next":
        event.preventDefault()
        next()
        return
      case "move":
        event.preventDefault()
        move(action.step)
        return
      case "focus":
        event.preventDefault()
        focus(action.index)
        return
      default:
        return
    }
  }

  const selectOption = (optIndex: number) => {
    if (sending()) return

    if (optIndex === options().length) {
      customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setUI("editing", false)
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const commitCustom = () => {
    setUI("editing", false)
    customUpdate(input())
    focus(options().length)
  }

  const resizeInput = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }

  const focusCustom = (el: HTMLTextAreaElement) => {
    setTimeout(() => {
      el.focus()
      resizeInput(el)
    }, 0)
  }

  const toggleCustomMark = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    customToggle()
  }

  const next = () => {
    if (sending()) return
    if (ui.editing) commitCustom()

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setUI("editing", false)
    focus(pickFocus(tab))
  }

  const back = () => {
    if (sending()) return
    if (store.tab <= 0) return
    const tab = store.tab - 1
    setStore("tab", tab)
    setUI("editing", false)
    focus(pickFocus(tab))
  }

  const collapse = () => {
    const next = !ui.collapsed
    setUI("collapsed", next)
    if (next) {
      setUI("editing", false)
      return
    }
    focus(pickFocus())
  }

  const jump = (tab: number) => {
    if (sending()) return
    setStore("tab", tab)
    setUI("editing", false)
    focus(pickFocus(tab))
  }

  return (
    <Show when={draftReady()}>
    <DockPrompt
      kind="question"
      ref={(el) => (root = el)}
      onKeyDown={nav}
      collapsed={ui.collapsed}
      header={
        <>
          <div data-slot="question-header-title" class="ui-question-header-title">{summary()}</div>
          <Show when={ui.collapsed}>
            <div data-slot="question-header-preview" class="ui-question-header-preview">{question()?.question}</div>
          </Show>
          <div data-slot="question-header-actions">
            {/* One question has nothing to navigate between, and a lone 16x2px
                segment reads as a window control rather than progress. */}
            <Show when={total() > 1}>
              <div data-slot="question-progress">
                <For each={questions()}>
                  {(_, i) => (
                    <button
                      type="button"
                      data-slot="question-progress-segment"
                      data-active={i() === store.tab}
                      data-answered={answered(i())}
                      disabled={sending()}
                      onClick={() => jump(i())}
                      aria-label={`${language.t("ui.tool.questions")} ${i() + 1}`}
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
              style={{ transform: `rotate(${ui.collapsed ? 180 : 0}deg)` }}
              aria-expanded={!ui.collapsed}
              aria-label={language.t(ui.collapsed ? "session.question.expand" : "session.question.collapse")}
              onClick={collapse}
            />
          </div>
        </>
      }
      footer={
        <>
          <div data-slot="question-footer-actions">
            <Show when={props.onStop}>
              <Button variant="ghost" size="large" disabled={sending()} onClick={stop}>
                {language.t("prompt.action.stop")}
              </Button>
            </Show>
            <Button variant="ghost" size="large" disabled={sending()} onClick={reject} aria-keyshortcuts="Escape">
              {language.t("ui.common.dismiss")}
            </Button>
          </div>
          <div data-slot="question-footer-actions">
            <Show when={store.tab > 0}>
              <Button variant="secondary" size="large" disabled={sending()} onClick={back}>
                {language.t("ui.common.back")}
              </Button>
            </Show>
            <Button
              variant={last() ? "primary" : "secondary"}
              size="large"
              disabled={sending()}
              onClick={next}
              aria-keyshortcuts="Meta+Enter Control+Enter"
            >
              {last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
            </Button>
          </div>
        </>
      }
    >
      <div id={questionTextId} data-slot="question-text" class="ui-question-text overflow-auto">
        {question()?.question}
      </div>
      <Show when={multi()} fallback={<div data-slot="question-hint">{language.t("ui.question.singleHint")}</div>}>
        <div data-slot="question-hint">{language.t("ui.question.multiHint")}</div>
      </Show>
      {/* Group the option controls and name them with the question so AT
          announces "<question>, radio group" (single) / group (multi) instead
          of a bare list of radios/checkboxes. */}
      <div
        data-slot="question-options"
        role={multi() ? "group" : "radiogroup"}
        aria-labelledby={questionTextId}
      >
        <For each={options()}>
          {(opt, i) => (
            <Option
              multi={multi()}
              picked={picked(opt.label)}
              label={opt.label}
              description={opt.description}
              disabled={sending()}
              focused={ui.focus === i()}
              ref={(el) => (optsRef[i()] = el)}
              onFocus={() => setUI("focus", i())}
              onClick={() => selectOption(i())}
            />
          )}
        </For>

        <Show
          when={ui.editing}
          fallback={
            <button
              type="button"
              ref={customRef}
              data-slot="question-option"
              data-custom="true"
              data-picked={on()}
              role={multi() ? "checkbox" : "radio"}
              aria-checked={on()}
              tabindex={ui.focus === options().length ? 0 : -1}
              disabled={sending()}
              onFocus={() => setUI("focus", options().length)}
              onClick={customOpen}
            >
              <Mark multi={multi()} picked={on()} onClick={toggleCustomMark} />
              <span data-slot="question-option-main">
                <span data-slot="option-label">{customLabel()}</span>
                <span data-slot="option-description">{input() || customPlaceholder()}</span>
              </span>
            </button>
          }
        >
          <form
            data-slot="question-option"
            data-custom="true"
            data-picked={on()}
            role={multi() ? "checkbox" : "radio"}
            aria-checked={on()}
            onMouseDown={(e) => {
              if (sending()) {
                e.preventDefault()
                return
              }
              if (e.target instanceof HTMLTextAreaElement) return
              const input = e.currentTarget.querySelector('[data-slot="question-custom-input"]')
              if (input instanceof HTMLTextAreaElement) input.focus()
            }}
            onSubmit={(e) => {
              e.preventDefault()
              commitCustom()
            }}
          >
            <Mark multi={multi()} picked={on()} onClick={toggleCustomMark} />
            <span data-slot="question-option-main">
              <span data-slot="option-label">{customLabel()}</span>
              <textarea
                ref={focusCustom}
                data-slot="question-custom-input" class="ui-question-custom-input"
                placeholder={customPlaceholder()}
                value={input()}
                rows={1}
                disabled={sending()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault()
                    setUI("editing", false)
                    focus(options().length)
                    return
                  }
                  if ((e.metaKey || e.ctrlKey) && !e.altKey) return
                  if (e.key !== "Enter" || e.shiftKey) return
                  e.preventDefault()
                  commitCustom()
                }}
                onInput={(e) => {
                  customUpdate(e.currentTarget.value)
                  resizeInput(e.currentTarget)
                }}
              />
            </span>
          </form>
        </Show>
      </div>
    </DockPrompt>
    </Show>
  )
}
