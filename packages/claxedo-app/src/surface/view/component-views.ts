import type { Component } from "solid-js"
import type { SurfaceComponentName } from "@claxedo/plugin-api/surface"
import type { SurfaceNodeProps } from "../model"
import { AgentConfigurationPickerView } from "./agent-configuration-view"
import { BoardView } from "./board-view"
import { ButtonView } from "./button-view"
import { ComboboxView } from "./combobox-view"
import { ChoicePickerView } from "./choice-picker-view"
import { CardView, CollapsibleView, TabsView } from "./container-views"
import { CheckBoxView, SwitchView, TextFieldView } from "./field-views"
import { FilePickerView } from "./file-picker-view"
import { ColumnView, DividerView, GridView, SurfaceListView, RowView } from "./layout-views"
import { ListItemView } from "./list-item-view"
import { FooterView, HeaderView, SectionView } from "./page-views"
import { DateTimeInputView, SliderView } from "./range-views"
import { ImageView } from "./image-view"
import { DiffStatView, EmptyStateView, ProgressView, SpinnerView } from "./status-views"
import { CalloutView, KeyValueView, StatView } from "./summary-views"
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
  Image: ImageView,
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
  Header: HeaderView,
  Section: SectionView,
  Stat: StatView,
  Grid: GridView,
  ListItem: ListItemView,
  Callout: CalloutView,
  KeyValue: KeyValueView,
  Footer: FooterView,
  AgentConfigurationPicker: AgentConfigurationPickerView,
  Board: BoardView,
  FilePicker: FilePickerView,
  Combobox: ComboboxView,
}
