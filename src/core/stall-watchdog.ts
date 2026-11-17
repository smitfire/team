import { createHash, randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';

export const DEFAULT_PROGRESS_WATCH_LIMIT = 4;

/**
 * Loop-detection watchdog: fingerprints consecutive
 * `[toolName, argsSummary, outputPreview]` tuples to halt repetitive calls.
 */
export class ProgressWatch {
  readonly limit: number;
  private previous: string | null = null;
  private repeats = 0;

  constructor(limit = DEFAULT_PROGRESS_WATCH_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 2) {
      throw new Error(`ProgressWatch limit must be an integer >= 2 (got ${limit})`);
    }
    this.limit = limit;
  }

  observe(toolName: string, argsSummary: string, outputPreview = ''): boolean {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([toolName, argsSummary, outputPreview]))
      .digest('hex');
    if (fingerprint === this.previous) {
      this.repeats += 1;
    } else {
      this.previous = fingerprint;
      this.repeats = 1;
    }
    return this.repeats >= this.limit;
  }

  getRepeatCount(): number {
    return this.repeats;
  }

  reset(): void {
    this.previous = null;
    this.repeats = 0;
  }
}

export type WatchdogEventKind =
  | 'max_tokens_continue'
  | 'request_error_retry'
  | 'idle_stall_recover'
  | 'subagent_cold_resume'
  | 'board_orphan_reconciled'
  | 'loop_cap_reached';

export interface WatchdogEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly kind: WatchdogEventKind;
  readonly attempt?: number;
  readonly detail: string;
}

export interface WatchdogSessionSnapshot {
  readonly sessionId: string;
  readonly running: boolean;
  readonly lastActivityAt: number;
  readonly inFlightToolCalls: number;
  readonly pendingHitlPrompts: number;
  readonly lastFinishReason?: string;
  readonly autoContinuations: number;
  readonly requestErrorRetries: number;
  readonly stallRecoveries: number;
  readonly userCancelled: boolean;
}

export interface WatchdogStatusSnapshot {
  readonly activeSessions: number;
  readonly runningSessions: number;
  readonly totalEvents: number;
  readonly recentEvents: readonly WatchdogEvent[];
  readonly sessions: readonly WatchdogSessionSnapshot[];
  readonly session?: WatchdogSessionSnapshot;
}

interface InternalSessionState {
  sessionId: string;
  running: boolean;
  lastActivityAt: number;
  inFlightToolCalls: number;
  pendingHitlPrompts: number;
  lastFinishReason?: string;
  autoContinuations: number;
  requestErrorRetries: number;
  stallRecoveries: number;
  userCancelled: boolean;
  progressWatch: ProgressWatch;
}

type BudgetCounterField = 'autoContinuations' | 'requestErrorRetries' | 'stallRecoveries';

const RETRYABLE_CODES = new Set([
  'RATE_LIMIT',
  'TIMEOUT',
  'NETWORK',
  'SERVER_ERROR',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

const USER_ABORT_CODES = new Set(['USER_ABORT', 'ABORT', 'ABORTED']);

const NON_RETRYABLE_CODES = new Set([
  'AUTH',
  'PERMISSION',
  'CUGA',
  'CUGA_POLICY_DENY',
  'VALIDATION',
  'INVALID_REQUEST',
  ...USER_ABORT_CODES,
]);

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const RETRYABLE_MSG_RE =
  /\b(?:rate[-_ ]?limit|too many requests|timed? ?out|etimedout|econnreset|fetch failed|overloaded|stream closed|temporarily unavailable|internal server error|bad gateway|gateway timeout|408|429|500|502|503|504)\b/i;

const NON_RETRYABLE_MSG_RE =
  /\b(?:unauthorized|invalid api key|forbidden|cuga|cuga_policy_deny|permission|validation|user cancel(?:led|ed)?|aborted by user|user_abort|aborted)\b/i;

/**
 * Shared predicate identifying user-initiated cancellation / abort failure codes.
 */
export function isUserAbortFailure(failure: unknown): boolean {
  if (typeof failure === 'string') {
    return /\b(?:USER_ABORT|ABORT|ABORTED|user cancel(?:led|ed)?)\b/i.test(failure);
  }
  if (!failure || typeof failure !== 'object') return false;
  const obj = failure as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : '';
  const code = typeof obj.code === 'string' ? obj.code.toUpperCase() : '';
  return name === 'AbortError' || USER_ABORT_CODES.has(code);
}

/**
 * Shared predicate identifying deterministic (non-retryable) failures such as auth, permission, CUGA, or user aborts.
 */
export function isDeterministicFailure(errOrFailure: unknown): boolean {
  if (!errOrFailure) return false;
  if (isUserAbortFailure(errOrFailure)) return true;
  if (typeof errOrFailure === 'string') {
    return NON_RETRYABLE_MSG_RE.test(errOrFailure);
  }
  if (typeof errOrFailure !== 'object') return false;
  const obj = errOrFailure as Record<string, unknown>;
  const code = typeof obj.code === 'string' ? obj.code.toUpperCase() : '';
  const status = typeof obj.status === 'number' ? obj.status : undefined;
  const message = typeof obj.message === 'string' ? obj.message : '';
  if (NON_RETRYABLE_CODES.has(code) || code.startsWith('CUGA_') || status === 401 || status === 403 || status === 400) {
    return true;
  }
  return NON_RETRYABLE_MSG_RE.test(message);
}

/**
 * Classify upstream LLM/transport failures for bounded automatic retry.
 * Explicit structured error codes and HTTP statuses take precedence over message text.
 */
export function isRetryableUpstreamFailure(errOrFailure: unknown): boolean {
  if (!errOrFailure) return false;
  if (typeof errOrFailure === 'string') {
    if (NON_RETRYABLE_MSG_RE.test(errOrFailure)) return false;
    return RETRYABLE_MSG_RE.test(errOrFailure);
  }
  if (typeof errOrFailure !== 'object') return false;
  const obj = errOrFailure as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : '';
  const code = typeof obj.code === 'string' ? obj.code.toUpperCase() : '';
  const status = typeof obj.status === 'number' ? obj.status : undefined;
  const message = typeof obj.message === 'string' ? obj.message : '';

  if (name === 'AbortError' || NON_RETRYABLE_CODES.has(code) || code.startsWith('CUGA_')) return false;
  if (RETRYABLE_CODES.has(code)) return true;
  if (status !== undefined && RETRYABLE_STATUSES.has(status)) return true;
  if (NON_RETRYABLE_MSG_RE.test(message)) return false;
  return RETRYABLE_MSG_RE.test(message);
}

/**
 * Construct an immutable frozen DSH UserMessage structurally matching `Agent['steer']`.
 * Cast is isolated here because `@deepseek-ai/dsh-agent` leaves `UserMessage.id` branded at type level.
 */
export function makeWatchdogUserMessage(text: string): Parameters<Agent['steer']>[0] {
  const block = Object.freeze({ type: 'text' as const, text });
  const source = Object.freeze({ kind: 'user' as const });
  const candidate = Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: Object.freeze([block]),
    source,
  });
  return candidate as unknown as Parameters<Agent['steer']>[0];
}

/**
 * Coordinates anti-stall detection (`dsh-stall-guard`), `max-tokens` continuation,
 * transient request retry, HITL/in-flight-tool exemptions, and bounded event history.
 */
export class StallWatchdog {
  private readonly sessions = new Map<string, InternalSessionState>();
  private readonly events: WatchdogEvent[] = [];
  private readonly maxEvents: number;
  private readonly progressWatchLimit: number;
  private totalEvents = 0;

  constructor(opts: { maxEvents?: number; progressWatchLimit?: number } = {}) {
    this.maxEvents = opts.maxEvents ?? 100;
    this.progressWatchLimit = opts.progressWatchLimit ?? DEFAULT_PROGRESS_WATCH_LIMIT;
  }

  private ensure(sessionId: string, now = Date.now()): InternalSessionState {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = {
        sessionId,
        running: false,
        lastActivityAt: now,
        inFlightToolCalls: 0,
        pendingHitlPrompts: 0,
        autoContinuations: 0,
        requestErrorRetries: 0,
        stallRecoveries: 0,
        userCancelled: false,
        progressWatch: new ProgressWatch(this.progressWatchLimit),
      };
      this.sessions.set(sessionId, st);
    }
    return st;
  }

  private toSnapshot(st: InternalSessionState): WatchdogSessionSnapshot {
    return {
      sessionId: st.sessionId,
      running: st.running,
      lastActivityAt: st.lastActivityAt,
      inFlightToolCalls: st.inFlightToolCalls,
      pendingHitlPrompts: st.pendingHitlPrompts,
      lastFinishReason: st.lastFinishReason,
      autoContinuations: st.autoContinuations,
      requestErrorRetries: st.requestErrorRetries,
      stallRecoveries: st.stallRecoveries,
      userCancelled: st.userCancelled,
    };
  }

  touch(sessionId: string, now = Date.now(), resetStallBudget = false): void {
    const st = this.ensure(sessionId, now);
    st.lastActivityAt = now;
    if (resetStallBudget) {
      st.stallRecoveries = 0;
    }
  }

  setRunning(sessionId: string, running: boolean, now = Date.now()): void {
    const st = this.ensure(sessionId, now);
    st.running = running;
    st.lastActivityAt = now;
    if (running) {
      st.userCancelled = false;
      st.lastFinishReason = undefined;
    }
  }

  beginToolCall(sessionId: string, now = Date.now()): void {
    const st = this.ensure(sessionId, now);
    st.inFlightToolCalls += 1;
    st.lastActivityAt = now;
  }

  endToolCall(sessionId: string, now = Date.now()): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    st.inFlightToolCalls = Math.max(0, st.inFlightToolCalls - 1);
    st.lastActivityAt = now;
  }

  setPendingHitl(sessionId: string, delta: number, now = Date.now()): void {
    if (delta < 0 && !this.sessions.has(sessionId)) return;
    const st = delta > 0 ? this.ensure(sessionId, now) : this.sessions.get(sessionId);
    if (!st) return;
    st.pendingHitlPrompts = Math.max(0, st.pendingHitlPrompts + delta);
    st.lastActivityAt = now;
  }

  markUserCancelled(sessionId: string, cancelled = true, now = Date.now()): void {
    const st = this.ensure(sessionId, now);
    st.userCancelled = cancelled;
    st.lastActivityAt = now;
  }

  recordFinishReason(sessionId: string, reason: string, now = Date.now()): void {
    const st = this.ensure(sessionId, now);
    st.lastFinishReason = reason;
    st.lastActivityAt = now;
    if (reason === 'stop') {
      st.autoContinuations = 0;
      st.requestErrorRetries = 0;
      st.stallRecoveries = 0;
      st.progressWatch.reset();
    } else if (reason === 'tool-calls') {
      // Tool execution is forward progress for network/stall retries, while preserving max-tokens cap across interleaved tool calls.
      st.requestErrorRetries = 0;
      st.stallRecoveries = 0;
    }
  }

  refundRequestRetry(sessionId: string): void {
    const st = this.sessions.get(sessionId);
    if (st && st.requestErrorRetries > 0) {
      st.requestErrorRetries -= 1;
    }
  }

  observeToolOutcome(
    sessionId: string,
    toolName: string,
    argsSummary: string,
    outputPreview = '',
    now = Date.now(),
  ): boolean {
    const st = this.ensure(sessionId, now);
    st.lastActivityAt = now;
    const triggered = st.progressWatch.observe(toolName, argsSummary, outputPreview);
    if (triggered) {
      this.recordEvent({
        sessionId,
        kind: 'loop_cap_reached',
        attempt: st.progressWatch.getRepeatCount(),
        detail: `Repeated identical tool outcome (${toolName}) reached limit ${st.progressWatch.limit}`,
        timestamp: now,
      });
    } else {
      // Distinct forward tool progress resets stall recovery counter so long runs retain protection.
      st.stallRecoveries = 0;
    }
    return triggered;
  }

  private consumeBudget(
    sessionId: string,
    field: BudgetCounterField,
    maxAllowed: number,
    successKind: WatchdogEventKind,
    capLabel: string,
    detail: string,
    now: number,
  ): { allowed: boolean; count: number } {
    const st = this.ensure(sessionId, now);
    const current = st[field];
    if (st.userCancelled) {
      return { allowed: false, count: current };
    }
    if (current >= maxAllowed) {
      this.recordEvent({
        sessionId,
        kind: 'loop_cap_reached',
        attempt: current,
        detail: `${capLabel} [${field}] (${current}/${maxAllowed}): ${detail}`,
        timestamp: now,
      });
      return { allowed: false, count: current };
    }
    const next = current + 1;
    st[field] = next;
    st.lastActivityAt = now;
    this.recordEvent({
      sessionId,
      kind: successKind,
      attempt: next,
      detail,
      timestamp: now,
    });
    return { allowed: true, count: next };
  }

  consumeAutoContinuation(
    sessionId: string,
    maxAutoContinuations: number,
    detail = 'max-tokens finish reached',
    now = Date.now(),
  ): { allowed: boolean; count: number } {
    return this.consumeBudget(
      sessionId,
      'autoContinuations',
      maxAutoContinuations,
      'max_tokens_continue',
      'Auto-continuation capped',
      detail,
      now,
    );
  }

  consumeRequestRetry(
    sessionId: string,
    maxRequestErrorRetries: number,
    detail: string,
    now = Date.now(),
  ): { allowed: boolean; count: number } {
    return this.consumeBudget(
      sessionId,
      'requestErrorRetries',
      maxRequestErrorRetries,
      'request_error_retry',
      'Request retry capped',
      detail,
      now,
    );
  }

  /**
   * Identify silently stalled sessions while exempting in-flight tool executions and pending HITL prompts.
   */
  checkStalledSessions(
    now: number,
    stallTimeoutMs: number,
    extraBusyCheck?: (sessionId: string) => boolean,
  ): string[] {
    if (stallTimeoutMs <= 0) return [];
    const stalled: string[] = [];
    for (const st of this.sessions.values()) {
      if (!st.running) continue;
      if (st.userCancelled) continue;
      if (st.inFlightToolCalls > 0) continue;
      if (st.pendingHitlPrompts > 0) continue;
      if (extraBusyCheck?.(st.sessionId)) continue;
      if (now - st.lastActivityAt >= stallTimeoutMs) {
        stalled.push(st.sessionId);
      }
    }
    return stalled;
  }

  consumeStallRecovery(
    sessionId: string,
    maxStallRecoveries: number,
    detail = 'silent stream/turn stall detected',
    now = Date.now(),
  ): { allowed: boolean; count: number } {
    return this.consumeBudget(
      sessionId,
      'stallRecoveries',
      maxStallRecoveries,
      'idle_stall_recover',
      'Stall recovery capped',
      detail,
      now,
    );
  }

  recordEvent(input: Omit<WatchdogEvent, 'id' | 'timestamp'> & { timestamp?: number }): WatchdogEvent {
    const ev: WatchdogEvent = {
      id: randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
      sessionId: input.sessionId,
      kind: input.kind,
      attempt: input.attempt,
      detail: input.detail.slice(0, 500),
    };
    this.totalEvents += 1;
    this.events.push(ev);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    return ev;
  }

  getStatus(sessionId?: string): WatchdogStatusSnapshot {
    const sessions = [...this.sessions.values()].map((s) => this.toSnapshot(s));
    const st = sessionId ? this.sessions.get(sessionId) : undefined;
    return {
      activeSessions: sessions.length,
      runningSessions: sessions.filter((s) => s.running).length,
      totalEvents: this.totalEvents,
      recentEvents: this.events.slice(-20),
      sessions,
      ...(st ? { session: this.toSnapshot(st) } : {}),
    };
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
