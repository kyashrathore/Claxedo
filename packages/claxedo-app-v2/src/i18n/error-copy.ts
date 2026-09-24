import type { AppError } from "@/server"
import type { Translations } from "./dictionary"
import { dictionary as ar } from "./errors/ar"
import { dictionary as br } from "./errors/br"
import { dictionary as bs } from "./errors/bs"
import { dictionary as da } from "./errors/da"
import { dictionary as de } from "./errors/de"
import { dictionary as en } from "./errors/en"
import { dictionary as es } from "./errors/es"
import { dictionary as fr } from "./errors/fr"
import { dictionary as ja } from "./errors/ja"
import { dictionary as ko } from "./errors/ko"
import { dictionary as no } from "./errors/no"
import { dictionary as pl } from "./errors/pl"
import { dictionary as ru } from "./errors/ru"
import { dictionary as th } from "./errors/th"
import { dictionary as tr } from "./errors/tr"
import { dictionary as zh } from "./errors/zh"
import { dictionary as zht } from "./errors/zht"
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
