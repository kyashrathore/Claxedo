import type { I18nApi } from "@claxedo/plugin-api"
import { CARD_WORDS } from "./words/card-words"
import { COMMON_WORDS } from "./words/common-words"
import { PAGE_WORDS } from "./words/page-words"
import { PRESET_WORDS } from "./words/preset-words"

const en = { ...CARD_WORDS, ...COMMON_WORDS, ...PAGE_WORDS, ...PRESET_WORDS }

export type TasksKey = keyof typeof en

export type Translate = (key: TasksKey, params?: Readonly<Record<string, string | number>>) => string

export const dictionary: { readonly en: Readonly<Record<TasksKey, string>> } = { en }

export function translator(i18n: I18nApi): Translate {
  return (key, params) => i18n.t(key, params)
}
