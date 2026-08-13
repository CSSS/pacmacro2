import { TestBed } from '@angular/core/testing';

import { PAC_WINDOW } from '../browser-window.token';
import { PlayerStatus, PlayerType } from '../game.models';
import { AdminSocketService } from './admin-socket.service';

class MockAdminWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: MockAdminWebSocket[] = [];

  readyState = MockAdminWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  protocol = '';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    MockAdminWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    if (this.readyState === MockAdminWebSocket.CLOSED) {
      return;
    }
    this.serverClose(true);
  }

  serverClose(wasClean: boolean, code = wasClean ? 1000 : 1006, reason = ''): void {
    this.readyState = MockAdminWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean }));
  }

  open(): void {
    this.readyState = MockAdminWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  message(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

describe('sockets/AdminSocketService', () => {
  let service: AdminSocketService;
  let socket: MockAdminWebSocket;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    MockAdminWebSocket.instances.length = 0;
    originalWebSocket = window.WebSocket;
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockAdminWebSocket as unknown as typeof WebSocket,
    });
    TestBed.configureTestingModule({
      providers: [AdminSocketService, { provide: PAC_WINDOW, useValue: window }],
    });
    service = TestBed.inject(AdminSocketService);
    service.connect();
    socket = MockAdminWebSocket.instances[0];
    socket.open();
  });

  afterEach(() => {
    service.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: originalWebSocket,
    });
  });

  it('connects to the authenticated Admin feed', () => {
    expect(socket.url).toBe(`ws://${window.location.host}/api/admin/ws`);
    expect(service.status()).toBe('Connected');
    expect(service.isReady()).toBe(false);
  });

  it('does not become ready until a valid snapshot arrives and resets readiness on close', () => {
    socket.message({
      event: 'upsert',
      player: {
        id: 'AAAA',
        name: 'Early update',
        type: PlayerType.Ghost,
        status: PlayerStatus.Connected,
      },
    });
    socket.message({ event: 'snapshot', players: [] });

    expect(service.isReady()).toBe(false);

    socket.message({ event: 'snapshot', isFlagFound: true, players: [] });
    expect(service.isReady()).toBe(true);

    socket.serverClose(false);
    expect(service.isReady()).toBe(false);
  });

  it('stops reconnecting and gives registration guidance after an authentication rejection', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    socket.serverClose(true, 1008, 'Admin authentication required');
    vi.runAllTimers();

    expect(service.isReady()).toBe(false);
    expect(service.status()).toContain('Register as admin again in this browser');
    expect(MockAdminWebSocket.instances).toHaveLength(1);
  });

  it('applies and sorts a complete snapshot including flag state', () => {
    socket.message({
      event: 'snapshot',
      isFlagFound: true,
      players: [
        {
          id: 'BBBB',
          name: 'Zed',
          type: PlayerType.Ghost,
          status: PlayerStatus.Connected,
        },
        {
          id: 'AAAA',
          name: 'Ada',
          type: PlayerType.Leader,
          status: PlayerStatus.Disconnected,
        },
      ],
    });

    expect(service.players().map((player) => player.id)).toEqual(['AAAA', 'BBBB']);
    expect(service.isFlagFound()).toBe(true);
  });

  it('inserts and replaces players from upsert events while preserving sort order', () => {
    socket.message({
      event: 'snapshot',
      isFlagFound: false,
      players: [
        {
          id: 'BBBB',
          name: 'Ben',
          type: PlayerType.Ghost,
          status: PlayerStatus.Connected,
        },
      ],
    });
    socket.message({
      event: 'upsert',
      player: {
        id: 'AAAA',
        name: 'Ada',
        type: PlayerType.Pacman,
        status: PlayerStatus.Connected,
      },
    });
    socket.message({
      event: 'upsert',
      player: {
        id: 'BBBB',
        name: 'Ben',
        type: PlayerType.Edible,
        status: PlayerStatus.Disconnected,
      },
    });

    expect(service.players().map((player) => player.id)).toEqual(['AAAA', 'BBBB']);
    expect(service.players().find((player) => player.id === 'BBBB')).toMatchObject({
      type: PlayerType.Edible,
      status: PlayerStatus.Disconnected,
    });
  });

  it('applies live flag events without changing players', () => {
    socket.message({ event: 'snapshot', isFlagFound: false, players: [] });
    socket.message({ event: 'flag', isFlagFound: true });

    expect(service.players()).toEqual([]);
    expect(service.isFlagFound()).toBe(true);
  });

  it('rejects malformed frames, unknown events, and snapshots missing flag state', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    socket.message({ event: 'snapshot', isFlagFound: true, players: [] });

    socket.message('{not-json');
    socket.message({ event: 'unknown', players: [] });
    socket.message({ event: 'snapshot', players: [] });

    expect(service.players()).toEqual([]);
    expect(service.isFlagFound()).toBe(true);
    expect(service.status()).toBe('Connected');
  });

  it('rejects invalid player records atomically', () => {
    socket.message({
      event: 'snapshot',
      isFlagFound: true,
      players: [
        {
          id: 'AAAA',
          name: 'Valid',
          type: PlayerType.Ghost,
          status: PlayerStatus.Connected,
        },
      ],
    });
    socket.message({
      event: 'snapshot',
      isFlagFound: false,
      players: [
        {
          id: 'BBBB',
          name: 'Invalid',
          type: 99,
          status: PlayerStatus.Connected,
        },
      ],
    });
    socket.message({
      event: 'upsert',
      player: {
        id: 'CCCC',
        name: 'Invalid',
        type: PlayerType.Ghost,
        status: 99,
      },
    });

    expect(service.players().map((player) => player.id)).toEqual(['AAAA']);
    expect(service.isFlagFound()).toBe(true);
  });
});
