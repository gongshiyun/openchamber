import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ModelRef, Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { useConfigStore } from "@/stores/useConfigStore"
import { ChildStoreManager } from "./child-store"
import { setActionRefs, setOptimisticRefs } from "./session-actions"
import { setSyncRefs } from "./sync-refs"
import { resolveSendSelection, routeMessage, useSessionUIStore } from "./session-ui-store"
import { useSelectionStore } from "./selection-store"

/**
 * A send's model/agent selection: a Claude session runs on its own backend
 * model, so the composer's OpenCode pick and agent never travel as a switch;
 * an OpenCode session keeps switching on a genuine change.
 */

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const claudeSession: Session = {
  id: "ses_claude",
  projectID: "project",
  directory: "/repo",
  title: "Claude session",
  cost: 0,
  tokens,
  time: { created: 1, updated: 1 },
  metadata: { openchamber: { backend: "claude" } },
  model: { providerID: "claude-code", id: "opus" },
}

const openCodeSession: Session = {
  id: "ses_opencode",
  projectID: "project",
  directory: "/repo",
  title: "OpenCode session",
  cost: 0,
  tokens,
  time: { created: 1, updated: 1 },
  metadata: { openchamber: { backend: "opencode" } },
  model: { providerID: "openai", id: "gpt-5" },
  agent: "build",
}

const originalSendMessage = opencodeClient.sendMessage
const originalSelection = useSessionUIStore.getState()
let stores: ChildStoreManager
const sent: Array<{ model?: ModelRef; agent?: string }> = []

beforeEach(() => {
  stores = new ChildStoreManager()
  setActionRefs(stores, () => "/repo")
  setSyncRefs(opencodeClient.getSdkClient(), stores, "/repo")
  setOptimisticRefs(() => undefined, () => undefined, () => undefined)
  stores.ensureChild("/repo", { bootstrap: false }).setState({ session: [claudeSession, openCodeSession] })
  // The send path waits for OpenCode's first connection before doing anything.
  useConfigStore.setState({ isConnected: true, hasEverConnected: true })
  sent.length = 0
  opencodeClient.sendMessage = async (params) => {
    sent.push({ model: params.model, agent: params.agent })
    return "msg_sent"
  }
})

afterEach(() => {
  opencodeClient.sendMessage = originalSendMessage
  useConfigStore.setState({ isConnected: false, hasEverConnected: false })
  useSessionUIStore.setState(originalSelection)
  stores.disposeAll()
})

describe("resolveSendSelection", () => {
  test("a Claude session never takes the composer's OpenCode selection", () => {
    expect(resolveSendSelection("ses_claude", "/repo", {
      providerID: "openai",
      modelID: "gpt-5",
      agent: "build",
    })).toEqual({})
  })

  test("an OpenCode session still switches on a genuine change", () => {
    expect(resolveSendSelection("ses_opencode", "/repo", {
      providerID: "anthropic",
      modelID: "claude-x",
      agent: "plan",
    })).toEqual({
      model: { providerID: "anthropic", id: "claude-x", variant: undefined },
      agent: "plan",
    })
  })

  test("an OpenCode session sends nothing when the selection already matches", () => {
    expect(resolveSendSelection("ses_opencode", "/repo", {
      providerID: "openai",
      modelID: "gpt-5",
      agent: "build",
    })).toEqual({})
  })
})

describe("a send on a Claude session", () => {
  test("reaches the prompt without a model or agent switch", async () => {
    const route = await routeMessage({
      sessionId: "ses_claude",
      directory: "/repo",
      content: "hello",
      providerID: "openai",
      modelID: "gpt-5",
      agent: "build",
    })

    expect(route).toBe("prompt")
    expect(sent).toEqual([{ model: undefined, agent: undefined }])
  })

  test("does not record the OpenCode selection as the session's own", async () => {
    useSessionUIStore.setState({ currentSessionId: "ses_claude", currentSessionDirectory: "/repo" })
    await useSessionUIStore.getState().sendMessage("hello", "openai", "gpt-5", "build")

    expect(sent).toEqual([{ model: undefined, agent: undefined }])
    expect(useSelectionStore.getState().getSessionModelSelection("ses_claude")).toBeNull()
  })
})

describe("a send on an OpenCode session", () => {
  test("still carries the changed model and agent to the prompt", async () => {
    const route = await routeMessage({
      sessionId: "ses_opencode",
      directory: "/repo",
      content: "hello",
      providerID: "anthropic",
      modelID: "claude-x",
      agent: "plan",
    })

    expect(route).toBe("prompt")
    expect(sent).toEqual([{
      model: { providerID: "anthropic", id: "claude-x", variant: undefined },
      agent: "plan",
    }])
  })
})
