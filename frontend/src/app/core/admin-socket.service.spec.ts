import { TestBed } from '@angular/core/testing';

import { AdminSocketService } from './admin-socket.service';
import { PAC_WINDOW } from './browser-window.token';
import { PlayerStatus } from './game.models';

class MockAdminWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: MockAdminWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = MockAdminWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    MockAdminWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockAdminWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close'));
  }

  open(): void {
    this.readyState = MockAdminWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

describe('AdminSocketService', () => {
  let service: AdminSocketService;
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
  });

  afterEach(() => {
    service.stop();
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: originalWebSocket });
  });

  it('connects to the authenticated admin endpoint without sending credentials in a frame', () => {
    service.start();
    const socket = MockAdminWebSocket.instances[0];

    expect(socket.url).toBe(`ws://${window.location.host}/api/admin/ws`);
    socket.open();

    expect(socket.sent).toEqual([]);
    expect(service.state()).toBe('connected');
  });

  it('loads the initial snapshot and applies player join and disconnect updates', () => {
    service.start();
    const socket = MockAdminWebSocket.instances[0];
    socket.open();
    socket.message(
      JSON.stringify({
        event: 'snapshot',
        players: [{ id: 'BBBB', type: 0, name: 'Test', reps: 0, status: PlayerStatus.Connected }],
      }),
    );
    socket.message(
      JSON.stringify({
        event: 'upsert',
        player: { id: 'AAAA', type: 0, name: 'Test2', reps: 0, status: PlayerStatus.Connected },
      }),
    );
    socket.message(
      JSON.stringify({
        event: 'upsert',
        player: { id: 'BBBB', type: 0, name: 'Test', reps: 0, status: PlayerStatus.Disconnected },
      }),
    );

    expect(service.players().map((player) => player.id)).toEqual(['AAAA', 'BBBB']);
    expect(service.players().find((player) => player.id === 'BBBB')?.status).toBe(
      PlayerStatus.Disconnected,
    );
  });

  it('ignores malformed server frames', () => {
    service.start();
    const socket = MockAdminWebSocket.instances[0];
    socket.open();
    socket.message('{not-json');

    expect(service.players()).toEqual([]);
    expect(service.status()).toContain('invalid');
  });
});
