import { api } from './api.ts';
import type { RefreshStatus } from './state.ts';

const POLL_INTERVAL_MS = 750;

export class RefreshPoller {
  private active: Promise<RefreshStatus> | null = null;

  constructor(
    private readonly receive: (status: RefreshStatus) => void,
    private readonly cursor: () => number,
  ) {}

  run(): Promise<RefreshStatus> {
    if (this.active) return this.active;
    const run = this.poll().finally(() => {
      if (this.active === run) this.active = null;
    });
    this.active = run;
    return run;
  }

  private async poll(): Promise<RefreshStatus> {
    let latest = await api.startRefresh();
    this.receive(latest);
    while (latest.refreshing) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      latest = await api.refreshStatus(this.cursor());
      this.receive(latest);
    }
    return latest;
  }
}
