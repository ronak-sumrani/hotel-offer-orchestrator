import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../logger';

/** Error with an HTTP status and a machine-readable code, rendered as-is to clients. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string };
}

function body(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Fallback for unmatched routes. Register after all routes. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

/** Central error handler. Register last. */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const log = res.locals.log ?? logger;

  if (err instanceof AppError) {
    res.status(err.status).json(body(err.code, err.message));
    return;
  }

  // Malformed JSON body from express.json()
  if (isBodyParserError(err) && err.type === 'entity.parse.failed') {
    res.status(400).json(body('INVALID_JSON', 'Request body is not valid JSON'));
    return;
  }

  log.error({ err }, 'unhandled error');
  res.status(500).json(body('INTERNAL_ERROR', 'Internal server error'));
};

function isBodyParserError(err: unknown): err is { type: string } {
  return typeof err === 'object' && err !== null && typeof (err as { type?: unknown }).type === 'string';
}
