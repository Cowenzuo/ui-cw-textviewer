/**
 * Open-history: the most recently opened file paths (capped, most recent
 * first, deduped by path). Persisted in localStorage (best-effort: private
 * mode or quota failures degrade to in-memory only).
 */

/** One history entry: a previously opened file. */
export interface HistoryEntry {
  name: string
  path: string
}

const STORAGE_KEY = 'dsh-plugins/ui-cw-textviewer/history'
/** Default history size. */
export const HISTORY_CAP = 10

/** Insert at the front, dedupe by path, cap the length. Pure — unit-tested. */
export function pushHistory(list: readonly HistoryEntry[], entry: HistoryEntry, cap = HISTORY_CAP): HistoryEntry[] {
  return [entry, ...list.filter(item => item.path !== entry.path)].slice(0, cap)
}

/** Read the persisted history; any corruption degrades to an empty list. */
export function loadHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is HistoryEntry =>
        typeof item === 'object' && item !== null
        && typeof (item as HistoryEntry).name === 'string'
        && typeof (item as HistoryEntry).path === 'string')
      .slice(0, HISTORY_CAP)
  } catch {
    return []
  }
}

/** Persist the history (best-effort). */
export function saveHistory(list: readonly HistoryEntry[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // storage unavailable — history stays in memory only
  }
}
