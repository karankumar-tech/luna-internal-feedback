export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'INTERNAL';

export interface ErrorIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly issues?: ErrorIssue[],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static unauthorized(msg = 'Missing or invalid API key') { return new AppError(401, 'UNAUTHORIZED', msg); }
  static forbidden(msg = 'Not allowed') { return new AppError(403, 'FORBIDDEN', msg); }
  static notFound(msg = 'Not found') { return new AppError(404, 'NOT_FOUND', msg); }
  static conflict(msg: string) { return new AppError(409, 'CONFLICT', msg); }
  static validation(issues: ErrorIssue[], msg = 'Request failed validation') {
    return new AppError(422, 'VALIDATION_FAILED', msg, issues);
  }
}
