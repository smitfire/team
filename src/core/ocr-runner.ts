import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

export function parseOcrJsonReport(rawStdout: string): OcrGateResult {
  const trimmed = rawStdout.trim();
  if (!trimmed) {
    return { ran: false, passed: false, blockingCount: 1, findings: [], error: 'empty OCR output' };
  }
  try {
    const parsed = JSON.parse(trimmed) as { comments?: unknown };
    if (!Array.isArray(parsed.comments)) {
      return { ran: false, passed: false, blockingCount: 1, findings: [], error: 'OCR report missing comments array' };
    }
    const findings: OcrFinding[] = parsed.comments.map((raw) => {
      const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return {
        path: String(c.path ?? ''),
        severity: String(c.severity ?? 'medium').toLowerCase(),
        category: String(c.category ?? 'other'),
        startLine: typeof c.start_line === 'number' ? c.start_line : undefined,
        content: String(c.content ?? ''),
      };
    });
    const blocking = findings.filter((f) => ['critical', 'high'].includes(f.severity));
    return {
      ran: true,
      passed: blocking.length === 0,
      blockingCount: blocking.length,
      findings,
    };
  } catch (err) {
    return {
      ran: false,
      passed: false,
      blockingCount: 1,
      findings: [],
      error: `invalid OCR JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function resolveRepoEnvToken(repoDir: string): string {
  if (process.env.OCR_LLM_TOKEN) return process.env.OCR_LLM_TOKEN;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const envFile = join(repoDir, '.env');
  if (!existsSync(envFile)) return '';
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/u)) {
    const m = line.trim().match(/^DEEPSEEK_API_KEY=(.+)$/);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

export function runOcrDiffReview(
  repoDir: string,
  baseRef = 'HEAD~1',
  opts?: { ocrBin?: string; effort?: 'low' | 'medium'; pathPrefix?: string },
): OcrGateResult {
  const ocrBin = opts?.ocrBin ?? 'ocr';
  const token = resolveRepoEnvToken(repoDir);
  const pathPrefix = opts?.pathPrefix ?? process.env.OCR_PATH_PREFIX;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(pathPrefix ? { PATH: `${pathPrefix}:${process.env.PATH ?? ''}` } : {}),
    ...(token && !process.env.OCR_LLM_TOKEN
      ? {
          OCR_LLM_URL: process.env.OCR_LLM_URL ?? 'https://api.deepseek.com/v1',
          OCR_LLM_TOKEN: token,
          OCR_LLM_MODEL: process.env.OCR_LLM_MODEL ?? 'deepseek-chat',
          OCR_LLM_PROTOCOL: 'openai',
        }
      : {}),
  };
  const res = spawnSync(
    ocrBin,
    [
      'review',
      '--from',
      baseRef,
      '--effort',
      opts?.effort ?? 'low',
      '--exclude',
      'dist/**,pnpm-lock.yaml',
      '--format',
      'json',
      '--audience',
      'agent',
    ],
    {
      cwd: repoDir,
      encoding: 'utf8',
      env,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (res.error) {
    return { ran: false, passed: false, blockingCount: 1, findings: [], error: res.error.message };
  }
  const parsed = parseOcrJsonReport(res.stdout ?? '');
  if (!parsed.ran && res.stderr) parsed.error = res.stderr.trim().slice(0, 400);
  if (!parsed.ran && res.status !== 0 && !parsed.error) {
    parsed.error = `ocr exited with status ${res.status}`;
  }
  return parsed;
}
