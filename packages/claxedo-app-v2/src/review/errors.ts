import { useErrorCopy, useTranslator } from "@/i18n"
import type { AppError } from "@/server"
import { dictionary } from "./i18n"
import { gitErrorCopy } from "./model"

export function useErrorText(): (error: AppError) => string {
  const t = useTranslator(dictionary)
  const errorCopy = useErrorCopy()
  return (error) => {
    const git = gitErrorCopy(error)
    return git ? t(git.key, git.params) : errorCopy(error).message
  }
}
