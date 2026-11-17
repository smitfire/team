import type { Agent } from '@deepseek-ai/dsh-agent';
export declare const DEFAULT_PROGRESS_WATCH_LIMIT = 4;
/**
 * Loop-detection watchdog inspired by `dsh-workbench`'s ProgressWatch:
 * fingerprints consecutive `[toolName, argsSummary, outputPreview]` tuples.
 */
export declare class ProgressWatch {
    readonly limit: number;
    private previous;
    private repeats;
    constructor(limit?: number);
    observe(toolName: string, argsSummary: string, outputPreview?: string): boolean;
    getRepeatCount(): number;
    reset(): void;
}
export type WatchdogEventKind = 'max_tokens_continue' | 'request_error_retry' | 'idle_stall_recover' | 'subagent_cold_resume' | 'board_orphan_reconciled' | 'loop_cap_reached';
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
export declare const USER_ABORT_CODES: Set<string>;
/**
 * Shared predicate identifying user-initiated cancellation / abort failure codes.
 */
export declare function isUserAbortFailure(failure: unknown): boolean;
/**
 * Classify upstream LLM/transport failures for bounded automatic retry.
 * Explicit structured error codes and HTTP statuses take precedence over message text.
 */
export declare function isRetryableUpstreamFailure(errOrFailure: unknown): boolean;
/**
 * Construct an immutable frozen DSH UserMessage structurally matching `Agent['steer']`.
 * Cast is isolated here because `@deepseek-ai/dsh-agent` leaves `UserMessage.id` branded at type level.
 */
export declare function makeWatchdogUserMessage(text: string): Parameters<Agent['steer']>[0];
/**
 * Coordinates anti-stall detection (`dsh-stall-guard`), `max-tokens` continuation,
 * transient request retry, HITL/in-flight-tool exemptions, and bounded event history.
 */
export declare class StallWatchdog {
    private readonly sessions;
    private readonly events;
    private readonly maxEvents;
    private readonly progressWatchLimit;
    private totalEvents;
    constructor(opts?: {
        maxEvents?: number;
        progressWatchLimit?: number;
    });
    private ensure;
    private toSnapshot;
    touch(sessionId: string, now?: number, resetStallBudget?: boolean): void;
    setRunning(sessionId: string, running: boolean, now?: number): void;
    beginToolCall(sessionId: string, now?: number): void;
    endToolCall(sessionId: string, now?: number): void;
    setPendingHitl(sessionId: string, delta: number, now?: number): void;
    markUserCancelled(sessionId: string, cancelled?: boolean, now?: number): void;
    recordFinishReason(sessionId: string, reason: string, now?: number): void;
    observeToolOutcome(sessionId: string, toolName: string, argsSummary: string, outputPreview?: string, now?: number): boolean;
    private consumeBudget;
    consumeAutoContinuation(sessionId: string, maxAutoContinuations: number, detail?: string, now?: number): {
        allowed: boolean;
        count: number;
    };
    consumeRequestRetry(sessionId: string, maxRequestErrorRetries: number, detail: string, now?: number): {
        allowed: boolean;
        count: number;
    };
    /**
     * Identify silently stalled sessions while exempting in-flight tool executions and pending HITL prompts.
     */
    checkStalledSessions(now: number, stallTimeoutMs: number, extraBusyCheck?: (sessionId: string) => boolean): string[];
    consumeStallRecovery(sessionId: string, maxStallRecoveries: number, detail?: string, now?: number): {
        allowed: boolean;
        count: number;
    };
    recordEvent(input: Omit<WatchdogEvent, 'id' | 'timestamp'> & {
        timestamp?: number;
    }): WatchdogEvent;
    getStatus(sessionId?: string): WatchdogStatusSnapshot;
    clearSession(sessionId: string): void;
}
//# sourceMappingURL=stall-watchdog.d.ts.map