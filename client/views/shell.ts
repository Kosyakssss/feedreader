import type { AppState, RefreshStatus } from '../state.ts';
import { filledRefreshSegments } from '../refresh-progress.ts';
import { requiredElement } from './dom.ts';

const SEGMENT_SCAN_MS = 320;
const COMPLETE_HOLD_MS = 700;
const TOAST_VISIBLE_MS = 2500;
const TOAST_EXIT_MS = 180;
const COMPACT_LAYOUT_QUERY = '(max-width: 699px)';

interface ShellTiming {
  segmentScanMs: number;
  completeHoldMs: number;
  toastVisibleMs: number;
  toastExitMs: number;
}

const DEFAULT_TIMING: ShellTiming = {
  segmentScanMs: SEGMENT_SCAN_MS,
  completeHoldMs: COMPLETE_HOLD_MS,
  toastVisibleMs: TOAST_VISIBLE_MS,
  toastExitMs: TOAST_EXIT_MS,
};

export class ShellView {
  private readonly refreshRoot = requiredElement<HTMLButtonElement>('#refresh-status');
  private readonly refreshGraphic = requiredElement<HTMLElement>('[data-refresh-graphic]', this.refreshRoot);
  private readonly refreshLabel = requiredElement<HTMLElement>('[data-refresh-label]', this.refreshRoot);
  private readonly refreshLive = requiredElement<HTMLElement>('[data-refresh-live]', this.refreshRoot);
  private readonly bars = [...this.refreshRoot.querySelectorAll<HTMLElement>('.refresh-bar')];
  private readonly bulkBar = requiredElement<HTMLElement>('#bulk-bar');
  private readonly bulkCount = requiredElement<HTMLElement>('#bulk-count');
  private readonly shortcuts = requiredElement<HTMLElement>('#shortcuts-overlay');
  private collapseTimer: number | null = null;
  private segmentTimer: number | null = null;
  private displayedSegments = 0;
  private segmentStartedAt = 0;
  private visualRunStarted = false;
  private visualRunId: string | null = null;
  private settledRunId: string | null | undefined;
  private latestStatus: RefreshStatus | null = null;
  private shortcutReturnFocus: HTMLElement | null = null;
  private readonly timing: ShellTiming;

  constructor(timing: Partial<ShellTiming> = {}) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
    const compactLayout = matchMedia(COMPACT_LAYOUT_QUERY);
    compactLayout.addEventListener('change', () => this.setNavigationOpen(false));
    this.refreshRoot.addEventListener('click', () => this.toggleRefreshDetails());
    document.addEventListener('pointerdown', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[data-refresh-status]')) this.dismissRefreshDetails();
    }, true);
    this.shortcuts.addEventListener('keydown', event => this.trapShortcutFocus(event));
  }

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
    window.setTimeout(() => toast.classList.add('is-leaving'), this.timing.toastVisibleMs - this.timing.toastExitMs);
    window.setTimeout(() => toast.remove(), this.timing.toastVisibleMs);
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

  toggleRefreshDetails(): void {
    if (!this.refreshRoot.dataset.phase?.endsWith('-collapsed')) return;
    const revealed = this.refreshRoot.dataset.revealed === 'true';
    this.refreshRoot.dataset.revealed = String(!revealed);
    this.refreshRoot.setAttribute('aria-expanded', String(!revealed));
  }

  dismissRefreshDetails(): void {
    delete this.refreshRoot.dataset.revealed;
    this.refreshRoot.setAttribute('aria-expanded', 'false');
  }

  setShortcutsOpen(open: boolean): void {
    if (open === !this.shortcuts.hidden) return;
    if (open) {
      this.shortcutReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.shortcuts.hidden = false;
      this.shortcutFocusables()[0]?.focus({ preventScroll: true });
      return;
    }
    this.shortcuts.hidden = true;
    const returnFocus = this.shortcutReturnFocus;
    this.shortcutReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
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

    if (!this.visualRunStarted || status.runId !== this.visualRunId) this.beginVisualRun(status);
    this.latestStatus = status;
    this.updateRefreshAccessibility(status);

    if (!status.refreshing && status.runId === this.settledRunId) {
      this.refreshRoot.title = failureTitle(status);
      return;
    }

    this.renderRunning(status);
    this.advanceVisualProgress();
  }

  private beginVisualRun(status: RefreshStatus): void {
    this.clearTimers();
    this.dismissRefreshDetails();
    this.visualRunStarted = true;
    this.visualRunId = status.runId;
    this.settledRunId = undefined;
    this.displayedSegments = 0;
    this.segmentStartedAt = performance.now();
    this.latestStatus = status;
    this.refreshRoot.classList.add('is-refresh-resetting');
    this.refreshRoot.dataset.phase = 'resetting';
    this.bars.forEach(bar => bar.classList.remove('is-filled', 'is-active'));
    void this.refreshGraphic.offsetWidth;
    this.refreshRoot.classList.remove('is-refresh-resetting');
  }

  private advanceVisualProgress(): void {
    const status = this.latestStatus;
    if (!status || status.runId !== this.visualRunId) return;
    const confirmed = status.refreshing
      ? filledRefreshSegments(status.completed, status.total).filter(Boolean).length
      : this.bars.length;

    if (this.displayedSegments >= confirmed) {
      if (!status.refreshing && this.displayedSegments === this.bars.length) this.finishVisualRun(status);
      return;
    }
    if (this.segmentTimer !== null) return;

    const elapsed = performance.now() - this.segmentStartedAt;
    const delay = Math.max(0, this.timing.segmentScanMs - elapsed);
    this.segmentTimer = window.setTimeout(() => {
      this.segmentTimer = null;
      const latest = this.latestStatus;
      if (!latest || latest.runId !== this.visualRunId) return;
      const latestConfirmed = latest.refreshing
        ? filledRefreshSegments(latest.completed, latest.total).filter(Boolean).length
        : this.bars.length;
      if (this.displayedSegments < latestConfirmed) {
        this.displayedSegments += 1;
        this.segmentStartedAt = performance.now();
      }
      if (!latest.refreshing && this.displayedSegments === this.bars.length) this.finishVisualRun(latest);
      else {
        this.renderRunning(latest);
        this.advanceVisualProgress();
      }
    }, delay);
  }

  private renderRunning(status: RefreshStatus): void {
    this.refreshRoot.dataset.phase = 'running';
    this.dismissRefreshDetails();
    this.refreshGraphic.removeAttribute('aria-hidden');
    this.refreshGraphic.setAttribute('role', 'progressbar');
    this.refreshGraphic.setAttribute('aria-valuemin', '0');
    this.refreshGraphic.setAttribute('aria-valuemax', String(status.total || 0));
    this.refreshGraphic.setAttribute('aria-valuenow', String(status.completed || 0));
    this.bars.forEach((bar, index) => {
      bar.classList.toggle('is-filled', index < this.displayedSegments);
      bar.classList.toggle('is-active', index === this.displayedSegments);
    });
    this.refreshLabel.textContent = '';
    this.refreshRoot.title = failureTitle(status);
  }

  private updateRefreshAccessibility(status: RefreshStatus): void {
    const text = refreshText(status);
    this.refreshRoot.setAttribute('aria-label', status.refreshing ? text : collapsedRefreshText(status));
    this.refreshLive.textContent = text;
  }

  private finishVisualRun(status: RefreshStatus): void {
    if (status.runId === this.settledRunId) return;
    this.settledRunId = status.runId;
    const outcome = refreshOutcome(status);
    this.refreshRoot.dataset.phase = outcome;
    this.refreshGraphic.removeAttribute('role');
    this.refreshGraphic.removeAttribute('aria-valuemin');
    this.refreshGraphic.removeAttribute('aria-valuemax');
    this.refreshGraphic.removeAttribute('aria-valuenow');
    this.refreshGraphic.setAttribute('aria-hidden', 'true');
    this.bars.forEach(bar => {
      bar.classList.add('is-filled');
      bar.classList.remove('is-active');
    });
    this.refreshLabel.textContent = collapsedRefreshText(status);
    this.refreshRoot.title = failureTitle(status);
    this.collapseTimer = window.setTimeout(() => {
      this.refreshRoot.dataset.phase = `${outcome}-collapsed`;
    }, this.timing.completeHoldMs);
  }

  private setCollapsed(text: string, phase: string): void {
    this.clearTimers();
    this.dismissRefreshDetails();
    this.visualRunStarted = false;
    this.settledRunId = undefined;
    this.latestStatus = null;
    this.refreshRoot.dataset.phase = phase;
    this.refreshLabel.textContent = text;
    this.refreshRoot.setAttribute('aria-label', text || 'Feed refresh status');
    this.refreshLive.textContent = text;
    this.bars.forEach(bar => bar.classList.remove('is-filled', 'is-active'));
  }

  private clearTimers(): void {
    if (this.collapseTimer !== null) window.clearTimeout(this.collapseTimer);
    if (this.segmentTimer !== null) window.clearTimeout(this.segmentTimer);
    this.collapseTimer = null;
    this.segmentTimer = null;
  }

  private shortcutFocusables(): HTMLElement[] {
    return [...this.shortcuts.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(element => !element.hidden);
  }

  private trapShortcutFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || this.shortcuts.hidden) return;
    const focusable = this.shortcutFocusables();
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

function refreshOutcome(status: RefreshStatus): 'complete' | 'warning' | 'failed' {
  if (status.error || (status.total > 0 && status.failed >= status.total)) return 'failed';
  return status.failed > 0 || status.failures.length > 0 ? 'warning' : 'complete';
}

function collapsedRefreshText(status: RefreshStatus): string {
  const failed = Math.max(status.failed, status.failures.length);
  if (status.error || (status.total > 0 && failed >= status.total)) return 'All feeds failed';
  if (failed > 0) return `${failed} ${failed === 1 ? 'feed' : 'feeds'} failing`;
  return 'All refreshed';
}

function refreshText(status: RefreshStatus): string {
  if (status.refreshing) {
    if (!status.total && !status.completed) return 'Starting refresh…';
    const progress = status.total > 0 ? `${status.completed}/${status.total}` : String(status.completed || 0);
    return `Checking feeds ${progress}${status.count ? ` · ${status.count} new` : ''}`;
  }
  if (status.error) return 'Refresh failed';
  const result = status.count ? `${status.count} new` : 'Up to date';
  return status.failed ? `${result} · ${status.failed} failed` : result;
}

function failureTitle(status: RefreshStatus): string {
  return status.failures.map(failure => `${failure.label}: ${failure.error}`).join('\n');
}
