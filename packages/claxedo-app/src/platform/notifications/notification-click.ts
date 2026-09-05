export const handleNotificationClick = (href?: string) => {
  window.focus()
  if (!href) return
  window.location.assign(href)
}
