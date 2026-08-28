export class RefreshRequestQueue {
  private all = false;
  private ids = new Set<string>();

  enqueue(feedIds?: readonly string[]): void {
    if (feedIds === undefined) {
      this.all = true;
      this.ids.clear();
      return;
    }
    if (this.all) return;
    for (const id of feedIds) this.ids.add(id);
  }

  take(allFeedIds: readonly string[], activeFeedIds: ReadonlySet<string>): Set<string> {
    const requested = this.all ? allFeedIds : [...this.ids];
    this.clear();
    return new Set(requested.filter(id => !activeFeedIds.has(id)));
  }

  get pending(): boolean {
    return this.all || this.ids.size > 0;
  }

  clear(): void {
    this.all = false;
    this.ids.clear();
  }
}
