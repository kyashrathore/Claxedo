// @ts-nocheck
import { ScrollableOutput } from "./scrollable-output"

const docs = `### Overview
A tool's output in a capped, scrolling box. When the output is taller than the cap, a
"Show all" control lifts the cap for that box; "Show less" restores it.

### Behavior
- The control appears only when the content overflows the cap.
- Clicking it does not toggle the tool row it sits in.
`

const numberedLines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")

export default {
  title: "UI/ScrollableOutput",
  id: "components-scrollable-output",
  component: ScrollableOutput,
  tags: ["autodocs"],
  parameters: { docs: { description: { component: docs } } },
}

export const All = {
  render: () => (
    <div style="display: flex; flex-direction: column; gap: 24px; max-width: 720px;">
      <div style="display: flex; flex-direction: column;">
        <ScrollableOutput component="tool-output">
          <pre>{numberedLines(4)}</pre>
        </ScrollableOutput>
      </div>
      <div style="display: flex; flex-direction: column;">
        <ScrollableOutput component="tool-output">
          <pre>{numberedLines(80)}</pre>
        </ScrollableOutput>
      </div>
      <div class="ui-bash-output" data-component="bash-output" style="display: flex; flex-direction: column;">
        <ScrollableOutput slot="bash-scroll" class="ui-bash-scroll">
          <pre data-slot="bash-pre"><code>{`$ bun test\n\n${numberedLines(60)}`}</code></pre>
        </ScrollableOutput>
      </div>
    </div>
  ),
}
