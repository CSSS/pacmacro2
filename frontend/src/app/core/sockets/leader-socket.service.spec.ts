import { TestBed } from '@angular/core/testing';

import { PAC_WINDOW } from '../browser-window.token';
import { LeaderState, PlayerStatus, PlayerType } from '../game.models';
import { LeaderSocketService } from './leader-socket.service';

class MockLeaderWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: MockLeaderWebSocket[] = [];
  static closeSynchronously = true;

  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readyState = MockLeaderWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  protocol = '';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    MockLeaderWebSocket.instances.push(this);
  }

  send(): void {}

  close(code?: number, reason?: string): void {
    if (this.readyState === MockLeaderWebSocket.CLOSED) {
      return;
    }
    this.closeCalls.push({ code, reason });
    if (MockLeaderWebSocket.closeSynchronously) {
      this.serverClose(true, code ?? 1000, reason ?? '');
    }
  }

  open(): void {
    this.readyState = MockLeaderWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  message(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  serverClose(wasClean: boolean, code = wasClean ? 1000 : 1006, reason = ''): void {
    this.readyState = MockLeaderWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean }));
  }
}

const leader = {
  id: 'LEAD',
  name: 'Leader',
  type: PlayerType.AntiPacLeader,
  status: PlayerStatus.Disconnected,
};

const player = {
  id: 'PLAY',
  name: 'Player',
  type: PlayerType.Ghost,
  status: PlayerStatus.Connected,
};

describe('LeaderSocketService', () => {
  let service: LeaderSocketService;
  let originalWebSocket: typeof WebSocket;
  let originalOnline: PropertyDescriptor | undefined;

  beforeEach(() => {
    MockLeaderWebSocket.instances.length = 0;
    MockLeaderWebSocket.closeSynchronously = true;
    originalWebSocket = window.WebSocket;
    originalOnline = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockLeaderWebSocket as unknown as typeof WebSocket,
    });
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    TestBed.configureTestingModule({
      providers: [LeaderSocketService, { provide: PAC_WINDOW, useValue: window }],
    });
    service = TestBed.inject(LeaderSocketService);
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: originalWebSocket });
    if (originalOnline) {
      Object.defineProperty(window.navigator, 'onLine', originalOnline);
    } else {
      Reflect.deleteProperty(window.navigator, 'onLine');
    }
  });

  it('connects to the same-origin endpoint and applies a sorted snapshot', () => {
    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    expect(socket.url).toBe(`ws://${window.location.host}/api/leader/ws`);
    socket.open();
    socket.message({
      event: 'snapshot',
      leader,
      players: [
        { ...player, id: 'ZZZZ', name: 'Zed' },
        { ...player, id: 'AAAA', name: 'Ada' },
      ],
      isFlagFound: true,
    });

    expect(service.leader()).toEqual(leader);
    expect(service.players().map((value) => value.id)).toEqual(['AAAA', 'ZZZZ']);
    expect(service.isFlagFound()).toBe(true);
    expect(service.status()).toBe('Connected to the leader feed.');
  });

  it('applies every live event while preserving sort order', () => {
    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    socket.open();
    socket.message({ event: 'snapshot', leader, players: [], isFlagFound: false });
    socket.message({
      event: 'upsert',
      player: { ...player, id: 'BBBB', name: 'Ben', type: PlayerType.Edible },
    });
    socket.message({
      event: 'upsert',
      player: { ...player, id: 'AAAA', name: 'Ada' },
    });
    socket.message({ event: 'flag', isFlagFound: true });
    socket.message({
      event: 'self',
      leader: { ...leader, type: PlayerType.FlagLeader },
    });

    expect(service.players().map((value) => value.id)).toEqual(['AAAA', 'BBBB']);
    expect(service.isFlagFound()).toBe(true);
    expect(service.leader()?.type).toBe(PlayerType.FlagLeader);

    socket.message({
      event: 'upsert',
      player: { ...player, id: 'AAAA', type: PlayerType.Leader },
    });
    socket.message({ event: 'remove', playerId: 'BBBB' });
    expect(service.players()).toEqual([]);
  });

  it('validates snapshots and updates atomically', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const initial: LeaderState = { leader, players: [player], isFlagFound: true };
    expect(service.applySnapshot(initial)).toBe(true);

    expect(
      service.applySnapshot({
        leader,
        players: [{ ...player, id: 'BAD', type: PlayerType.FlagLeader }],
        isFlagFound: false,
      }),
    ).toBe(false);
    expect(service.leader()).toEqual(leader);
    expect(service.players()).toEqual([player]);
    expect(service.isFlagFound()).toBe(true);

    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    socket.open();
    socket.message({ event: 'snapshot', ...initial });
    socket.message('{not-json');
    socket.message({
      event: 'snapshot',
      leader,
      players: [{ ...player, type: PlayerType.Leader }],
      isFlagFound: false,
    });
    socket.message({ event: 'upsert', player: { ...player, status: 99 } });
    socket.message({ event: 'self', leader: { ...leader, type: PlayerType.Ghost } });
    socket.message({ event: 'flag', isFlagFound: 'yes' });
    socket.message({ event: 'unknown' });

    expect(service.leader()).toEqual(leader);
    expect(service.players()).toEqual([player]);
    expect(service.isFlagFound()).toBe(true);
    expect(service.status()).toContain('invalid leader update');
  });

  it.each([
    ['clean', true],
    ['abnormal', false],
  ] as const)('reconnects after a %s close and clears stale state on open', (_label, wasClean) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.start();
    const first = MockLeaderWebSocket.instances[0];
    first.open();
    first.message({ event: 'snapshot', leader, players: [player], isFlagFound: true });

    first.serverClose(wasClean);
    expect(service.status()).toContain('Leader feed lost');
    vi.advanceTimersByTime(1000);
    expect(MockLeaderWebSocket.instances).toHaveLength(2);

    MockLeaderWebSocket.instances[1].open();
    expect(service.leader()).toBeNull();
    expect(service.players()).toEqual([]);
    expect(service.isFlagFound()).toBe(false);
  });

  it('waits offline before the initial connection', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });

    service.start();
    expect(service.state()).toBe('offline');
    expect(MockLeaderWebSocket.instances).toHaveLength(0);

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    expect(MockLeaderWebSocket.instances).toHaveLength(1);
  });

  it('stop cancels a pending reconnect', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    socket.open();
    socket.serverClose(false);

    service.stop();
    vi.runAllTimers();

    expect(service.state()).toBe('idle');
    expect(service.status()).toBe('Leader feed is not connected.');
    expect(MockLeaderWebSocket.instances).toHaveLength(1);
  });

  it('retries a revocation frame and reports restoration only after a valid snapshot', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    socket.open();
    socket.message({ event: 'snapshot', leader, players: [player], isFlagFound: true });
    socket.message({ event: 'revoked', reason: 'Role removed.' });

    expect(service.state()).toBe('revoked');
    expect(service.leader()).toBeNull();
    expect(service.players()).toEqual([]);
    expect(service.isFlagFound()).toBe(false);
    expect(service.status()).toContain('Waiting for the role to be restored');
    vi.advanceTimersByTime(1000);

    const restoredSocket = MockLeaderWebSocket.instances[1];
    restoredSocket.open();
    expect(service.state()).toBe('revoked');
    expect(service.status()).not.toContain('access restored');
    restoredSocket.message({
      event: 'snapshot',
      leader: { ...leader, type: PlayerType.Leader },
      players: [],
      isFlagFound: false,
    });

    expect(service.state()).toBe('connected');
    expect(service.leader()?.type).toBe(PlayerType.Leader);
    expect(service.status()).toContain('Leader access restored');
  });

  it('treats a policy close as recoverable revocation', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.start();
    const socket = MockLeaderWebSocket.instances[0];
    socket.open();

    socket.serverClose(true, 1008, 'Leader authentication required');
    expect(service.state()).toBe('revoked');
    expect(service.status()).toContain('Leader access was revoked');
    vi.advanceTimersByTime(1000);

    expect(MockLeaderWebSocket.instances).toHaveLength(2);
    MockLeaderWebSocket.instances[1].open();
    expect(service.state()).toBe('revoked');
  });
});
