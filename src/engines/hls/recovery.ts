/** Recovery classification is separate from the HTTP transport. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string | null,
  ) {
    super(`HLS HTTP ${status}`);
    this.name = 'HttpError';
  }
}
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}
export function retryable(error: unknown): boolean {
  if (error instanceof HttpError)
    return [404, 408, 425, 429].includes(error.status) || error.status >= 500;
  return (
    error instanceof NetworkError ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}
export function retryDelay(attempt: number): number {
  return Math.min(4000, 300 * 2 ** Math.min(attempt, 4));
}
