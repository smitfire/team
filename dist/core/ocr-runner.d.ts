export interface OcrFinding {
    path: string;
    severity: string;
    category: string;
    startLine?: number;
    content: string;
}
export interface OcrGateResult {
    ran: boolean;
    passed: boolean;
    blockingCount: number;
    findings: OcrFinding[];
    error?: string;
}
export declare function parseOcrJsonReport(rawStdout: string): OcrGateResult;
export declare function runOcrDiffReview(repoDir: string, baseRef?: string, opts?: {
    ocrBin?: string;
    effort?: 'low' | 'medium';
    pathPrefix?: string;
}): OcrGateResult;
//# sourceMappingURL=ocr-runner.d.ts.map