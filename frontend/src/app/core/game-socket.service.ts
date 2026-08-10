import { inject, Service, signal } from '@angular/core';

import { PAC_WINDOW } from './browser-window.token';
import {
  Coordinate,
  GameState,
  isPlayerStatus,
  isPlayerType,
  LivePlayer,
  Player,
  SocketMessage,
} from './game.models';

export type SocketState = 'idle' | 'connecting' | 'connected' | 'offline' | 'suspended' | 'error';
type SocketMode = 'player' | 'viewer';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 10000] as const;
const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSING = 2;

@Service({ autoProvided: false })
export class GameSocketService {
  private readonly browserWindow = inject(PAC_WINDOW);
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private playerId: string | null = null;
  private mode: SocketMode | null = null;
  private active = false;
  private intentionallyClosed = false;
  private onConnected: (() => void) | null = null;

  readonly players = signal<Record<string, LivePlayer>>({});
  readonly isFlagFound = signal(false);
  readonly state = signal<SocketState>('idle');
  readonly status = signal('Not connected.');

  start(id: string, onConnected: () => void): void {
    this.stop();
    this.mode = 'player';
    this.playerId = id;
    this.onConnected = onConnected;
    this.active = true;
    this.resume();
  }

  startViewer(onConnected: () => void = () => undefined): void {
    this.stop();
    this.mode = 'viewer';
    this.onConnected = onConnected;
    this.active = true;
    this.resume();
  }

  resume(): void {
    if (!this.active || !this.mode || !this.browserWindow) {
      return;
    }
    if (this.mode === 'player' && !this.playerId) {
      return;
    }
    if (this.browserWindow.navigator.onLine === false) {
      this.state.set('offline');
      this.status.set('Offline. Waiting for a network connection…');
      return;
    }
    this.intentionallyClosed = false;
    this.connect();
  }

  suspend(reason = 'Paused while the page is hidden.'): void {
    this.intentionallyClosed = true;
    this.clearReconnectTimer();
    this.state.set('suspended');
    this.status.set(reason);
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WEB_SOCKET_CLOSING) {
      socket.close(1000, 'Client suspended');
    }
  }

  stop(): void {
    this.active = false;
    this.intentionallyClosed = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WEB_SOCKET_CLOSING) {
      socket.close(1000, 'Client stopped');
    }
    this.mode = null;
    this.playerId = null;
    this.onConnected = null;
    this.reconnectAttempt = 0;
    this.state.set('idle');
    this.status.set('Not connected.');
  }

  sendCoordinate(coordinate: Coordinate): boolean {
    if (this.mode !== 'player' || !this.socket || this.socket.readyState !== WEB_SOCKET_OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(coordinate));
    return true;
  }

  setInitialState(state: GameState): void {
    this.isFlagFound.set(state.isFlagFound);
  }

  private connect(): void {
    if (!this.browserWindow || !this.mode) {
      return;
    }
    if (this.mode === 'player' && !this.playerId) {
      return;
    }
    if (this.socket && this.socket.readyState <= WEB_SOCKET_OPEN) {
      return;
    }

    this.clearReconnectTimer();
    this.state.set('connecting');
    this.status.set(
      this.mode === 'viewer'
        ? this.reconnectAttempt
          ? 'Reconnecting to the admin map…'
          : 'Connecting to the admin map…'
        : this.reconnectAttempt
          ? 'Reconnecting to the game…'
          : 'Joining PacMacro…',
    );

    const protocol = this.browserWindow.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url =
      this.mode === 'viewer'
        ? `${protocol}//${this.browserWindow.location.host}/api/admin/map/ws`
        : `${protocol}//${this.browserWindow.location.host}/api/ws/${encodeURIComponent(this.playerId!)}`;

    let socket: WebSocket;
    try {
      socket = new this.browserWindow.WebSocket(url);
    } catch {
      this.state.set('error');
      this.status.set(
        this.mode === 'viewer'
          ? 'The admin map connection could not be created.'
          : 'The game connection could not be created.',
      );
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket || !this.active || !this.mode) {
        return;
      }
      if (this.mode === 'player' && !this.playerId) {
        return;
      }
      // A reconnect receives a fresh list of active players from the server.
      // Clear missed disconnects from a period when this connection was unavailable.
      this.players.set({});
      this.reconnectAttempt = 0;
      this.state.set('connected');
      this.status.set(this.mode === 'viewer' ? 'Connected to the admin map.' : 'Connected.');
      this.onConnected?.();
    });

    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        this.state.set('error');
        this.status.set(
          this.mode === 'viewer'
            ? 'The admin map connection was rejected. Register as admin again in this browser, then retry.'
            : 'The game connection encountered an error.',
        );
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      if (!this.intentionallyClosed && this.active) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.browserWindow || this.reconnectTimer !== null || !this.active) {
      return;
    }
    if (this.browserWindow.navigator.onLine === false) {
      this.state.set('offline');
      this.status.set('Offline. Waiting for a network connection…');
      return;
    }
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt += 1;
    this.status.set(
      this.mode === 'viewer'
        ? `Admin map connection lost. Register as admin again if the session expired. Retrying in ${delay / 1000} s…`
        : `Connection lost. Retrying in ${delay / 1000} s…`,
    );
    this.reconnectTimer = this.browserWindow.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null && this.browserWindow) {
      this.browserWindow.clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = null;
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    if (typeof event.data !== 'string') {
      return;
    }

    let message: SocketMessage;
    try {
      message = JSON.parse(event.data) as SocketMessage;
    } catch {
      this.status.set('Ignored an invalid game update.');
      return;
    }

    if (
      !message ||
      typeof message !== 'object' ||
      typeof message.command !== 'string' ||
      typeof message.data !== 'string'
    ) {
      return;
    }

    if (message.command === 'remove') {
      this.players.update((players) => {
        if (!(message.data in players)) {
          return players;
        }
        const remaining = { ...players };
        delete remaining[message.data];
        return remaining;
      });
      return;
    }

    const coordinate = message.coordinate;
    if (!isCoordinate(coordinate)) {
      return;
    }

    if (message.command === 'state') {
      let state: GameState;
      try {
        state = JSON.parse(message.data) as GameState;
      } catch {
        return;
      }
      if (typeof state?.isFlagFound === 'boolean') {
        this.isFlagFound.set(state.isFlagFound);
      }
      return;
    }

    if (message.command === 'inform') {
      let player: Player;
      try {
        player = JSON.parse(message.data) as Player;
      } catch {
        return;
      }
      if (!isPlayer(player)) {
        return;
      }
      this.players.update((players) => ({
        ...players,
        [player.id]: { coordinate, player },
      }));
      return;
    }

    if (message.command === 'move' && typeof message.data === 'string') {
      this.players.update((players) => {
        const current = players[message.data];
        if (!current) {
          return players;
        }
        return {
          ...players,
          [message.data]: { ...current, coordinate },
        };
      });
    }
  }
}

function isCoordinate(value: unknown): value is Coordinate {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const coordinate = value as Partial<Coordinate>;
  return Number.isFinite(coordinate.latitude) && Number.isFinite(coordinate.longitude);
}

function isPlayer(value: unknown): value is Player {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const player = value as Partial<Player>;
  return (
    typeof player.id === 'string' &&
    typeof player.name === 'string' &&
    isPlayerType(player.type) &&
    isPlayerStatus(player.status)
  );
}
