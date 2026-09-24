import { useTranslator, type DomainTranslate, type Translations } from "@/i18n"

import ar from "./locales/ar"
import br from "./locales/br"
import bs from "./locales/bs"
import da from "./locales/da"
import de from "./locales/de"
import en from "./locales/en"
import es from "./locales/es"
import fr from "./locales/fr"
import ja from "./locales/ja"
import ko from "./locales/ko"
import no from "./locales/no"
import pl from "./locales/pl"
import ru from "./locales/ru"
import th from "./locales/th"
import tr from "./locales/tr"
import zh from "./locales/zh"
import zht from "./locales/zht"

export type ProjectsKey = keyof typeof en

export const projectsDictionary = { en, ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht } satisfies Translations<ProjectsKey>

export type ProjectsText = DomainTranslate<ProjectsKey>

export const useProjectsText = (): ProjectsText => useTranslator(projectsDictionary)
