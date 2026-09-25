import type { AppError } from "@/server"
import type { Translations } from "./dictionary"
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

type ErrorKey = keyof typeof en

export const errorDictionary = { en, ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht } satisfies Translations<ErrorKey>

export function useErrorCopy(): (error: AppError) => ErrorCopy {
  const t = useTranslator(errorDictionary)
  return (error) => ({
    title: t(`i18n.error.${error.class}.title`),
    message: t(`i18n.error.${error.class}.message`),
    retry: t(`i18n.error.${error.class}.retry`),
  })
}
