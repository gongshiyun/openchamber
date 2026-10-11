import { describe, expect, test } from "bun:test"
import type { Session } from "./opencode/model"
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODEL_ALIASES,
  CLAUDE_PERMISSION_MODES,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  isClaudeBackendSession,
  isClaudeEffort,
  isClaudeModelAlias,
  isClaudePermissionMode,
  selectClaudeSessionEffort,
  selectClaudeSessionModel,
  selectClaudeSessionPermissionMode,
  selectIsClaudeBackendSession,
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

describe("Claude permission modes", () => {
  test("the static list is the wire contract, in order", () => {
    expect([...CLAUDE_PERMISSION_MODES]).toEqual(["default", "acceptEdits", "bypassPermissions"])
    expect(CLAUDE_PERMISSION_MODES).toContain(DEFAULT_CLAUDE_PERMISSION_MODE)
  })

  test("only the mode list validates", () => {
    for (const mode of CLAUDE_PERMISSION_MODES) expect(isClaudePermissionMode(mode)).toBe(true)
    expect(isClaudePermissionMode("ask")).toBe(false)
    expect(isClaudePermissionMode("")).toBe(false)
  })

  test("an absent or unknown stored mode reads as the default", () => {
    expect(selectClaudeSessionPermissionMode(sessionWith({ openchamber: { backend: "claude" } }))).toBe("default")
    expect(selectClaudeSessionPermissionMode(sessionWith({ openchamber: { backend: "claude", permissionMode: "acceptEdits" } }))).toBe("acceptEdits")
    expect(selectClaudeSessionPermissionMode(sessionWith({ openchamber: { backend: "claude", permissionMode: "ask" } }))).toBe("default")
    expect(selectClaudeSessionPermissionMode(sessionWith({ openchamber: { backend: "claude", permissionMode: 7 } }))).toBe("default")
  })

  test("a non-Claude record has no Claude permission mode", () => {
    expect(selectClaudeSessionPermissionMode(sessionWith({ openchamber: { backend: "opencode" } }))).toBeNull()
    expect(selectClaudeSessionPermissionMode(sessionWith(undefined))).toBeNull()
    expect(selectClaudeSessionPermissionMode(undefined)).toBeNull()
  })
})

describe("Claude effort levels", () => {
  test("the static list is the wire contract, in order", () => {
    expect([...CLAUDE_EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("only the effort list validates", () => {
    for (const level of CLAUDE_EFFORT_LEVELS) expect(isClaudeEffort(level)).toBe(true)
    expect(isClaudeEffort("xhigh ")).toBe(false)
    expect(isClaudeEffort("")).toBe(false)
  })

  test("an absent or unknown stored effort reads as unset", () => {
    expect(selectClaudeSessionEffort(sessionWith({ openchamber: { backend: "claude" } }))).toBeNull()
    expect(selectClaudeSessionEffort(sessionWith({ openchamber: { backend: "claude", effort: "high" } }))).toBe("high")
    expect(selectClaudeSessionEffort(sessionWith({ openchamber: { backend: "claude", effort: "turbo" } }))).toBeNull()
    expect(selectClaudeSessionEffort(sessionWith({ openchamber: { backend: "claude", effort: false } }))).toBeNull()
  })

  test("a non-Claude record has no Claude effort", () => {
    expect(selectClaudeSessionEffort(sessionWith({ openchamber: { backend: "opencode", effort: "high" } }))).toBeNull()
    expect(selectClaudeSessionEffort(undefined)).toBeNull()
  })
})

describe("selectIsClaudeBackendSession", () => {
  test("matches isClaudeBackendSession and reads an unknown record as false", () => {
    expect(selectIsClaudeBackendSession(sessionWith({ openchamber: { backend: "claude" } }))).toBe(true)
    expect(selectIsClaudeBackendSession(sessionWith({ openchamber: { backend: "opencode" } }))).toBe(false)
    expect(selectIsClaudeBackendSession(undefined)).toBe(false)
  })
})
