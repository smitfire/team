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
export declare function removeIsolatedWorktree(repoRoot: string, worktreePath: string, branch?: string): void;
/**
 * Copies the candidate tree into an ephemeral directory and executes a trusted
 * host-configured verification command without allowing mutations back into the source tree.
 */
export declare function verifySnapshotTests(worktreePath: string, testCommand: string, opts?: {
    timeoutMs?: number;
}): SnapshotVerifyResult;
//# sourceMappingURL=snapshot-verify.d.ts.map