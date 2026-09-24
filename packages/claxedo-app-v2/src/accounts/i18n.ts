import { useTranslator, type DomainTranslate, type Translations } from "@/i18n"

import { dictionary as ar } from "./locales/ar"
import { dictionary as br } from "./locales/br"
import { dictionary as bs } from "./locales/bs"
import { dictionary as da } from "./locales/da"
import { dictionary as de } from "./locales/de"
import { dictionary as en } from "./locales/en"
import { dictionary as es } from "./locales/es"
import { dictionary as fr } from "./locales/fr"
import { dictionary as ja } from "./locales/ja"
import { dictionary as ko } from "./locales/ko"
import { dictionary as no } from "./locales/no"
import { dictionary as pl } from "./locales/pl"
import { dictionary as ru } from "./locales/ru"
import { dictionary as th } from "./locales/th"
import { dictionary as tr } from "./locales/tr"
import { dictionary as zh } from "./locales/zh"
import { dictionary as zht } from "./locales/zht"

export type AccountsKey = keyof typeof en

export const dictionary = { en, ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht } satisfies Translations<AccountsKey>

export type AccountsText = DomainTranslate<AccountsKey>

export const useAccountsText = (): AccountsText => useTranslator(dictionary)
