import { Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { PAC_WINDOW } from '../browser-window.token';
import { TransportState, WebSocketService } from './websocket.service';

interface TestMessage {
  value: string;
}

@Injectable()
class TestWebSocketService extends WebSocketService<TestMessage> {
  protected override CONNECT_PATH = '/api/test/ws';
  protected override SERVICE_NAME = 'TestWebSocketService';

  readonly messages: TestMessage[] = [];

  readonly transportState = this.state;

  protected override isMessageValid(message: unknown): message is TestMessage {
    return (
      !!message &&
      typeof message === 'object' &&
      typeof (message as Partial<TestMessage>).value === 'string'
    );
  }

  protected override handleMessage(message: TestMessage): void {
    this.messages.push(message);
  }
}

class MockRxWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: MockRxWebSocket[] = [];

  readonly sent: unknown[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readyState = MockRxWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  protocol = '';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    MockRxWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === MockRxWebSocket.CLOSED) {
      return;
    }
    this.closeCalls.push({ code, reason });
    this.serverClose(true, code ?? 1000, reason ?? '');
  }

  open(): void {
    this.readyState = MockRxWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  message(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  serverClose(wasClean: boolean, code = wasClean ? 1000 : 1006, reason = ''): void {
    this.readyState = MockRxWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean }));
  }
}

describe('WebSocketService', () => {
  let service: TestWebSocketService;
  let originalWebSocket: typeof WebSocket;
  let originalOnline: PropertyDescriptor | undefined;

  beforeEach(() => {
    MockRxWebSocket.instances.length = 0;
    originalWebSocket = window.WebSocket;
    originalOnline = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockRxWebSocket as unknown as typeof WebSocket,
    });
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    TestBed.configureTestingModule({
      providers: [TestWebSocketService, { provide: PAC_WINDOW, useValue: window }],
    });
    service = TestBed.inject(TestWebSocketService);
  });

  afterEach(() => {
    service?.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: originalWebSocket,
    });
    if (originalOnline) {
      Object.defineProperty(window.navigator, 'onLine', originalOnline);
    } else {
      Reflect.deleteProperty(window.navigator, 'onLine');
    }
  });

  it('connects once to the current WebSocket origin and reports lifecycle state', () => {
    expect(service.transportState()).toBe<TransportState>('idle');

    service.connect();
    service.connect();

    expect(MockRxWebSocket.instances).toHaveLength(1);
    expect(MockRxWebSocket.instances[0].url).toBe(`ws://${window.location.host}/api/test/ws`);
    expect(service.transportState()).toBe<TransportState>('connecting');

    MockRxWebSocket.instances[0].open();
    expect(service.transportState()).toBe<TransportState>('connected');
    expect(service.status()).toBe('Connected');
  });

  it('delivers valid messages and ignores malformed or invalid frames', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service.connect();
    const socket = MockRxWebSocket.instances[0];
    socket.open();

    socket.message('{not-json');
    socket.message(JSON.stringify({ unexpected: true }));
    socket.message(JSON.stringify({ value: 'accepted' }));

    expect(service.messages).toEqual([{ value: 'accepted' }]);
    expect(service.transportState()).toBe<TransportState>('connected');
  });

  it.each([
    ['abnormal', false],
    ['clean', true],
  ] as const)('reconnects after a %s close', (_label, wasClean) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.connect();
    const first = MockRxWebSocket.instances[0];
    first.open();

    first.serverClose(wasClean);
    expect(service.transportState()).toBe<TransportState>('connecting');
    vi.advanceTimersByTime(999);
    expect(MockRxWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);

    expect(MockRxWebSocket.instances).toHaveLength(2);
    MockRxWebSocket.instances[1].open();
    expect(service.transportState()).toBe<TransportState>('connected');
  });

  it('waits for the browser to return online before reconnecting', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.connect();
    const first = MockRxWebSocket.instances[0];
    first.open();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });

    first.serverClose(false);
    expect(service.transportState()).toBe<TransportState>('offline');
    vi.advanceTimersByTime(10_000);
    expect(MockRxWebSocket.instances).toHaveLength(1);

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(999);
    expect(MockRxWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockRxWebSocket.instances).toHaveLength(2);
  });

  it('cancels a pending reconnect when explicitly disconnected', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.connect();
    const first = MockRxWebSocket.instances[0];
    first.open();
    first.serverClose(false);

    service.disconnect();
    vi.runAllTimers();

    expect(service.transportState()).toBe<TransportState>('idle');
    expect(MockRxWebSocket.instances).toHaveLength(1);
  });

  it('closes the active socket when its injection context is destroyed', () => {
    service.connect();
    const socket = MockRxWebSocket.instances[0];
    socket.open();

    TestBed.resetTestingModule();

    expect(socket.readyState).toBe(MockRxWebSocket.CLOSED);
    expect(service.transportState()).toBe<TransportState>('idle');
  });

  it('waits until online before creating the first socket', () => {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: false,
    });

    service.connect();
    service.connect();

    expect(service.transportState()).toBe('offline');
    expect(MockRxWebSocket.instances).toHaveLength(0);

    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event('online'));

    expect(MockRxWebSocket.instances).toHaveLength(1);
    expect(service.transportState()).toBe('connecting');
  });

  it('disconnect cancels the initial offline online listener', () => {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    service.connect();

    service.disconnect();
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event('online'));

    expect(MockRxWebSocket.instances).toHaveLength(0);
    expect(service.transportState()).toBe<TransportState>('idle');
  });

  it('destruction cancels the initial offline online listener', () => {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    service.connect();

    TestBed.resetTestingModule();
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event('online'));

    expect(MockRxWebSocket.instances).toHaveLength(0);
    expect(service.transportState()).toBe<TransportState>('idle');
  });
});
