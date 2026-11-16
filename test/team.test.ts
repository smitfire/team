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
  createIsolatedWorktree,
  generateSwitchyardRoutesToml,
  parseOcrJsonReport,
  removeIsolatedWorktree,
  selectCrossFamilyReviewer,
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
