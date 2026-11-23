/**
 * Log an action failure for debugging; console output never leaves the browser, so addresses and error details are safe to include.
 *
 * @param context The action that failed (pledge, create, claim, ...).
 * @param error The caught failure.
 */
export function logError(context: string, error: unknown): void {
  console.error(`[kasakame:${context}]`, error)
}
