import { TestBed } from '@angular/core/testing';

import { PAC_WINDOW } from './browser-window.token';
import { PlayerNameService } from './player-name.service';

describe('PlayerNameService', () => {
  let service: PlayerNameService;
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    const mockWindow = {
      localStorage: {
        getItem: (key: string) => mockStorage[key] ?? null,
        setItem: (key: string, value: string) => {
          mockStorage[key] = value;
        },
      },
    };

    TestBed.configureTestingModule({
      providers: [PlayerNameService, { provide: PAC_WINDOW, useValue: mockWindow }],
    });
    service = TestBed.inject(PlayerNameService);
  });

  it('returns an empty string when no name has been saved', () => {
    expect(service.get()).toBe('');
  });

  it('saves and retrieves a player name', () => {
    service.save('Odin');
    expect(service.get()).toBe('Odin');
  });

  it('returns an empty string when localStorage throws on get', () => {
    TestBed.resetTestingModule();
    const throwingWindow = {
      localStorage: {
        getItem: () => {
          throw new Error('unavailable');
        },
        setItem: () => {},
      },
    };
    TestBed.configureTestingModule({
      providers: [PlayerNameService, { provide: PAC_WINDOW, useValue: throwingWindow }],
    });
    service = TestBed.inject(PlayerNameService);
    expect(service.get()).toBe('');
  });

  it('silently ignores localStorage errors on save', () => {
    TestBed.resetTestingModule();
    const throwingWindow = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
    };
    TestBed.configureTestingModule({
      providers: [PlayerNameService, { provide: PAC_WINDOW, useValue: throwingWindow }],
    });
    service = TestBed.inject(PlayerNameService);
    expect(() => service.save('Odin')).not.toThrow();
  });

  it('returns an empty string when PAC_WINDOW is null', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [PlayerNameService, { provide: PAC_WINDOW, useValue: null }],
    });
    service = TestBed.inject(PlayerNameService);
    expect(service.get()).toBe('');
    expect(() => service.save('Odin')).not.toThrow();
  });
});
