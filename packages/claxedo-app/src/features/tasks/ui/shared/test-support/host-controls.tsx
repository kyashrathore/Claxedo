import { For, createContext, useContext, type JSX } from "solid-js"
import { fireEvent, screen, within } from "@solidjs/testing-library"

/**
 * Stand-ins for the two host controls a jsdom component test cannot open.
 *
 * Kobalte's menu and select are portal- and pointer-driven; substituting them —
 * the established pattern for every other menu surface in this package — leaves
 * the CONTENTS as the thing under test, which is where every Tasks assertion
 * about presets, slots and statuses lives. What the doubles keep is what the
 * assertions read: the trigger is a real disabled-able button carrying the
 * caller's `data-testid` and label, items carry their roles and disabled state,
 * and a radio group reports which value is checked.
 */

type Props = Record<string, unknown>

const child = (props: Props) => props.children as JSX.Element
const attrs = (props: Props, drop: readonly string[]) =>
  Object.fromEntries(Object.entries(props).filter(([key]) => !drop.includes(key) && !key.startsWith("on")))

const RadioContext = createContext<{ value: () => unknown; onChange: (value: string) => void }>()

export function dropdownMenuDouble() {
  const Root = (props: Props) => <div>{child(props)}</div>
  const Pass = (props: Props) => <div {...attrs(props, ["children", "class", "classList"])}>{child(props)}</div>

  const Trigger = (props: Props) => (
    <button
      type="button"
      {...attrs(props, ["children", "class", "classList", "as", "icon", "size", "variant"])}
      disabled={props.disabled === true}
    >
      {child(props)}
    </button>
  )

  const Item = (props: Props) => (
    <button
      type="button"
      role="menuitem"
      {...attrs(props, ["children", "class", "classList", "disabled"])}
      disabled={props.disabled === true}
      onClick={() => {
        if (props.disabled !== true) (props.onSelect as (() => void) | undefined)?.()
      }}
    >
      {child(props)}
    </button>
  )

  const RadioGroup = (props: Props) => (
    <RadioContext.Provider
      value={{ value: () => props.value, onChange: (next) => (props.onChange as ((value: string) => void) | undefined)?.(next) }}
    >
      <div role="radiogroup" {...attrs(props, ["children", "class", "classList", "value"])}>
        {child(props)}
      </div>
    </RadioContext.Provider>
  )

  const RadioItem = (props: Props) => {
    const group = useContext(RadioContext)
    const checked = () => group?.value() === props.value
    return (
      <button
        type="button"
        role="menuitemradio"
        {...attrs(props, ["children", "class", "classList", "value", "disabled"])}
        aria-checked={checked()}
        disabled={props.disabled === true}
        onClick={() => {
          if (props.disabled !== true) group?.onChange(String(props.value))
        }}
      >
        {child(props)}
      </button>
    )
  }

  return {
    DropdownMenu: Object.assign(Root, {
      Trigger,
      Icon: Pass,
      Portal: Pass,
      Content: Pass,
      Arrow: Pass,
      Separator: () => <hr />,
      Group: Pass,
      GroupLabel: Pass,
      Item,
      ItemLabel: Pass,
      ItemDescription: Pass,
      ItemIndicator: Pass,
      RadioGroup,
      RadioItem,
      CheckboxItem: Item,
      Sub: Root,
      SubTrigger: Trigger,
      SubContent: Pass,
    }),
  }
}

export function selectDouble() {
  const Select = (props: Props) => {
    const options = () => (props.options as unknown[] | undefined) ?? []
    const key = (option: unknown) => ((props.value as ((x: unknown) => string) | undefined) ?? String)(option)
    const label = (option: unknown) => ((props.label as ((x: unknown) => string) | undefined) ?? String)(option)
    const trigger = (props.triggerProps as Record<string, string> | undefined) ?? {}
    const testId = trigger["data-testid"]
    return (
      <div data-component="select">
        <button type="button" {...trigger} disabled={props.disabled === true}>
          {props.current === undefined ? ((props.placeholder as string | undefined) ?? "") : label(props.current)}
        </button>
        <div
          role="listbox"
          aria-label={trigger["aria-label"]}
          data-testid={testId === undefined ? undefined : `${testId}-options`}
        >
          <For each={options()}>
            {(option) => (
              <button
                type="button"
                role="option"
                data-value={key(option)}
                aria-selected={props.current !== undefined && key(props.current) === key(option)}
                disabled={props.disabled === true}
                onClick={() => (props.onSelect as ((value: unknown) => void) | undefined)?.(option)}
              >
                {label(option)}
              </button>
            )}
          </For>
        </div>
      </div>
    )
  }
  return { Select }
}

/** Picks an option out of a substituted `Select` by the label it renders. */
export function chooseOption(testId: string, name: string | RegExp) {
  fireEvent.click(within(screen.getByTestId(`${testId}-options`)).getByRole("option", { name }))
}

/** The options a substituted `Select` is offering, in order. */
export function optionLabels(testId: string) {
  return within(screen.getByTestId(`${testId}-options`))
    .getAllByRole("option")
    .map((option) => option.textContent)
}
