import type { Component } from "solid-js"
import type { SurfaceComponentName } from "@claxedo/plugin-api/surface"
import type { SurfaceNodeProps } from "../model"
import { ButtonView } from "./button-view"
import { ChoicePickerView } from "./choice-picker-view"
import { CardView, CollapsibleView, TabsView } from "./container-views"
import { CheckBoxView, SwitchView, TextFieldView } from "./field-views"
import { ColumnView, DividerView, SurfaceListView, RowView } from "./layout-views"
import { DateTimeInputView, SliderView } from "./range-views"
import { DiffStatView, EmptyStateView, ProgressView, SpinnerView } from "./status-views"
import { TableView } from "./table-view"
import { BadgeView, CodeView, IconView, LinkView, MarkdownView, TextView } from "./text-views"

type SurfaceViews = { readonly [Name in SurfaceComponentName]: Component<SurfaceNodeProps<Name>> }

export const SURFACE_VIEWS: SurfaceViews = {
  Text: TextView,
  Markdown: MarkdownView,
  Code: CodeView,
  Icon: IconView,
  Badge: BadgeView,
  Link: LinkView,
  Row: RowView,
  Column: ColumnView,
  List: SurfaceListView,
  Card: CardView,
  Tabs: TabsView,
  Collapsible: CollapsibleView,
  Divider: DividerView,
  Button: ButtonView,
  TextField: TextFieldView,
  CheckBox: CheckBoxView,
  Switch: SwitchView,
  ChoicePicker: ChoicePickerView,
  Slider: SliderView,
  DateTimeInput: DateTimeInputView,
  Progress: ProgressView,
  Spinner: SpinnerView,
  Table: TableView,
  DiffStat: DiffStatView,
  EmptyState: EmptyStateView,
}
