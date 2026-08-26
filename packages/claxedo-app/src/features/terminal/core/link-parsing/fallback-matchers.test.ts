import { describe, expect, it } from "bun:test"
import { detectFallbackLinks, generateTrimmedCandidates } from "./fallback-matchers"

describe("detectFallbackLinks", () => {
  describe("Python style errors", () => {
    it('detects File "/path/to/file.py", line 42', () => {
      const result = detectFallbackLinks('  File "/path/to/file.py", line 42')
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: '"/path/to/file.py", line 42',
        path: "/path/to/file.py",
        line: 42,
        col: undefined,
        index: 7,
      })
    })

    it('detects File "/path/to/file.py" without line', () => {
      const result = detectFallbackLinks('  File "/path/to/file.py"')
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: '"/path/to/file.py"',
        path: "/path/to/file.py",
        line: undefined,
        col: undefined,
        index: 7,
      })
    })
  })

  describe("Rust/Cargo error format", () => {
    it("detects --> src/main.rs:10:5", () => {
      const result = detectFallbackLinks("   --> src/main.rs:10:5")
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "src/main.rs:10:5",
        path: "src/main.rs",
        line: 10,
        col: 5,
        index: 7,
      })
    })
  })

  describe("C++ compile error formats", () => {
    it("detects /path/to/file.cpp(339): error", () => {
      const result = detectFallbackLinks("/path/to/file.cpp(339): error C2065")
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "/path/to/file.cpp(339)",
        path: "/path/to/file.cpp",
        line: 339,
        col: undefined,
        index: 0,
      })
    })

    it("detects /path/to/file.cpp(339,12): error", () => {
      const result = detectFallbackLinks("/path/to/file.cpp(339,12): error C2065")
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "/path/to/file.cpp(339,12)",
        path: "/path/to/file.cpp",
        line: 339,
        col: 12,
        index: 0,
      })
    })
  })

  describe("Additional tool formats", () => {
    it("detects FILE format", () => {
      const result = detectFallbackLinks("  FILE  /path/to/file.ts:10:5")
      expect(result).toHaveLength(1)
      expect(result[0]?.path).toBe("/path/to/file.ts")
      expect(result[0]?.line).toBe(10)
      expect(result[0]?.col).toBe(5)
    })

    it("detects clang/gcc style paths", () => {
      const result = detectFallbackLinks("/tmp/main.cpp:42:9: error: bad")
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "/tmp/main.cpp:42:9",
        path: "/tmp/main.cpp",
        line: 42,
        col: 9,
        index: 0,
      })
    })

    it("detects clang/gcc windows-drive paths with spaces", () => {
      const result = detectFallbackLinks("C:\\foo/bar baz:339: error ...")
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "C:\\foo/bar baz:339",
        path: "C:\\foo/bar baz",
        line: 339,
        col: undefined,
        index: 0,
      })
    })

    it("does not swallow message prefixes into clang/gcc paths", () => {
      // Anchored matcher: a "warning: " prefix means no fallback link at all,
      // never a link whose path starts with "warning: ".
      expect(detectFallbackLinks("warning: /path/file.c:10:2: note")).toEqual([])
    })

    it("detects go compiler format", () => {
      const result = detectFallbackLinks("pkg/main.go:22:7: undefined: x")
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "pkg/main.go:22:7",
        path: "pkg/main.go",
        line: 22,
        col: 7,
        index: 0,
      })
    })

    it("detects Java/Kotlin stack trace format", () => {
      const result = detectFallbackLinks("at com.example.Main.run(Main.java:12)")
      expect(result).toHaveLength(1)
      expect(result[0]?.path).toBe("Main.java")
      expect(result[0]?.line).toBe(12)
    })

    it("reports the matched occurrence index when the link text appears earlier", () => {
      const line = "Main.java:12 at com.example.Main.run(Main.java:12)"
      const result = detectFallbackLinks(line)
      expect(result).toHaveLength(1)
      expect(result[0]?.index).toBe(line.lastIndexOf("Main.java:12"))
    })

    it("detects Node.js stack trace format", () => {
      const line = "at Object.<anonymous> (/tmp/app.js:99:13)"
      const result = detectFallbackLinks(line)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "/tmp/app.js:99:13",
        path: "/tmp/app.js",
        line: 99,
        col: 13,
        index: line.indexOf("/tmp/app.js"),
      })
    })

    it("reports the capture-group index when the link text repeats inside the match", () => {
      const line = "at A.java:12.run(A.java:12)"
      const result = detectFallbackLinks(line)
      expect(result).toHaveLength(1)
      expect(result[0]?.index).toBe(line.lastIndexOf("A.java:12"))
    })

    it("detects eslint/ts style with dash separator", () => {
      const result = detectFallbackLinks("/tmp/app.ts:3:4 - error TS1005: ';' expected")
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "/tmp/app.ts:3:4",
        path: "/tmp/app.ts",
        line: 3,
        col: 4,
        index: 0,
      })
    })

    it("detects webpack/vite style", () => {
      const result = detectFallbackLinks("@ ./src/file.ts 10:5-20")
      expect(result).toHaveLength(1)
      expect(result[0]?.path).toBe("./src/file.ts")
      expect(result[0]?.line).toBe(10)
      expect(result[0]?.col).toBe(5)
    })

    it("detects ruby format", () => {
      const result = detectFallbackLinks("from /tmp/main.rb:14:in `run'")
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "/tmp/main.rb:14",
        path: "/tmp/main.rb",
        line: 14,
        col: undefined,
        index: 5,
      })
    })

    it("detects python paths with spaces", () => {
      const line = '  File "/tmp/my dir/x.py", line 3'
      const result = detectFallbackLinks(line)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: '"/tmp/my dir/x.py", line 3',
        path: "/tmp/my dir/x.py",
        line: 3,
        col: undefined,
        index: 7,
      })
    })

    it("does not extend a python path across a later quoted string", () => {
      const result = detectFallbackLinks('  File "/a.py", line 1, in "b"')
      expect(result).toHaveLength(1)
      expect(result[0]?.path).toBe("/a.py")
      expect(result[0]?.line).toBe(1)
    })

    it("detects php format", () => {
      const result = detectFallbackLinks("in /tmp/index.php on line 23")
      expect(result).toHaveLength(1)
      expect(result[0]?.path).toBe("/tmp/index.php")
      expect(result[0]?.line).toBe(23)
    })

    it("detects swift format", () => {
      const result = detectFallbackLinks("/tmp/App.swift:11:2: error: oops")
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        link: "/tmp/App.swift:11:2",
        path: "/tmp/App.swift",
        line: 11,
        col: 2,
        index: 0,
      })
    })

    it("detects PowerShell prompt paths", () => {
      const result = detectFallbackLinks("PS C:\\Users\\foo>")
      expect(result).toHaveLength(1)
      expect(result[0]?.path).toBe("C:\\Users\\foo")
    })
  })

  it("returns empty array for non-matching lines", () => {
    expect(detectFallbackLinks("just some regular text")).toEqual([])
    expect(detectFallbackLinks("")).toEqual([])
  })
})

describe("generateTrimmedCandidates", () => {
  it("generates candidates by trimming trailing punctuation", () => {
    const result = generateTrimmedCandidates("/path/to/file.ts.")
    expect(result).toEqual([{ path: "/path/to/file.ts", trimAmount: 1 }])
  })

  it("handles paths ending with multiple special chars", () => {
    const result = generateTrimmedCandidates("/path/to/file.ts...")
    // The regex matches multiple chars at once, so we get one candidate
    expect(result.length).toBeGreaterThanOrEqual(1)
    // The final trimmed path should be without the trailing dots
    const lastCandidate = result[result.length - 1]
    expect(lastCandidate?.path).toBe("/path/to/file.ts")
  })

  it("handles paths ending with brackets", () => {
    const result = generateTrimmedCandidates("/path/to/file]")
    expect(result).toEqual([{ path: "/path/to/file", trimAmount: 1 }])
  })

  it("returns empty array for paths without trailing punctuation", () => {
    expect(generateTrimmedCandidates("/path/to/file.ts")).toEqual([])
    expect(generateTrimmedCandidates("")).toEqual([])
  })
})
