import express from 'express';

import { isString } from '../shared/guards.js';

/**
 * The OpenCode v2 HTTP subset a Claude session serves, mounted at `/api`.
 *
 * The UI reaches the server through `@opencode/client` 2.0.25, whose generated
 * methods join their `/api/...` paths onto the base URL. This router answers
 * exactly the routes those methods call for a Claude session, with the same
 * methods, success statuses, and envelopes:
 *
 *   POST   /api/session                          session.create      -> 200 { data }
 *   GET    /api/session/:sessionID               session.get         -> 200 { data }
 *   PATCH  /api/session/:sessionID               session.update      -> 204
 *   DELETE /api/session/:sessionID               session.remove      -> 204
 *   POST   /api/session/:sessionID/move          session.move        -> 204
 *   POST   /api/session/:sessionID/model         session.switchModel -> 204
 *   POST   /api/session/:sessionID/agent         session.switchAgent -> 204
 *   POST   /api/session/:sessionID/prompt        session.prompt      -> 200 { data }
 *   POST   /api/session/:sessionID/generate      session.generate    -> 200 { data }
 *   POST   /api/session/:sessionID/synthetic     session.synthetic   -> 200 { data }
 *   POST   /api/session/:sessionID/interrupt     session.interrupt   -> 200 { interrupted }
 *   GET    /api/session/:sessionID/message       message.list        -> 200 { data, cursor }
 *   POST   /api/session/:sessionID/permission/:permID/reply          -> 204
 *
 * Paths, statuses, and envelopes come from the generated client in
 * node_modules/@opencode/client/dist/chunks/service-probe-9h52wrcy.js
 * (`session.create`, `session.get`, `session.update`, `session.remove`,
 * `session.move`, `session.switchModel`, `session.switchAgent`,
 * `session.prompt`, `session.generate`, `session.synthetic`,
 * `session.interrupt`, `message.list`, `permission.reply`).
 * Single-record answers arrive wrapped in `{ data }`; `interrupt` is the one
 * answer the SDK reads raw (`SessionInterruptResponse`), and `message.list`
 * keeps the `{ data, cursor }` page (`SessionMessagesResponse`).
 *
 * Errors use OpenCode's tagged body `{ _tag, message }`: the generated client
 * rethrows the parsed body for a declared status, and the shared UI maps the
 * tag back to a status (STATUS_BY_TAG in packages/ui/src/lib/opencode/client.ts).
 * `session.generate` declares 400/401/404/503, so its runtime failures answer
 * the tagged 503 (`ServiceUnavailableError`); the route validates the prompt
 * itself and answers 400 for a missing one.
 *
 * Every session-scoped route answers only for a session the registry owns
 * (`registry.isClaudeSession`); anything else leaves the router through
 * `next('router')` so the OpenCode proxy keeps serving it.
 *
 * @param {{ registry: {
 *   isClaudeSession: (sessionID: string) => boolean | Promise<boolean>,
 *   createSession: (input: { id?: string, title?: string, agent?: string, model?: object, metadata?: object, directory?: string }) => object | Promise<object>,
 *   getSession: (sessionID: string) => object | null | Promise<object | null>,
 *   renameSession: (sessionID: string, title: string) => void | Promise<void>,
 *   removeSession: (sessionID: string) => void | Promise<void>,
 *   moveSession: (sessionID: string, directory: string) => void | Promise<void>,
 *   sendPrompt: (sessionID: string, input: { text: string, id?: string, files?: unknown[], agents?: unknown[], skills?: unknown[], metadata?: object, delivery?: string }) => object | Promise<object>,
 *   generate: (sessionID: string, prompt: string) => { text: string } | Promise<{ text: string }>,
 *   synthetic: (sessionID: string, input: { id?: string, text: string, description?: string, metadata?: object }) => object | null | Promise<object | null>,
 *   interrupt: (sessionID: string) => boolean | { interrupted?: boolean } | Promise<boolean | { interrupted?: boolean }>,
 *   switchModel: (sessionID: string, model: object) => void | Promise<void>,
 *   switchAgent: (sessionID: string, agent: string) => void | Promise<void>,
 *   getMessages: (sessionID: string, query: { limit?: number, cursor?: string, order?: string }) => { data: unknown[], cursor: object } | Promise<{ data: unknown[], cursor: object }>,
 *   replyPermission: (sessionID: string, requestID: string, decision: string) => boolean | null | Promise<boolean | null>,
 * } }} options
 */
export function createClaudeRoutes({ registry }) {
  const router = express.Router({ mergeParams: true });

  /**
   * Async handlers must never throw synchronously; a sync throw and a rejected
   * promise both land in `next(error)`.
   */
  const handle = (handler) => (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };

  /**
   * The tagged body OpenCode answers a declared status with. The generated
   * client rethrows the parsed body as-is, and the shared UI reads `_tag` back
   * into a status, so every error path keeps this shape.
   */
  const sendError = (res, status, tag, message) => {
    res.status(status).json({ _tag: tag, message });
  };

  /**
   * Claude sessions only: anything else leaves this router (`next('router')`)
   * for the OpenCode proxy. A registry without the check owns nothing, which
   * is the safe direction.
   */
  const forClaudeSession = (handler) => {
    const gate = (req, res, next) => {
      Promise.resolve()
        .then(() => registry.isClaudeSession?.(req.params.sessionID))
        .then((isClaude) => (isClaude === true ? next() : next('router')))
        .catch(next);
    };
    return [gate, handle(handler)];
  };

  // OpenCode decodes the directory header once and falls back to the raw
  // value; `x-opencode-directory-encoding: uri` marks a value that had to be
  // re-encoded and carries one more layer (same reading as lib/git's helper).
  const decodeOnce = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  /** The directory a create names: the body's location first, then the SDK's header. */
  const requestDirectory = (req) => {
    const fromBody = req.body?.location?.directory;
    if (isString(fromBody) && fromBody !== '') return fromBody;
    const raw = [req.headers['x-opencode-directory']].flat().find(Boolean);
    if (!raw) return undefined;
    const unwrapped = req.headers['x-opencode-directory-encoding'] === 'uri' ? decodeOnce(String(raw)) : String(raw);
    return decodeOnce(unwrapped);
  };

  /** `message.list` sends `limit` as a query string; the registry pages with a number. */
  const readLimit = (value) => {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!isString(raw) || raw === '') return undefined;
    const limit = Number(raw);
    return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
  };

  // session.create — the backend header, not the body, chooses Claude (the
  // proxy re-serializes bodies; a header cannot be lost to that). The client
  // mints the session id and may name the initial agent and model; forward
  // them so the Claude session keeps the identity and selection the UI made.
  router.post('/session', handle(async (req, res, next) => {
    const backend = String(req.get('x-openchamber-backend') ?? '').trim().toLowerCase();
    if (backend !== 'claude') return next();
    const body = req.body ?? {};
    const input = {
      id: body.id,
      title: body.title,
      agent: body.agent,
      model: body.model,
      metadata: body.metadata,
    };
    const directory = requestDirectory(req);
    if (directory) input.directory = directory;
    res.status(200).json({ data: await registry.createSession(input) });
  }));

  // session.get — GET /api/session/:sessionID
  router.get('/session/:sessionID', forClaudeSession(async (req, res) => {
    const session = await registry.getSession(req.params.sessionID);
    if (!session) return sendError(res, 404, 'SessionNotFoundError', 'Session not found');
    res.status(200).json({ data: session });
  }));

  // session.update — PATCH /api/session/:sessionID. Rename only: Claude
  // metadata is written through the OpenChamber metadata route, not here.
  router.patch('/session/:sessionID', forClaudeSession(async (req, res) => {
    const title = req.body?.title;
    if (!isString(title)) return sendError(res, 400, 'InvalidRequestError', 'title is required');
    await registry.renameSession(req.params.sessionID, title);
    res.status(204).end();
  }));

  // session.remove — DELETE /api/session/:sessionID
  router.delete('/session/:sessionID', forClaudeSession(async (req, res) => {
    await registry.removeSession(req.params.sessionID);
    res.status(204).end();
  }));

  // session.move — POST /api/session/:sessionID/move
  router.post('/session/:sessionID/move', forClaudeSession(async (req, res) => {
    const directory = req.body?.directory;
    if (!isString(directory) || directory === '') {
      return sendError(res, 400, 'InvalidRequestError', 'directory is required');
    }
    await registry.moveSession(req.params.sessionID, directory);
    res.status(204).end();
  }));

  // session.switchModel — POST /api/session/:sessionID/model
  router.post('/session/:sessionID/model', forClaudeSession(async (req, res) => {
    await registry.switchModel(req.params.sessionID, req.body?.model);
    res.status(204).end();
  }));

  // session.switchAgent — POST /api/session/:sessionID/agent
  router.post('/session/:sessionID/agent', forClaudeSession(async (req, res) => {
    await registry.switchAgent(req.params.sessionID, req.body?.agent);
    res.status(204).end();
  }));

  // session.prompt — POST /api/session/:sessionID/prompt. The client mints the
  // user message id (its optimistic message reconciles on it) and may attach
  // files, agent mentions, skills, metadata, or a delivery mode; forward them
  // as they arrived.
  router.post('/session/:sessionID/prompt', forClaudeSession(async (req, res) => {
    const body = req.body ?? {};
    const text = body.text;
    if (!isString(text)) return sendError(res, 400, 'InvalidRequestError', 'prompt text is required');
    res.status(200).json({
      data: await registry.sendPrompt(req.params.sessionID, {
        text,
        id: body.id,
        files: body.files,
        agents: body.agents,
        skills: body.skills,
        metadata: body.metadata,
        delivery: body.delivery,
      }),
    });
  }));

  // session.generate — POST /api/session/:sessionID/generate. One transient
  // text in the session's context (a commit message, a summary): one one-shot
  // SDK query, answered as the text, recorded nowhere. The descriptor declares
  // 400/401/404/503, so a runtime failure answers the tagged 503.
  router.post('/session/:sessionID/generate', forClaudeSession(async (req, res) => {
    const prompt = req.body?.prompt;
    if (!isString(prompt) || prompt.trim() === '') {
      return sendError(res, 400, 'InvalidRequestError', 'prompt is required');
    }
    let result;
    try {
      result = await registry.generate(req.params.sessionID, prompt);
    } catch (error) {
      return sendError(res, 503, 'ServiceUnavailableError', error?.message ?? 'Claude Code generate failed');
    }
    res.status(200).json({ data: result });
  }));

  // session.synthetic — POST /api/session/:sessionID/synthetic. Context the UI
  // admits ahead of a prompt: it never starts a turn, the next prompt carries
  // it. `delivery`/`resume` are ignored (v1 has no inbox or resume here).
  router.post('/session/:sessionID/synthetic', forClaudeSession(async (req, res) => {
    const body = req.body ?? {};
    const text = body.text;
    if (!isString(text) || text === '') {
      return sendError(res, 400, 'InvalidRequestError', 'synthetic text is required');
    }
    res.status(200).json({
      data: await registry.synthetic(req.params.sessionID, {
        id: body.id,
        text,
        description: body.description,
        metadata: body.metadata,
      }),
    });
  }));

  // session.interrupt — POST /api/session/:sessionID/interrupt. The registry
  // may report the boolean directly or as the wire shape.
  router.post('/session/:sessionID/interrupt', forClaudeSession(async (req, res) => {
    const result = await registry.interrupt(req.params.sessionID);
    res.status(200).json({ interrupted: result === true || result?.interrupted === true });
  }));

  // message.list — GET /api/session/:sessionID/message
  router.get('/session/:sessionID/message', forClaudeSession(async (req, res) => {
    const page = await registry.getMessages(req.params.sessionID, {
      limit: readLimit(req.query.limit),
      cursor: isString(req.query.cursor) ? req.query.cursor : undefined,
      order: req.query.order === 'asc' || req.query.order === 'desc' ? req.query.order : undefined,
    });
    res.status(200).json({ data: page.data, cursor: page.cursor });
  }));

  // permission.reply — POST /api/session/:sessionID/permission/:permID/reply.
  // An unknown request is reported by the registry either as a settled
  // `false`/`null` or as a thrown 404; both answer 404, which
  // permission-auto-accept reads as "already replied" (runtime.js:271).
  router.post('/session/:sessionID/permission/:permID/reply', forClaudeSession(async (req, res) => {
    const decision = req.body?.decision;
    if (decision !== 'once' && decision !== 'always' && decision !== 'reject') {
      return sendError(res, 400, 'InvalidRequestError', 'decision must be once, always, or reject');
    }
    let handled;
    try {
      handled = await registry.replyPermission(req.params.sessionID, req.params.permID, decision);
    } catch (error) {
      if (error?.status !== 404) throw error;
      handled = false;
    }
    if (handled === false || handled === null) {
      return sendError(res, 404, 'PermissionNotFoundError', 'Permission request not found');
    }
    res.status(204).end();
  }));

  return router;
}
