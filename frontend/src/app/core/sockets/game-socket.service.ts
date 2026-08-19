import { Service, signal } from '@angular/core';

import {
  Coordinate,
  GameSocketMessage,
  GameState,
  isPlayerStatus,
  isPlayerType,
  isRecord,
  LivePlayer,
  Player,
  SocketMessage,
} from '../game.models';
import { TransportState, WebSocketService } from './websocket.service';

export type SocketState = Exclude<TransportState, 'revoked'>;
type SocketMode = 'player' | 'viewer';

@Service({ autoProvided: false })
export class GameSocketService extends WebSocketService<GameSocketMessage> {
  protected override get CONNECT_PATH(): string {
    return this.mode === 'viewer'
      ? '/api/admin/map/ws'
      : `/api/ws/${encodeURIComponent(this.playerId ?? '')}`;
  }

  protected override SERVICE_NAME = 'GameSocketService';

  private playerId: string | null = null;
  private mode: SocketMode | null = null;
  private onConnected: (() => void) | null = null;
  private reconnecting = false;
  private suspendedReason = 'Paused while the browser is offline.';
  private consecutiveFailures = 0;
  private readonly statusMessage = signal<string | null>(null);

  readonly players = signal<Record<string, LivePlayer>>({});
  readonly isFlagFound = signal(false);
  readonly sessionExpired = signal(false);
  readonly MAX_FAILED_ATTEMPTS = 3;

  start(id: string, onConnected: () => void): void {
    this.stop();
    this.mode = 'player';
    this.playerId = id;
    this.onConnected = onConnected;
    this.consecutiveFailures = 0;
    this.sessionExpired.set(false);
    this.resume();
  }

  startViewer(onConnected: () => void = () => undefined): void {
    this.stop();
    this.mode = 'viewer';
    this.onConnected = onConnected;
    this.resume();
  }

  resume(): void {
    if (!this.mode || (this.mode === 'player' && !this.playerId)) {
      return;
    }
    this.statusMessage.set(null);
    this.connect();
  }

  suspend(reason = 'Paused while the browser is offline.'): void {
    if (!this.mode) {
      return;
    }
    this.suspendedReason = reason;
    this.disconnect();
    this.state.set('suspended');
  }

  stop(): void {
    this.mode = null;
    this.playerId = null;
    this.onConnected = null;
    this.reconnecting = false;
    this.statusMessage.set(null);
    this.consecutiveFailures = 0;
    this.sessionExpired.set(false);
    this.disconnect();
  }

  sendCoordinate(coordinate: Coordinate): boolean {
    return this.mode === 'player' && isCoordinate(coordinate) && this.sendMessage(coordinate);
  }

  setInitialState(state: GameState): void {
    this.isFlagFound.set(state.isFlagFound);
  }

  protected override onSocketConnecting(reconnecting: boolean): void {
    this.reconnecting = reconnecting;
    this.statusMessage.set(null);
  }

  protected override onSocketOpen(): void {
    // Every connection receives a fresh list of active players. Clearing the
    // cache removes disconnects that may have been missed while unavailable.
    this.players.set({});
    this.reconnecting = false;
    this.statusMessage.set(null);
    this.consecutiveFailures = 0;
    this.onConnected?.();
  }

  protected override onSocketClose(): void {
    this.reconnecting = true;
  }

  protected override shouldReconnect(closeEvent: CloseEvent): boolean {
    if (this.mode !== 'player') {
      return true;
    }

    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.MAX_FAILED_ATTEMPTS) {
      this.sessionExpired.set(true);
      this.statusMessage.set(
        'Session has expired as game server restarted.',
      );
      return false; 
    }

    return true; 
  }

  protected override onSocketError(): void {
    this.statusMessage.set(
      this.mode === 'viewer'
        ? 'The admin map connection was rejected. Register as admin again in this browser, then retry.'
        : 'The game connection encountered an error.',
    );
  }

  protected override onInvalidMessage(): void {
    this.statusMessage.set('Ignored an invalid game update.');
  }

  protected override onReconnect(_attempt: number, delay: number, error?: unknown): void {
    this.reconnecting = true;
    if (!(error instanceof CloseEvent) && error !== undefined) {
      return;
    }
    this.statusMessage.set(
      this.mode === 'viewer'
        ? `Admin map connection lost. Register as admin again if the session expired. Retrying in ${delay / 1000} s…`
        : `Connection lost. Retrying in ${delay / 1000} s…`,
    );
  }

  protected override getStatus(state: TransportState): string {
    const message = this.statusMessage();
    if (message) {
      return message;
    }

    switch (state) {
      case 'idle':
        return 'Not connected.';
      case 'connecting':
        return this.mode === 'viewer'
          ? this.reconnecting
            ? 'Reconnecting to the admin map…'
            : 'Connecting to the admin map…'
          : this.reconnecting
            ? 'Reconnecting to the game…'
            : 'Joining PacMacro…';
      case 'connected':
        return this.mode === 'viewer' ? 'Connected to the admin map.' : 'Connected.';
      case 'offline':
        return 'Offline. Waiting for a network connection…';
      case 'suspended':
        return this.suspendedReason;
      case 'error':
        return this.mode === 'viewer'
          ? 'The admin map connection could not be created.'
          : 'The game connection could not be created.';
      default:
        return super.getStatus(state);
    }
  }

  protected override isMessageValid(message: unknown): message is GameSocketMessage {
    return isSocketMessage(message);
  }

  protected override handleMessage(message: GameSocketMessage): void {
    // Coordinates share the subject's outbound type but are never valid server
    // commands. Keep this narrowing explicit at the transport boundary.
    if (!isSocketMessage(message)) {
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
    if (!coordinate) {
      return;
    }

    if (message.command === 'state') {
      const state = parseJson(message.data);
      if (isRecord(state) && typeof state['isFlagFound'] === 'boolean') {
        this.isFlagFound.set(state['isFlagFound']);
      } else {
        this.onInvalidMessage();
      }
      return;
    }

    if (message.command === 'inform') {
      const player = parseJson(message.data);
      if (!isPlayer(player)) {
        this.onInvalidMessage();
        return;
      }
      this.players.update((players) => ({
        ...players,
        [player.id]: { coordinate, player },
      }));
      return;
    }

    if (message.command === 'move') {
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

function isSocketMessage(value: unknown): value is SocketMessage {
  if (!isRecord(value) || typeof value['data'] !== 'string') {
    return false;
  }

  switch (value['command']) {
    case 'remove':
      return true;
    case 'inform':
    case 'move':
    case 'state':
      return isCoordinate(value['coordinate']);
    default:
      return false;
  }
}

function isCoordinate(value: unknown): value is Coordinate {
  if (!isRecord(value)) {
    return false;
  }
  return Number.isFinite(value['latitude']) && Number.isFinite(value['longitude']);
}

function isPlayer(value: unknown): value is Player {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    isPlayerType(value['type']) &&
    isPlayerStatus(value['status'])
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
