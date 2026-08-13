import { computed, DestroyRef, inject, Service, signal } from '@angular/core';
import { PAC_WINDOW } from '../browser-window.token';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { EMPTY, fromEvent, Observable, Subscription, timer } from 'rxjs';
import { filter, repeat, retry, switchMap, take, tap } from 'rxjs/operators';

export type TransportState =
  | 'idle' // Transport has not been started or `stop()` was called
  | 'connecting' // A WebSocket is being established or waiting for its `open` event
  | 'connected' // Connected and communicating
  | 'offline' // No network activity detected
  | 'suspended' // The client has deliberately paused transport
  | 'revoked' // For leaders that have been demoted to non-leaders
  | 'error'; // An error has occurred, the client may be attempting to reconnect

@Service({ autoProvided: false })
export abstract class WebSocketService<T> {
  static readonly RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 10000] as const;
  static readonly WEBSOCKET_OPEN = 1;
  static readonly WEBSOCKET_CLOSING = 2;
  static readonly POLICY_VIOLATION_CODE = 1008;

  readonly status = computed(() => this.getStatus(this.state()));

  readonly state = signal<TransportState>('idle');
  private socketSubject$?: WebSocketSubject<T | null>;
  private socketSubscription?: Subscription;
  private onlineSubscription?: Subscription;
  private reconnectAllowed = false;
  private socketOpen = false;
  private connectionId = 0;
  private requestedReconnectState?: TransportState;

  protected abstract CONNECT_PATH: string;
  protected abstract SERVICE_NAME: string;

  private readonly browserWindow = inject(PAC_WINDOW);
  private readonly destroyRef = inject(DestroyRef);

  protected abstract isMessageValid(msg: unknown): msg is T;

  protected abstract handleMessage(msg: T): void;

  protected onSocketConnecting(_reconnecting: boolean): void {}

  protected onSocketOpen(): void {}

  protected onSocketClose(_closeEvent: CloseEvent): void {}

  protected onSocketError(_error: unknown): void {}

  protected onInvalidMessage(_message: unknown, _error: unknown): void {}

  protected onReconnect(_attempt: number, _delay: number, _error?: unknown): void {}

  protected onDisconnect(): void {}

  protected shouldReconnect(_closeEvent: CloseEvent): boolean {
    return true;
  }

  protected getConnectedState(): TransportState {
    return 'connected';
  }

  protected getReconnectState(): TransportState {
    return 'connecting';
  }

  constructor() {
    this.destroyRef.onDestroy(() => this.disconnect());
  }

  connect(): void {
    if (
      !this.browserWindow ||
      this.socketSubject$ ||
      this.socketSubscription ||
      this.onlineSubscription
    ) {
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

    const connectionId = ++this.connectionId;
    this.reconnectAllowed = true;
    this.requestedReconnectState = undefined;
    this.socketOpen = false;
    this.state.set('connecting');
    this.onSocketConnecting(false);

    const socketSubject$ = webSocket<T | null>({
      url: this.getConnectUrl(),
      WebSocketCtor: this.browserWindow.WebSocket,
      deserializer: (e: MessageEvent): T | null => {
        let data: unknown;
        try {
          data = JSON.parse(e.data);

          if (data && this.isMessageValid(data)) {
            return data;
          }

          throw new Error('Invalid data structure');
        } catch (error) {
          console.error(`Failed to parse message in ${this.SERVICE_NAME}:`, error);
          this.onInvalidMessage(data, error);
          return null;
        }
      },
      openObserver: {
        next: () => {
          if (!this.isCurrentConnection(connectionId, socketSubject$)) {
            return;
          }
          this.socketOpen = true;
          this.requestedReconnectState = undefined;
          this.state.set(this.getConnectedState());
          this.onSocketOpen();
        },
      },
      closeObserver: {
        next: (closeEvent) => {
          if (!this.isCurrentConnection(connectionId, socketSubject$)) {
            return;
          }
          this.socketOpen = false;
          console.log('WebSocket closed: ', closeEvent);
          this.onSocketClose(closeEvent);
          if (!this.shouldReconnect(closeEvent)) {
            this.reconnectAllowed = false;
            this.requestedReconnectState = undefined;
            this.state.set('error');
            return;
          }
          this.state.set(this.requestedReconnectState ?? this.stateWhileWaitingToReconnect());
        },
      },
    });
    this.socketSubject$ = socketSubject$;

    this.socketSubscription = socketSubject$
      .pipe(
        tap({
          error: (error) => {
            if (
              this.isCurrentConnection(connectionId, socketSubject$) &&
              !(error instanceof CloseEvent)
            ) {
              this.socketOpen = false;
              this.state.set('error');
              this.onSocketError(error);
            }
          },
        }),
        // This case handles abnormal closes e.g. internet disconnect
        retry({
          resetOnSuccess: true,
          delay: (error, retryCount) =>
            this.reconnectDelay(retryCount, connectionId, socketSubject$, error),
        }),
        // This case handles clean closes e.g. server gracefully shut down
        repeat({
          delay: (repeatCount) => this.reconnectDelay(repeatCount, connectionId, socketSubject$),
        }),
        filter((msg): msg is T => msg !== null),
      )
      .subscribe({
        next: (msg) => {
          if (!this.isCurrentConnection(connectionId, socketSubject$)) {
            return;
          }
          this.state.set(this.getConnectedState());
          this.handleMessage(msg);
        },
        error: (err) => {
          if (!this.isCurrentConnection(connectionId, socketSubject$)) {
            return;
          }
          this.state.set('error');
          console.error(`WebSocket error in ${this.SERVICE_NAME}:`, err);
          this.releaseConnection(connectionId, socketSubject$);
        },
        complete: () => this.releaseConnection(connectionId, socketSubject$),
      });
  }

  disconnect(): void {
    ++this.connectionId;
    this.reconnectAllowed = false;
    this.requestedReconnectState = undefined;
    this.socketOpen = false;

    const subject = this.socketSubject$;
    const sub = this.socketSubscription;
    const onlineSub = this.onlineSubscription;
    this.socketSubject$ = undefined;
    this.socketSubscription = undefined;
    this.onlineSubscription = undefined;

    sub?.unsubscribe();
    onlineSub?.unsubscribe();

    subject?.unsubscribe();
    this.state.set('idle');
    this.onDisconnect();
  }

  protected sendMessage(message: T): boolean {
    const socketSubject$ = this.socketSubject$;
    if (!this.socketOpen || !socketSubject$ || socketSubject$.closed) {
      return false;
    }

    try {
      socketSubject$.next(message);
      return true;
    } catch (error) {
      this.state.set('error');
      this.onSocketError(error);
      return false;
    }
  }

  /**
   * Closes the current socket while leaving its RxJS subscription active. The
   * normal retry/repeat pipeline will open a fresh socket after backoff.
   */
  protected reconnectWithBackoff(state: TransportState = 'connecting'): boolean {
    const socketSubject$ = this.socketSubject$;
    if (!this.socketOpen || !socketSubject$ || socketSubject$.closed) {
      return false;
    }

    this.requestedReconnectState = state;
    this.socketOpen = false;
    this.state.set(state);
    socketSubject$.complete();
    return true;
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
      case 'suspended': {
        return 'Websocket connection suspended.';
      }
      case 'revoked': {
        return 'Websocket access revoked.';
      }
      case 'error': {
        return 'Error with the websocket.';
      }
      default: {
        return `Unknown case ${state}`;
      }
    }
  }

  private reconnectDelay(
    attempt: number,
    connectionId: number,
    socketSubject$: WebSocketSubject<T | null>,
    error?: unknown,
  ): Observable<number> {
    if (!this.reconnectAllowed || !this.isCurrentConnection(connectionId, socketSubject$)) {
      return EMPTY;
    }

    const delayIndex = Math.min(attempt - 1, WebSocketService.RECONNECT_DELAYS.length - 1);
    const delayTime = WebSocketService.RECONNECT_DELAYS[delayIndex];
    console.warn(`Reconnect attempt ${attempt} on error:`);

    if (this.browserWindow && !this.browserWindow.navigator.onLine) {
      this.state.set('offline');
      this.onReconnect(attempt, delayTime, error);
      return fromEvent(this.browserWindow, 'online').pipe(
        take(1),
        switchMap(() => timer(delayTime)),
        filter(
          () => this.reconnectAllowed && this.isCurrentConnection(connectionId, socketSubject$),
        ),
        tap(() => this.beginReconnect(connectionId, socketSubject$)),
      );
    }

    if (error instanceof CloseEvent || error === undefined) {
      this.state.set(this.stateWhileWaitingToReconnect());
    }
    this.onReconnect(attempt, delayTime, error);
    return timer(delayTime).pipe(
      filter(() => this.reconnectAllowed && this.isCurrentConnection(connectionId, socketSubject$)),
      tap(() => this.beginReconnect(connectionId, socketSubject$)),
    );
  }

  private beginReconnect(connectionId: number, socketSubject$: WebSocketSubject<T | null>): void {
    if (!this.isCurrentConnection(connectionId, socketSubject$)) {
      return;
    }
    this.socketOpen = false;
    this.state.set(this.stateWhileWaitingToReconnect());
    this.onSocketConnecting(true);
  }

  private stateWhileWaitingToReconnect(): TransportState {
    if (this.browserWindow && !this.browserWindow.navigator.onLine) {
      return 'offline';
    }
    return this.requestedReconnectState ?? this.getReconnectState();
  }

  private isCurrentConnection(
    connectionId: number,
    socketSubject$: WebSocketSubject<T | null>,
  ): boolean {
    return (
      this.connectionId === connectionId &&
      this.socketSubject$ === socketSubject$ &&
      this.reconnectAllowed
    );
  }

  private releaseConnection(
    connectionId: number,
    socketSubject$: WebSocketSubject<T | null>,
  ): void {
    if (this.connectionId !== connectionId || this.socketSubject$ !== socketSubject$) {
      return;
    }
    this.reconnectAllowed = false;
    this.requestedReconnectState = undefined;
    this.socketOpen = false;
    this.socketSubject$ = undefined;
    this.socketSubscription = undefined;
  }
}
