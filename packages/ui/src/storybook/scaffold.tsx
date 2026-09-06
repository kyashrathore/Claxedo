import { ErrorBoundary, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"

type StoryComponent = Component<Record<string, unknown>>

function isComponent(value: unknown): value is StoryComponent {
  return typeof value === "function"
}

/**
 * A story module's exports are `unknown`; a component is the only kind this picks. Capturing
 * the narrowed value (rather than re-indexing after the check) is what keeps the result typed.
 */
function asComponent(value: unknown): StoryComponent | undefined {
  return isComponent(value) ? value : undefined
}

function pick(mod: Record<string, unknown>, name?: string): StoryComponent {
  const named = name ? asComponent(mod[name]) : undefined
  if (named) return named

  const fallback = asComponent(mod.default)
  if (fallback) return fallback

  const preferred = Object.keys(mod)
    .filter((k) => k[0] && k[0] === k[0].toUpperCase())
    .map((k) => asComponent(mod[k]))
    .find((value) => value !== undefined)
  if (preferred) return preferred

  const first = Object.keys(mod)
    .map((k) => asComponent(mod[k]))
    .find((value) => value !== undefined)
  if (first) return first

  return () => {
    return (
      <div data-component="storybook-missing">
        <div>Missing component export.</div>
        <div style="opacity:0.7;font-size:12px">Exports: {Object.keys(mod).join(", ") || "(none)"}</div>
      </div>
    )
  }
}

export function create(input: {
  title: string
  mod: Record<string, unknown>
  name?: string
  args?: Record<string, unknown>
}) {
  const component = pick(input.mod, input.name)

  return {
    meta: {
      title: input.title,
      component,
    },
    Basic: {
      args: input.args ?? {},
      render: (args: Record<string, unknown>) => {
        return (
          <ErrorBoundary
            fallback={(err) => {
              return (
                <pre data-component="storybook-error" style="white-space:pre-wrap">
                  {String(err)}
                </pre>
              )
            }}
          >
            <Dynamic component={component} {...args} />
          </ErrorBoundary>
        )
      },
    },
  }
}
