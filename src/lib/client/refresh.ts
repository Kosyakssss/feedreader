import { api } from './api';
import type { RefreshStatus } from './types';
const POLL_INTERVAL_MS = 750;
export class RefreshPoller {
  private active: Promise<RefreshStatus> | null = null;
  private syncing: Promise<RefreshStatus> | null = null;
  private reset = false;
  private runId: string | null = null;
  private cursor = 0;
  private feedCursor = 0;
  constructor(private readonly receive: (status: RefreshStatus) => void) {}
  async run(feedIds?: string[]): Promise<RefreshStatus> {
    await api.startRefresh(feedIds);
    if (this.active) return this.active;
    const run = this.poll().finally(() => {
      this.active = null;
    });
    this.active = run;
    return run;
  }
  sync(fromStart = false): Promise<RefreshStatus> {
    this.reset ||= fromStart;
    if (this.syncing) return this.syncing;
    const job = this.drain().finally(() => {
      this.syncing = null;
    });
    this.syncing = job;
    return job;
  }
  private async drain(): Promise<RefreshStatus> {
    while (true) {
      if (this.reset) this.cursor = this.feedCursor = 0;
      this.reset = false;
      const status = await api.refreshStatus(this.cursor, this.feedCursor);
      if (this.reset) continue;
      if (status.runId !== this.runId) {
        this.runId = status.runId;
        if (this.cursor || this.feedCursor) {
          this.reset = true;
          continue;
        }
      }
      this.cursor = status.cursor;
      this.feedCursor = status.feedCursor;
      this.receive(status);
      if (!status.refreshing || (!status.newEntries.length && !status.feedResults.length)) return status;
    }
  }
  private async poll(): Promise<RefreshStatus> {
    let status = await this.sync(true);
    while (status.refreshing) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      status = await this.sync();
    }
    return status;
  }
}
