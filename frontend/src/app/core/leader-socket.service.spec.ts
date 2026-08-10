import { TestBed } from '@angular/core/testing';

import { PAC_WINDOW } from './browser-window.token';
import { PlayerStatus, PlayerType } from './game.models';
import { LeaderSocketService } from './leader-socket.service';

class MockLeaderWebSocket extends EventTarget {
  static readonly instances: MockLeaderWebSocket[] = [];
  readyState = 0;

  constructor(readonly url: string) {
    super();
    MockLeaderWebSocket.instances.push(this);
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code }));
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}

describe('LeaderSocketService', () => {
  let service: LeaderSocketService;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    MockLeaderWebSocket.instances.length = 0;
    originalWebSocket = window.WebSocket;
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockLeaderWebSocket as unknown as typeof WebSocket,
    });
    TestBed.configureTestingModule({
      providers: [LeaderSocketService, { provide: PAC_WINDOW, useValue: window }],
    });
    service = TestBed.inject(LeaderSocketService);
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: originalWebSocket });
  });

  it('connects to the same-origin leader endpoint and validates a snapshot', () => {
    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    expect(socket.url).toBe(`ws://${window.location.host}/api/leader/ws`);
    socket.open();
    socket.message({
      event: 'snapshot',
      leader: {
        id: 'LEAD',
        name: 'Leader',
        type: PlayerType.AntiPacLeader,
        status: PlayerStatus.Disconnected,
      },
      players: [
        {
          id: 'PLAY',
          name: 'Player',
          type: PlayerType.Ghost,
          status: PlayerStatus.Connected,
        },
      ],
      isFlagFound: true,
    });

    expect(service.leader()?.type).toBe(PlayerType.AntiPacLeader);
    expect(service.players().map((player) => player.id)).toEqual(['PLAY']);
    expect(service.isFlagFound()).toBe(true);
  });

  it('applies upsert, removal, self-role, and flag messages', () => {
    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    socket.open();
    socket.message({
      event: 'snapshot',
      leader: {
        id: 'LEAD',
        name: 'Leader',
        type: PlayerType.AntiPacLeader,
        status: PlayerStatus.Disconnected,
      },
      players: [],
      isFlagFound: false,
    });
    socket.message({
      event: 'upsert',
      player: {
        id: 'PLAY',
        name: 'Player',
        type: PlayerType.Edible,
        status: PlayerStatus.Connected,
      },
    });
    socket.message({ event: 'flag', isFlagFound: true });
    socket.message({
      event: 'self',
      leader: {
        id: 'LEAD',
        name: 'Leader',
        type: PlayerType.Leader,
        status: PlayerStatus.Disconnected,
      },
    });
    expect(service.players()).toHaveLength(1);
    expect(service.isFlagFound()).toBe(true);
    expect(service.leader()?.type).toBe(PlayerType.Leader);

    socket.message({ event: 'remove', playerId: 'PLAY' });
    expect(service.players()).toEqual([]);
  });

  it('rejects snapshots containing leaders in the player list', () => {
    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    socket.open();
    socket.message({
      event: 'snapshot',
      leader: {
        id: 'LEAD',
        name: 'Leader',
        type: PlayerType.Leader,
        status: PlayerStatus.Disconnected,
      },
      players: [
        {
          id: 'OTHER',
          name: 'Other leader',
          type: PlayerType.FlagLeader,
          status: PlayerStatus.Disconnected,
        },
      ],
      isFlagFound: false,
    });
    expect(service.leader()).toBeNull();
    expect(service.status()).toContain('invalid leader snapshot');
  });

  it('automatically reconnects and restores access after revocation', () => {
    vi.useFakeTimers();
    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    socket.open();
    socket.message({ event: 'revoked', reason: 'Role removed.' });

    expect(service.state()).toBe('revoked');
    expect(service.status()).toContain('Waiting for the role to be restored');
    vi.advanceTimersByTime(1000);
    expect(MockLeaderWebSocket.instances).toHaveLength(2);

    const restoredSocket = MockLeaderWebSocket.instances[1];
    restoredSocket.open();
    restoredSocket.message({
      event: 'snapshot',
      leader: {
        id: 'LEAD',
        name: 'Leader',
        type: PlayerType.Leader,
        status: PlayerStatus.Disconnected,
      },
      players: [],
      isFlagFound: false,
    });

    expect(service.state()).toBe('connected');
    expect(service.leader()?.type).toBe(PlayerType.Leader);
    expect(service.status()).toContain('Leader access restored');
  });

  it('reconnects and clears stale data before the fresh snapshot', () => {
    vi.useFakeTimers();
    service.start();
    const first = MockLeaderWebSocket.instances[0];
    first.open();
    service.applySnapshot({
      leader: {
        id: 'LEAD',
        name: 'Leader',
        type: PlayerType.Leader,
        status: PlayerStatus.Disconnected,
      },
      players: [],
      isFlagFound: false,
    });
    first.close();
    vi.advanceTimersByTime(1000);
    expect(MockLeaderWebSocket.instances).toHaveLength(2);
    MockLeaderWebSocket.instances[1].open();
    expect(service.leader()).toBeNull();
  });
});
