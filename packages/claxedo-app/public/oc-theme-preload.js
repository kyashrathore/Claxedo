;(function () {
  var key = "opencode-theme-id"
  var themeId = localStorage.getItem(key) || "oc-2"

  if (themeId === "oc-1") {
    themeId = "oc-2"
    localStorage.setItem(key, themeId)
    localStorage.removeItem("opencode-theme-css-light")
    localStorage.removeItem("opencode-theme-css-dark")
  }

  var scheme = localStorage.getItem("opencode-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  // Declared before any stylesheet loads so the UA paints its canvas, form
  // controls and scrollbars in the right scheme on the very first frame. The
  // cached-CSS branch below only runs for non-default themes, so this cannot
  // live there.
  document.documentElement.style.colorScheme = mode

  // Update theme-color meta tags to match app color scheme. Documents that
  // declare a light and a dark variant have more than one, and only updating
  // the first left the other reporting the previous scheme's color.
  var background = isDark ? "#131010" : "#F8F7F7"
  var metas = document.querySelectorAll("meta[name='theme-color']")
  for (var index = 0; index < metas.length; index++) {
    metas[index].setAttribute("content", background)
  }

  if (themeId === "oc-2") return

  var css = localStorage.getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
