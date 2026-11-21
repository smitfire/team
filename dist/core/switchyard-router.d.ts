export type SwitchyardStrategy = 'orchestrator' | 'switchyard-stage' | 'subagent-team' | 'hybrid';
export type SwitchyardTier = 'efficient' | 'capable';
export type ToolSemanticCategory = 'observe' | 'mutate' | 'verify' | 'plan' | 'delegate';
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
export interface WindowTraceEntry {
    toolName: string;
    semantics: ToolSemanticCategory;
    isError: boolean;
    testFailed: boolean;
    testPassed: boolean;
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
    recentWindow: WindowTraceEntry[];
    semanticCounts: Record<ToolSemanticCategory, number>;
    observeChurn: number;
    holdRemaining: number;
    trajectoryScore: number;
    events: SwitchyardTransitionEvent[];
}
export interface SwitchyardConfig {
    strategy: SwitchyardStrategy;
    plannerRoute: ModelRoute;
    fallbackPlannerRoute: ModelRoute;
    efficientRoute: ModelRoute;
    capableRoute: ModelRoute;
    fallbackEfficientRoute: ModelRoute;
    fallbackCapableRoute: ModelRoute;
    deescalateAfterCleanSteps: number;
    turnWindow: number;
    enableChurnEscalation: boolean;
    earlyReleaseOnVerifyPass: boolean;
}
export declare const DEFAULT_SWITCHYARD_CONFIG: SwitchyardConfig;
/**
 * Heuristic gate choosing Planner (`high` + Kanban plan) vs Direct Fast-Path (`low`, immediate tools).
 */
export declare function shouldPlanTurn(prompt: string, opts?: {
    manualPlanPinned?: boolean;
    hasPendingReviewOrReplan?: boolean;
}): boolean;
/**
 * Classify a tool call into NeMo Switchyard `tool_semantics` categories.
 */
export declare function classifyToolSemantics(toolName: string, argsSummary?: string): ToolSemanticCategory;
export declare function mergeSwitchyardConfig(partial?: Partial<SwitchyardConfig>): SwitchyardConfig;
/**
 * NVIDIA NeMo Switchyard trajectory-aware StageRouter:
 * classifies `tool_semantics`, scores sliding windows, monitors test/tool failures, repetition loops,
 * and exploration churn to escalate in-place and de-escalate cleanly or on passing verification.
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
    private pickHealthyRoute;
    resolveRoute(tier: SwitchyardTier, preferredProvider?: string): ModelRoute;
    resolvePlannerRoute(preferredProvider?: string): ModelRoute;
    resolveAlternateProviderRoute(tier: SwitchyardTier, failedProvider: string): ModelRoute;
    /**
     * Deterministic per-card tier classification so frontier planners assign efficient vs capable workers per task.
     */
    inferCardTier(card: {
        title?: string;
        description?: string;
        writeScopes?: readonly string[];
        blockedBy?: readonly string[];
    }): SwitchyardTier;
    private computeTrajectoryScore;
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
        semantics: ToolSemanticCategory;
    };
    recordReviewRejection(sessionId: string, reason: string, preferredProvider?: string): {
        route: ModelRoute;
    };
    clearSession(sessionId: string): void;
}
export declare function generateSwitchyardRoutesToml(cfg?: Partial<SwitchyardConfig>): string;
//# sourceMappingURL=switchyard-router.d.ts.map