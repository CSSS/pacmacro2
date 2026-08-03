import { inject, Injectable, signal } from '@angular/core';

import { PAC_WINDOW } from './browser-window.token';

@Injectable()
export class WakeLockService {
  private readonly browserWindow = inject(PAC_WINDOW);
  private sentinel: WakeLockSentinel | null = null;

  readonly supported = signal(false);
  readonly enabled = signal(false);
  readonly active = signal(false);
  readonly status = signal('Screen wake lock is off.');

  initialize(): void {
    const navigator = this.browserWindow?.navigator;
    this.supported.set(Boolean(navigator?.wakeLock));
    if (!navigator?.wakeLock) {
      this.status.set('Screen wake lock is not supported by this browser.');
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled.set(enabled);
    if (enabled) {
      await this.acquire();
    } else {
      await this.release();
      this.status.set('Screen wake lock is off.');
    }
  }

  async handleVisibilityChange(): Promise<void> {
    if (this.enabled() && this.browserWindow?.document.visibilityState === 'visible') {
      await this.acquire();
    }
  }

  async release(): Promise<void> {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel && !sentinel.released) {
      await sentinel.release();
    }
    this.active.set(false);
  }

  private async acquire(): Promise<void> {
    const navigator = this.browserWindow?.navigator;
    if (!navigator?.wakeLock) {
      this.enabled.set(false);
      this.supported.set(false);
      this.status.set('Screen wake lock is not supported by this browser.');
      return;
    }
    if (this.sentinel && !this.sentinel.released) {
      return;
    }

    try {
      const sentinel = await navigator.wakeLock.request('screen');
      this.sentinel = sentinel;
      this.active.set(true);
      this.status.set('Screen wake lock is active.');
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) {
          this.sentinel = null;
        }
        this.active.set(false);
        if (this.enabled()) {
          this.status.set(
            'Screen wake lock was released; it will resume when the page is visible.',
          );
        }
      });
    } catch {
      this.active.set(false);
      this.status.set('The browser could not keep the screen awake.');
    }
  }
}
