import { expect, test } from "bun:test"
import { claxedoDocumentReferenceId, InvalidDocumentReferenceError } from "./claxedo-document"

test("reads the id out of a document reference, percent-decoded", () => {
  expect(claxedoDocumentReferenceId("claxedo://document/doc_plan")).toBe("doc_plan")
  expect(claxedoDocumentReferenceId("claxedo://document/doc%20one")).toBe("doc one")
  expect(claxedoDocumentReferenceId("CLAXEDO://DOCUMENT/doc_plan")).toBe("doc_plan")
})

test("ignores a trailing slash, a query and a fragment", () => {
  expect(claxedoDocumentReferenceId("claxedo://document/doc_plan/")).toBe("doc_plan")
  expect(claxedoDocumentReferenceId("claxedo://document/doc_plan?view=split")).toBe("doc_plan")
  expect(claxedoDocumentReferenceId("claxedo://document/doc_plan/#heading")).toBe("doc_plan")
})

test("leaves anything that is not a document reference to be read as an id or a name", () => {
  expect(claxedoDocumentReferenceId("  Release plan  ")).toBe("Release plan")
  expect(claxedoDocumentReferenceId("doc_plan")).toBe("doc_plan")
  expect(claxedoDocumentReferenceId("https://example.com/document/doc_plan")).toBe("https://example.com/document/doc_plan")
  expect(claxedoDocumentReferenceId("claxedo://document/")).toBe("claxedo://document/")
  expect(claxedoDocumentReferenceId("claxedo://session/ses_1")).toBe("claxedo://session/ses_1")
})

test("a malformed percent escape is a typed invalid-reference error, not a URIError", () => {
  for (const reference of ["claxedo://document/%", "claxedo://document/doc%zz", "claxedo://document/%E0%A4"]) {
    expect(() => claxedoDocumentReferenceId(reference)).toThrow(InvalidDocumentReferenceError)
    expect(() => claxedoDocumentReferenceId(reference)).not.toThrow(URIError)
  }
})
