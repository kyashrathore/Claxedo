;(function () {
  var theme = localStorage.getItem("claxedo-theme") || "claxedo"
  var scheme = localStorage.getItem("claxedo-color-scheme") || "system"
  var dark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = dark ? "dark" : "light"
  var html = document.documentElement

  html.dataset.theme = theme
  html.dataset.colorScheme = mode
  html.style.colorScheme = mode
  html.style.backgroundColor = dark ? "#161616" : "#ffffff"

  var metas = document.querySelectorAll("meta[name='theme-color']")
  for (var index = 0; index < metas.length; index++) {
    metas[index].setAttribute("content", html.style.backgroundColor)
  }

  if (theme === "claxedo") return

  var css = localStorage.getItem("claxedo-theme-css-" + mode)
  if (!css) return
  var style = document.createElement("style")
  style.id = "claxedo-theme-preload"
  style.textContent = 'html[data-theme="' + theme + '"]{' + css + "}"
  document.head.appendChild(style)
})()
