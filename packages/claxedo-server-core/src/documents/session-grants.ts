export function sessionMatchesDocumentProject(input: {
  documentProjectId: string
  sessionProjectId?: string
  sessionDirectory?: string
  resolveDirectoryProjectId: (directory: string) => string
}) {
  if (input.sessionDirectory) return input.resolveDirectoryProjectId(input.sessionDirectory) === input.documentProjectId
  return input.sessionProjectId === input.documentProjectId
}
