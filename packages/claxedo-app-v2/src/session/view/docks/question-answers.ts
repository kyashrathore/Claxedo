import { createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { AgentQuestionAnswer, AgentQuestionInfo } from "@claxedo/agent-runtime-contract"
import { clampFocus, focusIndexForTab, isAnswered, mergeCustomAnswer } from "./question-nav"

export type QuestionDraft = {
  tab: number
  answers: AgentQuestionAnswer[]
  custom: string[]
  customOn: boolean[]
  editing: boolean
  focus: number
  collapsed: boolean
}

export function createQuestionAnswers(questions: Accessor<readonly AgentQuestionInfo[]>, focusElement: (index: number) => void) {
  const [draft, setDraft] = createStore<QuestionDraft>({
    tab: 0,
    answers: [],
    custom: [],
    customOn: [],
    editing: false,
    focus: 0,
    collapsed: false,
  })
  const total = createMemo(() => questions().length)
  const question = createMemo(() => questions()[draft.tab])
  const options = createMemo(() => question()?.options ?? [])
  const multi = createMemo(() => question()?.multiple === true)
  const count = createMemo(() => options().length + 1)
  const input = () => draft.custom[draft.tab] ?? ""
  const customOn = () => draft.customOn[draft.tab] === true

  const pickFocus = (tab = draft.tab) =>
    focusIndexForTab({ options: questions()[tab]?.options ?? [], answers: draft.answers[tab], customOn: draft.customOn[tab] })

  const focus = (index: number) => {
    const next = clampFocus(index, count())
    setDraft("focus", next)
    if (!draft.editing && !draft.collapsed) focusElement(next)
  }

  const customUpdate = (value: string, selected = customOn()) => {
    const previous = input()
    setDraft("custom", draft.tab, value)
    if (!selected) return
    setDraft("answers", draft.tab, (current = []) => mergeCustomAnswer({ multi: multi(), current, previous, next: value }))
  }

  const goTo = (tab: number) => {
    setDraft({ tab, editing: false })
    focus(pickFocus(tab))
  }

  const pick = (label: string) => {
    setDraft("answers", draft.tab, [label])
    setDraft("customOn", draft.tab, false)
    setDraft("editing", false)
  }

  const toggle = (label: string) => {
    setDraft("editing", false)
    setDraft("answers", draft.tab, (current = []) =>
      current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
    )
  }

  const customOpen = () => {
    setDraft("focus", options().length)
    if (!customOn()) setDraft("customOn", draft.tab, true)
    setDraft("editing", true)
    customUpdate(input(), true)
  }

  const customToggle = () => {
    setDraft("focus", options().length)
    if (!multi() || !customOn()) return customOpen()
    setDraft("customOn", draft.tab, false)
    const value = input().trim()
    if (value) setDraft("answers", draft.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setDraft("editing", false)
    focus(options().length)
  }

  const commitCustom = () => {
    setDraft("editing", false)
    customUpdate(input())
    focus(options().length)
  }

  const select = (index: number) => {
    if (index === options().length) return customOpen()
    const option = options()[index]
    if (!option) return
    if (multi()) return toggle(option.label)
    pick(option.label)
  }

  const next = (): "submit" | "moved" => {
    if (draft.editing) commitCustom()
    if (draft.tab >= total() - 1) return "submit"
    goTo(draft.tab + 1)
    return "moved"
  }

  const collapse = () => {
    const collapsed = !draft.collapsed
    setDraft("collapsed", collapsed)
    if (collapsed) return setDraft("editing", false)
    focus(pickFocus())
  }

  return {
    draft,
    total,
    question,
    options,
    multi,
    count,
    input,
    customOn,
    last: () => draft.tab >= total() - 1,
    answers: () => questions().map((_, index) => draft.answers[index] ?? []),
    answered: (index: number) =>
      isAnswered({ answers: draft.answers[index], customOn: draft.customOn[index], custom: draft.custom[index] }),
    picked: (label: string) => draft.answers[draft.tab]?.includes(label) ?? false,
    focus,
    select,
    customOpen,
    customToggle,
    customUpdate,
    commitCustom,
    next,
    back: () => {
      if (draft.tab > 0) goTo(draft.tab - 1)
    },
    goTo,
    collapse,
    setFocus: (index: number) => setDraft("focus", index),
    stopEditing: () => setDraft("editing", false),
    initialFocus: () => focus(pickFocus()),
    move: (step: number) => {
      if (!draft.editing) focus(draft.focus + step)
    },
  }
}

export type QuestionAnswers = ReturnType<typeof createQuestionAnswers>
