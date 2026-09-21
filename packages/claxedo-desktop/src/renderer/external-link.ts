/** Leave clicks claimed by the transcript or another app surface with that owner. */
export function handleExternalLinkClick(event: MouseEvent, openLink: (url: string) => void) {
  if (event.defaultPrevented) return
  const target = event.target
  if (!(target instanceof Element)) return
  const link = target.closest("a.external-link")
  if (!(link instanceof HTMLAnchorElement) || !link.href) return
  event.preventDefault()
  openLink(link.href)
}
