/**
 * A response stream that went silent for longer than the hard idle budget.
 *
 * The SDK's `requestTimeout` only covers the wait for the response headers and
 * is cleared once they arrive, so nothing bounded the gaps between events. A
 * connection Kiro holds open without ever sending another event therefore hung
 * the read until the socket died, which on a healthy link is never.
 */
export class StreamIdleError extends Error {
  override readonly name = 'StreamIdleError'
  constructor(readonly idleMs: number) {
    super(`stream stalled: no event for ${idleMs}ms`)
  }
}

export interface IdleWatchdogOptions {
  /**
   * Silence after which the stream is cancelled and {@link StreamIdleError}
   * thrown. 0 disables the watchdog entirely.
   */
  hardMs: number
  /**
   * Silence after which the gap is reported through `onSoft`, once per gap.
   * The Kiro CLI watches the same two tiers; the soft one only observes, so a
   * stall that recovers on its own still leaves a trace. 0 disables it.
   */
  softMs?: number
  onSoft?: (idleMs: number) => void
}

/**
 * Build watchdog options from the single configured budget.
 *
 * One knob, two tiers: the soft tier sits at half the budget, so a gap that
 * recovers on its own still leaves a line in the log to find later. A budget
 * of 0 — or anything not a positive number — means no watchdog at all.
 */
export function idleWatchdogOptions(timeoutMs: number): IdleWatchdogOptions | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined
  return { hardMs: timeoutMs, softMs: Math.floor(timeoutMs / 2) }
}

/**
 * Wrap an event stream so a silent upstream fails instead of hanging.
 *
 * Idle is measured per gap — from asking for the next event until it arrives —
 * so a slow consumer never counts as a stall. On the hard tier the upstream
 * iterator is closed before the error propagates, which releases the socket
 * rather than leaving it parked for the life of the process.
 *
 * @param source the SDK event stream, or any async iterable
 * @throws StreamIdleError once a single gap exceeds `hardMs`
 */
export async function* guardStreamIdle<T>(
  source: AsyncIterable<T>,
  opts: IdleWatchdogOptions
): AsyncGenerator<T> {
  const hardMs = opts.hardMs > 0 ? opts.hardMs : 0
  const softMs = opts.softMs && opts.softMs > 0 ? opts.softMs : 0

  if (!hardMs && !softMs) {
    yield* source
    return
  }

  const it = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      const result = await raceIdle(it.next(), hardMs, softMs, opts.onSoft)
      if (result.done) return
      yield result.value
    }
  } finally {
    // Started, never awaited. Closing an async iterator that is parked inside
    // an await only completes once that await does — and a stalled stream is
    // exactly the case where that is unbounded, so awaiting here would hand
    // back the hang the watchdog exists to end.
    try {
      void Promise.resolve(it.return?.()).catch(() => {})
    } catch {
      // A `return` that throws synchronously is not a failure of this stream.
    }
  }
}

function raceIdle<T>(
  next: Promise<IteratorResult<T>>,
  hardMs: number,
  softMs: number,
  onSoft?: (idleMs: number) => void
): Promise<IteratorResult<T>> {
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const started = Date.now()
    let soft: ReturnType<typeof setTimeout> | undefined
    let hard: ReturnType<typeof setTimeout> | undefined

    const clear = () => {
      if (soft) clearTimeout(soft)
      if (hard) clearTimeout(hard)
    }

    if (softMs && onSoft) {
      soft = setTimeout(() => onSoft(Date.now() - started), softMs)
    }
    if (hardMs) {
      hard = setTimeout(() => {
        clear()
        reject(new StreamIdleError(Date.now() - started))
      }, hardMs)
    }

    next.then(
      (value) => {
        clear()
        resolve(value)
      },
      (err) => {
        clear()
        reject(err)
      }
    )
  })
}
