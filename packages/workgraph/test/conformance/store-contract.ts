import { describe, it } from "vitest"
import {
  workGraphArchiveConformance,
  workGraphAttentionConformance,
  workGraphAdapterConformance,
  workGraphSnapshotRestartConformance,
  type ArchiveConformanceFactory,
  type AttentionConformanceFactory,
  type ConformanceChangeView,
  type ConformanceCommands,
  type ConformanceQueries,
  type ConformanceSourceRevisionView,
  type ConformanceStreamView,
  type ConformanceWorkItemView,
  type StoreConformanceFactory,
  type SnapshotRestartConformanceFactory,
} from "../../src/conformance"

export type {
  ArchiveConformanceFactory,
  AttentionConformanceFactory,
  ConformanceChangeView,
  ConformanceCommands,
  ConformanceQueries,
  ConformanceSourceRevisionView,
  ConformanceStreamView,
  ConformanceWorkItemView,
  StoreConformanceFactory,
  SnapshotRestartConformanceFactory,
}

export function workGraphAttentionContract(name: string, factory: AttentionConformanceFactory) {
  describe(`${name} WorkGraph Attention conformance`, () => {
    workGraphAttentionConformance(factory).forEach((testCase) => it(testCase.name, testCase.run))
  })
}

export function workGraphArchiveContract(name: string, factory: ArchiveConformanceFactory) {
  describe(`${name} WorkGraph archive conformance`, () => {
    workGraphArchiveConformance(factory).forEach((testCase) => it(testCase.name, testCase.run))
  })
}

export function workGraphStoreContract(name: string, factory: StoreConformanceFactory) {
  describe(`${name} AtomicWorkGraphStore conformance`, () => {
    workGraphAdapterConformance(factory).forEach((testCase) => it(testCase.name, testCase.run))
  })
}

export function workGraphSnapshotRestartContract(name: string, factory: SnapshotRestartConformanceFactory) {
  describe(`${name} WorkGraph snapshot restart conformance`, () => {
    workGraphSnapshotRestartConformance(factory).forEach((testCase) => it(testCase.name, testCase.run))
  })
}
