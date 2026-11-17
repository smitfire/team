import { createHash, randomUUID } from 'node:crypto';
export const DEFAULT_PROGRESS_WATCH_LIMIT = 4;
/**
 * Loop-detection watchdog: fingerprints consecutive
 * `[toolName, argsSummary, outputPreview]` tuples to halt repetitive calls.
 */
export class ProgressWatch {
    limit;
    previous = null;
    repeats = 0;
    constructor(limit = DEFAULT_PROGRESS_WATCH_LIMIT) {
        if (!Number.isSafeInteger(limit) || limit < 2) {
            throw new Error(`ProgressWatch limit must be an integer >= 2 (got ${limit})`);
        }
        this.limit = limit;
    }
    observe(toolName, argsSummary, outputPreview = '') {
        const fingerprint = createHash('sha256')
            .update(JSON.stringify([toolName, argsSummary, outputPreview]))
            .digest('hex');
        if (fingerprint === this.previous) {
            this.repeats += 1;
        }
        else {
            this.previous = fingerprint;
            this.repeats = 1;
        }
        return this.repeats >= this.limit;
    }
    getRepeatCount() {
        return this.repeats;
    }
    reset() {
        this.previous = null;
        this.repeats = 0;
    }
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
const RETRYABLE_MSG_RE = /\b(?:rate[-_ ]?limit|too many requests|timed? ?out|etimedout|econnreset|fetch failed|overloaded|stream closed|temporarily unavailable|internal server error|bad gateway|gateway timeout|408|429|500|502|503|504)\b/i;
const NON_RETRYABLE_MSG_RE = /\b(?:unauthorized|invalid api key|forbidden|cuga|cuga_policy_deny|permission|validation|user cancel(?:led|ed)?|aborted by user|user_abort|aborted)\b/i;
/**
 * Shared predicate identifying user-initiated cancellation / abort failure codes.
 */
export function isUserAbortFailure(failure) {
    if (typeof failure === 'string') {
        return /\b(?:USER_ABORT|ABORT|ABORTED|user cancel(?:led|ed)?)\b/i.test(failure);
    }
    if (!failure || typeof failure !== 'object')
        return false;
    const obj = failure;
    const name = typeof obj.name === 'string' ? obj.name : '';
    const code = typeof obj.code === 'string' ? obj.code.toUpperCase() : '';
    return name === 'AbortError' || USER_ABORT_CODES.has(code);
}
/**
 * Shared predicate identifying deterministic (non-retryable) failures such as auth, permission, CUGA, or user aborts.
 */
export function isDeterministicFailure(errOrFailure) {
    if (!errOrFailure)
        return false;
    if (isUserAbortFailure(errOrFailure))
        return true;
    if (typeof errOrFailure === 'string') {
        return NON_RETRYABLE_MSG_RE.test(errOrFailure);
    }
    if (typeof errOrFailure !== 'object')
        return false;
    const obj = errOrFailure;
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
export function isRetryableUpstreamFailure(errOrFailure) {
    if (!errOrFailure)
        return false;
    if (typeof errOrFailure === 'string') {
        if (NON_RETRYABLE_MSG_RE.test(errOrFailure))
            return false;
        return RETRYABLE_MSG_RE.test(errOrFailure);
    }
    if (typeof errOrFailure !== 'object')
        return false;
    const obj = errOrFailure;
    const name = typeof obj.name === 'string' ? obj.name : '';
    const code = typeof obj.code === 'string' ? obj.code.toUpperCase() : '';
    const status = typeof obj.status === 'number' ? obj.status : undefined;
    const message = typeof obj.message === 'string' ? obj.message : '';
    if (name === 'AbortError' || NON_RETRYABLE_CODES.has(code) || code.startsWith('CUGA_'))
        return false;
    if (RETRYABLE_CODES.has(code))
        return true;
    if (status !== undefined && RETRYABLE_STATUSES.has(status))
        return true;
    if (NON_RETRYABLE_MSG_RE.test(message))
        return false;
    return RETRYABLE_MSG_RE.test(message);
}
/**
 * Construct an immutable frozen DSH UserMessage structurally matching `Agent['steer']`.
 * Cast is isolated here because `@deepseek-ai/dsh-agent` leaves `UserMessage.id` branded at type level.
 */
export function makeWatchdogUserMessage(text) {
    const block = Object.freeze({ type: 'text', text });
    const source = Object.freeze({ kind: 'user' });
    const candidate = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: Object.freeze([block]),
        source,
    });
    return candidate;
}
/**
 * Coordinates anti-stall detection (`dsh-stall-guard`), `max-tokens` continuation,
 * transient request retry, HITL/in-flight-tool exemptions, and bounded event history.
 */
export class StallWatchdog {
    sessions = new Map();
    events = [];
    maxEvents;
    progressWatchLimit;
    totalEvents = 0;
    constructor(opts = {}) {
        this.maxEvents = opts.maxEvents ?? 100;
        this.progressWatchLimit = opts.progressWatchLimit ?? DEFAULT_PROGRESS_WATCH_LIMIT;
    }
    ensure(sessionId, now = Date.now()) {
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
    toSnapshot(st) {
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
    touch(sessionId, now = Date.now(), resetStallBudget = false) {
        const st = this.ensure(sessionId, now);
        st.lastActivityAt = now;
        if (resetStallBudget) {
            st.stallRecoveries = 0;
        }
    }
    setRunning(sessionId, running, now = Date.now()) {
        const st = this.ensure(sessionId, now);
        st.running = running;
        st.lastActivityAt = now;
        if (running) {
            st.userCancelled = false;
            st.lastFinishReason = undefined;
        }
    }
    beginToolCall(sessionId, now = Date.now()) {
        const st = this.ensure(sessionId, now);
        st.inFlightToolCalls += 1;
        st.lastActivityAt = now;
    }
    endToolCall(sessionId, now = Date.now()) {
        const st = this.sessions.get(sessionId);
        if (!st)
            return;
        st.inFlightToolCalls = Math.max(0, st.inFlightToolCalls - 1);
        st.lastActivityAt = now;
    }
    setPendingHitl(sessionId, delta, now = Date.now()) {
        if (delta < 0 && !this.sessions.has(sessionId))
            return;
        const st = delta > 0 ? this.ensure(sessionId, now) : this.sessions.get(sessionId);
        if (!st)
            return;
        st.pendingHitlPrompts = Math.max(0, st.pendingHitlPrompts + delta);
        st.lastActivityAt = now;
    }
    markUserCancelled(sessionId, cancelled = true, now = Date.now()) {
        const st = this.ensure(sessionId, now);
        st.userCancelled = cancelled;
        st.lastActivityAt = now;
    }
    recordFinishReason(sessionId, reason, now = Date.now()) {
        const st = this.ensure(sessionId, now);
        st.lastFinishReason = reason;
        st.lastActivityAt = now;
        if (reason === 'stop') {
            st.autoContinuations = 0;
            st.requestErrorRetries = 0;
            st.stallRecoveries = 0;
            st.progressWatch.reset();
        }
        else if (reason === 'tool-calls') {
            // Tool execution is forward progress for network/stall retries, while preserving max-tokens cap across interleaved tool calls.
            st.requestErrorRetries = 0;
            st.stallRecoveries = 0;
        }
    }
    refundRequestRetry(sessionId) {
        const st = this.sessions.get(sessionId);
        if (st && st.requestErrorRetries > 0) {
            st.requestErrorRetries -= 1;
        }
    }
    observeToolOutcome(sessionId, toolName, argsSummary, outputPreview = '', now = Date.now()) {
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
        else {
            // Distinct forward tool progress resets stall recovery counter so long runs retain protection.
            st.stallRecoveries = 0;
        }
        return triggered;
    }
    consumeBudget(sessionId, field, maxAllowed, successKind, capLabel, detail, now) {
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
    consumeAutoContinuation(sessionId, maxAutoContinuations, detail = 'max-tokens finish reached', now = Date.now()) {
        return this.consumeBudget(sessionId, 'autoContinuations', maxAutoContinuations, 'max_tokens_continue', 'Auto-continuation capped', detail, now);
    }
    consumeRequestRetry(sessionId, maxRequestErrorRetries, detail, now = Date.now()) {
        return this.consumeBudget(sessionId, 'requestErrorRetries', maxRequestErrorRetries, 'request_error_retry', 'Request retry capped', detail, now);
    }
    /**
     * Identify silently stalled sessions while exempting in-flight tool executions and pending HITL prompts.
     */
    checkStalledSessions(now, stallTimeoutMs, extraBusyCheck) {
        if (stallTimeoutMs <= 0)
            return [];
        const stalled = [];
        for (const st of this.sessions.values()) {
            if (!st.running)
                continue;
            if (st.userCancelled)
                continue;
            if (st.inFlightToolCalls > 0)
                continue;
            if (st.pendingHitlPrompts > 0)
                continue;
            if (extraBusyCheck?.(st.sessionId))
                continue;
            if (now - st.lastActivityAt >= stallTimeoutMs) {
                stalled.push(st.sessionId);
            }
        }
        return stalled;
    }
    consumeStallRecovery(sessionId, maxStallRecoveries, detail = 'silent stream/turn stall detected', now = Date.now()) {
        return this.consumeBudget(sessionId, 'stallRecoveries', maxStallRecoveries, 'idle_stall_recover', 'Stall recovery capped', detail, now);
    }
    recordEvent(input) {
        const ev = {
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
    getStatus(sessionId) {
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
    clearSession(sessionId) {
        this.sessions.delete(sessionId);
    }
}
//# sourceMappingURL=stall-watchdog.js.map