import { createResource, Show, type Component, type JSX } from "solid-js"
import { lazyView } from "@/lib/lazy-view"
import type { Translations } from "./dictionary"
import { useI18n } from "./provider"

export type TranslationsLoad = () => Promise<readonly Translations[]>

export function WithTranslations(props: { readonly load: TranslationsLoad; readonly children: JSX.Element }): JSX.Element {
  const i18n = useI18n()
  const [included] = createResource(async () => {
    await i18n.include(await props.load())
    return true
  })
  return <Show when={included()}>{props.children}</Show>
}

export function useTranslatedLazyView<Props extends Record<string, unknown>>(load: () => Promise<Component<Props>>, translations: TranslationsLoad): Component<Props> {
  const i18n = useI18n()
  return lazyView(async () => {
    const [view, domains] = await Promise.all([load(), translations()])
    await i18n.include(domains)
    return view
  })
}
