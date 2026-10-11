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

/** Permission modes the Claude backend accepts; absent metadata reads as the default. */
export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions"] as const
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number]
export const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = "default"

/** Reasoning effort levels the Claude backend accepts; absent metadata reads as unset. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number]

const isJsonObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } =>
  value !== undefined && value !== null && !Array.isArray(value) && Object(value) === value

/** True when the session record says it runs on the Claude Code backend. */
export const isClaudeBackendSession = (session: Pick<Session, "metadata">): boolean => {
  const openchamber = session.metadata?.openchamber
  return isJsonObject(openchamber) && openchamber.backend === CLAUDE_BACKEND
}

/** True when the value names a permission mode the backend accepts. */
export const isClaudePermissionMode = (value: string): value is ClaudePermissionMode =>
  CLAUDE_PERMISSION_MODES.some((mode) => mode === value)

/** True when the value names an effort level the backend accepts. */
export const isClaudeEffort = (value: string): value is ClaudeEffort =>
  CLAUDE_EFFORT_LEVELS.some((level) => level === value)

/** True when the value names a Claude model alias the backend accepts. */
export const isClaudeModelAlias = (value: string): value is ClaudeModelAlias =>
  CLAUDE_MODEL_ALIASES.some((alias) => alias === value)

/**
 * The Claude model a session record runs on, or null when the session is not
 * Claude-backed. A Claude record whose model is not a known alias — not
 * written yet, or written by a version that knew a different list — reads as
 * the default alias, so the picker always has a selection to show.
 */
export const selectClaudeSessionModel = (
  session: Pick<Session, "metadata" | "model"> | undefined,
): ClaudeModelAlias | null => {
  if (!session || !isClaudeBackendSession(session)) return null
  const model = session.model
  return model && model.providerID === CLAUDE_PROVIDER_ID && isClaudeModelAlias(model.id)
    ? model.id
    : DEFAULT_CLAUDE_MODEL
}

/** True for a record that runs on Claude Code; false while the record is unknown. */
export const selectIsClaudeBackendSession = (session: Pick<Session, "metadata"> | undefined): boolean =>
  session !== undefined && isClaudeBackendSession(session)

const claudeOpenchamberNamespace = (session: Pick<Session, "metadata">): { [key: string]: JsonValue } | null => {
  const openchamber = session.metadata?.openchamber
  return isJsonObject(openchamber) ? openchamber : null
}

/**
 * The permission mode a Claude session runs with. Null for a non-Claude record;
 * an absent or unknown stored value reads as the default, the same healing the
 * server applies to the record.
 */
export const selectClaudeSessionPermissionMode = (session: Pick<Session, "metadata"> | undefined): ClaudePermissionMode | null => {
  if (!session || !isClaudeBackendSession(session)) return null
  const stored = claudeOpenchamberNamespace(session)?.permissionMode
  return CLAUDE_PERMISSION_MODES.find((mode) => mode === stored) ?? DEFAULT_CLAUDE_PERMISSION_MODE
}

/**
 * The reasoning effort a Claude session runs with, or null when unset (also
 * null for a non-Claude record: the composer only reads it inside a Claude
 * branch).
 */
export const selectClaudeSessionEffort = (session: Pick<Session, "metadata"> | undefined): ClaudeEffort | null => {
  if (!session || !isClaudeBackendSession(session)) return null
  const stored = claudeOpenchamberNamespace(session)?.effort
  return CLAUDE_EFFORT_LEVELS.find((level) => level === stored) ?? null
}
