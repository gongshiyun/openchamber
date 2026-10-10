/**
 * The Claude Code backend, as the shared UI knows it.
 *
 * A session runs on exactly one backend, fixed when it is created. The server
 * creates a Claude session when the session-create request carries the backend
 * header; the UI selects it through the pseudo-provider the server exposes, so
 * the model (`claude-code/<alias>`) is the whole choice and no separate state
 * travels beside the SDK call. Session records served for Claude sessions say
 * so in their metadata, which is what the sidebar badge reads.
 */

import type { JsonValue, Session } from "@/lib/opencode/model"

/** Provider id the server exposes for sessions created on Claude Code. */
export const CLAUDE_PROVIDER_ID = "claude-code"

/** The backend value the server reads from the session-create request header. */
export const CLAUDE_BACKEND = "claude"

/** Header the server reads to route a session create to the Claude backend. */
export const OPENCHAMBER_BACKEND_HEADER = "x-openchamber-backend"

/**
 * Claude model aliases the backend accepts, in picker order. v1 keeps this
 * list static instead of reading a provider catalog.
 */
export const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number]

/** Alias a Claude session starts on when the draft has not picked one. */
export const DEFAULT_CLAUDE_MODEL: ClaudeModelAlias = "opus"

const isJsonObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } =>
  value !== undefined && value !== null && !Array.isArray(value) && Object(value) === value

/** True when the session record says it runs on the Claude Code backend. */
export const isClaudeBackendSession = (session: Pick<Session, "metadata">): boolean => {
  const openchamber = session.metadata?.openchamber
  return isJsonObject(openchamber) && openchamber.backend === CLAUDE_BACKEND
}
