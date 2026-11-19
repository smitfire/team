export const DEFAULT_SWITCHYARD_CONFIG = {
    strategy: 'orchestrator',
    plannerRoute: {
        provider: 'google-antigravity',
        model: 'antigravity-gemini-4-hydrogen',
        reasoningEffort: 'high',
    },
    fallbackPlannerRoute: {
        provider: 'openai-codex',
        model: 'gpt-6.1-terra',
        reasoningEffort: 'high',
    },
    efficientRoute: {
        provider: 'google-antigravity',
        model: 'antigravity-gemini-4-hydrogen',
        reasoningEffort: 'low',
    },
    capableRoute: {
        provider: 'google-antigravity',
        model: 'antigravity-gemini-4-hydrogen',
        reasoningEffort: 'high',
    },
    fallbackEfficientRoute: {
        provider: 'openai-codex',
        model: 'gpt-6-luna',
        reasoningEffort: 'low',
    },
    fallbackCapableRoute: {
        provider: 'openai-codex',
        model: 'gpt-6.1-terra',
        reasoningEffort: 'high',
    },
    deescalateAfterCleanSteps: 3,
    turnWindow: 3,
    enableChurnEscalation: true,
    earlyReleaseOnVerifyPass: true,
};
const TEST_FAIL_RE = /\b(?:FAIL|AssertionError|ERR_ASSERTION|ELIFECYCLE|exit code [1-9]|failures?:\s*[1-9])\b/i;
const TEST_PASS_RE = /\b(?:PASS|all tests? passed|0 failures?|fail\s+0|[1-9]\d*\s+passed)\b/i;
const PLAN_TOOLS_RE = /^(?:handoff_plan|exit_plan_mode|enter_plan_mode|propose_work|board_propose|orchestrator_status|forewisp_upsert)$/i;
const DELEGATE_TOOLS_RE = /^(?:dispatch_worker|ask_advisor|spawn|subagent|agent_team)$/i;
const MUTATE_TOOLS_RE = /^(?:edit|edit_file|write|write_file|apply_patch|patch|multi_edit|str_replace|replace_in_file|create_file|fs_write|board_move|board_comment)$/i;
const SHELL_TOOLS_RE = /^(?:bash|terminal|shell)$/i;
const PTC_TOOLS_RE = /^(?:run_code|execute_code)$/i;
const SHELL_VERIFY_RE = /\b(?:node\s+--test|npm\s+test|pnpm\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|tsc\b|eslint|typecheck)\b/i;
const SHELL_MUTATE_RE = /(?:(?<![=0-9&])>>?(?![&>])|<<|\b(?:tee|rm|mv|cp|touch|mkdir|rmdir|chmod|chown|truncate|dd|git\s+(?:commit|checkout|reset|apply))\b|\bsed\s+-i)/i;
const PTC_MUTATE_RE = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|mkdir(?:Sync)?)\b/;
const CAPABLE_CARD_SIGNAL_RE = /\b(?:architect|design|plan|concurren\w*|race|security|auth\w*|token|migrat\w*|refactor|deadlock|retry|failover|debug|recover|investigat\w*|orchestrat\w*|contract)\b/i;
/**
 * Classify a tool call into NeMo Switchyard `tool_semantics` categories.
 */
export function classifyToolSemantics(toolName, argsSummary = '') {
    const name = toolName.trim();
    if (PLAN_TOOLS_RE.test(name))
        return 'plan';
    if (DELEGATE_TOOLS_RE.test(name))
        return 'delegate';
    if (MUTATE_TOOLS_RE.test(name))
        return 'mutate';
    if (SHELL_TOOLS_RE.test(name)) {
        if (SHELL_VERIFY_RE.test(argsSummary) && !SHELL_MUTATE_RE.test(argsSummary))
            return 'verify';
        if (SHELL_MUTATE_RE.test(argsSummary))
            return 'mutate';
        return 'observe';
    }
    if (PTC_TOOLS_RE.test(name)) {
        return PTC_MUTATE_RE.test(argsSummary) ? 'mutate' : 'observe';
    }
    return 'observe';
}
export function mergeSwitchyardConfig(partial = {}) {
    return {
        ...DEFAULT_SWITCHYARD_CONFIG,
        ...partial,
        plannerRoute: { ...DEFAULT_SWITCHYARD_CONFIG.plannerRoute, ...partial.plannerRoute },
        fallbackPlannerRoute: { ...DEFAULT_SWITCHYARD_CONFIG.fallbackPlannerRoute, ...partial.fallbackPlannerRoute },
        efficientRoute: { ...DEFAULT_SWITCHYARD_CONFIG.efficientRoute, ...partial.efficientRoute },
        capableRoute: { ...DEFAULT_SWITCHYARD_CONFIG.capableRoute, ...partial.capableRoute },
        fallbackEfficientRoute: {
            ...DEFAULT_SWITCHYARD_CONFIG.fallbackEfficientRoute,
            ...partial.fallbackEfficientRoute,
        },
        fallbackCapableRoute: {
            ...DEFAULT_SWITCHYARD_CONFIG.fallbackCapableRoute,
            ...partial.fallbackCapableRoute,
        },
    };
}
/**
 * NVIDIA NeMo Switchyard trajectory-aware StageRouter:
 * classifies `tool_semantics`, scores sliding windows, monitors test/tool failures, repetition loops,
 * and exploration churn to escalate in-place and de-escalate cleanly or on passing verification.
 */
export class SwitchyardStageRouter {
    cfg;
    sessions = new Map();
    cooldownUntil = new Map();
    constructor(partial = {}) {
        this.cfg = mergeSwitchyardConfig(partial);
    }
    get strategy() {
        return this.cfg.strategy;
    }
    stateFor(sessionId) {
        let st = this.sessions.get(sessionId);
        if (!st) {
            st = {
                sessionId,
                activeTier: 'efficient',
                consecutiveErrors: 0,
                bashTestFailures: 0,
                repeatedToolCalls: 0,
                reviewRejections: 0,
                consecutiveCleanSteps: 0,
                lastToolKey: '',
                escalations: 0,
                deescalations: 0,
                recentWindow: [],
                semanticCounts: { observe: 0, mutate: 0, verify: 0, plan: 0, delegate: 0 },
                observeChurn: 0,
                holdRemaining: 0,
                trajectoryScore: 0,
                events: [],
            };
            this.sessions.set(sessionId, st);
        }
        return st;
    }
    markProviderRateLimited(provider, cooldownMs = 60_000) {
        this.cooldownUntil.set(provider, Date.now() + cooldownMs);
    }
    isProviderHealthy(provider) {
        const until = this.cooldownUntil.get(provider);
        return !until || Date.now() >= until;
    }
    pickHealthyRoute(primary, secondary, preferredProvider) {
        if (preferredProvider === secondary.provider && this.isProviderHealthy(secondary.provider)) {
            return secondary;
        }
        if (this.isProviderHealthy(primary.provider))
            return primary;
        if (this.isProviderHealthy(secondary.provider))
            return secondary;
        const pExp = this.cooldownUntil.get(primary.provider) ?? 0;
        const sExp = this.cooldownUntil.get(secondary.provider) ?? 0;
        return sExp < pExp ? secondary : primary;
    }
    resolveRoute(tier, preferredProvider) {
        const primary = tier === 'capable' ? this.cfg.capableRoute : this.cfg.efficientRoute;
        const secondary = tier === 'capable' ? this.cfg.fallbackCapableRoute : this.cfg.fallbackEfficientRoute;
        return this.pickHealthyRoute(primary, secondary, preferredProvider);
    }
    resolvePlannerRoute(preferredProvider) {
        return this.pickHealthyRoute(this.cfg.plannerRoute, this.cfg.fallbackPlannerRoute, preferredProvider);
    }
    resolveAlternateProviderRoute(tier, failedProvider) {
        const candidates = tier === 'capable'
            ? [this.cfg.fallbackCapableRoute, this.cfg.capableRoute]
            : [this.cfg.fallbackEfficientRoute, this.cfg.efficientRoute];
        const alt = candidates.find((c) => c.provider !== failedProvider && this.isProviderHealthy(c.provider));
        if (alt)
            return alt;
        return candidates.find((c) => c.provider !== failedProvider) ?? candidates[0];
    }
    /**
     * Deterministic per-card tier classification so frontier planners assign efficient vs capable workers per task.
     */
    inferCardTier(card) {
        if ((card.blockedBy?.length ?? 0) >= 1 || (card.writeScopes?.length ?? 0) >= 3) {
            return 'capable';
        }
        const text = `${card.title ?? ''} ${card.description ?? ''}`;
        if (CAPABLE_CARD_SIGNAL_RE.test(text)) {
            return 'capable';
        }
        return 'efficient';
    }
    computeTrajectoryScore(st) {
        let score = 0;
        for (const entry of st.recentWindow) {
            if (entry.testFailed)
                score += 3;
            else if (entry.isError)
                score += 2;
            else if (entry.testPassed)
                score -= 2;
            else if (entry.semantics === 'mutate' || entry.semantics === 'verify')
                score -= 1;
        }
        if (st.repeatedToolCalls >= 1)
            score += st.repeatedToolCalls;
        if (st.observeChurn >= 3)
            score += 1;
        return Math.max(0, Math.min(10, score));
    }
    recordToolOutcome(input) {
        const st = this.stateFor(input.sessionId);
        const sig = `${input.toolName}:${input.argsSummary.slice(0, 80)}`;
        if (sig === st.lastToolKey)
            st.repeatedToolCalls += 1;
        else
            st.repeatedToolCalls = 0;
        st.lastToolKey = sig;
        const semantics = classifyToolSemantics(input.toolName, input.argsSummary);
        st.semanticCounts[semantics] = (st.semanticCounts[semantics] ?? 0) + 1;
        if (semantics === 'observe' && !input.isError) {
            st.observeChurn += 1;
        }
        else if (!input.isError) {
            st.observeChurn = 0;
        }
        const isBashVerify = SHELL_TOOLS_RE.test(input.toolName.trim()) || semantics === 'verify';
        const testFailed = Boolean(isBashVerify && input.outputPreview && TEST_FAIL_RE.test(input.outputPreview));
        const testPassed = Boolean(semantics === 'verify' && !input.isError && !testFailed && input.outputPreview && TEST_PASS_RE.test(input.outputPreview));
        st.recentWindow.push({ toolName: input.toolName, semantics, isError: input.isError, testFailed, testPassed });
        const maxWin = Math.max(1, this.cfg.turnWindow);
        while (st.recentWindow.length > maxWin)
            st.recentWindow.shift();
        if (input.isError || testFailed) {
            st.consecutiveErrors += 1;
            if (testFailed)
                st.bashTestFailures += 1;
            st.consecutiveCleanSteps = 0;
            if (st.activeTier === 'capable') {
                st.holdRemaining = this.cfg.deescalateAfterCleanSteps;
            }
        }
        else {
            st.consecutiveErrors = 0;
            st.bashTestFailures = 0;
            st.reviewRejections = 0;
            st.consecutiveCleanSteps += 1;
            if (st.activeTier === 'capable') {
                if (testPassed && this.cfg.earlyReleaseOnVerifyPass) {
                    st.holdRemaining = 0;
                }
                else {
                    st.holdRemaining = Math.max(0, st.holdRemaining - 1);
                }
            }
        }
        st.trajectoryScore = this.computeTrajectoryScore(st);
        let escalateReason;
        if (st.activeTier === 'efficient') {
            if (st.consecutiveErrors >= 2)
                escalateReason = `consecutive_tool_errors:${st.consecutiveErrors}`;
            else if (st.bashTestFailures >= 1)
                escalateReason = 'bash_test_failure';
            else if (st.repeatedToolCalls >= 2)
                escalateReason = `repeated_tool_loop:${sig}`;
            else if (this.cfg.enableChurnEscalation && st.observeChurn >= 5) {
                escalateReason = `observe_churn:${st.observeChurn}`;
            }
        }
        if (escalateReason) {
            const route = this.resolveRoute('capable', input.preferredProvider);
            st.activeTier = 'capable';
            st.escalations += 1;
            st.consecutiveCleanSteps = 0;
            st.holdRemaining = this.cfg.deescalateAfterCleanSteps;
            st.observeChurn = 0;
            st.events.push({ timestamp: Date.now(), from: 'efficient', to: 'capable', reason: escalateReason, route });
            return { changed: true, tier: 'capable', route, reason: escalateReason, semantics };
        }
        if (st.activeTier === 'capable' &&
            !input.isError &&
            !testFailed &&
            ((testPassed && this.cfg.earlyReleaseOnVerifyPass) ||
                (st.holdRemaining === 0 && st.consecutiveCleanSteps >= this.cfg.deescalateAfterCleanSteps))) {
            const route = this.resolveRoute('efficient', input.preferredProvider);
            st.activeTier = 'efficient';
            st.deescalations += 1;
            st.consecutiveCleanSteps = 0;
            st.holdRemaining = 0;
            const reason = testPassed && this.cfg.earlyReleaseOnVerifyPass
                ? 'verify_pass_early_release'
                : `clean_steps:${this.cfg.deescalateAfterCleanSteps}`;
            st.events.push({ timestamp: Date.now(), from: 'capable', to: 'efficient', reason, route });
            return { changed: true, tier: 'efficient', route, reason, semantics };
        }
        return {
            changed: false,
            tier: st.activeTier,
            route: this.resolveRoute(st.activeTier, input.preferredProvider),
            semantics,
        };
    }
    recordReviewRejection(sessionId, reason, preferredProvider) {
        const st = this.stateFor(sessionId);
        st.reviewRejections += 1;
        st.consecutiveCleanSteps = 0;
        st.holdRemaining = this.cfg.deescalateAfterCleanSteps;
        const route = this.resolveRoute('capable', preferredProvider);
        if (st.activeTier !== 'capable') {
            st.activeTier = 'capable';
            st.escalations += 1;
            st.events.push({
                timestamp: Date.now(),
                from: 'efficient',
                to: 'capable',
                reason: `review_rejection:${reason.slice(0, 80)}`,
                route,
            });
        }
        return { route };
    }
    clearSession(sessionId) {
        this.sessions.delete(sessionId);
    }
}
export function generateSwitchyardRoutesToml(cfg = {}) {
    const merged = mergeSwitchyardConfig(cfg);
    return [
        '# NVIDIA NeMo Switchyard (libsy) configuration generated by @smitfire/team',
        '[router]',
        `strategy = "stage_router"`,
        `orchestrator_default = ${merged.strategy === 'orchestrator'}`,
        `escalation = true`,
        `deescalate_after_clean_steps = ${merged.deescalateAfterCleanSteps}`,
        '',
        '[stage_router]',
        `turn_window = ${merged.turnWindow}`,
        `hold_turns = ${merged.deescalateAfterCleanSteps}`,
        'consecutive_errors_threshold = 2',
        'test_failure_escalation = true',
        'repeated_tool_threshold = 2',
        `observe_churn_escalation = ${merged.enableChurnEscalation}`,
        `early_release_on_verify_pass = ${merged.earlyReleaseOnVerifyPass}`,
        '',
        '[routes.switchyard]',
        'strategy = "stage_router"',
        `turn_window = ${merged.turnWindow}`,
        `hold_turns = ${merged.deescalateAfterCleanSteps}`,
        `early_release_on_verify_pass = ${merged.earlyReleaseOnVerifyPass}`,
        '',
        '[routes.switchyard.stage.tool_semantics]',
        'categories = ["observe", "mutate", "verify", "plan", "delegate"]',
        'observe_churn_threshold = 5',
        '',
        '[composite.advisor_gate]',
        'max_calls_per_card = 2',
        'cross_family = true',
        '',
        '[composite.subagents]',
        'per_card_model_tiering = true',
        'cold_resume_tier = "capable"',
        '',
        '[targets.planner]',
        `provider = "${merged.plannerRoute.provider}"`,
        `model = "${merged.plannerRoute.model}"`,
        `reasoning_effort = "${merged.plannerRoute.reasoningEffort}"`,
        '',
        '[targets.fallback_planner]',
        `provider = "${merged.fallbackPlannerRoute.provider}"`,
        `model = "${merged.fallbackPlannerRoute.model}"`,
        `reasoning_effort = "${merged.fallbackPlannerRoute.reasoningEffort}"`,
        '',
        '[targets.efficient]',
        `provider = "${merged.efficientRoute.provider}"`,
        `model = "${merged.efficientRoute.model}"`,
        `reasoning_effort = "${merged.efficientRoute.reasoningEffort}"`,
        '',
        '[targets.capable]',
        `provider = "${merged.capableRoute.provider}"`,
        `model = "${merged.capableRoute.model}"`,
        `reasoning_effort = "${merged.capableRoute.reasoningEffort}"`,
        '',
        '[targets.fallback_efficient]',
        `provider = "${merged.fallbackEfficientRoute.provider}"`,
        `model = "${merged.fallbackEfficientRoute.model}"`,
        `reasoning_effort = "${merged.fallbackEfficientRoute.reasoningEffort}"`,
        '',
        '[targets.fallback_capable]',
        `provider = "${merged.fallbackCapableRoute.provider}"`,
        `model = "${merged.fallbackCapableRoute.model}"`,
        `reasoning_effort = "${merged.fallbackCapableRoute.reasoningEffort}"`,
        '',
    ].join('\n');
}
//# sourceMappingURL=switchyard-router.js.map