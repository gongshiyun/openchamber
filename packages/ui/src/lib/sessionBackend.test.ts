import { describe, expect, test } from "bun:test"
import type { Session } from "./opencode/model"
import {
  CLAUDE_MODEL_ALIASES,
  DEFAULT_CLAUDE_MODEL,
  isClaudeBackendSession,
  isClaudeModelAlias,
  selectClaudeSessionModel,
} from "./sessionBackend"

const sessionWith = (metadata: Session["metadata"]): Pick<Session, "metadata"> => ({ metadata })

const claudeRecord = (
  model?: Session["model"],
  metadata: Session["metadata"] = { openchamber: { backend: "claude" } },
): Pick<Session, "metadata" | "model"> => ({ metadata, model })

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

  test("only the alias list validates", () => {
    for (const alias of CLAUDE_MODEL_ALIASES) expect(isClaudeModelAlias(alias)).toBe(true)
    expect(isClaudeModelAlias("gpt-5")).toBe(false)
    expect(isClaudeModelAlias("")).toBe(false)
  })
})

describe("the Claude model a session runs on", () => {
  test("reads the alias off a Claude record", () => {
    expect(selectClaudeSessionModel(claudeRecord({ providerID: "claude-code", id: "haiku" }))).toBe("haiku")
  })

  test("a Claude record without a usable alias reads as the default", () => {
    expect(selectClaudeSessionModel(claudeRecord(undefined))).toBe(DEFAULT_CLAUDE_MODEL)
    expect(selectClaudeSessionModel(claudeRecord({ providerID: "openai", id: "gpt-5" }))).toBe(DEFAULT_CLAUDE_MODEL)
    expect(selectClaudeSessionModel(claudeRecord({ providerID: "claude-code", id: "gpt-5" }))).toBe(DEFAULT_CLAUDE_MODEL)
  })

  test("an OpenCode session has no Claude model", () => {
    expect(selectClaudeSessionModel({
      metadata: { openchamber: { backend: "opencode" } },
      model: { providerID: "openai", id: "gpt-5" },
    })).toBeNull()
    expect(selectClaudeSessionModel(sessionWith(undefined))).toBeNull()
    expect(selectClaudeSessionModel(undefined)).toBeNull()
  })
})
