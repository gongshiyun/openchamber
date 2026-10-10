import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ModelRef, Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { materializeOpenDraftSession, useSessionUIStore } from "./session-ui-store"

/**
 * What a draft is created on: a Claude draft ignores the composer's OpenCode
 * pick and goes to the Claude model the backend control chose, while an
 * OpenCode draft keeps passing the selection through untouched.
 */

type CreateParams = { model?: ModelRef; agent?: string; title?: string }

const originalCreateSession = opencodeClient.createSession
const originalDirectory = opencodeClient.getDirectory()
const originalSelection = useSessionUIStore.getState()
let createCalls: CreateParams[] = []

const session: Session = {
  id: "ses_backend",
  projectID: "project-backend",
  directory: "/repo",
  title: "New session",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  model: { providerID: "claude-code", id: "sonnet" },
}

const openDraft = (claudeBackend?: { model: "opus" | "sonnet" | "haiku" | "fable" }) => {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    newSessionDraft: {
      draftId: 11,
      open: true,
      directoryOverride: "/repo",
      parentID: null,
      target: "project",
      // An explicit target keeps the create off the availability probe, which
      // would need a server.
      preserveDirectoryOverride: true,
      claudeBackend,
    },
  })
}

beforeEach(() => {
  createCalls = []
  opencodeClient.createSession = async (params) => {
    createCalls.push(params ?? {})
    return session
  }
})

afterEach(() => {
  opencodeClient.createSession = originalCreateSession
  opencodeClient.setDirectory(originalDirectory)
  useSessionUIStore.setState(originalSelection)
})

describe("draft backend selection", () => {
  test("a Claude draft is created on the Claude model, not the composer's OpenCode pick", async () => {
    openDraft({ model: "sonnet" })

    const result = await materializeOpenDraftSession({
      providerID: "openai",
      modelID: "gpt-5",
      agent: "build",
      variant: "high",
    })

    expect(createCalls).toHaveLength(1)
    expect(createCalls[0].model).toEqual({ providerID: "claude-code", id: "sonnet", variant: undefined })
    expect(createCalls[0].agent).toBeUndefined()
    expect(result?.model).toEqual({ providerID: "claude-code", modelID: "sonnet", variant: undefined })
    expect(result?.agent).toBeUndefined()
  })

  test("an OpenCode draft keeps passing the selection through", async () => {
    openDraft(undefined)

    const result = await materializeOpenDraftSession({
      providerID: "openai",
      modelID: "gpt-5",
      agent: " build ",
      variant: "high",
    })

    expect(createCalls).toHaveLength(1)
    expect(createCalls[0].model).toEqual({ providerID: "openai", id: "gpt-5", variant: "high" })
    expect(createCalls[0].agent).toBe("build")
    expect(result?.model).toEqual({ providerID: "openai", modelID: "gpt-5", variant: "high" })
    expect(result?.agent).toBe("build")
  })
})

describe("draft backend state", () => {
  test("picking and clearing the Claude backend updates the open draft only", () => {
    openDraft(undefined)

    useSessionUIStore.getState().setDraftClaudeBackend({ model: "haiku" })
    expect(useSessionUIStore.getState().newSessionDraft.claudeBackend).toEqual({ model: "haiku" })

    useSessionUIStore.getState().setDraftClaudeBackend(null)
    expect(useSessionUIStore.getState().newSessionDraft.claudeBackend).toBeUndefined()

    useSessionUIStore.setState((state) => ({ newSessionDraft: { ...state.newSessionDraft, open: false } }))
    useSessionUIStore.getState().setDraftClaudeBackend({ model: "opus" })
    expect(useSessionUIStore.getState().newSessionDraft.claudeBackend).toBeUndefined()
  })

  test("closing the draft drops the backend choice with the rest of the draft", () => {
    openDraft({ model: "opus" })

    useSessionUIStore.getState().closeNewSessionDraft()

    const draft = useSessionUIStore.getState().newSessionDraft
    expect(draft.open).toBe(false)
    expect(draft.claudeBackend).toBeUndefined()
  })
})
