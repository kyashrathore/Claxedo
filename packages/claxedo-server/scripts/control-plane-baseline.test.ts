import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, expect, test } from "vitest"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "control-plane-baseline-"))
  directories.push(directory)
  writeFileSync(path.join(directory, "0001_initial.sql"), `
create table parent (id text primary key, label text);
create table child (id text primary key, parent_id text references parent(id));
insert into parent values ('old', 'old');
create index child_parent on child(parent_id);
create trigger child_guard before insert on child BEGIN select case when new.id = 'bad' then raise(abort, 'bad child') end; END;
`)
  writeFileSync(path.join(directory, "0002_final.sql"), `
alter table parent add column current integer not null default 1;
update parent set label = 'converted';
create table retired (id text);
drop table retired;
`)
  return directory
}

function generate(directory: string) {
  return spawnSync("bun", [path.join(import.meta.dirname, "control-plane-baseline.ts"), "--directory", directory], {
    encoding: "utf8",
    env: { ...process.env, HOME: path.join(directory, "home") },
  })
}

test("generates the final schema without data, preserves indexes and trigger bodies, and replaces the chain", () => {
  const directory = fixture()
  const result = generate(directory)
  expect(result.status, result.stderr).toBe(0)
  expect(readdirSync(directory)).toEqual(["0001_baseline.sql"])
  const baseline = readFileSync(path.join(directory, "0001_baseline.sql"), "utf8")
  expect(baseline.indexOf("CREATE TABLE parent")).toBeLessThan(baseline.indexOf("CREATE TABLE child"))
  expect(baseline).not.toMatch(/^\s*(insert|update|drop|alter)\b/im)
  const database = new Database(":memory:")
  try {
    database.pragma("foreign_keys = ON")
    database.exec(baseline)
    expect(database.prepare("select * from parent").all()).toEqual([])
    expect(database.prepare("pragma table_info(parent)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "current" })]))
    expect(database.prepare("select name from sqlite_master where type = 'index' and sql is not null").all()).toEqual([{ name: "child_parent" }])
    expect(() => database.exec("insert into child(id) values ('bad')")).toThrow("bad child")
    expect(() => database.exec("insert into child values ('ok', 'missing')")).toThrow(/FOREIGN KEY/)
  } finally {
    database.close()
  }
})

test("identical input and regeneration produce identical bytes and later migrations are absorbed", () => {
  const first = fixture()
  const second = fixture()
  expect(generate(first).status).toBe(0)
  expect(generate(second).status).toBe(0)
  const bytes = () => readFileSync(path.join(first, "0001_baseline.sql"), "utf8")
  expect(bytes()).toBe(readFileSync(path.join(second, "0001_baseline.sql"), "utf8"))
  const original = bytes()
  expect(generate(first).status).toBe(0)
  expect(bytes()).toBe(original)
  writeFileSync(path.join(first, "0052_later.sql"), "create table later (id text primary key);")
  expect(generate(first).status).toBe(0)
  expect(bytes()).toContain("CREATE TABLE later")
  expect(readdirSync(first)).toEqual(["0001_baseline.sql"])
})

test("a failed migration leaves every input byte untouched", () => {
  const directory = fixture()
  writeFileSync(path.join(directory, "0003_invalid.sql"), "create table child (duplicate text);")
  const before = readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")])
  const result = generate(directory)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/table child already exists/)
  expect(readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")])).toEqual(before)
})
