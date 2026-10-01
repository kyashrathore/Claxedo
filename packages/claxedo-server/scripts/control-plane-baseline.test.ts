import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, expect, test } from "vitest"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

const CHAIN = [`
create table parent (id text primary key, label text);
create table child (id text primary key, parent_id text references parent(id));
insert into parent values ('old', 'old');
`, `
alter table parent add column current integer not null default 1;
create table child_next (id text primary key, parent_id text not null references parent(id));
insert into child_next select id, parent_id from child;
drop table child;
alter table child_next rename to child;
create index child_parent on child(parent_id);
create view labelled as select id, label from parent;
create trigger labelled_insert instead of insert on labelled BEGIN insert into parent (id, label) values (new.id, new.label); END;
`]

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "control-plane-baseline-"))
  directories.push(directory)
  CHAIN.forEach((sql, index) => writeFileSync(path.join(directory, `000${index + 1}_step.sql`), sql))
  return directory
}

function run(directory: string, ...flags: string[]) {
  return spawnSync("bun", [path.join(import.meta.dirname, "control-plane-baseline.ts"), ...flags, directory], { encoding: "utf8" })
}

const baseline = (directory: string) => readFileSync(path.join(directory, "0001_baseline.sql"), "utf8")
const contents = (directory: string) => readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")])

test("the baseline rebuilds exactly the sqlite_master the chain built, holds no rows, and replaces the chain", () => {
  const directory = fixture()
  expect(run(directory).status).toBe(0)
  expect(readdirSync(directory)).toEqual(["0001_baseline.sql"])
  const [chain, rebuilt] = [new Database(":memory:"), new Database(":memory:")]
  try {
    CHAIN.forEach((sql) => chain.exec(sql))
    rebuilt.exec(baseline(directory))
    const master = (database: Database.Database) => database.prepare("select type, name, tbl_name, sql from sqlite_master order by type, name").all()
    expect(master(rebuilt)).toEqual(master(chain))
    expect(rebuilt.prepare("select * from parent").all()).toEqual([])
  } finally {
    chain.close()
    rebuilt.close()
  }
})

test("generation is deterministic, a fixed point, and folds a later migration", () => {
  const [first, second] = [fixture(), fixture()]
  expect(run(first).status).toBe(0)
  expect(run(second).status).toBe(0)
  const original = baseline(first)
  expect(baseline(second)).toBe(original)
  expect(run(first).status).toBe(0)
  expect(baseline(first)).toBe(original)
  writeFileSync(path.join(first, "0052_later.sql"), "create table later (id text primary key);")
  expect(run(first).stdout).toContain("folded 1 migrations: 0052_later.sql")
  expect(baseline(first)).toContain("CREATE TABLE later")
  expect(readdirSync(first)).toEqual(["0001_baseline.sql"])
})

test.each([
  ["a failing migration", "create table child (duplicate text);", /table child already exists/],
  ["a commented CREATE, which D1 would store without the comment", "create table noted (\n  id text -- key\n);", /noted: remove the SQL comment/],
  ["a blank line after a semicolon in a trigger", "create trigger spaced after insert on parent BEGIN\n  select 1;\n\n  select 2;\nEND;", /spaced: a blank line after a semicolon/],
])("%s is refused and leaves every input byte untouched", (_, sql, error) => {
  const directory = fixture()
  writeFileSync(path.join(directory, "0003_extra.sql"), sql)
  const before = contents(directory)
  const result = run(directory)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(error)
  expect(contents(directory)).toEqual(before)
})

test("check refuses a migration beside the baseline and a hand-edited baseline", () => {
  const directory = fixture()
  expect(run(directory).status).toBe(0)
  expect(run(directory, "--check").status).toBe(0)
  writeFileSync(path.join(directory, "0052_later.sql"), "create table later (id text primary key);")
  expect(run(directory, "--check").stderr).toContain("Migrations not folded into 0001_baseline.sql: 0052_later.sql. Run bun run d1:baseline:generate.")
  rmSync(path.join(directory, "0052_later.sql"))
  writeFileSync(path.join(directory, "0001_baseline.sql"), `${baseline(directory)}\nCREATE TABLE appended (id text);\n`)
  expect(run(directory, "--check").stderr).toContain("0001_baseline.sql is not the generator's output. Run bun run d1:baseline:generate.")
})

test("the shipped control-plane migrations are exactly the generated baseline", () => {
  const result = spawnSync("bun", [path.join(import.meta.dirname, "control-plane-baseline.ts"), "--check"], { encoding: "utf8" })
  expect(result.status, result.stderr).toBe(0)
})
