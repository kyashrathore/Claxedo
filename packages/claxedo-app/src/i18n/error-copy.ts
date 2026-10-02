import type { AppError, ErrorClass } from "@/server"
import type { Translations } from "./dictionary"
import type { Locale } from "./locales"
import type { ErrorMessages } from "./errors/model"
import ar from "./errors/ar"
import br from "./errors/br"
import bs from "./errors/bs"
import da from "./errors/da"
import de from "./errors/de"
import en from "./errors/en"
import es from "./errors/es"
import fr from "./errors/fr"
import ja from "./errors/ja"
import ko from "./errors/ko"
import no from "./errors/no"
import pl from "./errors/pl"
import ru from "./errors/ru"
import th from "./errors/th"
import tr from "./errors/tr"
import zh from "./errors/zh"
import zht from "./errors/zht"
import { useTranslator } from "./provider"

export type ErrorCopy = { readonly title: string; readonly message: string; readonly retry: string }

type ErrorKey = `i18n.error.${ErrorClass}.${"title" | "message"}` | "i18n.error.signIn" | "i18n.error.retry" | "i18n.error.reload"

function errorTranslations(messages: ErrorMessages): Record<ErrorKey, string> {
  const { signIn, retry, reload, ...classes } = messages
  return Object.fromEntries([
    ["i18n.error.signIn", signIn], ["i18n.error.retry", retry], ["i18n.error.reload", reload],
    ...Object.entries(classes).flatMap(([kind, [title, message]]) => [[`i18n.error.${kind}.title`, title], [`i18n.error.${kind}.message`, message]]),
  ]) as Record<ErrorKey, string>
}

const messages = { en, ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht } satisfies Record<Locale, ErrorMessages>
export const errorDictionary = Object.fromEntries(Object.entries(messages).map(([locale, copy]) => [locale, errorTranslations(copy)])) as Translations<ErrorKey>

export function useErrorCopy(): (error: AppError) => ErrorCopy {
  const t = useTranslator(errorDictionary)
  return (error) => ({
    title: t(`i18n.error.${error.class}.title`),
    message: t(`i18n.error.${error.class}.message`),
    retry: t(error.class === "auth" ? "i18n.error.signIn" : error.class === "not_found" || error.class === "conflict" ? "i18n.error.reload" : "i18n.error.retry"),
  })
}
