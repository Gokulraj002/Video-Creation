/** Frame math shared by the director compiler, the API and the web preview. */

const EPSILON = 1e-9;

export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export function framesToSeconds(frames: number, fps: number): number {
  if (!(fps > 0)) throw new RangeError('fps must be > 0');
  return frames / fps;
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer (got ${String(value)})`);
  }
}

/**
 * Largest-remainder apportionment of `totalFrames` proportional to positive `weights`.
 *
 * - every entry is >= `minFrames` (entries whose proportional share would fall below the minimum are pinned
 *   to it and the rest is re-apportioned among the remaining entries);
 * - the result sums EXACTLY to `totalFrames`;
 * - deterministic: remainder ties are broken by lower index first.
 *
 * @throws RangeError if `weights` is empty or contains a non-finite / non-positive weight, if
 *   `totalFrames`/`minFrames` are not non-negative integers, or if `weights.length * minFrames > totalFrames`.
 */
export function allocateFrames(weights: readonly number[], totalFrames: number, minFrames = 1): number[] {
  assertNonNegativeInt(totalFrames, 'totalFrames');
  assertNonNegativeInt(minFrames, 'minFrames');
  if (weights.length === 0) throw new RangeError('weights must not be empty');
  weights.forEach((w, i) => {
    if (!Number.isFinite(w) || w <= 0) {
      throw new RangeError(`weights[${i}] must be a finite positive number (got ${String(w)})`);
    }
  });
  const n = weights.length;
  if (n * minFrames > totalFrames) {
    throw new RangeError(
      `Cannot allocate ${totalFrames} frames to ${n} entries with minFrames=${minFrames} (needs ${n * minFrames})`,
    );
  }

  const pinned = new Array<boolean>(n).fill(false);
  let quotas = new Array<number>(n).fill(0);
  let freeTotal = totalFrames;

  // Pin entries whose proportional share falls below the minimum, then re-apportion the rest.
  for (;;) {
    const pinnedCount = pinned.filter(Boolean).length;
    freeTotal = totalFrames - pinnedCount * minFrames;
    let freeWeight = 0;
    for (let i = 0; i < n; i++) if (!pinned[i]) freeWeight += weights[i] ?? 0;
    quotas = weights.map((w, i) => (pinned[i] ? minFrames : (freeTotal * w) / freeWeight));
    let newlyPinned = false;
    for (let i = 0; i < n; i++) {
      if (!pinned[i] && (quotas[i] ?? 0) < minFrames - EPSILON) {
        pinned[i] = true;
        newlyPinned = true;
      }
    }
    if (!newlyPinned || pinned.every(Boolean)) break;
  }

  const result = new Array<number>(n).fill(0);
  const remainders: { index: number; remainder: number }[] = [];
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    if (pinned[i]) {
      result[i] = minFrames;
    } else {
      const q = quotas[i] ?? 0;
      const base = Math.max(minFrames, Math.floor(q + EPSILON));
      result[i] = base;
      remainders.push({ index: i, remainder: q - base });
    }
    assigned += result[i] ?? 0;
  }

  remainders.sort((a, b) => {
    const diff = b.remainder - a.remainder;
    if (Math.abs(diff) > EPSILON) return diff;
    return a.index - b.index;
  });

  let leftover = totalFrames - assigned;
  // Distribute leftover frames by largest remainder (round-robin in case of float drift).
  while (leftover > 0 && remainders.length > 0) {
    for (const r of remainders) {
      if (leftover === 0) break;
      result[r.index] = (result[r.index] ?? 0) + 1;
      leftover--;
    }
  }
  // Defensive: take back frames if float drift over-assigned (never below minFrames).
  while (leftover < 0) {
    let progressed = false;
    for (let k = remainders.length - 1; k >= 0 && leftover < 0; k--) {
      const r = remainders[k];
      if (r && (result[r.index] ?? 0) > minFrames) {
        result[r.index] = (result[r.index] ?? 0) - 1;
        leftover++;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  if (leftover !== 0) {
    // Only reachable when every entry is pinned and totalFrames > n * minFrames: give extra to the heaviest.
    let heaviest = 0;
    for (let i = 1; i < n; i++) if ((weights[i] ?? 0) > (weights[heaviest] ?? 0)) heaviest = i;
    result[heaviest] = (result[heaviest] ?? 0) + leftover;
  }
  return result;
}

/** Formats a frame index as `HH:MM:SS:FF` (hours are not wrapped; fps is rounded to an integer base). */
export function formatTimecode(frame: number, fps: number): string {
  if (!Number.isFinite(frame) || frame < 0) throw new RangeError('frame must be a non-negative number');
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError('fps must be > 0');
  const base = Math.max(1, Math.round(fps));
  const f = Math.floor(frame);
  const totalSeconds = Math.floor(f / base);
  const ff = f % base;
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}
