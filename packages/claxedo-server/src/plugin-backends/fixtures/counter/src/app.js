import { definePlugin } from "@claxedo/plugin-api"

function counterPage(api) {
  const page = document.createElement("section")
  page.setAttribute("aria-label", "Counter")
  const heading = document.createElement("h2")
  heading.textContent = "Counter"
  const count = document.createElement("p")
  count.setAttribute("role", "status")
  count.textContent = "Counting…"
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = "Count"
  const show = (answer) =>
    answer.then(
      async (response) => {
        const body = await response.json()
        count.textContent = response.ok ? `Count: ${body.value}` : `The counter answered ${response.status}`
      },
      (error) => {
        count.textContent = `The counter failed: ${error instanceof Error ? error.message : String(error)}`
      },
    )
  button.addEventListener("click", () => void show(api.server.backend().fetch("/count", { method: "POST" })))
  void show(api.server.backend().fetch("/count"))
  page.append(heading, count, button)
  return page
}

export default definePlugin({
  activate(api) {
    api.pages.register({ id: "counter", path: "/counter", title: "Counter", render: () => counterPage(api) })
    api.sidebar.item({ id: "counter", label: "Counter", pageId: "counter" })
  },
})
