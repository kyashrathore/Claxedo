/** Reviewed source snapshot, 2026-09-09. A reference proves a caller, not that its conditional UI is currently visible. */
export type IconUsage = {
  kind: "used" | "indirect" | "no-caller"
  how: string
  references: { file: string; line: number; code: string; context: string }[]
}
export const iconMappingUsage: Record<string, IconUsage> = {
  glasses: {
    kind: "used",
    how: "Conversation → file-read tool headers; shared BasicTool read-intent icon.",
    references: [
      {
        file: "packages/session-ui/src/components/basic-tool.tsx",
        line: 408,
        code: 'read: "glasses",',
        context:
          'const INTENT_ICONS: Record<string, IconProps["name"]> = {\n  edit: "pencil-line",\n  read: "glasses",\n  shell: "terminal",\n  search: "magnifying-glass",',
      },
      {
        file: "packages/session-ui/src/components/basic-tool.tsx",
        line: 425,
        code: 'return "glasses"',
        context:
          '    case "read":\n    case "read_file":\n      return "glasses"\n    case "bash":\n    case "command":',
      },
      {
        file: "packages/session-ui/src/components/message-part.tsx",
        line: 519,
        code: 'icon: "glasses",',
        context:
          '    case "read":\n      return {\n        icon: "glasses",\n        title: i18n.t("ui.tool.read"),\n        subtitle: input.filePath ? getFilename(input.filePath) : undefined,',
      },
      {
        file: "packages/session-ui/src/components/message-part.tsx",
        line: 2213,
        code: 'icon="glasses"',
        context:
          '        <BasicTool\n          {...props}\n          icon="glasses"\n          trigger={{\n            title: i18n.t("ui.tool.read"),',
      },
    ],
  },
}
