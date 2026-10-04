import type { AppError, ErrorClass } from "@/server"
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
  return {
    "i18n.error.signIn": messages.signIn,
    "i18n.error.retry": messages.retry,
    "i18n.error.reload": messages.reload,
    "i18n.error.auth.title": messages.auth[0],
    "i18n.error.auth.message": messages.auth[1],
    "i18n.error.rate_limit.title": messages.rate_limit[0],
    "i18n.error.rate_limit.message": messages.rate_limit[1],
    "i18n.error.network.title": messages.network[0],
    "i18n.error.network.message": messages.network[1],
    "i18n.error.not_found.title": messages.not_found[0],
    "i18n.error.not_found.message": messages.not_found[1],
    "i18n.error.conflict.title": messages.conflict[0],
    "i18n.error.conflict.message": messages.conflict[1],
    "i18n.error.invalid.title": messages.invalid[0],
    "i18n.error.invalid.message": messages.invalid[1],
    "i18n.error.internal.title": messages.internal[0],
    "i18n.error.internal.message": messages.internal[1],
  }
}

export const errorDictionary = {
  en: errorTranslations(en),
  ar: errorTranslations(ar),
  br: errorTranslations(br),
  bs: errorTranslations(bs),
  da: errorTranslations(da),
  de: errorTranslations(de),
  es: errorTranslations(es),
  fr: errorTranslations(fr),
  ja: errorTranslations(ja),
  ko: errorTranslations(ko),
  no: errorTranslations(no),
  pl: errorTranslations(pl),
  ru: errorTranslations(ru),
  th: errorTranslations(th),
  tr: errorTranslations(tr),
  zh: errorTranslations(zh),
  zht: errorTranslations(zht),
} satisfies Record<Locale, Readonly<Record<ErrorKey, string>>>

export function useErrorCopy(): (error: AppError) => ErrorCopy {
  const t = useTranslator(errorDictionary)
  return (error) => ({
    title: t(`i18n.error.${error.class}.title`),
    message: t(`i18n.error.${error.class}.message`),
    retry: t(error.class === "auth" ? "i18n.error.signIn" : error.class === "not_found" || error.class === "conflict" ? "i18n.error.reload" : "i18n.error.retry"),
  })
}
