export type Variable = { readonly name: string; readonly label: string }

export type PromptTemplate = {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly description: string
  readonly body: string
  readonly variables: readonly Variable[]
}

export const BUILT_IN_CATEGORIES: readonly string[] = ["Debugging", "Testing", "Refactoring", "Review", "Documentation", "Planning"]

export const BUILT_IN_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: "reproduce-bug",
    name: "Reproduce and fix a bug",
    category: "Debugging",
    description: "Turns a bug report into a failing test, then a fix.\n\n- **Use when** a user-visible symptom has no known cause.\n- **You get** the root cause in two sentences and the list of changed files.",
    body: "A user reports: {symptom}.\n\nReproduce it in {area} with a failing test first. Then find the root cause and fix it without weakening the test. Explain the cause in two sentences and list every file you changed.",
    variables: [
      { name: "symptom", label: "Symptom" },
      { name: "area", label: "Area of the code" },
    ],
  },
  {
    id: "flaky-test",
    name: "Investigate a flaky test",
    category: "Debugging",
    description: "Finds the source of nondeterminism in a test.\n\n- **Use when** a test passes and fails without code changes.\n- Looks at ordering, timers, shared state and network.",
    body: "The test {testName} fails about {frequency} of runs. Run it repeatedly, find the source of nondeterminism (ordering, timers, shared state, network) and fix the cause. Do not add retries or longer timeouts.",
    variables: [
      { name: "testName", label: "Test name" },
      { name: "frequency", label: "Failure rate" },
    ],
  },
  {
    id: "perf-regression",
    name: "Trace a performance regression",
    category: "Debugging",
    description: "Measures before changing anything.\n\n- **Use when** an operation got slower.\n- Asks for a measured before/after number.",
    body: "{operation} used to take {baseline} and now takes {current}. Measure it, bisect the change that made it slower, and propose the smallest fix. Report the before and after numbers you measured.",
    variables: [
      { name: "operation", label: "Operation" },
      { name: "baseline", label: "Previous duration" },
      { name: "current", label: "Current duration" },
    ],
  },
  {
    id: "unit-tests",
    name: "Write unit tests",
    category: "Testing",
    description: "Covers behaviour, not implementation.\n\n- **Use when** a module has little or no coverage.\n- Each test names the behaviour it proves.",
    body: "Write unit tests for {module}, focusing on {focus}. Test observable behaviour through the public API, including the failure paths. Name each test after the behaviour it proves and run the suite before you finish.",
    variables: [
      { name: "module", label: "Module" },
      { name: "focus", label: "Focus" },
    ],
  },
  {
    id: "e2e-test",
    name: "Add an end-to-end test",
    category: "Testing",
    description: "Drives the real entrypoint.\n\n- **Use when** a user flow broke and unit tests missed it.",
    body: "Add an end-to-end test for the flow \"{flow}\" starting from {entrypoint}. Drive it the way a person would, assert on what they would see, and make sure the test fails if the flow breaks.",
    variables: [
      { name: "flow", label: "User flow" },
      { name: "entrypoint", label: "Entrypoint" },
    ],
  },
  {
    id: "coverage",
    name: "Raise coverage for a file",
    category: "Testing",
    description: "Targets the untested branches of one file.\n\n- **Use when** a coverage report shows a weak spot.",
    body: "Raise test coverage of {file} to at least {target}. Start from the uncovered branches, prefer meaningful cases over line-chasing, and report the coverage before and after.",
    variables: [
      { name: "file", label: "File" },
      { name: "target", label: "Coverage target" },
    ],
  },
  {
    id: "extract-module",
    name: "Extract a module",
    category: "Refactoring",
    description: "Moves one concept into its own module.\n\n- **Use when** a file holds several responsibilities.\n- Keeps behaviour identical.",
    body: "In {source}, the concept \"{concept}\" is mixed with unrelated code. Extract it into its own module with a narrow API, update the callers, and keep behaviour identical. Run the tests after each step.",
    variables: [
      { name: "source", label: "Source file" },
      { name: "concept", label: "Concept" },
    ],
  },
  {
    id: "dead-code",
    name: "Remove dead code",
    category: "Refactoring",
    description: "Deletes what nothing reaches.\n\n- **Use when** a directory has accumulated unused exports, flags or helpers.",
    body: "Find code in {directory} that nothing reaches: unused exports, stale feature flags, helpers with no callers. Prove each one is unused with a search, delete it, and run the typecheck and tests.",
    variables: [{ name: "directory", label: "Directory" }],
  },
  {
    id: "review-pr",
    name: "Review a pull request",
    category: "Review",
    description: "Correctness first, style last.\n\n- **Use when** a branch is ready for review.\n- Every finding cites a file and line.",
    body: "Review the changes on {branch}. Report correctness bugs first, then {risk}, then readability. Cite the file and line for every finding and say how confident you are.",
    variables: [
      { name: "branch", label: "Branch" },
      { name: "risk", label: "Risk to look for" },
    ],
  },
  {
    id: "security-review",
    name: "Security review",
    category: "Review",
    description: "Looks for exploitable issues on one surface.\n\n- **Use when** code handles untrusted input, secrets or permissions.",
    body: "Do a security review of {surface}. Look for injection, missing authorization, secret leakage and unsafe deserialization. For each finding, give a concrete exploit scenario and a fix.",
    variables: [{ name: "surface", label: "Surface" }],
  },
  {
    id: "api-review",
    name: "API design review",
    category: "Review",
    description: "Judges an API from its callers' side.\n\n- **Use when** a public interface is about to be published.",
    body: "Review the design of {api} as used by {consumers}. Check naming, error handling, what a caller must know that the types do not say, and what will be hard to change later. Suggest a smaller API if one exists.",
    variables: [
      { name: "api", label: "API" },
      { name: "consumers", label: "Consumers" },
    ],
  },
  {
    id: "explain-subsystem",
    name: "Explain a subsystem",
    category: "Documentation",
    description: "Traces the real code flow.\n\n- **Use when** someone new needs to change a subsystem.",
    body: "Explain how {subsystem} works for {audience}. Start from the event that triggers it, trace the code in order with exact file and function names, and say where its state lives.",
    variables: [
      { name: "subsystem", label: "Subsystem" },
      { name: "audience", label: "Audience" },
    ],
  },
  {
    id: "changelog",
    name: "Write a changelog entry",
    category: "Documentation",
    description: "Summarises user-visible changes.\n\n- **Use when** cutting a release.",
    body: "Write a changelog entry for the commits in {range}. Group them by user-visible effect, skip internal refactors, and write each line as what a user can now do or no longer hits.",
    variables: [{ name: "range", label: "Commit range" }],
  },
  {
    id: "plan-feature",
    name: "Plan a feature",
    category: "Planning",
    description: "Produces reviewable slices.\n\n- **Use when** a feature is too large for one change.",
    body: "Plan the feature \"{feature}\" under these constraints: {constraints}. Read the code it touches first, then split the work into reviewable slices, each with its acceptance check and the files it changes.",
    variables: [
      { name: "feature", label: "Feature" },
      { name: "constraints", label: "Constraints" },
    ],
  },
  {
    id: "migration-plan",
    name: "Migration plan",
    category: "Planning",
    description: "Moves from one dependency or pattern to another.\n\n- **Use when** replacing a library or an internal pattern.",
    body: "Plan the migration from {from} to {to}. Inventory every use, order the steps so the build stays green after each one, and finish by removing the old path entirely.",
    variables: [
      { name: "from", label: "From" },
      { name: "to", label: "To" },
    ],
  },
]
