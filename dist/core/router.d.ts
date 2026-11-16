export interface ReviewerChoice {
    provider: string;
    model: string;
    crossFamily: boolean;
    warning?: string;
}
/**
 * Selects a mandatory non-author reviewer across provider families (OpenAI <-> Gemini),
 * degrading gracefully with an explicit warning if only one provider family is available.
 */
export declare function selectCrossFamilyReviewer(authorProvider: string, healthyProviders?: readonly string[]): ReviewerChoice;
//# sourceMappingURL=router.d.ts.map