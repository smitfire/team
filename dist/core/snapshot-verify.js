import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.ns-dsh']);
function hashDirectoryTree(root) {
    const hash = createHash('sha256');
    const files = [];
    const walk = (dir, relPrefix) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (EXCLUDED_DIRS.has(entry.name))
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
    const headSha = execFileSync('git', ['-C', absRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (existsSync(worktreePath)) {
        try {
            const existing = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
            if (existing === headSha)
                return { worktreePath, branch, headSha };
        }
        catch {
            /* recreate stale or corrupted worktree directory */
        }
        removeIsolatedWorktree(absRepo, worktreePath, branch);
    }
    // Disable repo git hooks on ephemeral worktree checkout so untrusted repo hooks cannot execute implicitly.
    execFileSync('git', ['-C', absRepo, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-B', branch, worktreePath, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { worktreePath, branch, headSha };
}
export function removeIsolatedWorktree(repoRoot, worktreePath, branch) {
    const absRepo = resolve(repoRoot);
    try {
        execFileSync('git', ['-C', absRepo, 'worktree', 'remove', '--force', worktreePath], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch {
        rmSync(worktreePath, { recursive: true, force: true });
        try {
            execFileSync('git', ['-C', absRepo, 'worktree', 'prune'], { stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch { /* ignore */ }
    }
    if (branch) {
        try {
            execFileSync('git', ['-C', absRepo, 'branch', '-D', branch], { stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch { /* ignore if branch already absent */ }
    }
}
/**
 * Copies the candidate tree into an ephemeral directory and executes a trusted
 * host-configured verification command without allowing mutations back into the source tree.
 */
export function verifySnapshotTests(worktreePath, testCommand, opts) {
    const absWorktree = resolve(worktreePath);
    const preSha = hashDirectoryTree(absWorktree);
    const sandboxDir = mkdtempSync(join(tmpdir(), 'ns-team-verify-'));
    const started = performance.now();
    try {
        cpSync(absWorktree, sandboxDir, {
            recursive: true,
            filter: (src) => resolve(src) === absWorktree || !EXCLUDED_DIRS.has(basename(src)),
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