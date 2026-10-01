import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, expect, test } from "vitest"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

const CHAIN: Record<string, string> = {
  "0001_initial.sql": `
create table parent (id text primary key, label text);
create table child (id text primary key, parent_id text references parent(id));
insert into parent values ('old', 'old');
create index child_parent on child(parent_id);
create trigger child_guard before insert on child BEGIN select case when new.id = 'bad' then raise(abort, 'bad child') end; END;
`,
  "0002_final.sql": `
alter table parent add column current integer not null default 1;
update parent set label = 'converted';
create table retired (id text);
drop table retired;
create table child_next (id text primary key, parent_id text not null references parent(id));
insert into child_next select id, parent_id from child;
drop table child;
alter table child_next rename to child;
create index child_parent on child(parent_id);
create trigger child_guard before insert on child BEGIN select case when new.id = 'bad' then raise(abort, 'bad child') end; END;
create view labelled as select id, label from parent;
create trigger labelled_insert instead of insert on labelled BEGIN insert into parent (id, label) values (new.id, new.label); END;
`,
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "control-plane-baseline-"))
  directories.push(directory)
  for (const [name, sql] of Object.entries(CHAIN)) writeFileSync(path.join(directory, name), sql)
  return directory
}

function run(directory: string, ...flags: string[]) {
  return spawnSync("bun", [path.join(import.meta.dirname, "control-plane-baseline.ts"), ...flags, "--directory", directory], {
    encoding: "utf8",
    env: { ...process.env, HOME: path.join(directory, "home") },
  })
}

function schema(database: Database.Database) {
  return database.prepare("select type, name, tbl_name, sql from sqlite_master where name not like 'sqlite_%' order by type, name").all()
}

function contents(directory: string) {
  return readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")])
}

test("the baseline rebuilds exactly the sqlite_master the chain built, without its rows, and replaces the chain", () => {
  const directory = fixture()
  const chain = new Database(":memory:")
  const baseline = new Database(":memory:")
  try {
    chain.pragma("foreign_keys = ON")
    for (const sql of Object.values(CHAIN)) chain.exec(sql)
    const result = run(directory)
    expect(result.status, result.stderr).toBe(0)
    expect(readdirSync(directory)).toEqual(["0001_baseline.sql"])
    const generated = readFileSync(path.join(directory, "0001_baseline.sql"), "utf8")
    expect(generated).not.toMatch(/^\s*(insert|update|drop|alter)\b/im)
    baseline.pragma("foreign_keys = ON")
    baseline.exec(generated)
    expect(schema(baseline)).toEqual(schema(chain))
    expect(schema(baseline).map((row) => (row as { type: string }).type)).toEqual(["index", "table", "table", "trigger", "trigger", "view"])
    expect(baseline.prepare("select * from parent").all()).toEqual([])
    expect(() => baseline.exec("insert into child(id, parent_id) values ('bad', 'x')")).toThrow("bad child")
    expect(() => baseline.exec("insert into child values ('ok', 'missing')")).toThrow(/FOREIGN KEY/)
    baseline.exec("insert into labelled values ('p', 'through the view')")
    expect(baseline.prepare("select id, label, current from parent").all()).toEqual([{ id: "p", label: "through the view", current: 1 }])
  } finally {
    chain.close()
    baseline.close()
  }
})

test("identical input produces identical bytes, regeneration is a fixed point, and a later migration is folded in", () => {
  const first = fixture()
  const second = fixture()
  expect(run(first).status).toBe(0)
  expect(run(second).status).toBe(0)
  const bytes = () => readFileSync(path.join(first, "0001_baseline.sql"), "utf8")
  expect(bytes()).toBe(readFileSync(path.join(second, "0001_baseline.sql"), "utf8"))
  const original = bytes()
  expect(run(first).status).toBe(0)
  expect(bytes()).toBe(original)
  writeFileSync(path.join(first, "0052_later.sql"), "create table later (id text primary key);")
  const folded = run(first)
  expect(folded.stdout).toContain("folded 1 migrations: 0052_later.sql")
  expect(bytes()).toContain("CREATE TABLE later")
  expect(readdirSync(first)).toEqual(["0001_baseline.sql"])
})

test("a failed migration leaves every input byte untouched", () => {
  const directory = fixture()
  writeFileSync(path.join(directory, "0003_invalid.sql"), "create table child (duplicate text);")
  const before = contents(directory)
  const result = run(directory)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/table child already exists/)
  expect(contents(directory)).toEqual(before)
})

test("a CREATE statement carrying a comment is refused, since D1 would store it without one", () => {
  const directory = fixture()
  writeFileSync(path.join(directory, "0003_commented.sql"), "create table noted (\n  id text primary key -- the key\n);")
  const before = contents(directory)
  const result = run(directory)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("noted: remove the SQL comment")
  expect(contents(directory)).toEqual(before)
})

test("a trigger body with a blank line after a semicolon is refused, since the baseline splits statements there", () => {
  const directory = fixture()
  writeFileSync(path.join(directory, "0003_spaced.sql"), "create trigger spaced after insert on parent BEGIN\n  select 1;\n\n  select 2;\nEND;")
  const result = run(directory)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("spaced: a blank line after a semicolon")
})

test("check refuses a migration beside the baseline and a hand-edited baseline, and writes nothing", () => {
  const directory = fixture()
  expect(run(directory).status).toBe(0)
  expect(run(directory, "--check").status).toBe(0)

  writeFileSync(path.join(directory, "0052_later.sql"), "create table later (id text primary key);")
  const unfolded = run(directory, "--check")
  expect(unfolded.status).not.toBe(0)
  expect(unfolded.stderr).toContain("Migrations not folded into 0001_baseline.sql: 0052_later.sql. Run bun run d1:baseline:generate.")
  expect(readdirSync(directory).sort()).toEqual(["0001_baseline.sql", "0052_later.sql"])
  rmSync(path.join(directory, "0052_later.sql"))

  const baseline = path.join(directory, "0001_baseline.sql")
  writeFileSync(baseline, `${readFileSync(baseline, "utf8")}\nCREATE TABLE appended (id text);\n`)
  const edited = run(directory, "--check")
  expect(edited.status).not.toBe(0)
  expect(edited.stderr).toContain("0001_baseline.sql is not the generator's output. Run bun run d1:baseline:generate.")
})

test("the shipped control-plane migrations are exactly the generated baseline", () => {
  const result = spawnSync("bun", [path.join(import.meta.dirname, "control-plane-baseline.ts"), "--check"], { encoding: "utf8" })
  expect(result.status, result.stderr).toBe(0)
})
