import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SwitchyardStageRouter, type OcrGateResult, type SnapshotVerifyResult, type SwitchyardStrategy } from '../core/index.js';
export declare const name = "ns-team";
export declare const inject: readonly ["tools", "agents", "subagents", "systemPrompt"];
export interface PluginConfig {
    strategy: SwitchyardStrategy;
    maxAdvisorCallsPerCard: number;
    requireHumanReviewApproval: boolean;
    defaultTestCommand: string;
    deescalateAfterCleanSteps: number;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    strategy: z<"switchyard-stage" | "subagent-team" | "hybrid", "switchyard-stage" | "subagent-team" | "hybrid", "defined">;
    maxAdvisorCallsPerCard: z<number, number, "defined">;
    requireHumanReviewApproval: z<boolean, boolean, "defined">;
    defaultTestCommand: z<string, string, "defined">;
    deescalateAfterCleanSteps: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    strategy: z<"switchyard-stage" | "subagent-team" | "hybrid", "switchyard-stage" | "subagent-team" | "hybrid", "defined">;
    maxAdvisorCallsPerCard: z<number, number, "defined">;
    requireHumanReviewApproval: z<boolean, boolean, "defined">;
    defaultTestCommand: z<string, string, "defined">;
    deescalateAfterCleanSteps: z<number, number, "defined">;
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
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        nsTeam?: NsTeamService;
    }
}
export declare function apply(ctx: Context, rawConfig?: Partial<PluginConfig>): void;
//# sourceMappingURL=index.d.ts.map