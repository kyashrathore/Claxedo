import { useTranslator } from "@/i18n"
import { sessionScreenEnglishDictionaries, type SessionScreenTextKey } from "./i18n"

export const useSessionScreenText = () => useTranslator<SessionScreenTextKey>(sessionScreenEnglishDictionaries)
