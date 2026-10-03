import { For, Show, createMemo, createSignal, createUniqueId, onMount, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { reviewDictionary, type ReviewKey } from "../i18n"
import { shortRef, type ReviewMode } from "../intent"

type CompareGroupId = "default" | "branches" | "remote" | "tags" | "commits"

export type CompareOption =
  | { readonly kind: "mode"; readonly mode: ReviewMode; readonly label: string }
  | { readonly kind: "ref"; readonly ref: string; readonly group: Exclude<CompareGroupId, "commits"> }
  | { readonly kind: "commit"; readonly ref: string; readonly subject: string }

const COMPARE_GROUP_LABEL: Readonly<Record<CompareGroupId, ReviewKey>> = {
  default: "review.compare.group.default",
  branches: "review.compare.group.branches",
  remote: "review.compare.group.remote",
  tags: "review.compare.group.tags",
  commits: "review.compare.group.commits",
}

function optionMatchesQuery(option: CompareOption, query: string): boolean {
  if (option.kind === "mode" || query.length === 0) return true
  if (option.ref.toLowerCase().includes(query)) return true
  return option.kind === "commit" && option.subject.toLowerCase().includes(query)
}

function optionGroup(option: CompareOption): CompareGroupId | undefined {
  if (option.kind === "mode") return undefined
  return option.kind === "commit" ? "commits" : option.group
}

export function CompareList(props: {
  readonly testId: string
  readonly label: string
  readonly header: JSX.Element
  readonly options: readonly CompareOption[]
  readonly onSelect: (option: CompareOption) => void
}): JSX.Element {
  const t = useTranslator(reviewDictionary)
  const listId = createUniqueId()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const normalizedQuery = () => query().trim().toLowerCase()
  const visible = createMemo(() => props.options.filter((option) => optionMatchesQuery(option, normalizedQuery())))
  const activeOption = () => visible()[Math.min(active(), visible().length - 1)]
  const optionId = (index: number) => `${listId}-option-${index}`
  const noMatches = () => normalizedQuery().length > 0 && visible().every((option) => option.kind === "mode")
  let input: HTMLInputElement | undefined
  onMount(() => input?.focus())

  const move = (delta: number) => {
    const count = visible().length
    if (count === 0) return
    setActive((current) => (Math.min(current, count - 1) + delta + count) % count)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") move(1)
    else if (event.key === "ArrowUp") move(-1)
    else if (event.key === "Home") setActive(0)
    else if (event.key === "End") setActive(Math.max(visible().length - 1, 0))
    else if (event.key === "Enter") {
      const option = activeOption()
      if (option) props.onSelect(option)
    } else return
    event.preventDefault()
  }

  return (
    <div data-testid={props.testId} class="flex max-h-96 w-[280px] flex-col">
      <input
        ref={input}
        data-testid="review-compare-search"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={activeOption() ? optionId(visible().indexOf(activeOption())) : undefined}
        autocomplete="off"
        spellcheck={false}
        placeholder={t("review.compare.search")}
        class="mx-1.5 mt-1.5 h-7 shrink-0 rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base outline-none placeholder:text-text-weaker focus:border-border-base"
        value={query()}
        onInput={(event) => {
          setQuery(event.currentTarget.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
      />
      <div class="flex min-w-0 items-center gap-2 px-3 pt-2.5 pb-0.5 text-11-regular text-text-base">
        {props.header}
      </div>
      <div id={listId} role="listbox" aria-label={props.label} class="min-h-0 overflow-y-auto p-1 pt-0">
        <For each={visible()}>
          {(option, index) => {
            const group = optionGroup(option)
            const first = () => {
              const previous = visible()[index() - 1]
              return !!group && (!previous || optionGroup(previous) !== group)
            }
            return (
              <>
                <Show when={first() && group}>
                  {(heading) => (
                    <div class="px-2 pt-2 pb-1 text-11-regular text-text-weaker">
                      {t(COMPARE_GROUP_LABEL[heading()])}
                    </div>
                  )}
                </Show>
                <div
                  id={optionId(index())}
                  role="option"
                  aria-selected={activeOption() === option}
                  data-testid={option.kind === "mode" ? `review-compare-${option.mode}` : undefined}
                  data-ref={option.kind === "mode" ? undefined : option.ref}
                  class="flex h-7 min-w-0 cursor-default items-center gap-2 rounded-md px-2 text-12-regular text-text-base hover:bg-surface-base-hover aria-selected:bg-surface-base-hover"
                  onMouseMove={() => setActive(index())}
                  onClick={() => props.onSelect(option)}
                >
                  <Show when={option.kind === "commit" && option}>
                    {(commit) => (
                      <span class="shrink-0 font-mono text-11-regular text-text-weak">{shortRef(commit().ref)}</span>
                    )}
                  </Show>
                  <span class="min-w-0 flex-1 truncate">
                    {option.kind === "mode" ? option.label : option.kind === "commit" ? option.subject : option.ref}
                  </span>
                </div>
              </>
            )
          }}
        </For>
        <Show when={noMatches()}>
          <div data-testid="review-compare-no-matches" class="px-2 py-2 text-12-regular text-text-weak">
            {t("review.compare.noMatches")}
          </div>
        </Show>
      </div>
    </div>
  )
}
