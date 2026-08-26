import { api, type FeedreaderApi } from './api.ts';
import type { RefreshStatus } from './state.ts';

const POLL_INTERVAL_MS = 750;

export class RefreshPoller {
  private active: Promise<RefreshStatus> | null = null;

  constructor(
    private readonly receive: (status: RefreshStatus) => void,
    private readonly cursor: () => number,
    private readonly feedCursor: () => number,
    private readonly client: FeedreaderApi = api,
  ) {}

  run(feedIds?: string[]): Promise<RefreshStatus> {
    if (this.active) return this.active;
    const run = this.poll(feedIds).finally(() => {
      if (this.active === run) this.active = null;
    });
    this.active = run;
    return run;
  }

  private async poll(feedIds?: string[]): Promise<RefreshStatus> {
    let latest = await this.client.startRefresh(feedIds);
    this.receive(latest);
    while (latest.refreshing) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      latest = await this.client.refreshStatus(this.cursor(), this.feedCursor());
      this.receive(latest);
    }
    return latest;
  }
}
