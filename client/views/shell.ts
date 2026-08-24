import type { AppState, RefreshStatus } from '../state.ts';
import { filledRefreshSegments } from '../refresh-progress.ts';
import { requiredElement } from './dom.ts';

const COMPLETE_HOLD_MS = 700;
const RESULT_TEXT_HOLD_MS = 2500;

export class ShellView {
  private readonly refreshRoot = requiredElement<HTMLElement>('#refresh-status');
  private readonly refreshGraphic = requiredElement<HTMLElement>('[data-refresh-graphic]', this.refreshRoot);
  private readonly refreshLabel = requiredElement<HTMLElement>('[data-refresh-label]', this.refreshRoot);
  private readonly refreshLive = requiredElement<HTMLElement>('[data-refresh-live]', this.refreshRoot);
  private readonly bars = [...this.refreshRoot.querySelectorAll<HTMLElement>('.refresh-bar')];
  private readonly bulkBar = requiredElement<HTMLElement>('#bulk-bar');
  private readonly bulkCount = requiredElement<HTMLElement>('#bulk-count');
  private readonly shortcuts = requiredElement<HTMLElement>('#shortcuts-overlay');
  private collapseTimer: number | null = null;
  private resultTimer: number | null = null;
  private lastRunning = false;
  private lastRunId: string | null = null;

  update(state: AppState): void {
    this.updateNavigation(state.page);
    this.updateBulk(state);
    this.updateRefresh(state);
  }

  toast(message: string): void {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    requiredElement('#toast-container').append(toast);
    window.setTimeout(() => toast.remove(), 2500);
  }

  setNavigationOpen(open: boolean): void {
    document.body.classList.toggle('nav-menu-open', open);
    const trigger = requiredElement('[data-nav-menu]');
    trigger.setAttribute('aria-expanded', String(open));
    trigger.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    const scrim = requiredElement<HTMLElement>('[data-nav-scrim]');
    scrim.hidden = !open;
  }

  navigationOpen(): boolean {
    return document.body.classList.contains('nav-menu-open');
  }

  setShortcutsOpen(open: boolean): void {
    this.shortcuts.hidden = !open;
  }

  shortcutsOpen(): boolean {
    return !this.shortcuts.hidden;
  }

  private updateNavigation(path: string): void {
    document.querySelectorAll<HTMLElement>('[data-nav]').forEach(link => {
      const href = link.dataset.nav ?? '';
      const active = path === href || (href !== '/' && path.startsWith(href));
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  private updateBulk(state: AppState): void {
    const active = state.selectedIds.size > 0;
    this.bulkBar.hidden = !active;
    document.body.classList.toggle('bulk-active', active);
    this.bulkCount.textContent = `${state.selectedIds.size} selected`;
  }

  private updateRefresh(state: AppState): void {
    if (state.initialDataLoading) {
      this.setCollapsed('Loading saved entries…', 'loading');
      return;
    }

    const status = state.refreshStatus;
    if (!status) {
      this.setCollapsed('', 'idle');
      return;
    }

    const isNewRun = !!status.runId && status.runId !== this.lastRunId;
    if (isNewRun) this.lastRunId = status.runId;
    if (status.refreshing) {
      this.clearTimers();
      this.refreshRoot.dataset.phase = 'running';
      this.refreshGraphic.removeAttribute('aria-hidden');
      this.refreshGraphic.setAttribute('role', 'progressbar');
      this.refreshGraphic.setAttribute('aria-valuemin', '0');
      this.refreshGraphic.setAttribute('aria-valuemax', String(status.total || 0));
      this.refreshGraphic.setAttribute('aria-valuenow', String(status.completed || 0));
      const filled = filledRefreshSegments(status.completed, status.total);
      this.bars.forEach((bar, index) => bar.classList.toggle('is-filled', filled[index] ?? false));
      const text = refreshText(status);
      this.refreshLabel.textContent = text;
      this.refreshLive.textContent = text;
      this.refreshRoot.title = failureTitle(status);
      this.lastRunning = true;
      return;
    }

    if (this.lastRunning || isNewRun) {
      this.lastRunning = false;
      this.refreshRoot.dataset.phase = status.error ? 'failed' : status.failures.length ? 'warning' : 'complete';
      this.refreshGraphic.removeAttribute('role');
      this.refreshGraphic.removeAttribute('aria-valuemin');
      this.refreshGraphic.removeAttribute('aria-valuemax');
      this.refreshGraphic.removeAttribute('aria-valuenow');
      this.refreshGraphic.setAttribute('aria-hidden', 'true');
      const finalSegments = status.error
        ? filledRefreshSegments(status.completed, status.total)
        : this.bars.map(() => true);
      this.bars.forEach((bar, index) => bar.classList.toggle('is-filled', finalSegments[index] ?? false));
      const text = refreshText(status);
      this.refreshLabel.textContent = text;
      this.refreshLive.textContent = text;
      this.refreshRoot.title = failureTitle(status);
      this.collapseTimer = window.setTimeout(() => {
        this.refreshRoot.dataset.phase = status.error ? 'failed-collapsed' : status.failures.length ? 'warning-collapsed' : 'idle';
      }, COMPLETE_HOLD_MS);
      if (!status.error && status.failures.length === 0) {
        this.resultTimer = window.setTimeout(() => { this.refreshLabel.textContent = ''; }, RESULT_TEXT_HOLD_MS);
      }
      return;
    }

    this.refreshRoot.title = failureTitle(status);
  }

  private setCollapsed(text: string, phase: string): void {
    this.clearTimers();
    this.refreshRoot.dataset.phase = phase;
    this.refreshLabel.textContent = text;
    this.refreshLive.textContent = text;
    this.bars.forEach(bar => bar.classList.remove('is-filled'));
  }

  private clearTimers(): void {
    if (this.collapseTimer !== null) window.clearTimeout(this.collapseTimer);
    if (this.resultTimer !== null) window.clearTimeout(this.resultTimer);
    this.collapseTimer = null;
    this.resultTimer = null;
  }
}

function refreshText(status: RefreshStatus): string {
  if (status.refreshing) {
    if (!status.total && !status.completed) return 'Starting refresh…';
    const progress = status.total > 0 ? `${status.completed}/${status.total}` : String(status.completed || 0);
    return `Checking feeds ${progress}${status.count ? ` · ${status.count} new` : ''}`;
  }
  if (status.error) return 'Refresh failed';
  const result = status.count ? `${status.count} new` : 'Up to date';
  return status.failures.length ? `${result} · ${status.failures.length} failed` : result;
}

function failureTitle(status: RefreshStatus): string {
  return status.failures.map(failure => `${failure.label}: ${failure.error}`).join('\n');
}
