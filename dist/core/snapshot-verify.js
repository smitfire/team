import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
function hashDirectoryTree(root) {
    const hash = createHash('sha256');
    const files = [];
    const walk = (dir, relPrefix) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.ns-dsh')
                continue;
            const abs = join(dir, entry.name);
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            if (entry.isDirectory())
                walk(abs, rel);
            else if (entry.isFile())
                files.push(rel);
        }
    };
    walk(root, '');
    files.sort();
    for (const rel of files) {
        hash.update(rel);
        hash.update('\0');
        hash.update(readFileSync(join(root, rel)));
        hash.update('\0');
    }
    return hash.digest('hex');
}
export function createIsolatedWorktree(repoRoot, cardId, worktreeBaseDir = join(repoRoot, '.ns-dsh', 'worktrees')) {
    const absRepo = resolve(repoRoot);
    mkdirSync(worktreeBaseDir, { recursive: true, mode: 0o755 });
    const safeId = cardId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
    const worktreePath = resolve(worktreeBaseDir, safeId);
    const branch = `ns-work/${safeId}`;
    const headSha = execFileSync('git', ['-C', absRepo, '-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
    }).trim();
    if (existsSync(worktreePath)) {
        return { worktreePath, branch, headSha };
    }
    execFileSync('git', ['-C', absRepo, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-B', branch, worktreePath, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { worktreePath, branch, headSha };
}
export function removeIsolatedWorktree(repoRoot, worktreePath) {
    try {
        execFileSync('git', ['-C', resolve(repoRoot), '-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', worktreePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch {
        rmSync(worktreePath, { recursive: true, force: true });
    }
}
/**
 * Hermetically copies the candidate worktree into a throwaway directory, runs the
 * verification command inside that copy (so tests can never mutate the reviewed tree),
 * and checks that the original worktree hash remained untouched.
 */
export function verifySnapshotTests(worktreePath, testCommand, opts) {
    const absWorktree = resolve(worktreePath);
    const preSha = hashDirectoryTree(absWorktree);
    const sandboxDir = mkdtempSync(join(tmpdir(), 'ns-team-verify-'));
    const started = performance.now();
    try {
        cpSync(absWorktree, sandboxDir, {
            recursive: true,
            filter: (src) => {
                const name = src.slice(dirname(src).length + 1);
                return name !== '.git' && name !== 'node_modules' && name !== '.ns-dsh';
            },
        });
        const nmSrc = join(absWorktree, 'node_modules');
        if (existsSync(nmSrc)) {
            symlinkSync(nmSrc, join(sandboxDir, 'node_modules'));
        }
        const res = spawnSync('/bin/sh', ['-c', testCommand], {
            cwd: sandboxDir,
            encoding: 'utf8',
            timeout: opts?.timeoutMs ?? 60_000,
            maxBuffer: 4 * 1024 * 1024,
            env: {
                ...process.env,
                CI: '1',
            },
        });
        const postSha = hashDirectoryTree(absWorktree);
        const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim().slice(0, 16_384);
        const exitCode = res.status ?? (res.error ? 1 : 0);
        return {
            passed: exitCode === 0,
            exitCode,
            durationMs: Number((performance.now() - started).toFixed(1)),
            output: combined,
            preSnapshotSha256: preSha,
            worktreeIntact: preSha === postSha,
        };
    }
    finally {
        rmSync(sandboxDir, { recursive: true, force: true });
    }
}
//# sourceMappingURL=snapshot-verify.js.map