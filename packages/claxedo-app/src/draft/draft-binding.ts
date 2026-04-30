export type DraftBinding = {
  draftId: string
  directory?: string
}

const DRAFT_DIRECTORY_PREFIX = "__draft__"

export function createDraftBinding(draftId: string): DraftBinding {
  return { draftId }
}

export function attachDraftBinding(binding: DraftBinding, directory: string): DraftBinding {
  if (binding.directory === directory) return binding
  return {
    ...binding,
    directory,
  }
}

export function draftScopeDirectory(draftId: string) {
  return `${DRAFT_DIRECTORY_PREFIX}/${draftId}`
}

export function isDraftScopeDirectory(directory?: string) {
  return !!directory && directory.startsWith(`${DRAFT_DIRECTORY_PREFIX}/`)
}
