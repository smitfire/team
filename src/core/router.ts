export interface ReviewerChoice {
  provider: string;
  model: string;
  crossFamily: boolean;
  warning?: string;
}

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  'openai-codex': 'gpt-6-luna',
  'google-antigravity': 'antigravity-gemini-3.8-flash',
};

/**
 * Selects a mandatory non-author reviewer across provider families (OpenAI <-> Gemini),
 * degrading gracefully with an explicit warning if only one provider family is available.
 */
export function selectCrossFamilyReviewer(
  authorProvider: string,
  healthyProviders: readonly string[] = ['google-antigravity', 'openai-codex'],
): ReviewerChoice {
  const normalizedAuthor = authorProvider.trim();
  const isOpenAiAuthor = normalizedAuthor.includes('openai');
  const preferredPartner = isOpenAiAuthor ? 'google-antigravity' : 'openai-codex';

  if (healthyProviders.includes(preferredPartner)) {
    return {
      provider: preferredPartner,
      model: DEFAULT_MODEL_BY_PROVIDER[preferredPartner] ?? preferredPartner,
      crossFamily: true,
    };
  }

  const alternate = healthyProviders.find((p) => p !== normalizedAuthor);
  if (alternate) {
    return {
      provider: alternate,
      model: DEFAULT_MODEL_BY_PROVIDER[alternate] ?? alternate,
      crossFamily: alternate.includes('openai') !== isOpenAiAuthor,
    };
  }

  const fallback = healthyProviders[0] || normalizedAuthor || 'openai-codex';
  return {
    provider: fallback,
    model: DEFAULT_MODEL_BY_PROVIDER[fallback] ?? fallback,
    crossFamily: false,
    warning: `single-family fallback active (${fallback}); configure both OpenAI and Gemini for full cross-family review`,
  };
}
