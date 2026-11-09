/**
 * IrisVeil error model.
 *
 * `message` is always safe to show to an end user (CLI or web visitor).
 * `detail` is operator-only context for logs; it never contains secrets.
 */
export type IrisVeilErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIG_ERROR'
  | 'URL_BLOCKED'
  | 'FETCH_FAILED'
  | 'NOT_HTML'
  | 'SITE_TOO_THIN'
  | 'LLM_AUTH'
  | 'LLM_RATE_LIMITED'
  | 'LLM_BAD_REQUEST'
  | 'LLM_UNAVAILABLE'
  | 'LLM_TIMEOUT'
  | 'LLM_BAD_OUTPUT'
  | 'INSUFFICIENT_EVIDENCE'
  | 'RATE_LIMITED'
  | 'BUSY'
  | 'ABORTED'
  | 'INTERNAL';

export interface IrisVeilErrorOptions {
  cause?: unknown;
  detail?: string | undefined;
  retryAfterSeconds?: number | undefined;
}

export class IrisVeilError extends Error {
  readonly code: IrisVeilErrorCode;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: IrisVeilErrorCode, message: string, options: IrisVeilErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'IrisVeilError';
    this.code = code;
    this.detail = options.detail;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isIrisVeilError(value: unknown): value is IrisVeilError {
  return value instanceof IrisVeilError;
}

/** Errors raised before any LLM call; a failed run with one of these consumed no model quota. */
export const PRE_LLM_CODES: ReadonlySet<IrisVeilErrorCode> = new Set([
  'INVALID_INPUT',
  'URL_BLOCKED',
  'FETCH_FAILED',
  'NOT_HTML',
  'SITE_TOO_THIN',
]);

export function toIrisVeilError(value: unknown): IrisVeilError {
  if (isIrisVeilError(value)) return value;
  if (value instanceof Error && value.name === 'AbortError') {
    return new IrisVeilError('ABORTED', 'The run was cancelled.', { cause: value });
  }
  return new IrisVeilError('INTERNAL', 'Something went wrong inside IrisVeil. Try again.', {
    cause: value,
    detail: value instanceof Error ? `${value.name}: ${value.message}` : String(value),
  });
}
