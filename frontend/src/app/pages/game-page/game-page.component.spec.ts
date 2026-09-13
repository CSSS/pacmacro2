import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
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

describe('GamePageComponent leader overlay', () => {
  let fixture: ComponentFixture<GamePageComponent>;
  const map: MapInfo = {
    min: { latitude: 49.27, longitude: -122.92 },
    max: { latitude: 49.28, longitude: -122.9 },
    width: 32,
    height: 32,
    isFlagFound: false,
  };
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
    start: vi.fn(),
    stop: vi.fn(),
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
  const api = { getMap: vi.fn(() => of(map)), verifyPlayer: vi.fn(() => of(undefined)) };
  const credentials = { get: vi.fn(() => ({ id: 'SELF' })), clear: vi.fn() };
  const router = { navigateByUrl: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    api.getMap.mockReturnValue(of(map));
    api.verifyPlayer.mockReturnValue(of(undefined));
    credentials.get.mockReturnValue({ id: 'SELF' });
    gameSocket.players.update((players) => ({
      ...players,
      SELF: {
        ...players.SELF,
        player: { ...players.SELF.player, type: PlayerType.Ghost },
      },
    }));

    await TestBed.configureTestingModule({
      imports: [GamePageComponent],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: CredentialsService, useValue: credentials },
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
    'activates the leader overlay for leader type %s',
    async (playerType) => {
      const page = await render(playerType);
      expect(page.querySelector('.game-page__layout--with-panel')).not.toBeNull();
      expect(page.querySelector('pac-leader-overlay')).not.toBeNull();
    },
  );

  it.each([
    PlayerType.Ghost,
    PlayerType.Antipac,
    PlayerType.Edible,
    PlayerType.Pacman,
    PlayerType.Hidden,
  ])('does not activate the leader overlay for non-leader type %s', async (playerType) => {
    const page = await render(playerType);
    expect(page.querySelector('.game-page__layout--with-panel')).toBeNull();
  });

  it('verifies the session before initializing the map and socket', async () => {
    await render(PlayerType.Ghost);

    expect(api.verifyPlayer).toHaveBeenCalledOnce();
    expect(wakeLock.initialize).toHaveBeenCalledOnce();
    expect(api.getMap).toHaveBeenCalledOnce();
    expect(gameSocket.setInitialState).toHaveBeenCalledWith(map);
    expect(gameSocket.start).toHaveBeenCalledWith(
      'SELF',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('clears credentials and redirects when the game socket revokes the session', async () => {
    await render(PlayerType.Ghost);
    const onSessionRevoked = gameSocket.start.mock.calls[0][2] as () => void;

    onSessionRevoked();
    await fixture.whenStable();

    expect(geolocation.stop).toHaveBeenCalled();
    expect(credentials.clear).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/register');
  });

  it('clears a rejected session and redirects without starting the game', async () => {
    api.verifyPlayer.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 401 })));
    await render(PlayerType.Ghost);

    expect(credentials.clear).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/register');
    expect(wakeLock.initialize).not.toHaveBeenCalled();
    expect(api.getMap).not.toHaveBeenCalled();
    expect(gameSocket.start).not.toHaveBeenCalled();
  });

  it('keeps credentials and shows an error for a verification API failure', async () => {
    api.verifyPlayer.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 503 })));
    const page = await render(PlayerType.Ghost);

    expect(credentials.clear).not.toHaveBeenCalled();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(page.textContent).toContain('Could not verify your player session');
    expect(wakeLock.initialize).not.toHaveBeenCalled();
    expect(api.getMap).not.toHaveBeenCalled();
    expect(gameSocket.start).not.toHaveBeenCalled();
  });
});
