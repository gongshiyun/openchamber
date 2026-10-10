import { describe, expect, test } from "bun:test"
import type { Session } from "./opencode/model"
import { CLAUDE_MODEL_ALIASES, DEFAULT_CLAUDE_MODEL, isClaudeBackendSession } from "./sessionBackend"

const sessionWith = (metadata: Session["metadata"]): Pick<Session, "metadata"> => ({ metadata })

describe("session backend metadata", () => {
  test("a record marked by the server reads as Claude", () => {
    expect(isClaudeBackendSession(sessionWith({ openchamber: { backend: "claude" } }))).toBe(true)
  })

  test("OpenCode sessions and unmarked records stay unmarked", () => {
    expect(isClaudeBackendSession(sessionWith({ openchamber: { backend: "opencode" } }))).toBe(false)
    expect(isClaudeBackendSession(sessionWith({ openchamber: {} }))).toBe(false)
    expect(isClaudeBackendSession(sessionWith({}))).toBe(false)
    expect(isClaudeBackendSession(sessionWith(undefined))).toBe(false)
    // Malformed metadata is not a Claude marker, whatever shape it took.
    expect(isClaudeBackendSession(sessionWith({ openchamber: "claude" }))).toBe(false)
    expect(isClaudeBackendSession(sessionWith({ openchamber: ["claude"] }))).toBe(false)
    expect(isClaudeBackendSession(sessionWith({ openchamber: { backend: ["claude"] } }))).toBe(false)
  })
})

describe("Claude model aliases", () => {
  test("the static list is the v1 picker source, in order", () => {
    expect([...CLAUDE_MODEL_ALIASES]).toEqual(["opus", "sonnet", "haiku", "fable"])
  })

  test("the default alias is one the backend accepts", () => {
    expect(CLAUDE_MODEL_ALIASES).toContain(DEFAULT_CLAUDE_MODEL)
  })
})
