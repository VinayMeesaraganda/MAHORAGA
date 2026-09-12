/** Bound the whole request, including body consumption, and abort its transport. */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  timeoutError: Error,
  request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so callers receive a useful provider error even when fetch
      // immediately rejects with a generic AbortError. Aborting is essential:
      // racing alone leaves the network request running after the caller exits.
      reject(timeoutError);
      controller.abort(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
