export type SwitchyardStrategy = 'switchyard-stage' | 'subagent-team' | 'hybrid';
export type SwitchyardTier = 'efficient' | 'capable';
export interface ModelRoute {
    provider: string;
    model: string;
    reasoningEffort: 'low' | 'medium' | 'high';
}
export interface SwitchyardTransitionEvent {
    timestamp: number;
    from: SwitchyardTier;
    to: SwitchyardTier;
    reason: string;
    route: ModelRoute;
}
export interface SessionTraceState {
    sessionId: string;
    activeTier: SwitchyardTier;
    consecutiveErrors: number;
    bashTestFailures: number;
    repeatedToolCalls: number;
    reviewRejections: number;
    consecutiveCleanSteps: number;
    lastToolKey: string;
    escalations: number;
    deescalations: number;
    events: SwitchyardTransitionEvent[];
}
export interface SwitchyardConfig {
    strategy: SwitchyardStrategy;
    efficientRoute: ModelRoute;
    capableRoute: ModelRoute;
    fallbackEfficientRoute: ModelRoute;
    fallbackCapableRoute: ModelRoute;
    deescalateAfterCleanSteps: number;
}
export declare const DEFAULT_SWITCHYARD_CONFIG: SwitchyardConfig;
export declare function mergeSwitchyardConfig(partial?: Partial<SwitchyardConfig>): SwitchyardConfig;
/**
 * NVIDIA NeMo Switchyard-inspired trajectory-aware StageRouter:
 * monitors recent tool errors, test failures, repeated calls, and review rejections
 * to escalate efficient -> capable in-place and de-escalate after sustained clean steps.
 */
export declare class SwitchyardStageRouter {
    private readonly cfg;
    private readonly sessions;
    private readonly cooldownUntil;
    constructor(partial?: Partial<SwitchyardConfig>);
    get strategy(): SwitchyardStrategy;
    stateFor(sessionId: string): SessionTraceState;
    markProviderRateLimited(provider: string, cooldownMs?: number): void;
    isProviderHealthy(provider: string): boolean;
    resolveRoute(tier: SwitchyardTier, preferredProvider?: string): ModelRoute;
    recordToolOutcome(input: {
        sessionId: string;
        toolName: string;
        argsSummary: string;
        isError: boolean;
        outputPreview?: string;
        preferredProvider?: string;
    }): {
        changed: boolean;
        tier: SwitchyardTier;
        route: ModelRoute;
        reason?: string;
    };
    recordReviewRejection(sessionId: string, reason: string, preferredProvider?: string): {
        route: ModelRoute;
    };
    clearSession(sessionId: string): void;
}
export declare function generateSwitchyardRoutesToml(cfg?: Partial<SwitchyardConfig>): string;
//# sourceMappingURL=switchyard-router.d.ts.map