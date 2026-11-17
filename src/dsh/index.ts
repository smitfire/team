import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import {
  createIsolatedWorktree,
  DEFAULT_PROGRESS_WATCH_LIMIT,
  generateSwitchyardRoutesToml,
  isRetryableUpstreamFailure,
  isUserAbortFailure,
  makeWatchdogUserMessage,
  removeIsolatedWorktree,
  runOcrDiffReview,
  selectCrossFamilyReviewer,
  StallWatchdog,
  SwitchyardStageRouter,
  verifySnapshotTests,
  type OcrGateResult,
  type SnapshotVerifyResult,
  type SwitchyardStrategy,
} from '../core/index.js';

const WATCHDOG_FOLLOWUP_SETTLE_MS = 150;
const MAX_DISPATCH_ATTEMPTS = 2;

export const name = 'ns-team';
export const inject = ['tools', 'agents', 'subagents', 'systemPrompt'] as const;

export interface PluginConfig {
  strategy: SwitchyardStrategy;
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
}

export const Config = z.object({
  strategy: z
    .union([z.const('switchyard-stage'), z.const('subagent-team'), z.const('hybrid')])
    .default('hybrid'),
  maxAdvisorCallsPerCard: z.number().default(2),
  requireHumanReviewApproval: z.boolean().default(false),
  defaultTestCommand: z.string().default('npm test'),
  deescalateAfterCleanSteps: z.number().default(3),
  stallTimeoutMs: z.number().default(90_000),
  watchdogSweepMs: z.number().default(5_000),
  maxAutoContinuations: z.number().default(3),
  maxRequestErrorRetries: z.number().default(2),
  maxStallRecoveries: z.number().default(2),
  retryBackoffMs: z.number().default(600),
});

export interface ReviewGateReport {
  cardId: string;
  passed: boolean;
  finalColumn: 'review' | 'done';
  snapshot: SnapshotVerifyResult;
  ocr: OcrGateResult;
  reviewer: { provider: string; model: string; crossFamily: boolean; warning?: string; verdictSummary: string };
  blockingReasons: string[];
}

export interface NsTeamService {
  readonly router: SwitchyardStageRouter;
  readonly watchdog: StallWatchdog;
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

interface BoardApiLike {
  proposeCard(req: Record<string, unknown>): { card: { id: string; revision: number }; scopeConflicts: unknown[] };
  moveCard(req: Record<string, unknown>): { ok: boolean; status: string; card?: { id: string; revision: number } };
  addComment(req: Record<string, unknown>): unknown;
  getCard(id: string): { id: string; revision: number; owner: string } | undefined;
  snapshot?(): {
    cards: Array<{ id: string; column: string; revision: number; agentSessionId?: string }>;
  };
}

interface ContextApiLike {
  flushDeferredForSession?(sessionId: string): Promise<number>;
}

function sleepWithSignal(
  ms: number,
  signal: AbortSignal | undefined,
  pendingTimers: Set<ReturnType<typeof setTimeout>>,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      pendingTimers.delete(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    pendingTimers.add(timer);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

function workspaceRootOf(agent?: Agent): string {
  const meta = (agent?.session as { meta?: { cwd?: string } } | undefined)?.meta;
  return typeof meta?.cwd === 'string' && meta.cwd.length > 0 ? meta.cwd : process.cwd();
}

export function apply(ctx: Context, rawConfig: Partial<PluginConfig> = {}): void {
  const strategy: SwitchyardStrategy = rawConfig.strategy ?? 'hybrid';
  const maxAdvisorCallsPerCard = rawConfig.maxAdvisorCallsPerCard ?? 2;
  const requireHumanReviewApproval = rawConfig.requireHumanReviewApproval ?? false;
  const defaultTestCommand = rawConfig.defaultTestCommand ?? 'npm test';
  const deescalateAfterCleanSteps = rawConfig.deescalateAfterCleanSteps ?? 3;
  const stallTimeoutMs = rawConfig.stallTimeoutMs ?? 90_000;
  const watchdogSweepMs = rawConfig.watchdogSweepMs ?? 5_000;
  const maxAutoContinuations = rawConfig.maxAutoContinuations ?? 3;
  const maxRequestErrorRetries = rawConfig.maxRequestErrorRetries ?? 2;
  const maxStallRecoveries = rawConfig.maxStallRecoveries ?? 2;
  const retryBackoffMs = rawConfig.retryBackoffMs ?? 600;

  const router = new SwitchyardStageRouter({
    strategy,
    deescalateAfterCleanSteps,
  });
  const watchdog = new StallWatchdog();
  const advisorCallsByCard = new Map<string, number>();
  const pendingModelSwitch = new Map<string, { provider: string; model: string; reasoningEffort: 'low' | 'medium' | 'high' }>();
  const childRepeatCounts = new Map<string, { lastSig: string; repeats: number; controller: AbortController }>();
  const activeDispatchCardIds = new Set<string>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let globalHitlPending = 0;
  let startupReconciled = false;

  const getBoard = () => ctx.get('nsBoard') as BoardApiLike | undefined;

  const reconcileOrphanedCards = (): number => {
    const board = getBoard();
    const snap = board?.snapshot?.();
    if (!board || !snap) return 0;
    const liveIds = new Set(ctx.agents.list().map((a) => String(a.session.id)));
    let reconciled = 0;
    for (const card of snap.cards) {
      if (card.column !== 'in_progress') continue;
      if (activeDispatchCardIds.has(card.id)) continue;
      if (!card.agentSessionId || liveIds.has(card.agentSessionId)) continue;
      const moved = board.moveCard({
        cardId: card.id,
        toColumn: 'ready',
        actor: 'ns-team-watchdog',
        role: 'system',
        expectedRevision: card.revision,
        reason: `Watchdog startup reconciliation: worker session ${card.agentSessionId} is no longer active`,
      });
      if (moved.ok) {
        reconciled += 1;
        board.addComment({
          cardId: card.id,
          author: 'ns-team-watchdog',
          role: 'system',
          kind: 'status',
          body: `Moved orphaned in_progress card back to ready (prior session: ${card.agentSessionId}).`,
        });
        watchdog.recordEvent({
          sessionId: card.agentSessionId,
          kind: 'board_orphan_reconciled',
          detail: `Reconciled orphaned in_progress card "${card.id}" -> ready`,
        });
      }
    }
    return reconciled;
  };

  const runReviewGate = (input: {
    cardId: string;
    repoDir: string;
    baseRef: string;
    testCommand: string;
    authorProvider: string;
    authorSessionId?: string;
    crossFamilyFindings?: readonly string[];
    runOcr?: boolean;
  }): ReviewGateReport => {
    const board = getBoard();
    board?.moveCard({
      cardId: input.cardId,
      toColumn: 'review',
      actor: 'ns-team',
      role: 'system',
      reason: 'Entering mandatory non-author Review gate (snapshot + OCR + cross-family)',
    });

    const snapshot = verifySnapshotTests(input.repoDir, input.testCommand);
    const ocr: OcrGateResult =
      input.runOcr === false
        ? { ran: false, passed: true, blockingCount: 0, findings: [] }
        : runOcrDiffReview(input.repoDir, input.baseRef);
    const reviewerChoice = selectCrossFamilyReviewer(input.authorProvider);
    const externalBlocking = [...(input.crossFamilyFindings ?? [])];

    const blockingReasons: string[] = [];
    if (!snapshot.passed) blockingReasons.push(`snapshot test failed (exit=${snapshot.exitCode})`);
    if (!snapshot.worktreeIntact) blockingReasons.push('snapshot integrity check detected mutation');
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
      `Cross-family reviewer (${reviewerChoice.provider}/${reviewerChoice.model}${reviewerChoice.warning ? '; SINGLE-FAMILY WARNING' : ''}): ${
        externalBlocking.length === 0 ? 'APPROVED' : `${externalBlocking.length} blocking finding(s)`
      }`,
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

    let finalColumn: 'review' | 'done' = 'review';
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
    watchdog,
    runReviewGate,
    exportRoutesToml: () => generateSwitchyardRoutesToml({ strategy, deescalateAfterCleanSteps }),
    reconcileOrphanedCards,
  });

  ctx.systemPrompt.context({
    name: 'ns-team:switchyard',
    order: 184,
    interpolate: false,
    text: (assembleCtx) => {
      const sid = assembleCtx.agent ? String(assembleCtx.agent.session.id) : undefined;
      if (!sid) return '';
      const st = router.stateFor(sid);
      const route = router.resolveRoute(st.activeTier);
      return `<switchyard-router strategy="${strategy}" tier="${st.activeTier}" target="${route.provider}/${route.model}" escalations="${st.escalations}" deescalations="${st.deescalations}" />`;
    },
  });

  const log = ctx.logger(name);
  ctx.on('agent/status', ({ agent, status }) => {
    watchdog.setRunning(String(agent.session.id), status === 'running');
  });

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sid = String(agent.session.id);
    watchdog.touch(sid);
    if (frame.type === 'chunk' && frame.chunk.type === 'finish') {
      const reason = frame.chunk.reason;
      watchdog.recordFinishReason(sid, reason.kind);
      if (reason.kind === 'aborted' && isUserAbortFailure((reason as { failure?: unknown }).failure)) {
        watchdog.markUserCancelled(sid, true);
      }
    }
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const sid = exec.agent ? String(exec.agent.session.id) : undefined;
    if (sid) watchdog.beginToolCall(sid);
    try {
      return await next();
    } finally {
      if (sid) watchdog.endToolCall(sid);
    }
  });

  // Intentionally untyped casts because approval/request and user-questions/request are optional plugins loaded by host profiles.
  for (const hitlEvent of ['approval/request', 'user-questions/request'] as const) {
    ctx.on(hitlEvent as never, (async (payload: { agent?: Agent; sessionId?: string }, next: () => Promise<unknown>) => {
      const sid = payload?.agent
        ? String(payload.agent.session.id)
        : typeof payload?.sessionId === 'string'
          ? payload.sessionId
          : undefined;
      if (sid) watchdog.setPendingHitl(sid, 1);
      else globalHitlPending += 1;
      try {
        return await next();
      } finally {
        if (sid) watchdog.setPendingHitl(sid, -1);
        else globalHitlPending = Math.max(0, globalHitlPending - 1);
      }
    }) as never);
  }

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    const sid = String(agent.session.id);
    if (signal?.aborted) {
      watchdog.markUserCancelled(sid, true);
      return;
    }
    const snap = watchdog.getStatus(sid).session;
    if (snap?.lastFinishReason === 'max-tokens') {
      const decision = watchdog.consumeAutoContinuation(sid, maxAutoContinuations, 'turn stopping after max-tokens');
      if (decision.allowed && typeof agent.steer === 'function') {
        agent.steer(
          makeWatchdogUserMessage(
            `[Auto-Continue ${decision.count}/${maxAutoContinuations}]: Output reached max-tokens limit. Continue seamlessly from exact cutoff without repeating completed work.`,
          ),
        );
      }
    }
  });

  ctx.on('agent/request-error', async (payload, next) => {
    const sid = String(payload.agent.session.id);
    const fObj =
      payload.failure && typeof payload.failure === 'object' ? (payload.failure as { code?: unknown; message?: unknown }) : undefined;
    const fCode = typeof fObj?.code === 'string' ? fObj.code : 'unknown';
    const fMsg = typeof fObj?.message === 'string' ? fObj.message.slice(0, 120) : '';
    if (!payload.signal?.aborted && isRetryableUpstreamFailure(payload.failure)) {
      const decision = watchdog.consumeRequestRetry(
        sid,
        maxRequestErrorRetries,
        `${payload.provider}:${fCode}${fMsg ? `:${fMsg}` : ''}`,
      );
      if (decision.allowed) {
        await sleepWithSignal(retryBackoffMs * Math.max(1, decision.count), payload.signal, pendingTimers);
        if (!payload.signal?.aborted) {
          return { kind: 'retry' };
        }
      }
    }
    return next();
  });

  ctx.on('subagent/end', (info) => {
    const sid = String(info.id);
    if (info.stopReason === 'error' || info.stopReason === 'max-tokens') {
      watchdog.recordEvent({
        sessionId: sid,
        kind: 'subagent_cold_resume',
        detail: `Observed subagent end (${info.stopReason}) under parent ${String(info.parentSessionId)}`,
      });
    }
  });

  const hasPendingInteractivePrompt = (): boolean => {
    if (globalHitlPending > 0) return true;
    const nsTui = ctx.get('nsTui') as
      | { pendingInteractions?: () => { approval?: unknown; question?: unknown } }
      | undefined;
    const pending = nsTui?.pendingInteractions?.();
    return Boolean(pending?.approval || pending?.question);
  };

  const runWatchdogSweep = () => {
    if (!startupReconciled && getBoard()?.snapshot) {
      try {
        reconcileOrphanedCards();
        startupReconciled = true;
      } catch (err) {
        log.warn(`Orphan card reconciliation deferred due to error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const stalledIds = watchdog.checkStalledSessions(Date.now(), stallTimeoutMs, () => hasPendingInteractivePrompt());
    for (const sid of stalledIds) {
      const liveAgent = ctx.agents.get(sid as never) ?? ctx.agents.list().find((a) => String(a.session.id) === sid);
      if (!liveAgent) continue;
      const decision = watchdog.consumeStallRecovery(sid, maxStallRecoveries, `no stream/tool activity for >= ${stallTimeoutMs}ms`);
      if (!decision.allowed) continue;

      const capRoute = router.resolveRoute('capable', liveAgent.options?.provider);
      pendingModelSwitch.set(sid, capRoute);

      const sessionsSvc = ctx.get('sessions') as { flush?: (s: unknown) => Promise<void> } | undefined;
      if (sessionsSvc?.flush && liveAgent.session) {
        void Promise.resolve(sessionsSvc.flush(liveAgent.session)).catch(() => {});
      }

      if (typeof liveAgent.cancel === 'function') {
        try {
          liveAgent.cancel({ kind: 'user' } as never, { keepInbox: true });
        } catch (err) {
          log.warn(`Watchdog cancel warning for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        const stillLive = ctx.agents.get(sid as never) ?? ctx.agents.list().find((a) => String(a.session.id) === sid);
        if (!stillLive || typeof stillLive.followup !== 'function') return;
        try {
          stillLive.followup(
            makeWatchdogUserMessage(
              `[Auto-Resume Watchdog ${decision.count}/${maxStallRecoveries}]: Previous turn stalled with no stream or tool progress. Inspect current workspace state and resume remaining work.`,
            ),
          );
        } catch (err) {
          log.warn(`Watchdog followup skipped for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, WATCHDOG_FOLLOWUP_SETTLE_MS);
      timer.unref?.();
      pendingTimers.add(timer);
    }
  };

  const sweepTimer = watchdogSweepMs > 0 ? setInterval(runWatchdogSweep, watchdogSweepMs) : undefined;
  sweepTimer?.unref?.();
  ctx.effect(() => () => {
    if (sweepTimer) clearInterval(sweepTimer);
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
  });

  // Track tool outcomes via SwitchyardStageRouter & abort stalled workers/loops on repeated identical calls.
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent) return;
    const sid = String(exec.agent.session.id);
    watchdog.touch(sid);
    const argsStr = JSON.stringify(exec.arguments ?? {}).slice(0, 120);
    const preview = (Array.isArray(result?.content) ? result.content : [])
      .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .slice(0, 300);

    const watch = childRepeatCounts.get(sid);
    if (watch) {
      const sig = `${exec.name}:${argsStr}`;
      if (sig === watch.lastSig) {
        watch.repeats += 1;
        if (watch.repeats >= DEFAULT_PROGRESS_WATCH_LIMIT) {
          watch.controller.abort(new Error(`worker stalled repeating ${exec.name} ${DEFAULT_PROGRESS_WATCH_LIMIT} times`));
        }
      } else {
        watch.lastSig = sig;
        watch.repeats = 1;
      }
    }

    if (watchdog.observeToolOutcome(sid, exec.name, argsStr, preview) && typeof exec.agent.cancel === 'function') {
      try {
        exec.agent.cancel({ kind: 'user' } as never, { keepInbox: false });
      } catch {
        /* ignore cancel error */
      }
    }

    if (strategy === 'subagent-team') return;
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
      try {
        payload.agent.model.select({
          provider: nextRoute.provider,
          model: nextRoute.model,
          reasoningEffort: nextRoute.reasoningEffort as AgentOptions['reasoningEffort'],
        });
        pendingModelSwitch.delete(sid);
      } catch (err) {
        log.warn(`Switchyard model.select skipped for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return next();
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const sid = String(agent.session.id);
    router.clearSession(sid);
    watchdog.clearSession(sid);
    pendingModelSwitch.delete(sid);
    childRepeatCounts.delete(sid);
  });

  const schemaObj = { type: 'object' as const, properties: {}, additionalProperties: true };

  ctx.tools.register(
    defineTool({
      name: 'propose_work',
      description: 'Decompose work into Kanban cards with writeScopes and cycle-checked blockedBy DAG dependencies.',
      parameters: {
        cards: { type: 'json', required: true, description: 'Array of { id?, title, description?, writeScopes?, blockedBy?, owner? }.' },
      },
      output: { schema: schemaObj, render: renderJson },
      execute: async (args, exec) => {
        const board = getBoard();
        if (!board) throw new Error('@smitfire/board (nsBoard) is required to propose team cards');
        const list = Array.isArray(args.cards) ? (args.cards as Array<Record<string, unknown>>) : [];
        const created = [];
        for (const item of list) {
          created.push(
            board.proposeCard({
              id: typeof item.id === 'string' ? item.id : undefined,
              title: String(item.title ?? ''),
              description: typeof item.description === 'string' ? item.description : undefined,
              owner: typeof item.owner === 'string' ? item.owner : 'worker',
              agentSessionId: exec.agent ? String(exec.agent.session.id) : undefined,
              writeScopes: Array.isArray(item.writeScopes) ? item.writeScopes.map(String) : undefined,
              blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.map(String) : undefined,
            }),
          );
        }
        return { proposed: created.length, cards: created } as never;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
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
        if (!exec.agent) throw new Error('dispatch_worker requires an active parent agent');
        const board = getBoard();
        const cardId = String(args.cardId);
        const repoRoot = workspaceRootOf(exec.agent);
        const inGitRepo = existsSync(join(repoRoot, '.git'));
        const useWorktree = args.useWorktree !== false && inGitRepo;
        let worktreeInfo: { worktreePath: string; branch: string; headSha: string } | null = null;
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
        let workerError: string | undefined;
        let resumedFromCheckpoint = false;
        activeDispatchCardIds.add(cardId);
        try {
          for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
            workerError = undefined;
            const isResumeAttempt = attempt === MAX_DISPATCH_ATTEMPTS;
            let promptText = String(args.task);
            let capableOverride: AgentOptions | undefined;
            if (isResumeAttempt) {
              resumedFromCheckpoint = true;
              let gitStatus = '';
              try {
                gitStatus = execFileSync('git', ['-C', workerDir, 'status', '--short'], {
                  encoding: 'utf8',
                  stdio: ['ignore', 'pipe', 'pipe'],
                }).trim();
              } catch {
                gitStatus = '';
              }
              const capRoute = router.resolveRoute('capable', authorProvider);
              capableOverride = {
                provider: capRoute.provider,
                model: capRoute.model,
                reasoningEffort: capRoute.reasoningEffort as AgentOptions['reasoningEffort'],
              };
              watchdog.recordEvent({
                sessionId: String(exec.agent.session.id),
                kind: 'subagent_cold_resume',
                attempt,
                detail: `Cold-resuming worker for card "${cardId}" in ${workerDir}`,
              });
              board?.addComment({
                cardId,
                author: 'ns-team-watchdog',
                role: 'system',
                kind: 'status',
                body: `Cold-resuming stalled/failed worker (attempt ${attempt}/${MAX_DISPATCH_ATTEMPTS}) using ${capRoute.provider}/${capRoute.model}.`,
              });
              promptText = [
                `[AUTO-RESUME CHECKPOINT — ATTEMPT ${attempt}/${MAX_DISPATCH_ATTEMPTS}]`,
                'The previous worker attempt did not complete. Untrusted workspace status block follows; inspect files directly before editing.',
                '<untrusted-git-status>',
                gitStatus || '(clean working tree)',
                '</untrusted-git-status>',
                `Inspect the existing worktree state and complete the task:\n${String(args.task)}`,
              ].join('\n');
            }

            let activation;
            let lastChildSid = '';
            try {
              activation = await ctx.subagents.startActivation({
                provider: 'spawn',
                parent: exec.agent,
                cwd: workerDir,
                label: `worker:${cardId}${isResumeAttempt ? ':resume' : ''}`,
                name: `w-${cardId.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 17) || 'card'}-a${attempt}`,
                prompt: [{ type: 'text', text: promptText }],
                ...(capableOverride ? { agentOptions: capableOverride } : {}),
                signal: combinedSignal,
                delivery: 'caller',
              });
              lastChildSid = String(activation.childId);
              childRepeatCounts.set(lastChildSid, { lastSig: '', repeats: 0, controller: stallCtrl });
              const subResult = await activation.result;
              workerSummary = subResult.output
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('\n')
                .slice(0, 4000);

              const nsContext = ctx.get('nsContext') as ContextApiLike | undefined;
              if (nsContext?.flushDeferredForSession) {
                await nsContext.flushDeferredForSession(lastChildSid);
              }

              if (subResult.stopReason && subResult.stopReason !== 'completed') {
                workerError = subResult.diagnostic || `subagent terminated with stopReason=${subResult.stopReason}`;
              }
            } catch (err) {
              workerError = err instanceof Error ? err.message : String(err);
              const nsContext = ctx.get('nsContext') as ContextApiLike | undefined;
              if (lastChildSid && nsContext?.flushDeferredForSession) {
                await nsContext.flushDeferredForSession(lastChildSid).catch(() => {});
              }
            } finally {
              if (activation) {
                childRepeatCounts.delete(String(activation.childId));
                try { await activation.dispose(); } catch { /* ignore teardown error */ }
              }
            }

            const deterministicOrAborted =
              exec.signal.aborted ||
              (workerError !== undefined && /\b(?:USER_ABORT|ABORTED|AUTH|PERMISSION|CUGA_POLICY_DENY)\b/i.test(workerError));
            if (!workerError || deterministicOrAborted) {
              break;
            }
          }

          if (exec.signal.aborted) {
            board?.moveCard({
              cardId,
              toColumn: 'ready',
              actor: 'orchestrator',
              role: 'system',
              reason: 'Parent aborted worker execution; returned card to ready',
            });
            return { ok: false, status: 'aborted', resumedFromCheckpoint } as never;
          }

          if (workerError) {
            board?.moveCard({
              cardId,
              toColumn: 'blocked',
              actor: 'orchestrator',
              role: 'system',
              reason: `Worker failed${resumedFromCheckpoint ? ' after cold-resume' : ''}: ${workerError}`,
            });
            return { ok: false, status: 'worker_failed', resumedFromCheckpoint, error: workerError } as never;
          }

          if (worktreeInfo) {
            try {
              execFileSync('git', ['-C', worktreeInfo.worktreePath, '-c', 'core.hooksPath=/dev/null', 'add', '-A'], {
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            } catch (err) {
              log.warn(`worktree git add -A warning for ${cardId}: ${err instanceof Error ? err.message : String(err)}`);
            }
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
            resumedFromCheckpoint,
            workerSummary,
            review,
          } as never;
        } finally {
          activeDispatchCardIds.delete(cardId);
          if (worktreeInfo) {
            removeIsolatedWorktree(repoRoot, worktreeInfo.worktreePath, worktreeInfo.branch);
          }
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'ask_advisor',
      description: 'Consult a read-only Advisor model (capped <= 2 calls/card) and record decision rationale on the Kanban card.',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Card id being consulted on.' },
        question: { type: 'string', required: true, description: 'Specific architectural or debugging question.' },
      },
      output: { schema: schemaObj, render: renderJson },
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('ask_advisor requires an active parent agent');
        const cardId = String(args.cardId);
        const count = advisorCallsByCard.get(cardId) ?? 0;
        if (count >= maxAdvisorCallsPerCard) {
          return { ok: false, error: `advisor budget exhausted for card "${cardId}" (${count}/${maxAdvisorCallsPerCard})` } as never;
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
            reasoningEffort: capableRoute.reasoningEffort as never,
          },
          signal: exec.signal,
          delivery: 'caller',
        });

        let advice = '';
        try {
          const res = await activation.result;
          advice = res.output
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .slice(0, 2000);
        } finally {
          await activation.dispose();
        }

        getBoard()?.addComment({
          cardId,
          author: `${capableRoute.provider}/${capableRoute.model}`,
          role: 'advisor',
          kind: 'note',
          body: `Advisor (#${count + 1}/${maxAdvisorCallsPerCard}): ${advice}`,
        });

        return { ok: true, count: count + 1, max: maxAdvisorCallsPerCard, model: capableRoute, advice } as never;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
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
        } as never;
      },
    }),
  );
}
