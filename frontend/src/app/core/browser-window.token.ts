import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { inject, InjectionToken, PLATFORM_ID } from '@angular/core';

export type PacWindow = Window & typeof globalThis;

export const PAC_WINDOW = new InjectionToken<PacWindow | null>('PacMacro browser window', {
  providedIn: 'root',
  factory: () => {
    const platformId = inject(PLATFORM_ID);
    const document = inject(DOCUMENT);
    return isPlatformBrowser(platformId) ? (document.defaultView as PacWindow | null) : null;
  },
});
