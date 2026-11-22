import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { StallWatchdog, SwitchyardStageRouter, type OcrGateResult, type SnapshotVerifyResult, type SwitchyardStrategy, type SwitchyardTier } from '../core/index.js';
export declare const name = "ns-team";
export declare const inject: readonly ["tools", "agents", "subagents", "systemPrompt"];
export type OrchestratorPhase = 'planning' | 'executing';
export interface OrchestratorSessionState {
    sessionId: string;
    phase: OrchestratorPhase;
    fastPathTurn?: boolean;
    manualPlanPinned?: boolean;
    lastClassifiedMsgKey?: string;
    activeCardId?: string;
    planSummary?: string;
    replanIf?: string;
    lastReplanReason?: string;
    stepsSincePlan: number;
    consecutiveFailures: number;
    planHandoffs: number;
    replans: number;
    cadenceReviews: number;
    lastTurnSeen?: number;
    pendingReplanNotice?: string;
    pendingCadenceNotice?: string;
    createdInlineCardIds: string[];
}
export interface PluginConfig {
    strategy: SwitchyardStrategy;
    adaptiveFastPath?: boolean;
    maxAdvisorCallsPerCard: number;
    requireHumanReviewApproval: boolean;
    defaultTestCommand: string;
    deescalateAfterCleanSteps: number;
    stallTimeoutMs?: number;
    watchdogSweepMs?: number;
    maxAutoContinuations?: number;
    maxRequestErrorRetries?: number;
    maxStallRecoveries?: number;
    retryBackoffMs?: number;
    progressWatchLimit?: number;
    watchdogFollowupSettleMs?: number;
    maxDispatchAttempts?: number;
    cadenceSteps?: number;
    twoStrikeThreshold?: number;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    strategy: z<"orchestrator" | "switchyard-stage" | "subagent-team" | "hybrid", "orchestrator" | "switchyard-stage" | "subagent-team" | "hybrid", "defined">;
    adaptiveFastPath: z<boolean, boolean, "defined">;
    maxAdvisorCallsPerCard: z<number, number, "defined">;
    requireHumanReviewApproval: z<boolean, boolean, "defined">;
    defaultTestCommand: z<string, string, "defined">;
    deescalateAfterCleanSteps: z<number, number, "defined">;
    stallTimeoutMs: z<number, number, "defined">;
    watchdogSweepMs: z<number, number, "defined">;
    maxAutoContinuations: z<number, number, "defined">;
    maxRequestErrorRetries: z<number, number, "defined">;
    maxStallRecoveries: z<number, number, "defined">;
    retryBackoffMs: z<number, number, "defined">;
    progressWatchLimit: z<number, number, "defined">;
    watchdogFollowupSettleMs: z<number, number, "defined">;
    maxDispatchAttempts: z<number, number, "defined">;
    cadenceSteps: z<number, number, "defined">;
    twoStrikeThreshold: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    strategy: z<"orchestrator" | "switchyard-stage" | "subagent-team" | "hybrid", "orchestrator" | "switchyard-stage" | "subagent-team" | "hybrid", "defined">;
    adaptiveFastPath: z<boolean, boolean, "defined">;
    maxAdvisorCallsPerCard: z<number, number, "defined">;
    requireHumanReviewApproval: z<boolean, boolean, "defined">;
    defaultTestCommand: z<string, string, "defined">;
    deescalateAfterCleanSteps: z<number, number, "defined">;
    stallTimeoutMs: z<number, number, "defined">;
    watchdogSweepMs: z<number, number, "defined">;
    maxAutoContinuations: z<number, number, "defined">;
    maxRequestErrorRetries: z<number, number, "defined">;
    maxStallRecoveries: z<number, number, "defined">;
    retryBackoffMs: z<number, number, "defined">;
    progressWatchLimit: z<number, number, "defined">;
    watchdogFollowupSettleMs: z<number, number, "defined">;
    maxDispatchAttempts: z<number, number, "defined">;
    cadenceSteps: z<number, number, "defined">;
    twoStrikeThreshold: z<number, number, "defined">;
}>>, "plain">;
export interface ReviewGateReport {
    cardId: string;
    passed: boolean;
    finalColumn: 'review' | 'done';
    snapshot: SnapshotVerifyResult;
    ocr: OcrGateResult;
    reviewer: {
        provider: string;
        model: string;
        crossFamily: boolean;
        warning?: string;
        verdictSummary: string;
    };
    blockingReasons: string[];
}
export interface NsTeamService {
    readonly router: SwitchyardStageRouter;
    readonly watchdog: StallWatchdog;
    readonly strategy: SwitchyardStrategy;
    getOrchestratorState(sessionId: string): OrchestratorSessionState;
    exitPlanMode(input: {
        sessionId: string;
        plan: string;
        replanIf?: string;
        executionTier?: SwitchyardTier;
        cards?: Array<Record<string, unknown>>;
        preferredProvider?: string;
    }): {
        ok: boolean;
        phase: OrchestratorPhase;
        cardId?: string;
        nextRoute: {
            provider: string;
            model: string;
            reasoningEffort: string;
        };
        cardsCreated: number;
    };
    enterPlanMode(input: {
        sessionId: string;
        reason: string;
        cardId?: string;
        preferredProvider?: string;
        kind?: 'manual' | 'two_strike' | 'cadence';
    }): {
        ok: boolean;
        phase: OrchestratorPhase;
        cardId?: string;
        nextRoute: {
            provider: string;
            model: string;
            reasoningEffort: string;
        };
        reason: string;
    };
    runReviewGate(input: {
        cardId: string;
        repoDir: string;
        baseRef: string;
        testCommand: string;
        authorProvider: string;
        authorSessionId?: string;
        crossFamilyFindings?: readonly string[];
        runOcr?: boolean;
    }): ReviewGateReport;
    exportRoutesToml(): string;
    reconcileOrphanedCards(): number;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        nsTeam?: NsTeamService;
    }
}
export declare function apply(ctx: Context, rawConfig?: Partial<PluginConfig>): void;
//# sourceMappingURL=index.d.ts.map