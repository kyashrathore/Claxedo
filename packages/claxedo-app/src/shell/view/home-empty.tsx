import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { projectSettingsPath, useProjectList } from "@/projects"
import { Button } from "@/ui"
import { shellDictionary } from "../i18n"
import { useShellRoute } from "../router"

export function useHomeEmpty(): () => JSX.Element | undefined {
  const t = useTranslator(shellDictionary)
  const projects = useProjectList()
  const routing = useShellRoute()
  return () => {
    const id = routing.route().kind === "home" ? projects.list()[0]?.project.id : undefined
    if (!id) return undefined
    return (
      <div class="flex max-w-sm flex-col items-center gap-3 text-center">
        <p>{t("shell.home.noPlacement")}</p>
        <Button variant="neutral" size="small" onClick={() => routing.navigate(projectSettingsPath(id))}>
          {t("shell.home.choosePlacement")}
        </Button>
      </div>
    )
  }
}
