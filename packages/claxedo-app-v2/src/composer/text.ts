import { useTranslator } from "@/i18n"
import { composerEnglishDictionaries, type ComposerTextKey } from "./i18n"

export const useComposerText = () => useTranslator<ComposerTextKey>(composerEnglishDictionaries)
