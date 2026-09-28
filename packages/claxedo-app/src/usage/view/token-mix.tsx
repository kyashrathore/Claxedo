import { createMemo, createUniqueId, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { usageDictionary, type UsageKey } from "../i18n"
import type { UsageTotals } from "../model"
import { tokenComposition, type TokenCategory, type TokenShare } from "../token-composition"
import { useUsageFormats } from "./usage-formats"

const CATEGORY_KEY: Readonly<Record<TokenCategory, UsageKey>> = {
  cacheRead: "usage.tokens.cacheRead",
  cacheWrite: "usage.tokens.cacheWrite",
  input: "usage.tokens.input",
  output: "usage.tokens.output",
  reasoning: "usage.tokens.reasoning",
}

function MixGroup(props: { readonly title: string; readonly parts: readonly TokenShare[]; readonly children?: JSX.Element }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  return (
    <div class="usage-mix-group">
      <h4 class="usage-mix-title">{props.title}</h4>
      <ul class="usage-mix-rows">
        <For each={props.parts}>
          {(part) => (
            <li class="usage-mix-row">
              <span class="usage-mix-name">{t(CATEGORY_KEY[part.category])}</span>
              <span class="usage-mix-track" aria-hidden="true">
                <i class="usage-mix-bar" data-empty={part.tokens === 0} style={{ width: `${part.share * 100}%` }} />
              </span>
              <span class="usage-mix-value">{format.count(part.tokens)}</span>
              <span class="usage-mix-share">{format.share(part.share)}</span>
            </li>
          )}
        </For>
      </ul>
      {props.children}
    </div>
  )
}

export function TokenMix(props: { readonly totals: UsageTotals }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const titleId = createUniqueId()
  const composition = createMemo(() => tokenComposition(props.totals))
  const incomplete = () => props.totals.unknownCategories > 0 || (props.totals.unavailableTurnCount ?? 0) > 0
  return (
    <section class="usage-mix" aria-labelledby={titleId}>
      <h3 id={titleId} class="usage-group-title">{t("usage.tokens")}</h3>
      <MixGroup title={t("usage.tokens.context")} parts={composition().context}>
        <p class="usage-hint">{t("usage.tokens.cacheExplained")}</p>
      </MixGroup>
      <MixGroup title={t("usage.tokens.generated")} parts={composition().generated} />
      <Show when={incomplete()}>
        <p class="usage-hint">{t("usage.tokens.incomplete")}</p>
      </Show>
    </section>
  )
}
