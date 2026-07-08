import type {
  AvailableCommand as AcpAvailableCommand,
  ContentBlock,
  SessionConfigOption as AcpSessionConfigOption,
  SessionConfigSelectGroup as AcpSessionConfigSelectGroup,
  SessionConfigSelectOption as AcpSessionConfigSelectOption,
  SessionNotification,
  StopReason as AcpStopReason,
  ToolCallContent as AcpToolCallContent,
  ToolKind as AcpToolKind,
} from "@agentclientprotocol/sdk"

export type ToolKind = AcpToolKind
export type ToolCallContent = AcpToolCallContent
export type AvailableCommand = AcpAvailableCommand

export type TextContent = Extract<ContentBlock, { type: "text" }>
export type ImageContent = Extract<ContentBlock, { type: "image" }>
export type AudioContent = Extract<ContentBlock, { type: "audio" }>
export type ResourceLinkContent = Extract<ContentBlock, { type: "resource_link" }>
export type ResourceContent = Extract<ContentBlock, { type: "resource" }>

export type SessionConfigSelectOption = AcpSessionConfigSelectOption
export type SessionConfigSelectGroup = AcpSessionConfigSelectGroup
export type SessionConfigOption = AcpSessionConfigOption

export type SessionUpdate = SessionNotification["update"]
export type StopReason = AcpStopReason
