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

describe('CredentialsService', () => {
  let service: CredentialsService;
  let mockDocument: { cookie: string };
  let mockStorage: Record<string, string>;
  let mockWindow: {
    location: { protocol: string };
    localStorage: {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
    };
  };

  beforeEach(() => {
    mockDocument = { cookie: '' };
    mockStorage = {};
    mockWindow = {
      location: { protocol: 'http:' },
      localStorage: {
        getItem: (key) => mockStorage[key] ?? null,
        setItem: (key, value) => {
          mockStorage[key] = value;
        },
      },
    };

    TestBed.configureTestingModule({
      providers: [
        CredentialsService,
        { provide: DOCUMENT, useValue: mockDocument },
        { provide: PAC_WINDOW, useValue: mockWindow },
      ],
    });
    service = TestBed.inject(CredentialsService);
  });

  it.each(['http:', 'https:'] as const)('expires the id cookie over %s', (protocol) => {
    mockWindow.location.protocol = protocol;
    mockDocument.cookie = 'id=ABC; theme=dark';

    service.clear();

    const secure = protocol === 'https:' ? '; Secure' : '';
    expect(mockDocument.cookie).toBe(`id=; Path=/; SameSite=Lax${secure}; Max-Age=0`);
  });

  it('leaves the cookie untouched when PAC_WINDOW is null', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        CredentialsService,
        { provide: DOCUMENT, useValue: mockDocument },
        { provide: PAC_WINDOW, useValue: null },
      ],
    });
    service = TestBed.inject(CredentialsService);
    mockDocument.cookie = 'id=ABC';

    service.clear();

    expect(mockDocument.cookie).toBe('id=ABC');
  });

  it('saves and retrieves the player name for auto re-registration', () => {
    service.savePlayerName('Odin');

    expect(service.getPlayerName()).toBe('Odin');
  });

  it('returns an empty player name when localStorage throws on get', () => {
    TestBed.resetTestingModule();
    const throwingWindow = {
      location: { protocol: 'http:' },
      localStorage: {
        getItem: () => {
          throw new Error('unavailable');
        },
        setItem: () => undefined,
      },
    };
    TestBed.configureTestingModule({
      providers: [
        CredentialsService,
        { provide: DOCUMENT, useValue: mockDocument },
        { provide: PAC_WINDOW, useValue: throwingWindow },
      ],
    });
    service = TestBed.inject(CredentialsService);

    expect(service.getPlayerName()).toBe('');
  });

  it('silently ignores localStorage errors when saving the player name', () => {
    TestBed.resetTestingModule();
    const throwingWindow = {
      location: { protocol: 'http:' },
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
    };
    TestBed.configureTestingModule({
      providers: [
        CredentialsService,
        { provide: DOCUMENT, useValue: mockDocument },
        { provide: PAC_WINDOW, useValue: throwingWindow },
      ],
    });
    service = TestBed.inject(CredentialsService);

    expect(() => service.savePlayerName('Odin')).not.toThrow();
  });

  it('returns an empty player name and ignores saves when PAC_WINDOW is null', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        CredentialsService,
        { provide: DOCUMENT, useValue: mockDocument },
        { provide: PAC_WINDOW, useValue: null },
      ],
    });
    service = TestBed.inject(CredentialsService);

    expect(service.getPlayerName()).toBe('');
    expect(() => service.savePlayerName('Odin')).not.toThrow();
  });
});
