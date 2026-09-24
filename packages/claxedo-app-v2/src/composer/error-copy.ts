import type { AppError } from "@/server"
import { useComposerText } from "./text"

export function useErrorCopy(): (error: AppError) => string {
  const t = useComposerText()
  return (error) => t(`composer.error.${error.class}`)
}
