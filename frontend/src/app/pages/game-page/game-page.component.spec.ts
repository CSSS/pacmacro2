import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { CredentialsService } from '../../core/credentials.service';
import { GameSocketService } from '../../core/sockets/game-socket.service';
import { GeolocationService } from '../../core/geolocation.service';
import { MapInfo, PlayerStatus, PlayerType } from '../../core/game.models';
import { WakeLockService } from '../../core/wake-lock.service';
import { GamePageComponent } from './game-page.component';
import { PlayerNameService } from '../../core/player-name.service';

const map: MapInfo = {
  min: { latitude: 49.27, longitude: -122.92 },
  max: { latitude: 49.28, longitude: -122.9 },
  width: 32,
  height: 32,
  isFlagFound: false,
};
const api = {
  getMap: vi.fn(() => of(map)),
  registerPlayer: vi.fn(() => of({ id: 'NEWID' })),
};
const credentials = {
  get: vi.fn(() => ({ id: 'SELF' })),
  save: vi.fn(),
  clear: vi.fn(),
};
const playerName = {
  get: vi.fn(() => ''),
  save: vi.fn(),
};
const router = { navigateByUrl: vi.fn() };
const gameSocket = {
  players: signal({
    SELF: {
      coordinate: { latitude: 49.275, longitude: -122.91 },
      player: {
        id: 'SELF',
        name: 'Leader',
        type: PlayerType.Ghost,
        status: PlayerStatus.Connected,
      },
    },
  }),
  status: signal('Connected.'),
  isFlagFound: signal(false),
  sessionExpired: signal(false),
  start: vi.fn((_id: string, _onConnected: () => void) => gameSocket.sessionExpired.set(false)),
  stop: vi.fn(() => gameSocket.sessionExpired.set(false)),
  resume: vi.fn(),
  suspend: vi.fn(),
  sendCoordinate: vi.fn(),
  setInitialState: vi.fn(),
};
const geolocation = {
  status: signal('Ready.'),
  start: vi.fn(),
  stop: vi.fn(),
};
const wakeLock = {
  supported: signal(true),
  enabled: signal(false),
  status: signal('Screen wake lock is off.'),
  initialize: vi.fn(),
  setEnabled: vi.fn(async () => undefined),
  handleVisibilityChange: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
};

async function configureTestBed(): Promise<void> {
  await TestBed.configureTestingModule({
    imports: [GamePageComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: CredentialsService, useValue: credentials },
      { provide: PlayerNameService, useValue: playerName },
      { provide: Router, useValue: router },
    ],
  })
    .overrideComponent(GamePageComponent, {
      set: {
        providers: [
          { provide: GameSocketService, useValue: gameSocket },
          { provide: GeolocationService, useValue: geolocation },
          { provide: WakeLockService, useValue: wakeLock },
        ],
      },
    })
    .compileComponents();
}

describe('GamePageComponent leader link', () => {
  let fixture: ComponentFixture<GamePageComponent>;

  beforeEach(async () => {
    gameSocket.players.update((players) => ({
      ...players,
      SELF: {
        ...players.SELF,
        player: { ...players.SELF.player, type: PlayerType.Ghost },
      },
    }));

    await configureTestBed();
  });

  async function render(playerType: PlayerType): Promise<HTMLElement> {
    gameSocket.players.update((players) => ({
      ...players,
      SELF: { ...players.SELF, player: { ...players.SELF.player, type: playerType } },
    }));
    fixture = TestBed.createComponent(GamePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it.each([PlayerType.Leader, PlayerType.AntiPacLeader, PlayerType.FlagLeader])(
    'opens /leader in a new tab for leader type %s',
    async (playerType) => {
      const page = await render(playerType);
      const link = page.querySelector<HTMLAnchorElement>('.game-page__leader-link a');
      expect(link?.getAttribute('href')).toBe('/leader');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener');
    },
  );

  it('does not show the leader link to a non-leader', async () => {
    const page = await render(PlayerType.Ghost);
    const link = page.querySelector<HTMLAnchorElement>('.game-page__leader-link a');
    expect(link?.style.visibility).toBe('hidden');
  });
});

describe('GamePageComponent re-registration', () => {
  let fixture: ComponentFixture<GamePageComponent>;

  beforeEach(async () => {
    vi.clearAllMocks();
    gameSocket.sessionExpired.set(false);
    await configureTestBed();
  });

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(GamePageComponent);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  async function flushReRegistration(): Promise<void> {
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  it('clears credentials and redirects to /register when no name is saved', async () => {
    playerName.get.mockReturnValue('');
    await render();

    gameSocket.sessionExpired.set(true);
    await flushReRegistration();

    expect(credentials.clear).toHaveBeenCalled();
    expect(gameSocket.stop).toHaveBeenCalled();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/register');
  });

  it('re-registers with the saved name and reconnects', async () => {
    playerName.get.mockReturnValue('Odin');
    api.registerPlayer.mockReturnValue(of({ id: 'NEWID' }));
    const page = await render();

    gameSocket.sessionExpired.set(true);
    await flushReRegistration();

    expect(api.registerPlayer).toHaveBeenCalledWith('Odin');
    expect(credentials.save).toHaveBeenCalledWith({ id: 'NEWID' });
    expect(credentials.clear).not.toHaveBeenCalled();
    expect(page.textContent).toContain('Re-registered. Reconnecting…');

    const startCalls = gameSocket.start.mock.calls;
    const onConnected = startCalls[startCalls.length - 1][1] as () => void;
    expect(startCalls[startCalls.length - 1][0]).toBe('NEWID');
    onConnected();
    fixture.detectChanges();

    expect(geolocation.start).toHaveBeenCalledWith(expect.any(Function));
    expect(page.textContent).toContain('Connected to PacMacro.');
  });

  it('clears credentials and redirects when re-registration fails', async () => {
    playerName.get.mockReturnValue('Odin');
    api.registerPlayer.mockReturnValue(throwError(() => new Error('API is down')));
    const page = await render();

    gameSocket.sessionExpired.set(true);
    await flushReRegistration();

    expect(credentials.clear).toHaveBeenCalled();
    expect(gameSocket.stop).toHaveBeenCalled();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/register');
    expect(page.textContent).toContain('Could not re-register. Redirecting…');
  });

  it('treats an empty player ID from the API as a failure', async () => {
    playerName.get.mockReturnValue('Odin');
    api.registerPlayer.mockReturnValue(of({ id: '   ' }));
    const page = await render();

    gameSocket.sessionExpired.set(true);
    await flushReRegistration();

    expect(credentials.clear).toHaveBeenCalled();
    expect(gameSocket.stop).toHaveBeenCalled();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/register');
    expect(page.textContent).toContain('Could not re-register. Redirecting…');
  });
});
