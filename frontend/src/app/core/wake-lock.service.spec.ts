import { TestBed } from '@angular/core/testing';

import { PacWindow, PAC_WINDOW } from './browser-window.token';
import { WakeLockService } from './wake-lock.service';

class MockWakeLockSentinel extends EventTarget implements WakeLockSentinel {
  onrelease: ((this: WakeLockSentinel, event: Event) => unknown) | null = null;
  released = false;
  type: WakeLockType = 'screen';

  async release(): Promise<void> {
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

describe('WakeLockService', () => {
  it('reports unsupported browsers without throwing', () => {
    const fakeWindow = { navigator: {}, document: { visibilityState: 'visible' } } as PacWindow;
    TestBed.configureTestingModule({
      providers: [WakeLockService, { provide: PAC_WINDOW, useValue: fakeWindow }],
    });
    const service = TestBed.inject(WakeLockService);
    service.initialize();

    expect(service.supported()).toBe(false);
    expect(service.status()).toContain('not supported');
  });

  it('acquires and releases a user-enabled screen wake lock', async () => {
    const sentinel = new MockWakeLockSentinel();
    const fakeWindow = {
      navigator: { wakeLock: { request: async () => sentinel } },
      document: { visibilityState: 'visible' },
    } as unknown as PacWindow;
    TestBed.configureTestingModule({
      providers: [WakeLockService, { provide: PAC_WINDOW, useValue: fakeWindow }],
    });
    const service = TestBed.inject(WakeLockService);
    service.initialize();
    await service.setEnabled(true);

    expect(service.supported()).toBe(true);
    expect(service.active()).toBe(true);

    await service.setEnabled(false);
    expect(sentinel.released).toBe(true);
    expect(service.active()).toBe(false);
  });
});
