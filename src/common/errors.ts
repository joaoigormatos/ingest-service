const DUPLICATE_KEY = 11000;

/** True for MongoDB's E11000: a write collided with a unique index. */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === DUPLICATE_KEY
  );
}

/** A log-friendly message for anything that was thrown. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
