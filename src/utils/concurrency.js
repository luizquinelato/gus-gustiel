/**
 * Concurrency utilities
 *
 * Shared primitives for controlling async concurrency across the app.
 * Extracted from sprint-data-resolver.js (makeSemaphore) and
 * team-sprint-resolver.js (sequential delay loop).
 *
 * Rules:
 *  - Never define these inline in a resolver.
 *  - Import from here wherever bounded concurrency or sequential execution is needed.
 */

/**
 * Creates a semaphore that limits the number of concurrently executing async
 * operations to `limit`.  Extra callers queue and are released in FIFO order.
 *
 * The GreenHopper API is rate-limited per Jira instance (not per board), so
 * firing one call per team simultaneously triggers HTTP 429 for larger portfolios.
 * Wrapping every GreenHopper call with the returned `runLimited` function keeps
 * total in-flight requests under the burst threshold while still running multiple
 * teams in parallel.
 *
 * @param   {number}   limit - Maximum number of concurrently running operations.
 * @returns {function}       - `runLimited(fn)` — call with a zero-arg async function.
 *
 * @example
 *   const runLimited = makeSemaphore(3);
 *   await Promise.all(items.map(item => runLimited(() => fetchSomething(item))));
 */
export function makeSemaphore(limit) {
    let running = 0;
    const queue = [];
    return async function runLimited(fn) {
        if (running >= limit) {
            await new Promise(resolve => queue.push(resolve));
        }
        running++;
        try {
            return await fn();
        } finally {
            running--;
            if (queue.length > 0) queue.shift()();
        }
    };
}

/**
 * Runs `asyncFn` for each item in `items` one at a time, waiting for each
 * call to complete before starting the next.  An optional `delayMs` pause is
 * inserted between calls (useful as a courtesy delay when the API has no formal
 * rate-limit header but is sensitive to burst traffic).
 *
 * Prefer `makeSemaphore` for portfolio-level work where multiple teams must
 * make progress concurrently.  Use `sequential` only when strict ordering or
 * a time-based backoff is required.
 *
 * @param   {Array}    items     - Items to iterate.
 * @param   {function} asyncFn   - Async function called with (item, index).
 * @param   {number}   [delayMs=0] - Milliseconds to wait between calls.
 * @returns {Promise<Array>}     - Array of results in the same order as items.
 *
 * @example
 *   const results = await sequential(sprints, s => fetchReport(boardId, s.id), 300);
 */
export async function sequential(items, asyncFn, delayMs = 0) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
        results.push(await asyncFn(items[i], i));
        if (delayMs > 0 && i < items.length - 1) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return results;
}
