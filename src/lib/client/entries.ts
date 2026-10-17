import type { EntryState } from '../types';
function acceptsEntryState(currentAt: number | undefined, incomingAt: number | undefined): boolean {
  return currentAt === undefined || (incomingAt !== undefined && incomingAt >= currentAt);
}
export function mergeEntryState(current: EntryState = {}, incoming: EntryState = {}): EntryState {
  const merged = { ...current };
  if (incoming.read !== undefined && acceptsEntryState(current.readAt, incoming.readAt)) {
    merged.read = incoming.read;
    merged.readAt = incoming.readAt;
  }
  if (incoming.starred !== undefined && acceptsEntryState(current.starredAt, incoming.starredAt)) {
    merged.starred = incoming.starred;
    merged.starredAt = incoming.starredAt;
  }
  return merged;
}
export function timeAgo(iso: string): string {
  const date = new Date(iso);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown date';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < -300) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 172800) return 'yesterday';
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function safeHttpUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
