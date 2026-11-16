export const DEFAULT_SWITCHYARD_CONFIG = {
    strategy: 'hybrid',
    efficientRoute: {
        provider: 'google-antigravity',
        model: 'antigravity-gemini-3.8-flash',
        reasoningEffort: 'low',
    },
    capableRoute: {
        provider: 'google-antigravity',
        model: 'antigravity-gemini-3.8-flash',
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
};
const TEST_FAIL_RE = /\b(?:FAIL|AssertionError|ERR_ASSERTION|ELIFECYCLE|exit code [1-9]|failures?:\s*[1-9])\b/i;
export function mergeSwitchyardConfig(partial = {}) {
    return {
        ...DEFAULT_SWITCHYARD_CONFIG,
        ...partial,
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
 * NVIDIA NeMo Switchyard-inspired trajectory-aware StageRouter:
 * monitors recent tool errors, test failures, repeated calls, and review rejections
 * to escalate efficient -> capable in-place and de-escalate after sustained clean steps.
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
    resolveRoute(tier, preferredProvider) {
        const primary = tier === 'capable' ? this.cfg.capableRoute : this.cfg.efficientRoute;
        const secondary = tier === 'capable' ? this.cfg.fallbackCapableRoute : this.cfg.fallbackEfficientRoute;
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
    recordToolOutcome(input) {
        const st = this.stateFor(input.sessionId);
        const sig = `${input.toolName}:${input.argsSummary.slice(0, 80)}`;
        if (sig === st.lastToolKey)
            st.repeatedToolCalls += 1;
        else
            st.repeatedToolCalls = 0;
        st.lastToolKey = sig;
        const testFailed = (input.toolName === 'bash' || input.toolName === 'terminal' || input.toolName === 'shell') &&
            Boolean(input.outputPreview && TEST_FAIL_RE.test(input.outputPreview));
        if (input.isError || testFailed) {
            st.consecutiveErrors += 1;
            if (testFailed)
                st.bashTestFailures += 1;
            st.consecutiveCleanSteps = 0;
        }
        else {
            st.consecutiveErrors = 0;
            st.bashTestFailures = 0;
            st.reviewRejections = 0;
            st.consecutiveCleanSteps += 1;
        }
        let escalateReason;
        if (st.activeTier === 'efficient') {
            if (st.consecutiveErrors >= 2)
                escalateReason = `consecutive_tool_errors:${st.consecutiveErrors}`;
            else if (st.bashTestFailures >= 1)
                escalateReason = 'bash_test_failure';
            else if (st.repeatedToolCalls >= 2)
                escalateReason = `repeated_tool_loop:${sig}`;
        }
        if (escalateReason) {
            const route = this.resolveRoute('capable', input.preferredProvider);
            st.activeTier = 'capable';
            st.escalations += 1;
            st.consecutiveCleanSteps = 0;
            st.events.push({ timestamp: Date.now(), from: 'efficient', to: 'capable', reason: escalateReason, route });
            return { changed: true, tier: 'capable', route, reason: escalateReason };
        }
        if (st.activeTier === 'capable' && st.consecutiveCleanSteps >= this.cfg.deescalateAfterCleanSteps) {
            const route = this.resolveRoute('efficient', input.preferredProvider);
            st.activeTier = 'efficient';
            st.deescalations += 1;
            st.consecutiveCleanSteps = 0;
            const reason = `clean_steps:${this.cfg.deescalateAfterCleanSteps}`;
            st.events.push({ timestamp: Date.now(), from: 'capable', to: 'efficient', reason, route });
            return { changed: true, tier: 'efficient', route, reason };
        }
        return {
            changed: false,
            tier: st.activeTier,
            route: this.resolveRoute(st.activeTier, input.preferredProvider),
        };
    }
    recordReviewRejection(sessionId, reason, preferredProvider) {
        const st = this.stateFor(sessionId);
        st.reviewRejections += 1;
        st.consecutiveCleanSteps = 0;
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
        '# NVIDIA NeMo Switchyard configuration generated by @smitfire/team',
        '[router]',
        `strategy = "stage_router"`,
        `escalation = true`,
        `deescalate_after_clean_steps = ${merged.deescalateAfterCleanSteps}`,
        '',
        '[stage_router]',
        'consecutive_errors_threshold = 2',
        'test_failure_escalation = true',
        'repeated_tool_threshold = 2',
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