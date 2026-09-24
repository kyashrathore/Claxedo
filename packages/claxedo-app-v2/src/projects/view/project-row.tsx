import type { Component } from "solid-js"
import type { Project } from "@/server"
import { Icon, IconButton, Menu } from "@/ui"
import { useProjectsText } from "../i18n"

export const ProjectRow: Component<{
  project: Project
  active: boolean
  onOpen: () => void
  onRename: () => void
  onRemove: () => void
}> = (props) => {
  const t = useProjectsText()
  return (
    <li class="projects-row" data-project-id={props.project.id} aria-current={props.active ? "page" : undefined}>
      <button type="button" class="projects-row-open" onClick={() => props.onOpen()}>
        <Icon name="folder" />
        <span class="truncate">{props.project.name}</span>
      </button>
      <Menu placement="bottom-end">
        <Menu.Trigger
          as={IconButton}
          icon="three-dots"
          variant="ghost"
          size="small"
          aria-label={t("projects.actionsFor", { name: props.project.name })}
        />
        <Menu.Portal>
          <Menu.Content>
            <Menu.Item onSelect={() => props.onRename()}>{t("projects.rename")}</Menu.Item>
            <Menu.Item onSelect={() => props.onRemove()}>{t("projects.remove")}</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </li>
  )
}
