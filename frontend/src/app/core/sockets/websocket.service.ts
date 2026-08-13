import { computed, DestroyRef, inject, Service, signal } from '@angular/core';
import { PAC_WINDOW } from '../browser-window.token';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { EMPTY, fromEvent, Observable, Subscription, timer } from 'rxjs';
import { filter, repeat, retry, switchMap, take } from 'rxjs/operators';

export type TransportState =
  | 'idle' // Transport has not been started or `stop()` was called
  | 'connecting' // A WebSocket is being established or waiting for its `open` event
  | 'connected' // Connected and communicating
  | 'offline' // No network activity detected
  // | 'suspended' // The client has deliberately paused transport
  // | 'revoked' // For leaders that have been demoted to non-leaders
  | 'error'; // An error has occurred, the client may be attempting to reconnect

@Service({ autoProvided: false })
export abstract class WebSocketService<T> {
  static readonly RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 10000] as const;
  static readonly WEBSOCKET_OPEN = 1;
  static readonly WEBSOCKET_CLOSING = 2;
  static readonly POLICY_VIOLATION_CODE = 1008;

  status = computed(() => this.getStatus(this.state()));

  protected state = signal<TransportState>('idle');
  private socketSubject$?: WebSocketSubject<T | null>;
  private socketSubscription?: Subscription;
  private onlineSubscription?: Subscription;
  private reconnectAllowed = true;

  protected abstract CONNECT_PATH: string;
  protected abstract SERVICE_NAME: string;

  private readonly browserWindow = inject(PAC_WINDOW);
  private readonly destroyRef = inject(DestroyRef);

  protected abstract isMessageValid(msg: unknown): msg is T;

  protected abstract handleMessage(msg: T): void;

  protected onSocketOpen(): void {}

  protected onSocketClose(_closeEvent: CloseEvent): void {}

  protected onDisconnect(): void {}

  protected shouldReconnect(_closeEvent: CloseEvent): boolean {
    return true;
  }

  constructor() {
    this.destroyRef.onDestroy(() => this.disconnect());
  }

  connect(): void {
    if (!this.browserWindow || this.socketSubject$ || this.onlineSubscription) {
      return;
    }

    // This will block websocket connection attempts until the browser is online.
    if (this.browserWindow.navigator.onLine === false) {
      this.state.set('offline');

      this.onlineSubscription = fromEvent(this.browserWindow, 'online')
        .pipe(take(1))
        .subscribe(() => {
          this.onlineSubscription = undefined;
          this.connect();
        });

      return;
    }

    this.disconnect();
    this.reconnectAllowed = true;
    this.state.set('connecting');
    this.socketSubject$ = webSocket<T | null>({
      url: this.getConnectUrl(),
      WebSocketCtor: this.browserWindow.WebSocket,
      deserializer: (e: MessageEvent): T | null => {
        try {
          const data = JSON.parse(e.data);

          if (data && this.isMessageValid(data)) {
            return data as T;
          }

          throw new Error('Invalid data structure');
        } catch (error) {
          console.error(`Failed to parse message in ${this.SERVICE_NAME}:`, error);
          return null;
        }
      },
      openObserver: {
        next: () => {
          this.state.set('connected');
          this.onSocketOpen();
        },
      },
      closeObserver: {
        next: (closeEvent) => {
          console.log('WebSocket closed: ', closeEvent);
          this.onSocketClose(closeEvent);
          if (!this.shouldReconnect(closeEvent)) {
            this.reconnectAllowed = false;
            this.state.set('error');
            return;
          }
          this.state.set(!this.browserWindow?.navigator.onLine ? 'offline' : 'connecting');
        },
      },
    });

    this.socketSubscription = this.socketSubject$
      .pipe(
        // This case handles abnormal closes e.g. internet disconnect
        retry({
          resetOnSuccess: true,
          delay: (_error, retryCount) => this.reconnectDelay(retryCount),
        }),
        // This case handles clean closes e.g. server gracefully shut down
        repeat({
          delay: (repeatCount) => this.reconnectDelay(repeatCount),
        }),
        filter((msg): msg is T => msg !== null),
      )
      .subscribe({
        next: (msg) => {
          this.state.set('connected');
          this.handleMessage(msg);
        },
        error: (err) => {
          this.state.set('error');
          console.error(`WebSocket error in ${this.SERVICE_NAME}:`, err);
        },
      });
  }

  disconnect(): void {
    const subject = this.socketSubject$;
    const sub = this.socketSubscription;
    const onlineSub = this.onlineSubscription;
    this.socketSubject$ = undefined;
    this.socketSubscription = undefined;
    this.onlineSubscription = undefined;

    sub?.unsubscribe();
    onlineSub?.unsubscribe();

    if (subject && !subject.closed) {
      subject.complete();
    }
    this.state.set('idle');
    this.onDisconnect();
  }

  protected getConnectUrl(): string {
    if (this.browserWindow === null) {
      throw new Error('Browser window not available.');
    }

    const protocol = this.browserWindow.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${this.browserWindow.location.host}${this.CONNECT_PATH}`;
  }

  protected getStatus(state: TransportState): string {
    switch (state) {
      case 'idle': {
        return 'Offline';
      }
      case 'connecting': {
        return 'Connecting to websocket...';
      }
      case 'connected': {
        return 'Connected';
      }
      case 'offline': {
        return 'Offline... retrying to connect';
      }
      case 'error': {
        return 'Error with the websocket.';
      }
      default: {
        return `Unknown case ${state}`;
      }
    }
  }

  private reconnectDelay(attempt: number): Observable<number> {
    if (!this.reconnectAllowed) {
      return EMPTY;
    }

    const delayIndex = Math.min(attempt - 1, WebSocketService.RECONNECT_DELAYS.length - 1);
    const delayTime = WebSocketService.RECONNECT_DELAYS[delayIndex];
    console.warn(`Reconnect attempt ${attempt} on error:`);

    if (this.browserWindow && !this.browserWindow.navigator.onLine) {
      this.state.set('offline');
      return fromEvent(this.browserWindow, 'online').pipe(
        take(1),
        switchMap(() => timer(delayTime)),
        filter(() => this.reconnectAllowed),
      );
    }

    this.state.set('connecting');
    return timer(delayTime).pipe(filter(() => this.reconnectAllowed));
  }
}
