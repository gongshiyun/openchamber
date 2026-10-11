import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { useConfigStore } from "@/stores/useConfigStore"
import { useSessionGoalArmStore } from "@/stores/useSessionGoalArmStore"
import { ChildStoreManager } from "./child-store"
import { setActionRefs, setOptimisticRefs } from "./session-actions"
import { setSyncRefs } from "./sync-refs"
import { routeMessage, useSessionUIStore } from "./session-ui-store"

/**
 * The send-path guards a Claude session needs: no shell route and no goal
 * loop. Both are already hidden from the composer, and these are the last
 * lines of defense for a stale composer or another surface.
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
const originalShellSession = opencodeClient.shellSession
const originalSelection = useSessionUIStore.getState()
let stores: ChildStoreManager
const sent: Array<{ context?: Array<{ text: string }> }> = []
const shellCommands: string[] = []

beforeEach(() => {
  stores = new ChildStoreManager()
  setActionRefs(stores, () => "/repo")
  setSyncRefs(opencodeClient.getSdkClient(), stores, "/repo")
  setOptimisticRefs(() => undefined, () => undefined, () => undefined)
  stores.ensureChild("/repo", { bootstrap: false }).setState({ session: [claudeSession, openCodeSession] })
  // The send path waits for OpenCode's first connection before doing anything.
  useConfigStore.setState({ isConnected: true, hasEverConnected: true })
  useSessionGoalArmStore.setState({ armed: false, objectiveOverride: null })
  sent.length = 0
  shellCommands.length = 0
  opencodeClient.sendMessage = async (params) => {
    sent.push({ context: params.context })
    return "msg_sent"
  }
  opencodeClient.shellSession = async (params) => {
    shellCommands.push(params.command)
    return "shell"
  }
})

afterEach(() => {
  opencodeClient.sendMessage = originalSendMessage
  opencodeClient.shellSession = originalShellSession
  useConfigStore.setState({ isConnected: false, hasEverConnected: false })
  useSessionGoalArmStore.setState({ armed: false, objectiveOverride: null })
  useSessionUIStore.setState(originalSelection)
  stores.disposeAll()
})

describe("shell mode on a Claude session", () => {
  test("routeMessage sends the text as a prompt instead of a shell command", async () => {
    const route = await routeMessage({
      sessionId: "ses_claude",
      directory: "/repo",
      content: "ls -la",
      providerID: "openai",
      modelID: "gpt-5",
      inputMode: "shell",
    })

    expect(route).toBe("prompt")
    expect(shellCommands).toEqual([])
    expect(sent).toHaveLength(1)
  })

  test("sendMessage leaves session.shell alone", async () => {
    useSessionUIStore.setState({ currentSessionId: "ses_claude", currentSessionDirectory: "/repo" })
    await useSessionUIStore.getState().sendMessage(
      "ls -la", "openai", "gpt-5", undefined, undefined, undefined, undefined, undefined, "shell",
    )

    expect(shellCommands).toEqual([])
    expect(sent).toHaveLength(1)
  })

  test("an OpenCode session still routes shell sends to session.shell", async () => {
    const route = await routeMessage({
      sessionId: "ses_opencode",
      directory: "/repo",
      content: "ls -la",
      providerID: "openai",
      modelID: "gpt-5",
      inputMode: "shell",
    })

    expect(route).toBe("shell")
    expect(shellCommands).toEqual(["ls -la"])
    expect(sent).toHaveLength(0)
  })
})

describe("an armed goal on a Claude session", () => {
  test("is consumed and never applied to the send", async () => {
    useSessionGoalArmStore.getState().setArmed(true)
    useSessionUIStore.setState({ currentSessionId: "ses_claude", currentSessionDirectory: "/repo" })

    await useSessionUIStore.getState().sendMessage("hello", "openai", "gpt-5", "build")

    expect(useSessionGoalArmStore.getState().armed).toBe(false)
    const contextTexts = (sent[0]?.context ?? []).map((part) => part.text)
    expect(contextTexts.some((text) => text.includes("Goal mode is active"))).toBe(false)
  })
})
