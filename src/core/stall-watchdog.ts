import { createHash, randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';

/**
 * Loop-detection watchdog inspired by `dsh-workbench`'s ProgressWatch:
 * fingerprints consecutive `[toolName, argsSummary, outputPreview]` tuples.
 */
export class ProgressWatch {
  readonly limit: number;
  private previous: string | null = null;
  private repeats = 0;

  constructor(limit = 4) {
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

const NON_RETRYABLE_CODES = new Set([
  'AUTH',
  'PERMISSION',
  'CUGA',
  'CUGA_POLICY_DENY',
  'USER_ABORT',
  'ABORT',
  'ABORTED',
  'VALIDATION',
  'INVALID_REQUEST',
]);

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classify upstream LLM/transport failures for bounded automatic retry.
 */
export function isRetryableUpstreamFailure(errOrFailure: unknown): boolean {
  if (!errOrFailure) return false;
  if (typeof errOrFailure === 'string') {
    const lower = errOrFailure.toLowerCase();
    if (/auth|unauthorized|forbidden|permission|cuga|user cancelled|aborted by user/.test(lower)) return false;
    return /rate.?limit|429|timeout|etimedout|econnreset|fetch failed|overloaded|stream closed|502|503|504|500|server.?error/.test(lower);
  }
  if (typeof errOrFailure !== 'object') return false;
  const obj = errOrFailure as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : '';
  const code = typeof obj.code === 'string' ? obj.code.toUpperCase() : '';
  const status = typeof obj.status === 'number' ? obj.status : undefined;
  const message = typeof obj.message === 'string' ? obj.message : '';

  if (name === 'AbortError' || NON_RETRYABLE_CODES.has(code) || code.startsWith('CUGA_')) return false;
  if (/abort|user cancel|unauthorized|invalid api key|forbidden|cuga/i.test(message)) return false;
  if (RETRYABLE_CODES.has(code)) return true;
  if (status !== undefined && RETRYABLE_STATUSES.has(status)) return true;
  return /rate.?limit|too many requests|timeout|etimedout|econnreset|fetch failed|overloaded|stream closed|temporarily unavailable|internal server error|bad gateway|gateway timeout/i.test(
    message,
  );
}

/**
 * Construct an immutable frozen DSH UserMessage without adding new package deps.
 */
export function makeWatchdogUserMessage(text: string): Parameters<Agent['steer']>[0] {
  const block = Object.freeze({ type: 'text' as const, text });
  const source = Object.freeze({ kind: 'user' as const });
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: Object.freeze([block]),
    source,
  }) as unknown as Parameters<Agent['steer']>[0];
}

/**
 * Coordinates anti-stall detection (`dsh-stall-guard`), `max-tokens` continuation,
 * transient request retry, HITL/in-flight-tool exemptions, and bounded event history.
 */
export class StallWatchdog {
  private readonly sessions = new Map<string, InternalSessionState>();
  private readonly events: WatchdogEvent[] = [];
  private readonly maxEvents: number;
  private totalEvents = 0;

  constructor(opts: { maxEvents?: number } = {}) {
    this.maxEvents = opts.maxEvents ?? 100;
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
        progressWatch: new ProgressWatch(4),
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

  touch(sessionId: string, now = Date.now()): void {
    const st = this.ensure(sessionId, now);
    st.lastActivityAt = now;
  }

  setRunning(sessionId: string, running: boolean, now = Date.now()): void {
    const st = this.ensure(sessionId, now);
    st.running = running;
    st.lastActivityAt = now;
    if (running) {
      st.userCancelled = false;
    }
  }

  beginToolCall(sessionId: string, now = Date.now()): void {
    const st = this.ensure(sessionId, now);
    st.inFlightToolCalls += 1;
    st.lastActivityAt = now;
  }

  endToolCall(sessionId: string, now = Date.now()): void {
    const st = this.ensure(sessionId, now);
    st.inFlightToolCalls = Math.max(0, st.inFlightToolCalls - 1);
    st.lastActivityAt = now;
  }

  setPendingHitl(sessionId: string, delta: number, now = Date.now()): void {
    const st = this.ensure(sessionId, now);
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
    }
    return triggered;
  }

  consumeAutoContinuation(
    sessionId: string,
    maxAutoContinuations: number,
    detail = 'max-tokens finish reached',
    now = Date.now(),
  ): { allowed: boolean; count: number } {
    const st = this.ensure(sessionId, now);
    st.lastActivityAt = now;
    if (st.userCancelled || st.autoContinuations >= maxAutoContinuations) {
      this.recordEvent({
        sessionId,
        kind: 'loop_cap_reached',
        attempt: st.autoContinuations,
        detail: `Auto-continuation capped (${st.autoContinuations}/${maxAutoContinuations}): ${detail}`,
        timestamp: now,
      });
      return { allowed: false, count: st.autoContinuations };
    }
    st.autoContinuations += 1;
    this.recordEvent({
      sessionId,
      kind: 'max_tokens_continue',
      attempt: st.autoContinuations,
      detail,
      timestamp: now,
    });
    return { allowed: true, count: st.autoContinuations };
  }

  consumeRequestRetry(
    sessionId: string,
    maxRequestErrorRetries: number,
    detail: string,
    now = Date.now(),
  ): { allowed: boolean; count: number } {
    const st = this.ensure(sessionId, now);
    st.lastActivityAt = now;
    if (st.userCancelled || st.requestErrorRetries >= maxRequestErrorRetries) {
      this.recordEvent({
        sessionId,
        kind: 'loop_cap_reached',
        attempt: st.requestErrorRetries,
        detail: `Request retry capped (${st.requestErrorRetries}/${maxRequestErrorRetries}): ${detail}`,
        timestamp: now,
      });
      return { allowed: false, count: st.requestErrorRetries };
    }
    st.requestErrorRetries += 1;
    this.recordEvent({
      sessionId,
      kind: 'request_error_retry',
      attempt: st.requestErrorRetries,
      detail,
      timestamp: now,
    });
    return { allowed: true, count: st.requestErrorRetries };
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
    const st = this.ensure(sessionId, now);
    st.lastActivityAt = now;
    if (st.userCancelled || st.stallRecoveries >= maxStallRecoveries) {
      this.recordEvent({
        sessionId,
        kind: 'loop_cap_reached',
        attempt: st.stallRecoveries,
        detail: `Stall recovery capped (${st.stallRecoveries}/${maxStallRecoveries}): ${detail}`,
        timestamp: now,
      });
      return { allowed: false, count: st.stallRecoveries };
    }
    st.stallRecoveries += 1;
    this.recordEvent({
      sessionId,
      kind: 'idle_stall_recover',
      attempt: st.stallRecoveries,
      detail,
      timestamp: now,
    });
    return { allowed: true, count: st.stallRecoveries };
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
