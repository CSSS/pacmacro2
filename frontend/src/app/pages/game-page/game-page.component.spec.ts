import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { CredentialsService } from '../../core/credentials.service';
import { GameSocketService } from '../../core/sockets/game-socket.service';
import { GeolocationService } from '../../core/geolocation.service';
import { MapInfo, PlayerStatus, PlayerType } from '../../core/game.models';
import { WakeLockService } from '../../core/wake-lock.service';
import { GamePageComponent } from './game-page.component';
import { PlayerNameService } from '../../core/player-name.service';

describe('GamePageComponent leader link', () => {
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
    sessionExpired: signal(false),
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

  beforeEach(async () => {
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
        { provide: ApiService, useValue: { getMap: vi.fn(() => of(map)) } },
        { provide: CredentialsService, useValue: { get: () => ({ id: 'SELF' }), save: vi.fn(), clear: vi.fn() } },
        { provide: PlayerNameService, useValue: { get: vi.fn(() => ''), save: vi.fn() } },
        { provide: Router, useValue: { navigateByUrl: vi.fn() } },
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
