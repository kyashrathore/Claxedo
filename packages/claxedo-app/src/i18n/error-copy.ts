import { useServer, type AppError, type ErrorClass, type ProductErrorSurface } from "@/server"
import type { LocaleLoader, Translations } from "./dictionary"
import type { ErrorMessages } from "./errors/model"
import en from "./errors/en"
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
    "i18n.error.forbidden.title": messages.forbidden[0],
    "i18n.error.forbidden.message": messages.forbidden[1],
    "i18n.error.rate_limit.title": messages.rate_limit[0],
    "i18n.error.rate_limit.message": messages.rate_limit[1],
    "i18n.error.network.title": messages.network[0],
    "i18n.error.network.message": messages.network[1],
    "i18n.error.runtime_unreachable.title": messages.runtime_unreachable[0],
    "i18n.error.runtime_unreachable.message": messages.runtime_unreachable[1],
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

const errorLocale = (load: () => Promise<{ readonly default: ErrorMessages }>): LocaleLoader<ErrorKey> => () =>
  load().then((module) => ({ default: errorTranslations(module.default) }))

export const errorDictionary = {
  en: errorTranslations(en),
  ar: errorLocale(() => import("./errors/ar")),
  br: errorLocale(() => import("./errors/br")),
  bs: errorLocale(() => import("./errors/bs")),
  da: errorLocale(() => import("./errors/da")),
  de: errorLocale(() => import("./errors/de")),
  es: errorLocale(() => import("./errors/es")),
  fr: errorLocale(() => import("./errors/fr")),
  ja: errorLocale(() => import("./errors/ja")),
  ko: errorLocale(() => import("./errors/ko")),
  no: errorLocale(() => import("./errors/no")),
  pl: errorLocale(() => import("./errors/pl")),
  ru: errorLocale(() => import("./errors/ru")),
  th: errorLocale(() => import("./errors/th")),
  tr: errorLocale(() => import("./errors/tr")),
  zh: errorLocale(() => import("./errors/zh")),
  zht: errorLocale(() => import("./errors/zht")),
} satisfies Translations<ErrorKey>

export function useErrorCopy(surface: ProductErrorSurface): (error: AppError) => ErrorCopy {
  const t = useTranslator(errorDictionary)
  const telemetry = useServer().telemetry
  const shown = new WeakSet<AppError>()
  const copy = (error: AppError): ErrorCopy => ({
    title: t(`i18n.error.${error.class}.title`),
    message: t(`i18n.error.${error.class}.message`),
    retry: t(error.class === "auth" ? "i18n.error.signIn" : error.class === "not_found" || error.class === "conflict" ? "i18n.error.reload" : "i18n.error.retry"),
  })
  return (error) => {
    if (!shown.has(error)) {
      shown.add(error)
      telemetry.record({ event: "ui_error_shown", properties: { error_class: error.class, surface } })
    }
    return copy(error)
  }
}
