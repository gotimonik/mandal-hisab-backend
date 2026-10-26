export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "ORG_INACTIVE"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  ORG_INACTIVE: 423,
  INTERNAL: 500,
};

/** Errors that are safe to show to API clients. Anything else becomes a generic 500. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError("BAD_REQUEST", m, d);
export const unauthorized = (m = "Authentication required") => new AppError("UNAUTHORIZED", m);
export const forbidden = (m = "You do not have permission to perform this action") => new AppError("FORBIDDEN", m);
export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);
export const conflict = (m: string, d?: unknown) => new AppError("CONFLICT", m, d);

export function isDuplicateKeyError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: number }).code === 11000;
}
