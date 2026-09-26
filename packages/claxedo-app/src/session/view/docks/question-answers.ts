import { createMemo, type Accessor } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
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

type QuestionContext = {
  readonly questions: Accessor<readonly AgentQuestionInfo[]>
  readonly draft: QuestionDraft
  readonly setDraft: SetStoreFunction<QuestionDraft>
  readonly focusElement: (index: number) => void
  readonly total: Accessor<number>
  readonly question: Accessor<AgentQuestionInfo | undefined>
  readonly options: Accessor<NonNullable<AgentQuestionInfo["options"]>>
  readonly multi: Accessor<boolean>
  readonly count: Accessor<number>
  readonly input: () => string
  readonly customOn: () => boolean
}

function createQuestionContext(questions: Accessor<readonly AgentQuestionInfo[]>, focusElement: (index: number) => void): QuestionContext {
  const [draft, setDraft] = createStore<QuestionDraft>({ tab: 0, answers: [], custom: [], customOn: [], editing: false, focus: 0, collapsed: false })
  const question = createMemo(() => questions()[draft.tab])
  const options = createMemo(() => question()?.options ?? [])
  return {
    questions,
    draft,
    setDraft,
    focusElement,
    total: createMemo(() => questions().length),
    question,
    options,
    multi: createMemo(() => question()?.multiple === true),
    count: createMemo(() => options().length + 1),
    input: () => draft.custom[draft.tab] ?? "",
    customOn: () => draft.customOn[draft.tab] === true,
  }
}

function pickFocus(context: QuestionContext, tab = context.draft.tab): number {
  const { draft } = context
  return focusIndexForTab({ options: context.questions()[tab]?.options ?? [], answers: draft.answers[tab], customOn: draft.customOn[tab] })
}

function focus(context: QuestionContext, index: number): void {
  const next = clampFocus(index, context.count())
  context.setDraft("focus", next)
  if (!context.draft.editing && !context.draft.collapsed) context.focusElement(next)
}

function customUpdate(context: QuestionContext, value: string, selected = context.customOn()): void {
  const { draft, setDraft } = context
  const previous = context.input()
  setDraft("custom", draft.tab, value)
  if (!selected) return
  setDraft("answers", draft.tab, (current = []) => mergeCustomAnswer({ multi: context.multi(), current, previous, next: value }))
}

function goTo(context: QuestionContext, tab: number): void {
  context.setDraft({ tab, editing: false })
  focus(context, pickFocus(context, tab))
}

function customOpen(context: QuestionContext): void {
  const { draft, setDraft } = context
  setDraft("focus", context.options().length)
  if (!context.customOn()) setDraft("customOn", draft.tab, true)
  setDraft("editing", true)
  customUpdate(context, context.input(), true)
}

function customToggle(context: QuestionContext): void {
  const { draft, setDraft } = context
  setDraft("focus", context.options().length)
  if (!context.multi() || !context.customOn()) return customOpen(context)
  setDraft("customOn", draft.tab, false)
  const value = context.input().trim()
  if (value) setDraft("answers", draft.tab, (current = []) => current.filter((item) => item.trim() !== value))
  setDraft("editing", false)
  focus(context, context.options().length)
}

function commitCustom(context: QuestionContext): void {
  context.setDraft("editing", false)
  customUpdate(context, context.input())
  focus(context, context.options().length)
}

function select(context: QuestionContext, index: number): void {
  const { draft, setDraft } = context
  if (index === context.options().length) return customOpen(context)
  const option = context.options()[index]
  if (!option) return
  setDraft("editing", false)
  if (!context.multi()) {
    setDraft("answers", draft.tab, [option.label])
    setDraft("customOn", draft.tab, false)
    return
  }
  setDraft("answers", draft.tab, (current = []) =>
    current.includes(option.label) ? current.filter((item) => item !== option.label) : [...current, option.label],
  )
}

function next(context: QuestionContext): "submit" | "moved" {
  if (context.draft.editing) commitCustom(context)
  if (context.draft.tab >= context.total() - 1) return "submit"
  goTo(context, context.draft.tab + 1)
  return "moved"
}

function collapse(context: QuestionContext): void {
  const collapsed = !context.draft.collapsed
  context.setDraft("collapsed", collapsed)
  if (collapsed) return context.setDraft("editing", false)
  focus(context, pickFocus(context))
}

export function createQuestionAnswers(questions: Accessor<readonly AgentQuestionInfo[]>, focusElement: (index: number) => void) {
  const context = createQuestionContext(questions, focusElement)
  const { draft, setDraft } = context
  return {
    draft,
    total: context.total,
    question: context.question,
    options: context.options,
    multi: context.multi,
    count: context.count,
    input: context.input,
    customOn: context.customOn,
    last: () => draft.tab >= context.total() - 1,
    answers: () => questions().map((_, index) => draft.answers[index] ?? []),
    answered: (index: number) => isAnswered({ answers: draft.answers[index], customOn: draft.customOn[index], custom: draft.custom[index] }),
    picked: (label: string) => draft.answers[draft.tab]?.includes(label) ?? false,
    focus: (index: number) => focus(context, index),
    select: (index: number) => select(context, index),
    customOpen: () => customOpen(context),
    customToggle: () => customToggle(context),
    customUpdate: (value: string, selected?: boolean) => customUpdate(context, value, selected),
    commitCustom: () => commitCustom(context),
    next: () => next(context),
    back: () => (draft.tab > 0 ? goTo(context, draft.tab - 1) : undefined),
    goTo: (tab: number) => goTo(context, tab),
    collapse: () => collapse(context),
    setFocus: (index: number) => setDraft("focus", index),
    stopEditing: () => setDraft("editing", false),
    initialFocus: () => focus(context, pickFocus(context)),
    move: (step: number) => (draft.editing ? undefined : focus(context, draft.focus + step)),
  }
}

export type QuestionAnswers = ReturnType<typeof createQuestionAnswers>
