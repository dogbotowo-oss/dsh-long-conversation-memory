/**
 * Minimal fake cordis/DSH host used by the integration tests.
 *
 * It reproduces exactly the public surface the plugin is allowed to use:
 * `ctx.on(event, listener)` (with disposers), `ctx.get(service)`,
 * `ctx.effect(setup)`, a logger, and one or more fake sessions that expose
 * `id`, `header`, `surface` and `deriveMessages()`.
 *
 * It also models the host commit rules the adapter depends on:
 * - `session/event` listeners receive `(session, event)`;
 * - `agent/pre-step` listeners receive the claimed-message payload and return
 *   the final decision, whose extra messages the host appends to the surface.
 *
 * This file is intentionally not named `*.test.mjs` so `node --test` treats it
 * as a helper, not as a test.
 */

import os from 'node:os'

/**
 * @typedef {object} FakeSessionState
 * @property {number} seq
 * @property {object[]} events
 * @property {{ event: object | null, message: object }[]} messages
 */

/**
 * @param {{ services?: Record<string, any> }} [options]
 */
export function createFakeHost(options = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {object[]} */
  const commands = []
  const services = options.services ?? {}
  const logLines = []

  const ctx = {
    logger: {
      debug(message) {
        logLines.push({ level: 'debug', message: String(message) })
      },
      info(message) {
        logLines.push({ level: 'info', message: String(message) })
      },
      warn(message) {
        logLines.push({ level: 'warn', message: String(message) })
      },
      error(message) {
        logLines.push({ level: 'error', message: String(message) })
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const at = current.indexOf(listener)
        if (at >= 0) current.splice(at, 1)
      }
    },
    get(service) {
      if (service === 'commands') {
        return {
          register(definition) {
            commands.push(definition)
            return () => {
              const at = commands.indexOf(definition)
              if (at >= 0) commands.splice(at, 1)
            }
          },
        }
      }
      return services[service]
    },
    effect(setup) {
      const dispose = setup()
      return () => dispose?.()
    },
  }

  /** @type {Map<string, { session: object, state: FakeSessionState }>} */
  const sessions = new Map()
  /** @type {{ agent: object, messages: object[], turn: number, step: number, decision: object }[]} */
  const preSteps = []

  /**
   * Create a fake host session.
   *
   * @param {string} id
   * @param {{ cwd?: string, origin?: string, header?: object, visible?: object[] }} [sessionOptions]
   */
  function createSession(id, sessionOptions = {}) {
    /** @type {FakeSessionState} */
    const state = { seq: 0, events: [], messages: [] }
    const session = {
      id,
      header: {
        id,
        cwd: sessionOptions.cwd ?? os.tmpdir(),
        origin: sessionOptions.origin ?? 'user',
        ...(sessionOptions.header ?? {}),
      },
      surface: { nodes: [], contentGeneration: 0 },
      deriveMessages() {
        return state.messages.map((entry) => entry.message)
      },
    }
    sessions.set(id, { session, state })
    for (const message of sessionOptions.visible ?? []) {
      state.messages.push({ event: null, message })
    }
    return session
  }

  /**
   * @param {object} session
   * @returns {FakeSessionState}
   */
  function stateOf(session) {
    const entry = sessions.get(session.id)
    if (entry === undefined) throw new Error(`unknown fake session: ${session.id}`)
    return entry.state
  }

  /**
   * Emit one committed host event (same order and seq numbering as the host).
   *
   * @param {object} session
   * @param {string} type
   * @param {object} data
   */
  function emit(session, type, data) {
    const state = stateOf(session)
    state.seq += 1
    const event = { type, seq: state.seq, time: new Date().toISOString(), data }
    state.events.push(event)
    for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    return event
  }

  /**
   * Replay one already-recorded event exactly (same seq), which is what a
   * restart or a retried append looks like to `session/event` listeners.
   *
   * @param {object} session
   * @param {{ type: string, seq: number, time?: string, data: object }} event
   */
  function replayEvent(session, event) {
    const state = stateOf(session)
    const committed = { time: new Date().toISOString(), ...event }
    if (Number.isInteger(committed.seq) && committed.seq > state.seq) state.seq = committed.seq
    for (const listener of listeners.get('session/event') ?? []) listener(session, committed)
    return committed
  }

  /**
   * Emit a user message and make it visible (as the host does).
   *
   * @param {object} session
   * @param {string} text
   * @param {{ id?: string, source?: object }} [messageOptions]
   */
  function emitUser(session, text, messageOptions = {}) {
    const message = {
      id: messageOptions.id ?? `u_${stateOf(session).seq + 1}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: messageOptions.source ?? { kind: 'user' },
    }
    emit(session, 'user/message', message)
    stateOf(session).messages.push({ event: null, message })
    return message
  }

  /**
   * Emit an assistant message (not appended to the visible surface here: the
   * tests decide when the model output becomes visible).
   *
   * @param {object} session
   * @param {string} text
   * @param {{ turn?: number, step?: number }} [options]
   */
  function emitAssistant(session, text, assistantOptions = {}) {
    const message = { id: `a_${stateOf(session).seq + 1}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } }
    return emit(session, 'assistant/message', { turn: assistantOptions.turn ?? 1, step: assistantOptions.step ?? 1, message })
  }

  /**
   * @param {object} session
   * @param {{ callId?: string, name?: string, arguments?: object, turn?: number, step?: number }} [options]
   */
  function emitToolCall(session, callOptions = {}) {
    return emit(session, 'tool/call', {
      turn: callOptions.turn ?? 1,
      step: callOptions.step ?? 1,
      callId: callOptions.callId ?? `call_${stateOf(session).seq + 1}`,
      name: callOptions.name ?? 'read_file',
      arguments: callOptions.arguments ?? {},
    })
  }

  /**
   * @param {object} session
   * @param {{ callId?: string, text?: string, error?: string | null, turn?: number, step?: number }} [options]
   */
  function emitToolResult(session, resultOptions = {}) {
    const callId = resultOptions.callId ?? 'call_1'
    const message = {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: resultOptions.text ?? '' }],
      isError: typeof resultOptions.error === 'string' && resultOptions.error.length > 0,
    }
    return emit(session, 'tool/result', {
      turn: resultOptions.turn ?? 1,
      step: resultOptions.step ?? 1,
      message,
      error: resultOptions.error ?? null,
    })
  }

  /**
   * Run the `agent/pre-step` waterfall exactly like the host: listeners wrap
   * `next()`, the default decision enters the claimed messages, and any extra
   * message the final decision adds is appended to the visible surface.
   *
   * @param {object} session
   * @param {{ messages?: object[], turn?: number, step?: number, signal?: AbortSignal }} [payload]
   */
  async function preStep(session, payload = {}) {
    const claimed = payload.messages ?? []
    const agent = { id: session.id, session }
    const call = {
      agent,
      messages: claimed,
      turn: payload.turn ?? 1,
      step: payload.step ?? 1,
      signal: payload.signal ?? new AbortController().signal,
    }
    let decision = { kind: 'enter', messages: [...claimed] }
    for (const listener of listeners.get('agent/pre-step') ?? []) {
      decision = await listener(call, async () => decision)
    }
    preSteps.push({ ...call, decision })
    if (decision.kind === 'enter') {
      const state = stateOf(session)
      // The host commits every message the final decision appends (e.g. the
      // memory block) as its own logged `user/message` event, after the claimed
      // user messages that `emitUser` already committed.
      for (const message of decision.messages) {
        if (claimed.includes(message)) continue
        emit(session, 'user/message', message)
        state.messages.push({ event: null, message })
      }
    }
    return decision
  }

  /**
   * Replace the visible surface (simulates a compaction that replaced the span).
   *
   * @param {object} session
   * @param {object[]} messages
   */
  function setVisible(session, messages) {
    const state = stateOf(session)
    state.messages = messages.map((message) => ({ event: null, message }))
  }

  /** @param {object} session */
  function visibleText(session) {
    return stateOf(session)
      .messages.map((entry) => {
        const content = entry.message?.content ?? []
        return Array.isArray(content) ? content.map((block) => (block?.type === 'text' ? block.text : '')).join('\n') : ''
      })
      .join('\n')
  }

  return {
    ctx,
    listeners,
    commands,
    sessions,
    preSteps,
    logLines,
    createSession,
    emit,
    emitUser,
    emitAssistant,
    emitToolCall,
    emitToolResult,
    replayEvent,
    preStep,
    setVisible,
    visibleText,
    stateOf,
  }
}
