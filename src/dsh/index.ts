import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Agent, AgentOptions, RequestErrorAction } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import {
  createIsolatedWorktree,
  DEFAULT_PROGRESS_WATCH_LIMIT,
  generateSwitchyardRoutesToml,
  isDeterministicFailure,
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

const execFileAsync = promisify(execFile);

const TEAM_DEFAULTS = {
  maxAdvisorCallsPerCard: 2,
  deescalateAfterCleanSteps: 3,
  stallTimeoutMs: 90_000,
  watchdogSweepMs: 5_000,
  maxAutoContinuations: 3,
  maxRequestErrorRetries: 2,
  maxStallRecoveries: 2,
  retryBackoffMs: 600,
  progressWatchLimit: DEFAULT_PROGRESS_WATCH_LIMIT,
  watchdogFollowupSettleMs: 150,
  maxDispatchAttempts: 2,
} as const;

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

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
  progressWatchLimit?: number;
  watchdogFollowupSettleMs?: number;
  maxDispatchAttempts?: number;
}

export const Config = z.object({
  strategy: z
    .union([z.const('switchyard-stage'), z.const('subagent-team'), z.const('hybrid')])
    .default('hybrid'),
  maxAdvisorCallsPerCard: z.number().default(TEAM_DEFAULTS.maxAdvisorCallsPerCard),
  requireHumanReviewApproval: z.boolean().default(false),
  defaultTestCommand: z.string().default('npm test'),
  deescalateAfterCleanSteps: z.number().default(TEAM_DEFAULTS.deescalateAfterCleanSteps),
  stallTimeoutMs: z.number().default(TEAM_DEFAULTS.stallTimeoutMs),
  watchdogSweepMs: z.number().default(TEAM_DEFAULTS.watchdogSweepMs),
  maxAutoContinuations: z.number().default(TEAM_DEFAULTS.maxAutoContinuations),
  maxRequestErrorRetries: z.number().default(TEAM_DEFAULTS.maxRequestErrorRetries),
  maxStallRecoveries: z.number().default(TEAM_DEFAULTS.maxStallRecoveries),
  retryBackoffMs: z.number().default(TEAM_DEFAULTS.retryBackoffMs),
  progressWatchLimit: z.number().default(TEAM_DEFAULTS.progressWatchLimit),
  watchdogFollowupSettleMs: z.number().default(TEAM_DEFAULTS.watchdogFollowupSettleMs),
  maxDispatchAttempts: z.number().default(TEAM_DEFAULTS.maxDispatchAttempts),
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
  moveCard(req: Record<string, unknown>): { ok: boolean; status: string; reason?: string; card?: { id: string; revision: number } };
  addComment(req: Record<string, unknown>): unknown;
  getCard(id: string): { id: string; revision: number; owner: string } | undefined;
  snapshot?(): {
    cards: Array<{ id: string; column: string; revision: number; agentSessionId?: string; updatedAt?: number }>;
  };
}

interface ContextApiLike {
  flushDeferredForSession?(sessionId: string): Promise<number>;
}

function sleepWithSignal(
  ms: number,
  signal: AbortSignal | undefined,
  pendingSleeps: Set<() => void>,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pendingSleeps.delete(finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    timer.unref?.();
    pendingSleeps.add(finish);
    signal?.addEventListener('abort', finish, { once: true });
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
  const maxAdvisorCallsPerCard = clampInt(rawConfig.maxAdvisorCallsPerCard, TEAM_DEFAULTS.maxAdvisorCallsPerCard, 0, 20);
  const requireHumanReviewApproval = rawConfig.requireHumanReviewApproval ?? false;
  const defaultTestCommand = rawConfig.defaultTestCommand ?? 'npm test';
  const deescalateAfterCleanSteps = clampInt(rawConfig.deescalateAfterCleanSteps, TEAM_DEFAULTS.deescalateAfterCleanSteps, 1, 100);
  const stallTimeoutMs = clampInt(rawConfig.stallTimeoutMs, TEAM_DEFAULTS.stallTimeoutMs, 10, 3_600_000);
  const watchdogSweepMs = clampInt(rawConfig.watchdogSweepMs, TEAM_DEFAULTS.watchdogSweepMs, 0, 600_000);
  const maxAutoContinuations = clampInt(rawConfig.maxAutoContinuations, TEAM_DEFAULTS.maxAutoContinuations, 0, 20);
  const maxRequestErrorRetries = clampInt(rawConfig.maxRequestErrorRetries, TEAM_DEFAULTS.maxRequestErrorRetries, 0, 20);
  const maxStallRecoveries = clampInt(rawConfig.maxStallRecoveries, TEAM_DEFAULTS.maxStallRecoveries, 0, 20);
  const retryBackoffMs = clampInt(rawConfig.retryBackoffMs, TEAM_DEFAULTS.retryBackoffMs, 0, 60_000);
  const progressWatchLimit = clampInt(rawConfig.progressWatchLimit, TEAM_DEFAULTS.progressWatchLimit, 2, 100);
  const watchdogFollowupSettleMs = clampInt(rawConfig.watchdogFollowupSettleMs, TEAM_DEFAULTS.watchdogFollowupSettleMs, 10, 30_000);
  const maxDispatchAttempts = clampInt(rawConfig.maxDispatchAttempts, TEAM_DEFAULTS.maxDispatchAttempts, 1, 10);

  const router = new SwitchyardStageRouter({
    strategy,
    deescalateAfterCleanSteps,
  });
  const watchdog = new StallWatchdog({ progressWatchLimit });
  const advisorCallsByCard = new Map<string, number>();
  const pendingModelSwitch = new Map<string, { provider: string; model: string; reasoningEffort: 'low' | 'medium' | 'high' }>();
  const childRepeatCounts = new Map<string, AbortController>();
  const activeDispatchCardIds = new Set<string>();
  const watchdogCancelling = new Set<string>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const pendingSleeps = new Set<() => void>();
  const pendingFollowupBySession = new Map<string, ReturnType<typeof setTimeout>>();
  let globalHitlPending = 0;
  let startupReconciled = false;

  const getBoard = () => ctx.get('nsBoard') as BoardApiLike | undefined;

  const reconcileOrphanedCards = (): number => {
    const board = getBoard();
    const snap = board?.snapshot?.();
    if (!board || !snap) return 0;
    const liveIds = new Set(ctx.agents.list().map((a) => String(a.session.id)));
    const now = Date.now();
    let reconciled = 0;
    for (const card of snap.cards) {
      if (card.column !== 'in_progress') continue;
      if (activeDispatchCardIds.has(card.id)) continue;
      if (!card.agentSessionId || liveIds.has(card.agentSessionId)) continue;
      if (typeof card.updatedAt !== 'number' || now - card.updatedAt < stallTimeoutMs) {
        continue;
      }
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
      } else {
        log.warn(`Skipped orphan card "${card.id}" reconciliation: ${moved.reason ?? moved.status}`);
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
      const wasWatchdogCancel = watchdogCancelling.has(sid);
      if (reason.kind !== 'aborted') {
        watchdogCancelling.delete(sid);
      }
      watchdog.recordFinishReason(sid, reason.kind);
      if (reason.kind === 'aborted' && !wasWatchdogCancel && isUserAbortFailure((reason as { failure?: unknown }).failure)) {
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

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const sid = String(agent.session.id);
    if (signal?.aborted) {
      watchdog.markUserCancelled(sid, true);
      return;
    }
    const snap = watchdog.getSession(sid);
    if (snap?.lastFinishReason === 'max-tokens') {
      const decision = watchdog.consumeAutoContinuation(sid, maxAutoContinuations, 'turn stopping after max-tokens');
      if (decision.allowed && typeof agent.steer === 'function') {
        try {
          await Promise.resolve(
            agent.steer(
              makeWatchdogUserMessage(
                `[Auto-Continue ${decision.count}/${maxAutoContinuations}]: Output reached max-tokens limit. Continue seamlessly from exact cutoff without repeating completed work.`,
              ),
            ),
          );
        } catch (err) {
          log.warn(`Auto-continue steer skipped for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  });

  // Uses @deepseek-ai/dsh-agent RequestErrorAction waterfall contract ({ kind: 'retry' } vs delegating to next()).
  ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
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
        await sleepWithSignal(retryBackoffMs * Math.max(1, decision.count), payload.signal, pendingSleeps);
        if (payload.signal?.aborted) {
          watchdog.refundRequestRetry(sid);
        } else {
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

  const hasPendingInteractivePrompt = (_sessionId?: string): boolean => {
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
    const stalledIds = watchdog.checkStalledSessions(Date.now(), stallTimeoutMs, (sid) => hasPendingInteractivePrompt(sid));
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
        watchdogCancelling.add(sid);
        try {
          liveAgent.cancel({ kind: 'user' } as never, { keepInbox: true });
        } catch (err) {
          watchdogCancelling.delete(sid);
          log.warn(`Watchdog cancel warning for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const existingFollowup = pendingFollowupBySession.get(sid);
      if (existingFollowup) {
        clearTimeout(existingFollowup);
        pendingTimers.delete(existingFollowup);
        pendingFollowupBySession.delete(sid);
      }

      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        pendingFollowupBySession.delete(sid);
        watchdogCancelling.delete(sid);
        const curSnap = watchdog.getSession(sid);
        const stillLive = ctx.agents.get(sid as never) ?? ctx.agents.list().find((a) => String(a.session.id) === sid);
        if (!curSnap || curSnap.userCancelled || !stillLive || typeof stillLive.followup !== 'function') {
          watchdog.refundStallRecovery(sid);
          return;
        }
        try {
          stillLive.followup(
            makeWatchdogUserMessage(
              `[Auto-Resume Watchdog ${decision.count}/${maxStallRecoveries}]: Previous turn stalled with no stream or tool progress. Inspect current workspace state and resume remaining work.`,
            ),
          );
        } catch (err) {
          watchdog.refundStallRecovery(sid);
          log.warn(`Watchdog followup skipped for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, watchdogFollowupSettleMs);
      timer.unref?.();
      pendingTimers.add(timer);
      pendingFollowupBySession.set(sid, timer);
    }
  };

  const sweepTimer = watchdogSweepMs > 0 ? setInterval(runWatchdogSweep, watchdogSweepMs) : undefined;
  sweepTimer?.unref?.();
  ctx.effect(() => () => {
    if (sweepTimer) clearInterval(sweepTimer);
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
    for (const finishSleep of [...pendingSleeps]) finishSleep();
    pendingSleeps.clear();
    pendingFollowupBySession.clear();
    watchdogCancelling.clear();
    globalHitlPending = 0;
  });

  // Track tool outcomes via SwitchyardStageRouter & abort stalled worker subagents after repeated identical calls.
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent) return;
    const sid = String(exec.agent.session.id);
    watchdog.touch(sid, Date.now(), result?.isError !== true);
    const argsStr = JSON.stringify(exec.arguments ?? {}).slice(0, 120);
    const preview = (Array.isArray(result?.content) ? result.content : [])
      .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .slice(0, 300);

    const workerCtrl = childRepeatCounts.get(sid);
    if (workerCtrl && watchdog.observeToolOutcome(sid, exec.name, argsStr, preview)) {
      workerCtrl.abort(new Error(`worker stalled repeating ${exec.name} ${progressWatchLimit} times`));
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
    watchdogCancelling.delete(sid);
    const pendingFollowup = pendingFollowupBySession.get(sid);
    if (pendingFollowup) {
      clearTimeout(pendingFollowup);
      pendingTimers.delete(pendingFollowup);
      pendingFollowupBySession.delete(sid);
    }
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
        const attemptErrors: string[] = [];
        let lastPriorSummary = '';
        let resumedFromCheckpoint = false;
        const parentSid = String(exec.agent.session.id);
        watchdog.beginToolCall(parentSid);
        activeDispatchCardIds.add(cardId);
        try {
          for (let attempt = 1; attempt <= maxDispatchAttempts; attempt += 1) {
            const stallCtrl = new AbortController();
            const onParentAbort = () => stallCtrl.abort(exec.signal.reason);
            if (exec.signal.aborted) {
              stallCtrl.abort(exec.signal.reason);
            } else {
              exec.signal.addEventListener('abort', onParentAbort, { once: true });
            }
            const isResumeAttempt = attempt > 1;
            const prevErr = attemptErrors.at(-1);
            if (isResumeAttempt && workerSummary) {
              lastPriorSummary = workerSummary;
            }
            workerError = undefined;
            workerSummary = '';
            let promptText = String(args.task);
            let capableOverride: AgentOptions | undefined;
            if (isResumeAttempt) {
              let gitStatus = '';
              try {
                const { stdout } = await execFileAsync('git', ['-C', workerDir, 'status', '--short'], {
                  encoding: 'utf8',
                  timeout: 5_000,
                });
                gitStatus = stdout.trim();
                if (gitStatus.length > 4000) {
                  gitStatus = `${gitStatus.slice(0, 4000)}\n...[truncated]`;
                }
              } catch {
                gitStatus = '';
              }
              const capRoute = router.resolveRoute('capable', authorProvider);
              capableOverride = {
                provider: capRoute.provider,
                model: capRoute.model,
                reasoningEffort: capRoute.reasoningEffort as never,
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
                body: `Cold-resuming stalled/failed worker (attempt ${attempt}/${maxDispatchAttempts}) using ${capRoute.provider}/${capRoute.model}.`,
              });
              promptText = [
                `[AUTO-RESUME CHECKPOINT — ATTEMPT ${attempt}/${maxDispatchAttempts}]`,
                `Previous attempt ended with: ${prevErr ?? 'unknown error'}.`,
                'Untrusted workspace status and prior output follow; inspect files directly before editing.',
                '<untrusted-git-status>',
                gitStatus || '(clean working tree)',
                '</untrusted-git-status>',
                ...(lastPriorSummary
                  ? ['<untrusted-prior-output>', lastPriorSummary.slice(0, 800), '</untrusted-prior-output>']
                  : []),
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
                signal: stallCtrl.signal,
                delivery: 'caller',
              });
              lastChildSid = activation.childId ? String(activation.childId) : '';
              if (lastChildSid) {
                childRepeatCounts.set(lastChildSid, stallCtrl);
                board?.moveCard({
                  cardId,
                  toColumn: 'in_progress',
                  actor: 'orchestrator',
                  role: 'orchestrator',
                  agentSessionId: lastChildSid,
                  reason: `Worker child session ${lastChildSid} active (attempt ${attempt}/${maxDispatchAttempts})`,
                });
              }
              const subResult = await activation.result;
              workerSummary = subResult.output
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('\n')
                .slice(0, 4000);

              const nsContext = ctx.get('nsContext') as ContextApiLike | undefined;
              if (lastChildSid && nsContext?.flushDeferredForSession) {
                await nsContext.flushDeferredForSession(lastChildSid);
              }

              if (subResult.stopReason !== undefined && subResult.stopReason !== 'completed') {
                workerError = subResult.diagnostic || `subagent terminated with stopReason=${subResult.stopReason}`;
              } else if (isResumeAttempt) {
                resumedFromCheckpoint = true;
              }
            } catch (err) {
              workerError = err instanceof Error ? err.message : String(err);
              const nsContext = ctx.get('nsContext') as ContextApiLike | undefined;
              if (lastChildSid && nsContext?.flushDeferredForSession) {
                await nsContext.flushDeferredForSession(lastChildSid).catch(() => {});
              }
            } finally {
              exec.signal.removeEventListener('abort', onParentAbort);
              if (lastChildSid) {
                childRepeatCounts.delete(lastChildSid);
              }
              if (activation) {
                try { await activation.dispose(); } catch { /* ignore teardown error */ }
              }
            }

            if (workerError) {
              attemptErrors.push(`attempt ${attempt}: ${workerError}`);
            }
            const abortedByWatchdog = stallCtrl.signal.aborted && !exec.signal.aborted;
            if (!workerError || exec.signal.aborted || (!abortedByWatchdog && isDeterministicFailure(workerError))) {
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
            const combinedError = `${attemptErrors.join('; ')}${lastPriorSummary ? ` | prior output: ${lastPriorSummary.slice(0, 300)}` : ''}`;
            board?.moveCard({
              cardId,
              toColumn: 'blocked',
              actor: 'orchestrator',
              role: 'system',
              reason: `Worker failed: ${combinedError}`,
            });
            return { ok: false, status: 'worker_failed', resumedFromCheckpoint, error: combinedError } as never;
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
          watchdog.endToolCall(parentSid);
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
