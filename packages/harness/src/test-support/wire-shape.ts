import { isRecord } from "@claxedo/helpers/guards"

export type Field = (value: unknown) => boolean
export type Shape = { required: readonly string[]; fields: Record<string, Field> }

export const text: Field = (value) => typeof value === "string"
export const flag: Field = (value) => typeof value === "boolean"
export const count: Field = (value) => Number.isInteger(value)
export const json: Field = () => true
export const optional = (field: Field): Field => (value) => value === undefined || value === null || field(value)
export const oneOf = (...values: string[]): Field => (value) => typeof value === "string" && values.includes(value)
export const list = (field: Field): Field => (value) => Array.isArray(value) && value.every(field)
export const either = (...fields: Field[]): Field => (value) => fields.some((field) => field(value))
export const shaped = (shape: Shape): Field => (value) => isRecord(value) && conforms(value, shape)
export const tagged = (tags: Record<string, Shape>): Field => (value) => {
  if (!isRecord(value)) return false
  const { type, ...fields } = value
  return conforms(fields, tags[String(type)])
}

export function conforms(params: Record<string, unknown>, shape: Shape | undefined): boolean {
  if (!shape) return false
  return shape.required.every((key) => params[key] !== undefined)
    && Object.entries(params).every(([key, value]) => shape.fields[key]?.(value) === true)
}
