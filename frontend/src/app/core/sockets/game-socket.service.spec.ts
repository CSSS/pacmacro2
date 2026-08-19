import { TestBed } from '@angular/core/testing';

import { PAC_WINDOW } from '../browser-window.token';
import { GameSocketService } from './game-socket.service';
import { PlayerStatus, PlayerType } from '../game.models';

class MockGameWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: MockGameWebSocket[] = [];
  static closeSynchronously = true;

  readonly sent: unknown[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readyState = MockGameWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  protocol = '';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    MockGameWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === MockGameWebSocket.CLOSED) {
      return;
    }
    this.closeCalls.push({ code, reason });
    if (MockGameWebSocket.closeSynchronously) {
      this.serverClose(true, code ?? 1000, reason ?? '');
    }
  }

  open(): void {
    this.readyState = MockGameWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  message(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }

  serverClose(wasClean: boolean, code = wasClean ? 1000 : 1006, reason = ''): void {
    this.readyState = MockGameWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean }));
  }
}

describe('GameSocketService', () => {
  let service: GameSocketService;
  let originalWebSocket: typeof WebSocket;
  let originalOnline: PropertyDescriptor | undefined;

  beforeEach(() => {
    MockGameWebSocket.instances.length = 0;
    MockGameWebSocket.closeSynchronously = true;
    originalWebSocket = window.WebSocket;
    originalOnline = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockGameWebSocket as unknown as typeof WebSocket,
    });
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    TestBed.configureTestingModule({
      providers: [GameSocketService, { provide: PAC_WINDOW, useValue: window }],
    });
    service = TestBed.inject(GameSocketService);
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

  it('uses the player URL, invokes the callback, and sends coordinates as JSON', () => {
    const onConnected = vi.fn();
    service.start('A B/C', onConnected);
    const socket = MockGameWebSocket.instances[0];

    expect(socket.url).toBe(`ws://${window.location.host}/api/ws/A%20B%2FC`);
    expect(service.sendCoordinate({ latitude: 49.2, longitude: -123 })).toBe(false);
    socket.open();

    expect(onConnected).toHaveBeenCalledOnce();
    expect(service.state()).toBe('connected');
    expect(service.sendCoordinate({ latitude: 49.2, longitude: -123 })).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify({ latitude: 49.2, longitude: -123 })]);
  });

  it('opens the authenticated viewer URL without sending coordinates', () => {
    const onConnected = vi.fn();
    service.startViewer(onConnected);
    const socket = MockGameWebSocket.instances[0];

    expect(socket.url).toBe(`ws://${window.location.host}/api/admin/map/ws`);
    socket.open();

    expect(service.sendCoordinate({ latitude: 49.2, longitude: -123 })).toBe(false);
    expect(socket.sent).toEqual([]);
    expect(onConnected).toHaveBeenCalledOnce();
    expect(service.status()).toContain('admin map');
  });

  it('applies inform, move, state, and location-free remove commands', () => {
    service.startViewer();
    const socket = MockGameWebSocket.instances[0];
    socket.open();
    service.setInitialState({ isFlagFound: false });

    socket.message({
      coordinate: { latitude: 49.2, longitude: -123 },
      command: 'inform',
      data: JSON.stringify({
        id: 'ABCD',
        name: '<b>Test</b>',
        type: PlayerType.Ghost,
        status: PlayerStatus.Connected,
      }),
    });
    socket.message({
      coordinate: { latitude: 49.21, longitude: -123.01 },
      command: 'move',
      data: 'ABCD',
    });
    socket.message({
      coordinate: { latitude: 0, longitude: 0 },
      command: 'state',
      data: JSON.stringify({ isFlagFound: true }),
    });

    expect(service.players()['ABCD']).toEqual({
      coordinate: { latitude: 49.21, longitude: -123.01 },
      player: {
        id: 'ABCD',
        name: '<b>Test</b>',
        type: PlayerType.Ghost,
        status: PlayerStatus.Connected,
      },
    });
    expect(service.isFlagFound()).toBe(true);

    socket.message({ command: 'remove', data: 'ABCD' });
    expect(service.players()).toEqual({});
  });

  it('rejects malformed and invalid commands without partially changing state', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service.start('ABCD', () => undefined);
    const socket = MockGameWebSocket.instances[0];
    socket.open();
    service.setInitialState({ isFlagFound: true });

    socket.message('{not-json');
    socket.message({
      command: 'inform',
      data: JSON.stringify({
        id: 'MISS',
        name: 'Missing coordinate',
        type: PlayerType.Ghost,
        status: PlayerStatus.Connected,
      }),
    });
    socket.message({
      coordinate: { latitude: 49.2, longitude: -123 },
      command: 'inform',
      data: JSON.stringify({
        id: 'BAD',
        name: 'Invalid type',
        type: 99,
        status: PlayerStatus.Connected,
      }),
    });
    socket.message({
      coordinate: { latitude: 0, longitude: 0 },
      command: 'state',
      data: JSON.stringify({ isFlagFound: 'yes' }),
    });
    socket.message({ coordinate: { latitude: 0, longitude: 0 }, command: 'unknown', data: '' });

    expect(service.players()).toEqual({});
    expect(service.isFlagFound()).toBe(true);
    expect(service.status()).toContain('invalid game update');
  });

  it.each([
    ['clean', true],
    ['abnormal', false],
  ] as const)('reconnects after a %s close and clears stale locations', (_label, wasClean) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onConnected = vi.fn();
    service.startViewer(onConnected);
    const first = MockGameWebSocket.instances[0];
    first.open();
    first.message({
      coordinate: { latitude: 49.2, longitude: -123 },
      command: 'inform',
      data: JSON.stringify({
        id: 'ABCD',
        name: 'Stale',
        type: PlayerType.Ghost,
        status: PlayerStatus.Connected,
      }),
    });

    first.serverClose(wasClean);
    expect(service.status()).toContain('Admin map connection lost');
    vi.advanceTimersByTime(1000);

    expect(MockGameWebSocket.instances).toHaveLength(2);
    const second = MockGameWebSocket.instances[1];
    expect(second.url).toBe(`ws://${window.location.host}/api/admin/map/ws`);
    second.open();
    expect(service.players()).toEqual({});
    expect(onConnected).toHaveBeenCalledTimes(2);
  });

  it('suspends deliberately and resumes in the same mode', () => {
    service.startViewer();
    const first = MockGameWebSocket.instances[0];
    first.open();

    service.suspend('Paused for a test.');
    expect(service.state()).toBe('suspended');
    expect(service.status()).toBe('Paused for a test.');
    expect(first.closeCalls).toHaveLength(1);

    service.resume();
    expect(MockGameWebSocket.instances).toHaveLength(2);
    expect(MockGameWebSocket.instances[1].url).toBe(
      `ws://${window.location.host}/api/admin/map/ws`,
    );
  });

  it('stop cancels retries and ignores a late close', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    MockGameWebSocket.closeSynchronously = false;
    service.start('ABCD', () => undefined);
    const socket = MockGameWebSocket.instances[0];
    socket.open();
    const lateClose = socket.onclose;

    service.stop();
    lateClose?.(new CloseEvent('close', { code: 1006, wasClean: false }));
    vi.runAllTimers();

    expect(service.state()).toBe('idle');
    expect(service.status()).toBe('Not connected.');
    expect(MockGameWebSocket.instances).toHaveLength(1);
    expect(service.sendCoordinate({ latitude: 49.2, longitude: -123 })).toBe(false);
  });

  it('waits for the browser to return online before opening the first socket', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });

    service.start('ABCD', () => undefined);
    expect(service.state()).toBe('offline');
    expect(service.status()).toContain('Waiting for a network connection');
    expect(MockGameWebSocket.instances).toHaveLength(0);

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    expect(MockGameWebSocket.instances).toHaveLength(1);
    expect(MockGameWebSocket.instances[0].url).toBe(`ws://${window.location.host}/api/ws/ABCD`);
  });

  it('reports a viewer transport error with actionable authentication guidance', () => {
    vi.useFakeTimers();
    service.startViewer();

    MockGameWebSocket.instances[0].fail();

    expect(service.state()).toBe('error');
    expect(service.status()).toContain('Register as admin again in this browser');
  });

  it('expires the session after three consecutive failed player connections', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onSessionExpired = vi.fn();
    service.start('ABCD', () => undefined, onSessionExpired);

    MockGameWebSocket.instances[0].serverClose(false);
    vi.advanceTimersByTime(1000);
    MockGameWebSocket.instances[1].serverClose(false);
    vi.advanceTimersByTime(2000);
    MockGameWebSocket.instances[2].serverClose(false);
    vi.runAllTimers();

    expect(service.sessionExpired()).toBe(true);
    expect(service.state()).toBe('error');
    expect(service.status()).toContain('Session has expired as game server restarted.');
    expect(MockGameWebSocket.instances).toHaveLength(3);
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it('does not invoke the session-expired callback after fewer than three failures', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onSessionExpired = vi.fn();
    service.start('ABCD', () => undefined, onSessionExpired);

    MockGameWebSocket.instances[0].serverClose(false);
    vi.advanceTimersByTime(1000);
    MockGameWebSocket.instances[1].serverClose(false);
    vi.advanceTimersByTime(2000);

    expect(service.sessionExpired()).toBe(false);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('keeps reconnecting a player socket after fewer than three failures', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.start('ABCD', () => undefined);

    MockGameWebSocket.instances[0].serverClose(false);
    vi.advanceTimersByTime(1000);
    MockGameWebSocket.instances[1].serverClose(false);
    vi.advanceTimersByTime(2000);

    expect(service.sessionExpired()).toBe(false);
    expect(service.state()).toBe('connecting');
    expect(MockGameWebSocket.instances).toHaveLength(3);
  });

  it('resets the failure counter when a player connection succeeds', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.start('ABCD', () => undefined);

    MockGameWebSocket.instances[0].serverClose(false);
    vi.advanceTimersByTime(1000);
    MockGameWebSocket.instances[1].serverClose(false);
    vi.advanceTimersByTime(2000);

    MockGameWebSocket.instances[2].open();
    MockGameWebSocket.instances[2].serverClose(false);
    vi.advanceTimersByTime(4000);
    MockGameWebSocket.instances[3].serverClose(false);
    vi.runAllTimers();

    expect(service.sessionExpired()).toBe(false);
    expect(MockGameWebSocket.instances).toHaveLength(5);
  });

  it('never expires the session for a viewer socket', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.startViewer();

    MockGameWebSocket.instances[0].serverClose(false);
    vi.advanceTimersByTime(1000);
    MockGameWebSocket.instances[1].serverClose(false);
    vi.advanceTimersByTime(2000);
    MockGameWebSocket.instances[2].serverClose(false);
    vi.runAllTimers();

    expect(service.sessionExpired()).toBe(false);
    expect(MockGameWebSocket.instances.length).toBeGreaterThan(3);
  });

  it('start and stop clear an expired session', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.start('ABCD', () => undefined);

    MockGameWebSocket.instances[0].serverClose(false);
    vi.advanceTimersByTime(1000);
    MockGameWebSocket.instances[1].serverClose(false);
    vi.advanceTimersByTime(2000);
    MockGameWebSocket.instances[2].serverClose(false);
    vi.runAllTimers();

    expect(service.sessionExpired()).toBe(true);

    service.stop();
    expect(service.sessionExpired()).toBe(false);

    service.start('ABCD', () => undefined);
    expect(service.sessionExpired()).toBe(false);
    expect(MockGameWebSocket.instances).toHaveLength(4);
  });
});
