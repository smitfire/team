import { DEFAULT_SWITCHYARD_CONFIG } from './switchyard-router.js';

export interface ReviewerChoice {
  provider: string;
  model: string;
  crossFamily: boolean;
  warning?: string;
}

const PROVIDER_FAMILY: Record<string, 'openai' | 'gemini'> = {
  'openai-codex': 'openai',
  openai: 'openai',
  'google-antigravity': 'gemini',
  gemini: 'gemini',
};

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  [DEFAULT_SWITCHYARD_CONFIG.efficientRoute.provider]: DEFAULT_SWITCHYARD_CONFIG.efficientRoute.model,
  [DEFAULT_SWITCHYARD_CONFIG.fallbackEfficientRoute.provider]: DEFAULT_SWITCHYARD_CONFIG.fallbackEfficientRoute.model,
};

/**
 * Selects a mandatory non-author reviewer across provider families (OpenAI <-> Gemini),
 * degrading gracefully with an explicit warning if only one provider family is available.
 */
export function selectCrossFamilyReviewer(
  authorProvider: string,
  healthyProviders: readonly string[] = [
    DEFAULT_SWITCHYARD_CONFIG.efficientRoute.provider,
    DEFAULT_SWITCHYARD_CONFIG.fallbackEfficientRoute.provider,
  ],
): ReviewerChoice {
  const normalizedAuthor = authorProvider.trim();
  const authorFamily = PROVIDER_FAMILY[normalizedAuthor];

  if (authorFamily) {
    const crossPartner = healthyProviders.find((p) => PROVIDER_FAMILY[p] && PROVIDER_FAMILY[p] !== authorFamily);
    if (crossPartner) {
      return {
        provider: crossPartner,
        model: DEFAULT_MODEL_BY_PROVIDER[crossPartner] ?? crossPartner,
        crossFamily: true,
      };
    }
  }

  const alternate = healthyProviders.find((p) => p !== normalizedAuthor);
  if (alternate) {
    const altFamily = PROVIDER_FAMILY[alternate];
    const crossFamily = Boolean(authorFamily && altFamily && authorFamily !== altFamily);
    return {
      provider: alternate,
      model: DEFAULT_MODEL_BY_PROVIDER[alternate] ?? alternate,
      crossFamily,
      ...(crossFamily ? {} : { warning: `provider family unknown or matched (${normalizedAuthor} -> ${alternate})` }),
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
