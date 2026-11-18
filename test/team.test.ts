import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import {
  classifyToolSemantics,
  createIsolatedWorktree,
  DEFAULT_SWITCHYARD_CONFIG,
  generateSwitchyardRoutesToml,
  isQuotaOrRateLimitFailure,
  isRetryableUpstreamFailure,
  parseOcrJsonReport,
  ProgressWatch,
  removeIsolatedWorktree,
  selectCrossFamilyReviewer,
  StallWatchdog,
  SwitchyardStageRouter,
  verifySnapshotTests,
} from '../dist/core/index.js';
import * as teamPlugin from '../dist/dsh/index.js';

test('NVIDIA NeMo Switchyard StageRouter escalates on failures and de-escalates after clean steps', () => {
  const router = new SwitchyardStageRouter({ deescalateAfterCleanSteps: 3 });

  // 2 consecutive tool errors escalate efficient -> capable
  const e1 = router.recordToolOutcome({ sessionId: 's1', toolName: 'edit', argsSummary: 'src/a.ts', isError: true });
  assert.equal(e1.changed, false);
  const e2 = router.recordToolOutcome({ sessionId: 's1', toolName: 'bash', argsSummary: 'npm test', isError: true });
  assert.equal(e2.changed, true);
  assert.equal(e2.tier, 'capable');
  assert.equal(e2.route.reasoningEffort, 'high');

  // 3 consecutive clean steps de-escalate back to efficient
  router.recordToolOutcome({ sessionId: 's1', toolName: 'read', argsSummary: 'src/a.ts', isError: false });
  router.recordToolOutcome({ sessionId: 's1', toolName: 'edit', argsSummary: 'src/b.ts', isError: false });
  const c3 = router.recordToolOutcome({ sessionId: 's1', toolName: 'bash', argsSummary: 'npm test', isError: false });
  assert.equal(c3.changed, true);
  assert.equal(c3.tier, 'efficient');

  // Single bash test failure output triggers immediate escalation
  const tf = router.recordToolOutcome({
    sessionId: 's2',
    toolName: 'bash',
    argsSummary: 'node --test',
    isError: false,
    outputPreview: 'FAIL test/app.test.ts exit code 1',
  });
  assert.equal(tf.changed, true);
  assert.equal(tf.tier, 'capable');

  // Quota exhaustion fails over cleanly across providers
  router.markProviderRateLimited('google-antigravity', 60_000);
  const failoverRoute = router.resolveRoute('efficient');
  assert.equal(failoverRoute.provider, 'openai-codex');

  const toml = generateSwitchyardRoutesToml();
  assert.match(toml, /strategy = "stage_router"/);
  assert.match(toml, /\[targets\.capable\]/);
});

test('selectCrossFamilyReviewer pairs OpenAI <-> Gemini and warns on single-family fallback', () => {
  const r1 = selectCrossFamilyReviewer('google-antigravity', ['google-antigravity', 'openai-codex']);
  assert.equal(r1.provider, 'openai-codex');
  assert.equal(r1.crossFamily, true);
  assert.equal(r1.warning, undefined);

  const r2 = selectCrossFamilyReviewer('openai-codex', ['google-antigravity', 'openai-codex']);
  assert.equal(r2.provider, 'google-antigravity');
  assert.equal(r2.crossFamily, true);

  const single = selectCrossFamilyReviewer('openai-codex', ['openai-codex']);
  assert.equal(single.crossFamily, false);
  assert.match(single.warning ?? '', /single-family fallback/);
});

test('Hermetic snapshot verifier isolates test side effects and worktrees clean up safely', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ns-team-git-'));
  try {
    execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    writeFileSync(join(repo, 'app.mjs'), 'export const add = (a, b) => a + b;\n');
    writeFileSync(join(repo, 'test.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('mutated.txt', 'side-effect'); console.log('ok');\n");
    execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'], { stdio: 'ignore' });

    const wt = createIsolatedWorktree(repo, 'card-1');
    const snap = verifySnapshotTests(wt.worktreePath, `${process.execPath} test.mjs`);
    assert.equal(snap.passed, true);
    assert.equal(snap.worktreeIntact, true);
    assert.equal(existsSync(join(wt.worktreePath, 'mutated.txt')), false);

    removeIsolatedWorktree(repo, wt.worktreePath);
    assert.equal(existsSync(wt.worktreePath), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('DSH ns-team plugin wires Switchyard agent/pre-step model switching and Review gate holds buggy commits', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ns-team-gate-'));
  writeFileSync(join(repo, 'ok.mjs'), "console.log('green');\n");
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  const selectedModels: unknown[] = [];
  const fakeAgent = {
    session: { id: 'sess-lead', meta: { cwd: repo } },
    options: { provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash' },
    model: {
      current: () => ({ provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash' }),
      select: (sel: unknown) => selectedModels.push(sel),
    },
  } as never;
  ctx.provide('agents', { get: () => fakeAgent });
  ctx.provide('subagents', {
    startActivation: async () => {
      throw new Error('stub');
    },
  });

  const fiber = ctx.plugin(teamPlugin, { strategy: 'hybrid', deescalateAfterCleanSteps: 3 });
  await fiber;

  try {
    // 2 errors in tools/result -> pre-step switches model to Switchyard capable route
    ctx.emit('tools/result', { name: 'edit', arguments: { path: 'a.ts' }, agent: fakeAgent } as never, { isError: true, content: [] } as never);
    ctx.emit('tools/result', { name: 'bash', arguments: { command: 'test' }, agent: fakeAgent } as never, { isError: true, content: [] } as never);
    await ctx.waterfall(
      'agent/pre-step',
      {
        agent: fakeAgent,
        messages: [],
        turn: 1,
        step: 2,
        signal: AbortSignal.timeout(5000),
        modelSelection: { provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash' } as never,
      },
      async () => ({ kind: 'enter' as const, messages: [] }),
    );
    assert.equal(selectedModels.length, 1);

    // Dual Review Gate holds a green-test commit when cross-family reviewer catches a subtle bug
    const hold = ctx.nsTeam!.runReviewGate({
      cardId: 'card-bug',
      repoDir: repo,
      baseRef: 'HEAD',
      testCommand: `${process.execPath} ok.mjs`,
      authorProvider: 'google-antigravity',
      authorSessionId: 'sess-lead',
      crossFamilyFindings: ['subtle race: non-atomic read-modify-write in cache'],
      runOcr: false,
    });
    assert.equal(hold.snapshot.passed, true);
    assert.equal(hold.passed, false);
    assert.equal(hold.finalColumn, 'review');

    const clean = ctx.nsTeam!.runReviewGate({
      cardId: 'card-clean',
      repoDir: repo,
      baseRef: 'HEAD',
      testCommand: `${process.execPath} ok.mjs`,
      authorProvider: 'google-antigravity',
      runOcr: false,
    });
    assert.equal(clean.passed, true);
    assert.equal(clean.finalColumn, 'done');

    const ocrFail = parseOcrJsonReport(JSON.stringify({ comments: [{ path: 'a.ts', severity: 'high', category: 'bug', content: 'race' }] }));
    assert.equal(ocrFail.passed, false);
    assert.equal(ocrFail.blockingCount, 1);

    const ocrMissing = parseOcrJsonReport(JSON.stringify({ status: 'error' }));
    assert.equal(ocrMissing.ran, false);
    assert.equal(ocrMissing.passed, false);

    const unknownReviewer = selectCrossFamilyReviewer('custom-proxy', ['custom-proxy', 'other-proxy']);
    assert.equal(unknownReviewer.crossFamily, false);
    assert.match(unknownReviewer.warning ?? '', /unknown/);
  } finally {
    await fiber.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('ProgressWatch, StallWatchdog exemptions, max-tokens steer, request-error retry, subagent cold-resume & orphan board reconcile', async () => {
  const pw = new ProgressWatch(4);
  assert.equal(pw.observe('read', 'a.ts', 'x'), false);
  assert.equal(pw.observe('read', 'a.ts', 'x'), false);
  assert.equal(pw.observe('read', 'a.ts', 'x'), false);
  assert.equal(pw.observe('read', 'a.ts', 'x'), true);
  assert.equal(pw.observe('edit', 'b.ts', 'y'), false);

  assert.equal(isRetryableUpstreamFailure({ code: 'RATE_LIMIT', status: 429, message: 'slow down' }), true);
  assert.equal(isRetryableUpstreamFailure({ message: 'ECONNRESET stream closed' }), true);
  assert.equal(isRetryableUpstreamFailure({ code: 'AUTH', status: 401, message: 'bad token' }), false);
  assert.equal(isRetryableUpstreamFailure({ code: 'CUGA_POLICY_DENY', message: 'blocked' }), false);
  assert.equal(isRetryableUpstreamFailure({ name: 'AbortError', message: 'aborted' }), false);

  const wd = new StallWatchdog();
  wd.setRunning('s-tool', true, 1000);
  wd.beginToolCall('s-tool', 1000);
  assert.deepEqual(wd.checkStalledSessions(200_000, 10_000), []);
  wd.endToolCall('s-tool', 200_000);
  wd.setPendingHitl('s-tool', 1, 200_000);
  assert.deepEqual(wd.checkStalledSessions(400_000, 10_000), []);
  wd.setPendingHitl('s-tool', -1, 400_000);
  assert.deepEqual(wd.checkStalledSessions(500_000, 10_000), ['s-tool']);

  const repo = mkdtempSync(join(tmpdir(), 'ns-team-watchdog-'));
  execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  writeFileSync(join(repo, 'app.mjs'), 'export const ok = true;\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'], { stdio: 'ignore' });

  const steered: unknown[] = [];
  const followups: unknown[] = [];
  const cancels: unknown[] = [];
  const fakeAgent = {
    id: 'sess-wd',
    session: { id: 'sess-wd', meta: { cwd: repo } },
    options: { provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash' },
    model: {
      current: () => ({ provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash' }),
      select: () => {},
    },
    steer: (m: unknown) => steered.push(m),
    followup: (m: unknown) => followups.push(m),
    cancel: (c: unknown, opts: unknown) => cancels.push({ c, opts }),
  } as never;

  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  ctx.provide('agents', {
    get: (id: unknown) => (String(id) === 'sess-wd' ? fakeAgent : undefined),
    list: () => [fakeAgent],
  });
  let subAttempts = 0;
  ctx.provide('subagents', {
    startActivation: async () => {
      subAttempts += 1;
      const attemptNo = subAttempts;
      return {
        childId: `child-${attemptNo}`,
        result:
          attemptNo === 1
            ? Promise.resolve({ output: [{ type: 'text', text: 'partial work' }], stopReason: 'error', diagnostic: 'stream dropped' })
            : Promise.resolve({ output: [{ type: 'text', text: 'completed cleanly' }], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
  });

  const orphanMoves: unknown[] = [];
  ctx.provide('nsBoard', {
    proposeCard: () => ({ card: { id: 'c1', revision: 1 }, scopeConflicts: [] }),
    moveCard: (req: unknown) => {
      orphanMoves.push(req);
      return { ok: true, status: 'moved', card: { id: 'c1', revision: 2 } };
    },
    addComment: () => ({}),
    getCard: () => ({ id: 'c1', revision: 1, owner: 'worker' }),
    snapshot: () => ({
      cards: [{ id: 'orphan-1', column: 'in_progress', revision: 3, agentSessionId: 'dead-child-session', updatedAt: 1 }],
    }),
  });

  const fiber = ctx.plugin(teamPlugin, {
    strategy: 'hybrid',
    stallTimeoutMs: 60,
    watchdogSweepMs: 20,
    watchdogFollowupSettleMs: 40,
    maxAutoContinuations: 2,
    maxRequestErrorRetries: 2,
    maxStallRecoveries: 2,
    retryBackoffMs: 5,
  });
  await fiber;

  try {
    // 1. max-tokens triggers agent.steer auto-continuation up to cap
    ctx.emit('agent/status', { agent: fakeAgent, status: 'running' } as never);
    ctx.emit('agent/assistant-stream', {
      agent: fakeAgent,
      frame: { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'max-tokens' } } },
    } as never);
    await ctx.serial('agent/turn-stopping', { agent: fakeAgent, turn: 1, signal: new AbortController().signal } as never);
    await ctx.serial('agent/turn-stopping', { agent: fakeAgent, turn: 1, signal: new AbortController().signal } as never);
    await ctx.serial('agent/turn-stopping', { agent: fakeAgent, turn: 1, signal: new AbortController().signal } as never);
    assert.equal(steered.length, 2);

    // 2. Retryable request-error returns { kind: 'retry' }; non-retryable AUTH delegates
    const retry1 = await ctx.waterfall(
      'agent/request-error',
      {
        agent: fakeAgent,
        turn: 1,
        step: 1,
        provider: 'google-antigravity',
        failure: { code: 'RATE_LIMIT', message: '429 rate limited', status: 429 },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      } as never,
      async () => undefined,
    );
    assert.deepEqual(retry1, { kind: 'retry' });
    const nonRetryAuth = await ctx.waterfall(
      'agent/request-error',
      {
        agent: fakeAgent,
        turn: 1,
        step: 2,
        provider: 'google-antigravity',
        failure: { code: 'AUTH', message: 'invalid api key', status: 401 },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      } as never,
      async () => undefined,
    );
    assert.equal(nonRetryAuth, undefined);

    // 3. dispatch_worker cold-resumes once in same worktree when attempt 1 fails with stopReason='error'
    const dispatchTool = ctx.tools.get('dispatch_worker')!;
    const dRes = (await dispatchTool.execute(
      { cardId: 'c1', task: 'Verify cold-resume', testCommand: 'node -e "process.exit(0)"', useWorktree: true },
      { agent: fakeAgent, signal: AbortSignal.timeout(10_000) } as never,
    )) as { ok: boolean; resumedFromCheckpoint: boolean; workerSummary: string; review: { snapshot: { passed: boolean } } };
    assert.equal(subAttempts, 2);
    assert.equal(dRes.resumedFromCheckpoint, true);
    assert.equal(dRes.workerSummary, 'completed cleanly');
    assert.equal(dRes.review.snapshot.passed, true);

    // 4. Idle stall sweep cancels with keepInbox=true and triggers followup + reconciles orphaned board card
    ctx.emit('agent/status', { agent: fakeAgent, status: 'running' } as never);
    await new Promise((r) => setTimeout(r, 220));
    assert.ok(cancels.length >= 1);
    assert.ok(followups.length >= 1);
    assert.ok(orphanMoves.some((m) => (m as { cardId?: string; toColumn?: string }).cardId === 'orphan-1' && (m as { toColumn?: string }).toColumn === 'ready'));
    assert.ok(ctx.nsTeam!.watchdog.getStatus('sess-wd').totalEvents >= 4);
  } finally {
    await fiber.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('NeMo Switchyard tool_semantics, churn escalation, verify-pass release, inferCardTier, and TOML', () => {
  assert.equal(DEFAULT_SWITCHYARD_CONFIG.strategy, 'orchestrator');
  assert.equal(classifyToolSemantics('read_file', '{"path":"a.ts"}'), 'observe');
  assert.equal(classifyToolSemantics('edit_file', '{"path":"a.ts"}'), 'mutate');
  assert.equal(classifyToolSemantics('bash', '{"command":"node --test test/a.test.mjs"}'), 'verify');
  assert.equal(classifyToolSemantics('bash', '{"command":"node --test test/a.test.mjs 2>&1"}'), 'verify');
  assert.equal(classifyToolSemantics('bash', '{"command":"node -e \"[1].map(x => x)\""}'), 'observe');
  assert.equal(classifyToolSemantics('bash', '{"command":"rm -rf tmp"}'), 'mutate');
  assert.equal(classifyToolSemantics('handoff_plan', '{}'), 'plan');
  assert.equal(classifyToolSemantics('dispatch_worker', '{}'), 'delegate');

  const router = new SwitchyardStageRouter({ deescalateAfterCleanSteps: 3, earlyReleaseOnVerifyPass: true, enableChurnEscalation: true });

  // Exploration churn (5 observe calls without mutate/plan/verify) escalates to capable
  for (let i = 0; i < 4; i += 1) {
    assert.equal(router.recordToolOutcome({ sessionId: 'churn', toolName: 'read', argsSummary: `f${i}.ts`, isError: false }).changed, false);
  }
  const churnEsc = router.recordToolOutcome({ sessionId: 'churn', toolName: 'grep', argsSummary: 'pattern', isError: false });
  assert.equal(churnEsc.changed, true);
  assert.equal(churnEsc.tier, 'capable');
  assert.match(churnEsc.reason ?? '', /observe_churn:5/);

  // Explicit passing verify command releases capable hold early
  const earlyRel = router.recordToolOutcome({
    sessionId: 'churn',
    toolName: 'bash',
    argsSummary: 'node --test',
    isError: false,
    outputPreview: 'PASS 4 passed, 0 failures',
  });
  assert.equal(earlyRel.changed, true);
  assert.equal(earlyRel.tier, 'efficient');
  assert.equal(earlyRel.reason, 'verify_pass_early_release');

  // Card tier inference + cross-provider alternate route
  assert.equal(router.inferCardTier({ title: 'Rename foo to bar', writeScopes: ['src/a.ts'] }), 'efficient');
  assert.equal(router.inferCardTier({ title: 'Fix concurrency race in auth cache', writeScopes: ['src/auth.ts'] }), 'capable');
  assert.equal(router.inferCardTier({ title: 'Wire module', blockedBy: ['c1'] }), 'capable');

  assert.equal(isQuotaOrRateLimitFailure({ code: 'QUOTA_EXCEEDED', status: 429 }), true);
  assert.equal(isQuotaOrRateLimitFailure('account quota exceeded'), true);
  assert.equal(isQuotaOrRateLimitFailure({ code: 'AUTH', status: 401 }), false);

  const toml = generateSwitchyardRoutesToml();
  assert.match(toml, /\[routes\.switchyard\.stage\.tool_semantics\]/);
  assert.match(toml, /\[composite\.advisor_gate\]/);
  assert.match(toml, /\[composite\.subagents\]/);
  assert.match(toml, /\[targets\.planner\]/);
});

test('Orchestrator default strategy enforces Plan->Kanban->Execute loop, 2-strike replan, cadence, per-card tiering, and quota failover', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ns-orch-unit-'));
  writeFileSync(join(repo, 'package.json'), '{"private":true}');
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);

  const selections: Array<{ provider?: string; model?: string; reasoningEffort?: string }> = [];
  let curModel = { provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash', reasoningEffort: 'low' };
  const fakeRoot = {
    id: 'orch-root',
    session: { id: 'orch-root', header: {}, meta: { cwd: repo } },
    options: { provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash' },
    model: {
      current: () => curModel,
      select: (sel: { provider: string; model: string; reasoningEffort?: string }) => {
        curModel = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort ?? 'low' };
        selections.push(sel);
      },
    },
  } as never;
  const childWorker = {
    id: 'child-exec-1',
    session: { id: 'child-exec-1', header: { parentSession: 'orch-root' }, meta: { cwd: repo } },
  } as never;

  const cards = new Map<string, Record<string, unknown>>();
  const comments: Array<{ cardId: string; kind: string; body: string }> = [];
  ctx.provide('nsBoard', {
    proposeCard: (req: Record<string, unknown>) => {
      const id = String(req.id || `c_${cards.size + 1}`);
      const card = { id, revision: 1, column: 'ready', ...req };
      cards.set(id, card);
      return { card, scopeConflicts: [] };
    },
    moveCard: (req: Record<string, unknown>) => {
      const c = cards.get(String(req.cardId)) ?? { id: String(req.cardId), revision: 0 };
      const updated = {
        ...c,
        column: req.toColumn,
        revision: Number(c.revision ?? 0) + 1,
        ...(req.modelTier ? { modelTier: req.modelTier } : {}),
        ...(req.phase ? { phase: req.phase } : {}),
      };
      cards.set(String(req.cardId), updated);
      return { ok: true, status: 'moved', card: updated };
    },
    updateCardMeta: (cardId: string, patch: Record<string, unknown>) => {
      const c = cards.get(cardId);
      if (!c) return undefined;
      const updated = { ...c, ...patch, revision: Number(c.revision ?? 0) + 1 };
      cards.set(cardId, updated);
      return updated;
    },
    addComment: (req: { cardId: string; kind: string; body: string }) => {
      comments.push({ cardId: req.cardId, kind: req.kind, body: req.body });
      return {};
    },
    getCard: (id: string) => cards.get(id),
    snapshot: () => ({ cards: [...cards.values()] }),
  });

  const subDispatches: Array<{ agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } }> = [];
  ctx.provide('agents', { get: () => fakeRoot, list: () => [fakeRoot] });
  ctx.provide('subagents', {
    startActivation: async (opts: { agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } }) => {
      subDispatches.push({ agentOptions: opts.agentOptions });
      return {
        childId: 'child-exec-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
  });

  // Omit strategy to prove default is 'orchestrator'
  const fiber = ctx.plugin(teamPlugin, { cadenceSteps: 4, twoStrikeThreshold: 2, retryBackoffMs: 1 });
  await fiber;

  try {
    assert.equal(ctx.nsTeam!.strategy, 'orchestrator');

    // 0. agent/created eagerly selects capable plannerRoute BEFORE Step 1 captures modelSelection
    await ctx.serial('agent/created' as never, { agent: fakeRoot, source: 'startup' } as never);
    assert.equal(selections.at(-1)?.reasoningEffort, 'high');

    // 1. Pre-step step 1 enters planning phase on capable plannerRoute & blocks mutating tools
    await ctx.waterfall(
      'agent/pre-step',
      { agent: fakeRoot, messages: [], turn: 1, step: 1, signal: AbortSignal.timeout(5000), modelSelection: curModel as never },
      async () => ({ kind: 'enter' as const, messages: [] }),
    );
    assert.equal(selections.at(-1)?.reasoningEffort, 'high');
    assert.ok(ctx.tools.checkGuards({ name: 'edit_file', agent: fakeRoot, arguments: {} } as never));
    assert.ok(ctx.tools.checkGuards({ name: 'bash', agent: fakeRoot, arguments: { command: 'rm -rf tmp' } } as never));
    assert.equal(ctx.tools.checkGuards({ name: 'bash', agent: fakeRoot, arguments: { command: 'node --test 2>&1' } } as never), undefined);
    // Child sessions bypass root planning lock
    assert.equal(ctx.tools.checkGuards({ name: 'edit_file', agent: childWorker, arguments: {} } as never), undefined);

    // 2. propose_work assigns per-card modelTier; dispatch_worker honors it on attempt 1
    const proposeTool = ctx.tools.get('propose_work')!;
    await proposeTool.execute(
      {
        cards: [
          { id: 'c-mech', title: 'Rename helper variable', writeScopes: ['src/a.ts'] },
          { id: 'c-hard', title: 'Fix token race condition in auth', writeScopes: ['src/auth.ts'] },
        ],
      },
      { agent: fakeRoot, signal: AbortSignal.timeout(5000) } as never,
    );
    assert.equal(cards.get('c-mech')?.modelTier, 'efficient');
    assert.equal(cards.get('c-hard')?.modelTier, 'capable');

    // 3. handoff_plan logs plan on Kanban and flips to fast efficient executor
    const exitTool = ctx.tools.get('handoff_plan')!;
    const handoff = (await exitTool.execute(
      { plan: 'Step 1: fix mechanical card\nStep 2: verify', executionTier: 'efficient' },
      { agent: fakeRoot, signal: AbortSignal.timeout(5000) } as never,
    )) as { phase: string; cardId: string };
    assert.equal(handoff.phase, 'executing');
    assert.ok(comments.some((c) => c.kind === 'plan' && c.body.includes('[ORCHESTRATOR PLAN HANDOFF #1]')));

    await ctx.waterfall(
      'agent/pre-step',
      { agent: fakeRoot, messages: [], turn: 1, step: 2, signal: AbortSignal.timeout(5000), modelSelection: curModel as never },
      async () => ({ kind: 'enter' as const, messages: [] }),
    );
    assert.equal(selections.at(-1)?.reasoningEffort, 'low');
    assert.equal(ctx.tools.checkGuards({ name: 'edit_file', agent: fakeRoot, arguments: {} } as never), undefined);

    // 4. Per-card dispatch_worker uses card's own tier on attempt 1
    const dispatchTool = ctx.tools.get('dispatch_worker')!;
    await dispatchTool.execute(
      { cardId: 'c-mech', task: 'Do mechanical edit', useWorktree: false, testCommand: `${process.execPath} -e "process.exit(0)"` },
      { agent: fakeRoot, signal: AbortSignal.timeout(10_000) } as never,
    );
    await dispatchTool.execute(
      { cardId: 'c-hard', task: 'Fix auth race', useWorktree: false, testCommand: `${process.execPath} -e "process.exit(0)"` },
      { agent: fakeRoot, signal: AbortSignal.timeout(10_000) } as never,
    );
    assert.equal(subDispatches[0].agentOptions?.reasoningEffort, 'low');
    assert.equal(subDispatches[1].agentOptions?.reasoningEffort, 'high');

    // 5. 2-strike failure automatically returns to planning on capable planner and annotates Kanban card
    ctx.emit('tools/result', { name: 'edit_file', arguments: {}, agent: fakeRoot } as never, { isError: true, content: [{ type: 'text', text: 'err 1' }] } as never);
    ctx.emit('tools/result', { name: 'bash', arguments: { command: 'node --test' }, agent: fakeRoot } as never, { isError: true, content: [{ type: 'text', text: 'FAIL exit code 1' }] } as never);
    assert.equal(ctx.nsTeam!.getOrchestratorState('orch-root').phase, 'planning');
    assert.ok(comments.some((c) => c.kind === 'status' && c.body.includes('[2-STRIKE RE-PLAN]')));
    assert.ok(ctx.tools.checkGuards({ name: 'edit_file', agent: fakeRoot, arguments: {} } as never));

    // 6. Mid-session quota exhaustion swaps provider cleanly in-place
    const quotaRes = await ctx.waterfall(
      'agent/request-error',
      {
        agent: fakeRoot,
        turn: 1,
        step: 3,
        provider: 'google-antigravity',
        failure: { code: 'QUOTA_EXCEEDED', message: 'Quota exhausted', status: 429 },
        retryPolicy: undefined,
        signal: AbortSignal.timeout(5000),
      } as never,
      async () => undefined,
    );
    assert.deepEqual(quotaRes, { kind: 'retry' });
    assert.equal(selections.at(-1)?.provider, 'openai-codex');
    assert.equal(selections.at(-1)?.model, 'gpt-6.1-terra');
    assert.equal(selections.at(-1)?.reasoningEffort, 'high');
    assert.ok(comments.some((c) => c.kind === 'status' && c.body.includes('[QUOTA FAILOVER]')));

    // 7. Cadence review triggers after cadenceSteps (4) execution steps
    await exitTool.execute({ plan: 'Resume execution phase 2' }, { agent: fakeRoot, signal: AbortSignal.timeout(5000) } as never);
    for (let s = 4; s <= 7; s += 1) {
      await ctx.waterfall(
        'agent/pre-step',
        { agent: fakeRoot, messages: [], turn: 1, step: s, signal: AbortSignal.timeout(5000), modelSelection: curModel as never },
        async () => ({ kind: 'enter' as const, messages: [] }),
      );
    }
    assert.equal(ctx.nsTeam!.getOrchestratorState('orch-root').phase, 'planning');
    assert.ok(comments.some((c) => c.kind === 'status' && c.body.includes('[CADENCE REVIEW]')));

    // 8. Pause in planning keeps inline card open; clean stop in executing closes inline orch-* card -> done
    await ctx.serial('agent/turn-stopping', { agent: fakeRoot, turn: 1, signal: new AbortController().signal } as never);
    assert.equal(cards.get(handoff.cardId)?.column, 'in_progress');
    await exitTool.execute({ plan: 'Final verification step' }, { agent: fakeRoot, signal: AbortSignal.timeout(5000) } as never);
    await ctx.serial('agent/turn-stopping', { agent: fakeRoot, turn: 1, signal: new AbortController().signal } as never);
    assert.equal(cards.get(handoff.cardId)?.column, 'done');
  } finally {
    await fiber.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});
