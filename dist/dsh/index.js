import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createIsolatedWorktree, generateSwitchyardRoutesToml, removeIsolatedWorktree, runOcrDiffReview, selectCrossFamilyReviewer, SwitchyardStageRouter, verifySnapshotTests, } from '../core/index.js';
export const name = 'ns-team';
export const inject = ['tools', 'agents', 'subagents', 'systemPrompt'];
export const Config = z.object({
    strategy: z
        .union([z.const('switchyard-stage'), z.const('subagent-team'), z.const('hybrid')])
        .default('hybrid'),
    maxAdvisorCallsPerCard: z.number().default(2),
    requireHumanReviewApproval: z.boolean().default(false),
    defaultTestCommand: z.string().default('npm test'),
    deescalateAfterCleanSteps: z.number().default(3),
});
function renderJson(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}
function workspaceRootOf(agent) {
    const meta = agent?.session?.meta;
    return typeof meta?.cwd === 'string' && meta.cwd.length > 0 ? meta.cwd : process.cwd();
}
export function apply(ctx, rawConfig = {}) {
    const strategy = rawConfig.strategy ?? 'hybrid';
    const maxAdvisorCallsPerCard = rawConfig.maxAdvisorCallsPerCard ?? 2;
    const requireHumanReviewApproval = rawConfig.requireHumanReviewApproval ?? false;
    const defaultTestCommand = rawConfig.defaultTestCommand ?? 'npm test';
    const deescalateAfterCleanSteps = rawConfig.deescalateAfterCleanSteps ?? 3;
    const router = new SwitchyardStageRouter({
        strategy,
        deescalateAfterCleanSteps,
    });
    const advisorCallsByCard = new Map();
    const pendingModelSwitch = new Map();
    const childRepeatCounts = new Map();
    const getBoard = () => ctx.get('nsBoard');
    const runReviewGate = (input) => {
        const board = getBoard();
        board?.moveCard({
            cardId: input.cardId,
            toColumn: 'review',
            actor: 'ns-team',
            role: 'system',
            reason: 'Entering mandatory non-author Review gate (snapshot + OCR + cross-family)',
        });
        const snapshot = verifySnapshotTests(input.repoDir, input.testCommand);
        const ocr = input.runOcr === false
            ? { ran: false, passed: true, blockingCount: 0, findings: [] }
            : runOcrDiffReview(input.repoDir, input.baseRef);
        const reviewerChoice = selectCrossFamilyReviewer(input.authorProvider);
        const externalBlocking = [...(input.crossFamilyFindings ?? [])];
        const blockingReasons = [];
        if (!snapshot.passed)
            blockingReasons.push(`snapshot test failed (exit=${snapshot.exitCode})`);
        if (!snapshot.worktreeIntact)
            blockingReasons.push('snapshot integrity check detected mutation');
        if (ocr.blockingCount > 0) {
            blockingReasons.push(`OCR found ${ocr.blockingCount} critical/high finding(s)${ocr.error ? `: ${ocr.error}` : ''}`);
        }
        for (const reason of externalBlocking) {
            blockingReasons.push(`cross-family reviewer (${reviewerChoice.provider}): ${reason}`);
        }
        const passed = blockingReasons.length === 0;
        const summaryLines = [
            `Snapshot tests: ${snapshot.passed ? 'PASS' : 'FAIL'} (exit=${snapshot.exitCode}, intact=${snapshot.worktreeIntact})`,
            `OCR review: ${ocr.passed ? 'PASS' : 'HOLD'} (blocking=${ocr.blockingCount}, total=${ocr.findings.length})`,
            `Cross-family reviewer (${reviewerChoice.provider}/${reviewerChoice.model}${reviewerChoice.warning ? '; SINGLE-FAMILY WARNING' : ''}): ${externalBlocking.length === 0 ? 'APPROVED' : `${externalBlocking.length} blocking finding(s)`}`,
            ...(blockingReasons.length > 0 ? ['Blocking reasons:', ...blockingReasons.map((r) => `- ${r}`)] : []),
        ];
        board?.addComment({
            cardId: input.cardId,
            author: reviewerChoice.provider,
            role: 'reviewer',
            kind: 'review',
            body: summaryLines.join('\n'),
        });
        if (!passed && input.authorSessionId) {
            router.recordReviewRejection(input.authorSessionId, blockingReasons[0] ?? 'review_gate_failed');
        }
        let finalColumn = 'review';
        if (passed && !requireHumanReviewApproval) {
            board?.moveCard({
                cardId: input.cardId,
                toColumn: 'done',
                actor: reviewerChoice.provider,
                role: 'reviewer',
                reviewFindings: 0,
                reason: 'Passed snapshot + OCR + cross-family review gate',
            });
            finalColumn = 'done';
        }
        return {
            cardId: input.cardId,
            passed,
            finalColumn,
            snapshot,
            ocr,
            reviewer: {
                provider: reviewerChoice.provider,
                model: reviewerChoice.model,
                crossFamily: reviewerChoice.crossFamily,
                warning: reviewerChoice.warning,
                verdictSummary: summaryLines.join(' | '),
            },
            blockingReasons,
        };
    };
    ctx.provide('nsTeam', {
        router,
        runReviewGate,
        exportRoutesToml: () => generateSwitchyardRoutesToml({ strategy, deescalateAfterCleanSteps }),
    });
    ctx.systemPrompt.context({
        name: 'ns-team:switchyard',
        order: 184,
        interpolate: false,
        text: (assembleCtx) => {
            const sid = assembleCtx.agent ? String(assembleCtx.agent.session.id) : undefined;
            if (!sid)
                return '';
            const st = router.stateFor(sid);
            const route = router.resolveRoute(st.activeTier);
            return `<switchyard-router strategy="${strategy}" tier="${st.activeTier}" target="${route.provider}/${route.model}" escalations="${st.escalations}" deescalations="${st.deescalations}" />`;
        },
    });
    // Track tool outcomes via SwitchyardStageRouter & detect worker stall loops (>3 reminder threshold -> abort at 5).
    ctx.on('tools/result', (exec, result) => {
        if (!exec.agent)
            return;
        const sid = String(exec.agent.session.id);
        const argsStr = JSON.stringify(exec.arguments ?? {}).slice(0, 120);
        const preview = (Array.isArray(result?.content) ? result.content : [])
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join(' ')
            .slice(0, 300);
        const watch = childRepeatCounts.get(sid);
        if (watch) {
            const sig = `${exec.name}:${argsStr}`;
            if (sig === watch.lastSig) {
                watch.repeats += 1;
                if (watch.repeats >= 5) {
                    watch.controller.abort(new Error(`worker stalled repeating ${exec.name} 5 times`));
                }
            }
            else {
                watch.lastSig = sig;
                watch.repeats = 1;
            }
        }
        if (strategy === 'subagent-team')
            return;
        const transition = router.recordToolOutcome({
            sessionId: sid,
            toolName: exec.name,
            argsSummary: argsStr,
            isError: result?.isError === true,
            outputPreview: preview,
            preferredProvider: exec.agent.options?.provider,
        });
        if (transition.changed) {
            pendingModelSwitch.set(sid, transition.route);
        }
    });
    // Apply Switchyard model selection cleanly before next model step preparation.
    ctx.on('agent/pre-step', async (payload, next) => {
        const sid = String(payload.agent.session.id);
        const nextRoute = pendingModelSwitch.get(sid);
        if (nextRoute && typeof payload.agent.model?.select === 'function') {
            pendingModelSwitch.delete(sid);
            try {
                payload.agent.model.select({
                    provider: nextRoute.provider,
                    model: nextRoute.model,
                    reasoningEffort: nextRoute.reasoningEffort,
                });
            }
            catch {
                /* ignore if session adapter pins a single static route */
            }
        }
        return next();
    });
    ctx.on('agent/disposed', ({ agent }) => {
        const sid = String(agent.session.id);
        router.clearSession(sid);
        pendingModelSwitch.delete(sid);
        childRepeatCounts.delete(sid);
    });
    const schemaObj = { type: 'object', properties: {}, additionalProperties: true };
    ctx.tools.register(defineTool({
        name: 'propose_work',
        description: 'Decompose work into Kanban cards with writeScopes and cycle-checked blockedBy DAG dependencies.',
        parameters: {
            cards: { type: 'json', required: true, description: 'Array of { id?, title, description?, writeScopes?, blockedBy?, owner? }.' },
        },
        output: { schema: schemaObj, render: renderJson },
        execute: async (args, exec) => {
            const board = getBoard();
            if (!board)
                throw new Error('@smitfire/board (nsBoard) is required to propose team cards');
            const list = Array.isArray(args.cards) ? args.cards : [];
            const created = [];
            for (const item of list) {
                created.push(board.proposeCard({
                    id: typeof item.id === 'string' ? item.id : undefined,
                    title: String(item.title ?? ''),
                    description: typeof item.description === 'string' ? item.description : undefined,
                    owner: typeof item.owner === 'string' ? item.owner : 'worker',
                    agentSessionId: exec.agent ? String(exec.agent.session.id) : undefined,
                    writeScopes: Array.isArray(item.writeScopes) ? item.writeScopes.map(String) : undefined,
                    blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.map(String) : undefined,
                }));
            }
            return { proposed: created.length, cards: created };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'dispatch_worker',
        description: 'Run a worker on a card in an isolated git worktree, await context flush, and run mandatory Review gate (snapshot + OCR + cross-family).',
        parameters: {
            cardId: { type: 'string', required: true, description: 'Target Kanban card id.' },
            task: { type: 'string', required: true, description: 'Focused execution prompt for the worker.' },
            testCommand: { type: 'string', description: 'Verification command for hermetic snapshot gate.' },
            useWorktree: { type: 'boolean', description: 'Use isolated git worktree (default true when inside git repo).' },
        },
        output: { schema: schemaObj, render: renderJson },
        execute: async (args, exec) => {
            if (!exec.agent)
                throw new Error('dispatch_worker requires an active parent agent');
            const board = getBoard();
            const cardId = String(args.cardId);
            const repoRoot = workspaceRootOf(exec.agent);
            const inGitRepo = existsSync(join(repoRoot, '.git'));
            const useWorktree = args.useWorktree !== false && inGitRepo;
            let worktreeInfo = null;
            if (useWorktree) {
                worktreeInfo = createIsolatedWorktree(repoRoot, cardId);
            }
            const workerDir = worktreeInfo?.worktreePath ?? repoRoot;
            const baseSha = worktreeInfo?.headSha ?? 'HEAD~1';
            const authorProvider = exec.agent.options?.provider ?? router.resolveRoute('efficient').provider;
            const stallCtrl = new AbortController();
            const combinedSignal = AbortSignal.any([exec.signal, stallCtrl.signal]);
            board?.moveCard({
                cardId,
                toColumn: 'in_progress',
                actor: 'orchestrator',
                role: 'orchestrator',
                agentSessionId: String(exec.agent.session.id),
                reason: `Dispatched worker in ${worktreeInfo ? worktreeInfo.branch : workerDir}`,
            });
            let workerSummary = '';
            let workerError;
            let activation;
            try {
                activation = await ctx.subagents.startActivation({
                    provider: 'spawn',
                    parent: exec.agent,
                    cwd: workerDir,
                    label: `worker:${cardId}`,
                    name: `w-${cardId.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 20) || 'card'}`,
                    prompt: [{ type: 'text', text: String(args.task) }],
                    signal: combinedSignal,
                    delivery: 'caller',
                });
                const childSid = String(activation.childId);
                childRepeatCounts.set(childSid, { lastSig: '', repeats: 0, controller: stallCtrl });
                const subResult = await activation.result;
                workerSummary = subResult.output
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n')
                    .slice(0, 4000);
                // Flush pending Forewisp context writes before tearing down child session.
                const nsContext = ctx.get('nsContext');
                if (nsContext?.flushDeferredForSession) {
                    await nsContext.flushDeferredForSession(childSid);
                }
            }
            catch (err) {
                workerError = err instanceof Error ? err.message : String(err);
            }
            finally {
                if (activation) {
                    childRepeatCounts.delete(String(activation.childId));
                    try {
                        await activation.dispose();
                    }
                    catch { /* ignore teardown error */ }
                }
            }
            if (workerError) {
                if (worktreeInfo)
                    removeIsolatedWorktree(repoRoot, worktreeInfo.worktreePath);
                board?.moveCard({
                    cardId,
                    toColumn: 'blocked',
                    actor: 'orchestrator',
                    role: 'system',
                    reason: `Worker failed: ${workerError}`,
                });
                return { ok: false, status: 'worker_failed', error: workerError };
            }
            // Run mandatory Review Gate before cleanup so worker diff & tests can be inspected.
            if (worktreeInfo) {
                try {
                    execFileSync('git', ['-C', worktreeInfo.worktreePath, '-c', 'core.hooksPath=/dev/null', 'add', '-A'], {
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                }
                catch { /* ignore */ }
            }
            const review = runReviewGate({
                cardId,
                repoDir: workerDir,
                baseRef: baseSha,
                testCommand: typeof args.testCommand === 'string' && args.testCommand.trim() ? args.testCommand : defaultTestCommand,
                authorProvider,
                authorSessionId: String(exec.agent.session.id),
            });
            return {
                ok: review.passed,
                workerSummary,
                worktreePath: worktreeInfo?.worktreePath,
                review,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'ask_advisor',
        description: 'Consult a read-only Advisor model (capped <= 2 calls/card) and record decision rationale on the Kanban card.',
        parameters: {
            cardId: { type: 'string', required: true, description: 'Card id being consulted on.' },
            question: { type: 'string', required: true, description: 'Specific architectural or debugging question.' },
        },
        output: { schema: schemaObj, render: renderJson },
        execute: async (args, exec) => {
            if (!exec.agent)
                throw new Error('ask_advisor requires an active parent agent');
            const cardId = String(args.cardId);
            const count = advisorCallsByCard.get(cardId) ?? 0;
            if (count >= maxAdvisorCallsPerCard) {
                return { ok: false, error: `advisor budget exhausted for card "${cardId}" (${count}/${maxAdvisorCallsPerCard})` };
            }
            advisorCallsByCard.set(cardId, count + 1);
            const parentProvider = exec.agent.options?.provider ?? router.resolveRoute('efficient').provider;
            const advisorChoice = selectCrossFamilyReviewer(parentProvider);
            const capableRoute = router.resolveRoute('capable', advisorChoice.provider);
            const activation = await ctx.subagents.startActivation({
                provider: 'spawn',
                parent: exec.agent,
                cwd: workspaceRootOf(exec.agent),
                label: `advisor:${cardId}`,
                prompt: [
                    {
                        type: 'text',
                        text: `[READ-ONLY ADVISOR — DO NOT EDIT FILES] Answer concisely:\n${String(args.question)}`,
                    },
                ],
                agentOptions: {
                    provider: capableRoute.provider,
                    model: capableRoute.model,
                    reasoningEffort: capableRoute.reasoningEffort,
                },
                signal: exec.signal,
                delivery: 'caller',
            });
            let advice = '';
            try {
                const res = await activation.result;
                advice = res.output
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n')
                    .slice(0, 2000);
            }
            finally {
                await activation.dispose();
            }
            getBoard()?.addComment({
                cardId,
                author: `${capableRoute.provider}/${capableRoute.model}`,
                role: 'advisor',
                kind: 'note',
                body: `Advisor (#${count + 1}/${maxAdvisorCallsPerCard}): ${advice}`,
            });
            return { ok: true, count: count + 1, max: maxAdvisorCallsPerCard, model: capableRoute, advice };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'switchyard_status',
        description: 'Inspect Switchyard StageRouter trajectory state, active tier, or export Switchyard routes.toml.',
        parameters: {
            exportRoutesToml: { type: 'boolean', description: 'Include rendered Switchyard routes.toml config.' },
        },
        output: { schema: schemaObj, render: renderJson },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const sid = exec.agent ? String(exec.agent.session.id) : 'default';
            const state = router.stateFor(sid);
            return {
                strategy,
                activeRoute: router.resolveRoute(state.activeTier, exec.agent?.options?.provider),
                state,
                ...(args.exportRoutesToml ? { routesToml: generateSwitchyardRoutesToml({ strategy, deescalateAfterCleanSteps }) } : {}),
            };
        },
    }));
}
//# sourceMappingURL=index.js.map