import { TestBed } from '@angular/core/testing';

import { PAC_WINDOW } from './browser-window.token';
import { GameSocketService } from './game-socket.service';
import { PlayerType } from './game.models';

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: MockWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = MockWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close'));
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

describe('GameSocketService', () => {
  let service: GameSocketService;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    originalWebSocket = window.WebSocket;
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockWebSocket as unknown as typeof WebSocket,
    });
    TestBed.configureTestingModule({
      providers: [GameSocketService, { provide: PAC_WINDOW, useValue: window }],
    });
    service = TestBed.inject(GameSocketService);
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: originalWebSocket });
  });

  it('uses the current origin without sending an authentication frame', () => {
    let opened = false;
    service.start('ABCD', () => (opened = true));
    const socket = MockWebSocket.instances[0];

    expect(socket.url).toBe(`ws://${window.location.host}/api/ws/ABCD`);
    socket.open();

    expect(socket.sent).toEqual([]);
    expect(opened).toBe(true);
    expect(service.state()).toBe('connected');
  });

  it('stays active while the game tab is hidden', () => {
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    try {
      service.start('ABCD', () => undefined);

      expect(MockWebSocket.instances).toHaveLength(1);
      MockWebSocket.instances[0].open();
      expect(service.state()).toBe('connected');
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityState);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    }
  });

  it('opens the authenticated viewer URL without sending coordinates', () => {
    let opened = false;
    service.startViewer(() => (opened = true));
    const socket = MockWebSocket.instances[0];

    expect(socket.url).toBe(`ws://${window.location.host}/api/admin/map/ws`);
    socket.open();

    expect(service.sendCoordinate({ latitude: 49.2, longitude: -123 })).toBe(false);
    expect(socket.sent).toEqual([]);
    expect(opened).toBe(true);
    expect(service.status()).toContain('admin map');
  });

  it('handles normal game updates in viewer mode', () => {
    service.startViewer();
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message(
      JSON.stringify({
        coordinate: { latitude: 49.2, longitude: -123 },
        command: 'inform',
        data: JSON.stringify({
          id: 'ABCD',
          name: 'Test',
          type: PlayerType.Ghost,
          status: 2,
        }),
      }),
    );
    socket.message(
      JSON.stringify({
        coordinate: { latitude: 49.21, longitude: -123.01 },
        command: 'move',
        data: 'ABCD',
      }),
    );

    expect(service.players()['ABCD'].coordinate).toEqual({
      latitude: 49.21,
      longitude: -123.01,
    });
  });

  it('validates and applies shared flag-state messages', () => {
    service.start('ABCD', () => undefined);
    const socket = MockWebSocket.instances[0];
    socket.open();
    service.setInitialState({ isFlagFound: false });
    socket.message(
      JSON.stringify({
        coordinate: { latitude: 0, longitude: 0 },
        command: 'state',
        data: JSON.stringify({ isFlagFound: true }),
      }),
    );
    expect(service.isFlagFound()).toBe(true);

    socket.message(
      JSON.stringify({
        coordinate: { latitude: 0, longitude: 0 },
        command: 'state',
        data: JSON.stringify({ isFlagFound: 'yes' }),
      }),
    );
    expect(service.isFlagFound()).toBe(true);
  });

  it('reconnects the viewer and requests a fresh snapshot after a disconnect', () => {
    vi.useFakeTimers();
    service.startViewer();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    firstSocket.message(
      JSON.stringify({
        coordinate: { latitude: 49.2, longitude: -123 },
        command: 'inform',
        data: JSON.stringify({
          id: 'ABCD',
          name: 'Test',
          type: PlayerType.Ghost,
          status: 2,
        }),
      }),
    );

    firstSocket.close();
    expect(service.status()).toContain('Admin map connection lost');
    vi.advanceTimersByTime(1000);

    expect(MockWebSocket.instances).toHaveLength(2);
    const secondSocket = MockWebSocket.instances[1];
    expect(secondSocket.url).toBe(`ws://${window.location.host}/api/admin/map/ws`);
    secondSocket.open();
    expect(service.players()).toEqual({});
  });

  it('gives actionable authentication guidance when the viewer is rejected', () => {
    service.startViewer();
    MockWebSocket.instances[0].fail();

    expect(service.state()).toBe('error');
    expect(service.status()).toContain('Register as admin again in this browser');
  });

  it('accepts inform and move messages without unsafe rendering', () => {
    service.start('ABCD', () => undefined);
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message(
      JSON.stringify({
        coordinate: { latitude: 49.2, longitude: -123 },
        command: 'inform',
        data: JSON.stringify({
          id: 'ABCD',
          name: '<b>Test</b>',
          type: PlayerType.Pacman,
          status: 2,
        }),
      }),
    );
    socket.message(
      JSON.stringify({
        coordinate: { latitude: 49.21, longitude: -123.01 },
        command: 'move',
        data: 'ABCD',
      }),
    );

    expect(service.players()['ABCD'].player.name).toBe('<b>Test</b>');
    expect(service.players()['ABCD'].coordinate.latitude).toBe(49.21);
  });

  it('removes cached players with a location-free remove message', () => {
    service.start('ABCD', () => undefined);
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message(
      JSON.stringify({
        coordinate: { latitude: 49.2, longitude: -123 },
        command: 'inform',
        data: JSON.stringify({
          id: 'EF01',
          name: 'Private player',
          type: PlayerType.Ghost,
          status: 2,
        }),
      }),
    );

    socket.message(JSON.stringify({ command: 'remove', data: 'EF01' }));

    expect(service.players()).toEqual({});
  });

  it('still requires coordinates for commands other than remove', () => {
    service.start('ABCD', () => undefined);
    const socket = MockWebSocket.instances[0];
    socket.open();

    socket.message(
      JSON.stringify({
        command: 'inform',
        data: JSON.stringify({
          id: 'EF01',
          name: 'Missing location',
          type: PlayerType.Ghost,
          status: 2,
        }),
      }),
    );

    expect(service.players()).toEqual({});
  });

  it('ignores malformed server frames', () => {
    service.start('ABCD', () => undefined);
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message('{not-json');
    expect(service.players()).toEqual({});
    expect(service.status()).toContain('invalid');
  });

  it('rejects inform messages containing an invalid player type', () => {
    service.start('ABCD', () => undefined);
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message(
      JSON.stringify({
        coordinate: { latitude: 49.2, longitude: -123 },
        command: 'inform',
        data: JSON.stringify({ id: 'ABCD', name: 'Test', type: 99, status: 2 }),
      }),
    );

    expect(service.players()).toEqual({});
  });
});
