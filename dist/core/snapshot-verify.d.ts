export interface SnapshotVerifyResult {
    passed: boolean;
    exitCode: number;
    durationMs: number;
    output: string;
    preSnapshotSha256: string;
    worktreeIntact: boolean;
}
export declare function createIsolatedWorktree(repoRoot: string, cardId: string, worktreeBaseDir?: string): {
    worktreePath: string;
    branch: string;
    headSha: string;
};
export declare function removeIsolatedWorktree(repoRoot: string, worktreePath: string): void;
/**
 * Hermetically copies the candidate worktree into a throwaway directory, runs the
 * verification command inside that copy (so tests can never mutate the reviewed tree),
 * and checks that the original worktree hash remained untouched.
 */
export declare function verifySnapshotTests(worktreePath: string, testCommand: string, opts?: {
    timeoutMs?: number;
}): SnapshotVerifyResult;
//# sourceMappingURL=snapshot-verify.d.ts.map