export interface VolumeWindow {
  date: string;
  cutoff: string;
  feed: "iex" | "sip";
  volume: number;
  complete: boolean;
}
/** Caller supplies comparable regular-session cumulative windows, excluding the current session. */
export function relativeVolume(current: VolumeWindow, history: VolumeWindow[]): number | null {
  if (!current.complete || !Number.isFinite(current.volume) || current.volume < 0) return null;
  const prior = history
    .filter((h) => h.date < current.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-20);
  if (
    prior.length !== 20 ||
    new Set(prior.map((h) => h.date)).size !== 20 ||
    prior.some(
      (h) =>
        !h.complete ||
        h.feed !== current.feed ||
        h.cutoff !== current.cutoff ||
        !Number.isFinite(h.volume) ||
        h.volume < 0
    )
  )
    return null;
  const mean = prior.reduce((n, h) => n + h.volume, 0) / 20;
  return mean > 0 ? current.volume / mean : null;
}
