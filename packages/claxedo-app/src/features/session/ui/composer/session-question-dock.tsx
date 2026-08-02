import { For, Show, createMemo, createUniqueId, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@/ui/session-kit"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { showToast } from "@opencode-ai/ui/toast"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/platform/i18n/provider"
import { useSDK } from "@/features/session/app-ports"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { dispatchSessionRequestsEvent } from "@/features/session/store/session-status-dispatcher"
import {
  clearSessionQuestionDockSnapshot,
  sessionQuestionDockSnapshot,
  setSessionQuestionDockSnapshot,
} from "./session-question-cache"
import {
  clampFocus,
  classifyQuestionKey,
  focusIndexForTab,
  isAnswered,
  mergeCustomAnswer,
} from "./session-question-dock-nav"

function Mark(props: { multi: boolean; picked: boolean; onClick?: (event: MouseEvent) => void }) {
  return (
    <span data-slot="question-option-check" aria-hidden="true" onClick={props.onClick}>
      <span data-slot="question-option-box" data-type={props.multi ? "checkbox" : "radio"} data-picked={props.picked}>
        <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" />}>
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

export const SessionQuestionDock: Component<{ request: QuestionRequest; onSubmit: () => void }> = (props) => {
  const sdk = useSDK()
  const language = useLanguage()
  const questionTextId = createUniqueId()

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const cached = sessionQuestionDockSnapshot(props.request.id)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as QuestionAnswer[]),
    custom: cached?.custom ?? ([] as string[]),
    customOn: cached?.customOn ?? ([] as boolean[]),
    editing: false,
    focus: 0,
  })

  let root: HTMLDivElement | undefined
  let customRef: HTMLButtonElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let replied = false
  let focusFrame: number | undefined

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const on = createMemo(() => store.customOn[store.tab] === true)
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
    if (!top) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }

    const dock = root.closest('[data-component="session-prompt-dock"]')
    if (!(dock instanceof HTMLElement)) return

    const dockBottom = dock.getBoundingClientRect().bottom
    const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
    const gap = 8
    const max = Math.max(240, Math.floor(dockBottom - top - gap - below))
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
    setStore("focus", next)
    if (store.editing) return
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
    if (replied) return
    setSessionQuestionDockSnapshot(props.request.id, {
      tab: store.tab,
      answers: store.answers.map((a) => (a ? [...a] : [])),
      custom: store.custom.map((s) => s ?? ""),
      customOn: store.customOn.map((b) => b ?? false),
    })
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
      replied = true
      clearSessionQuestionDockSnapshot(props.request.id)
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
      replied = true
      clearSessionQuestionDockSnapshot(props.request.id)
      clearQuestionRequest()
    },
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const reply = async (answers: QuestionAnswer[]) => {
    if (sending()) return
    await replyMutation.mutateAsync(answers)
  }

  const reject = async () => {
    if (sending()) return
    await rejectMutation.mutateAsync()
  }

  const submit = () => void reply(questions().map((_, i) => store.answers[i] ?? []))

  const answered = (i: number) =>
    isAnswered({ answers: store.answers[i], customOn: store.customOn[i], custom: store.custom[i] })

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  const customToggle = () => {
    if (sending()) return
    setStore("focus", options().length)

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setStore("editing", false)
    focus(options().length)
  }

  const customOpen = () => {
    if (sending()) return
    setStore("focus", options().length)
    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const move = (step: number) => {
    if (store.editing || sending()) return
    focus(store.focus + step)
  }

  const nav = (event: KeyboardEvent) => {
    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    const action = classifyQuestionKey(event, {
      editing: store.editing,
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
      setStore("editing", false)
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const commitCustom = () => {
    setStore("editing", false)
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
    if (store.editing) commitCustom()

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const back = () => {
    if (sending()) return
    if (store.tab <= 0) return
    const tab = store.tab - 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const jump = (tab: number) => {
    if (sending()) return
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  return (
    <DockPrompt
      kind="question"
      ref={(el) => (root = el)}
      onKeyDown={nav}
      header={
        <>
          <div data-slot="question-header-title">{summary()}</div>
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
        </>
      }
      footer={
        <>
          <Button variant="ghost" size="large" disabled={sending()} onClick={reject} aria-keyshortcuts="Escape">
            {language.t("ui.common.dismiss")}
          </Button>
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
      <div id={questionTextId} data-slot="question-text" class="overflow-auto">
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
              focused={store.focus === i()}
              ref={(el) => (optsRef[i()] = el)}
              onFocus={() => setStore("focus", i())}
              onClick={() => selectOption(i())}
            />
          )}
        </For>

        <Show
          when={store.editing}
          fallback={
            <button
              type="button"
              ref={customRef}
              data-slot="question-option"
              data-custom="true"
              data-picked={on()}
              role={multi() ? "checkbox" : "radio"}
              aria-checked={on()}
              tabindex={store.focus === options().length ? 0 : -1}
              disabled={sending()}
              onFocus={() => setStore("focus", options().length)}
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
                data-slot="question-custom-input"
                placeholder={customPlaceholder()}
                value={input()}
                rows={1}
                disabled={sending()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault()
                    setStore("editing", false)
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
  )
}
