import { TestBed } from '@angular/core/testing';

import { PAC_WINDOW } from './browser-window.token';
import { GameSocketService } from './game-socket.service';

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
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: originalWebSocket });
  });

  it('uses the current origin and sends the password as the first frame', () => {
    let opened = false;
    service.start('ABCD', '1234', () => (opened = true));
    const socket = MockWebSocket.instances[0];

    expect(socket.url).toBe(`ws://${window.location.host}/api/ws/ABCD`);
    socket.open();

    expect(socket.sent).toEqual(['1234']);
    expect(opened).toBe(true);
    expect(service.state()).toBe('connected');
  });

  it('accepts inform and move messages without unsafe rendering', () => {
    service.start('ABCD', '1234', () => undefined);
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message(
      JSON.stringify({
        coordinate: { latitude: 49.2, longitude: -123 },
        command: 'inform',
        data: JSON.stringify({ id: 'ABCD', type: 0, name: '<b>Ada</b>', reps: 1 }),
      }),
    );
    socket.message(
      JSON.stringify({
        coordinate: { latitude: 49.21, longitude: -123.01 },
        command: 'move',
        data: 'ABCD',
      }),
    );

    expect(service.players()['ABCD'].player.name).toBe('<b>Ada</b>');
    expect(service.players()['ABCD'].coordinate.latitude).toBe(49.21);
  });

  it('ignores malformed server frames', () => {
    service.start('ABCD', '1234', () => undefined);
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message('{not-json');
    expect(service.players()).toEqual({});
    expect(service.status()).toContain('invalid');
  });
});
