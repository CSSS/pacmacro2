import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import { PAC_WINDOW } from './browser-window.token';
import { CredentialsService, readCookie } from './credentials.service';

describe('readCookie', () => {
  it('reads and decodes an exact cookie name', () => {
    expect(readCookie('theme=dark; id=AB%20CD; userid=wrong', 'id')).toBe('AB CD');
  });

  it('returns an empty string for missing or malformed values', () => {
    expect(readCookie('id=%E0%A4%A', 'id')).toBe('');
    expect(readCookie('theme=dark', 'id')).toBe('');
  });
});

describe('CredentialsService.clear', () => {
  function createService(protocol: string | null): { service: CredentialsService; state: { cookie: string } } {
    const state = { cookie: 'theme=dark; id=PLAYER' };
    const document = {
      get cookie(): string {
        return state.cookie;
      },
      set cookie(value: string) {
        state.cookie = value;
      },
    } as Document;
    TestBed.configureTestingModule({
      providers: [
        CredentialsService,
        { provide: DOCUMENT, useValue: document },
        { provide: PAC_WINDOW, useValue: protocol ? { location: { protocol } } : null },
      ],
    });
    return { service: TestBed.inject(CredentialsService), state };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('expires only the readable player cookie over HTTP', () => {
    const result = createService('http:');
    result.service.clear();
    expect(result.state.cookie).toBe('id=; Max-Age=0; Path=/; SameSite=Lax');
  });

  it('uses matching HTTPS cookie attributes when clearing', () => {
    const result = createService('https:');
    result.service.clear();
    expect(result.state.cookie).toBe('id=; Max-Age=0; Path=/; SameSite=Lax; Secure');
  });

  it('does nothing during server-side rendering', () => {
    const result = createService(null);
    result.service.clear();
    expect(result.state.cookie).toBe('theme=dark; id=PLAYER');
  });
});
