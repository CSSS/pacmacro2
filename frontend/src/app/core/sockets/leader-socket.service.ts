import { Service, signal } from '@angular/core';

import {
  isLeaderType,
  isPlayerStatus,
  isPlayerType,
  isRecord,
  LeaderSocketMessage,
  LeaderState,
  Player,
} from '../game.models';
import { TransportState, WebSocketService } from './websocket.service';

export type LeaderSocketState = Exclude<TransportState, 'suspended'>;

@Service({ autoProvided: false })
export class LeaderSocketService extends WebSocketService<LeaderSocketMessage> {
  protected override CONNECT_PATH = '/api/leader/ws';
  protected override SERVICE_NAME = 'LeaderSocketService';

  private active = false;
  private reconnecting = false;
  private readonly revocationReason = signal<string | null>(null);
  private readonly statusMessage = signal<string | null>(null);

  readonly leader = signal<Player | null>(null);
  readonly players = signal<Player[]>([]);
  readonly isFlagFound = signal(false);

  start(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.statusMessage.set(null);
    this.connect();
  }

  stop(): void {
    this.active = false;
    this.reconnecting = false;
    this.revocationReason.set(null);
    this.statusMessage.set(null);
    this.disconnect();
  }

  applySnapshot(snapshot: LeaderState): boolean {
    if (!isLeaderSnapshot(snapshot)) {
      return false;
    }
    this.leader.set(snapshot.leader);
    this.players.set(sortPlayers(snapshot.players));
    this.isFlagFound.set(snapshot.isFlagFound);
    return true;
  }

  protected override getConnectedState(): TransportState {
    return this.revocationReason() === null ? 'connected' : 'revoked';
  }

  protected override getReconnectState(): TransportState {
    return this.revocationReason() === null ? 'connecting' : 'revoked';
  }

  protected override onSocketConnecting(reconnecting: boolean): void {
    this.reconnecting = reconnecting;
    if (this.revocationReason() === null) {
      this.statusMessage.set(null);
    }
  }

  protected override onSocketOpen(): void {
    this.leader.set(null);
    this.players.set([]);
    this.isFlagFound.set(false);
    this.reconnecting = false;
    this.statusMessage.set(null);
  }

  protected override onSocketClose(closeEvent: CloseEvent): void {
    this.reconnecting = true;
    if (closeEvent.code === WebSocketService.POLICY_VIOLATION_CODE) {
      this.recordRevocation('Leader access was revoked. Ask an admin to restore your Leader role.');
    }
  }

  protected override onSocketError(): void {
    this.statusMessage.set(
      'Could not authenticate the leader feed. Open the game with a current Leader identity, then retry.',
    );
  }

  protected override onInvalidMessage(message: unknown): void {
    this.statusMessage.set(
      isRecord(message) && message['event'] === 'snapshot'
        ? 'Ignored an invalid leader snapshot.'
        : 'Ignored an invalid leader update.',
    );
  }

  protected override onReconnect(_attempt: number, delay: number, error?: unknown): void {
    this.reconnecting = true;
    if (!(error instanceof CloseEvent) && error !== undefined) {
      return;
    }
    const reason = this.revocationReason();
    this.statusMessage.set(
      reason
        ? `${reason} Waiting for the role to be restored; retrying automatically in ${delay / 1000} s…`
        : this.state() === 'offline'
          ? `Offline. Retrying in ${delay / 1000} s…`
          : `Leader feed lost. Retrying in ${delay / 1000} s…`,
    );
  }

  protected override getStatus(state: TransportState): string {
    const message = this.statusMessage();
    if (message) {
      return message;
    }

    switch (state) {
      case 'idle':
        return 'Leader feed is not connected.';
      case 'connecting':
        return this.reconnecting
          ? 'Reconnecting to the leader feed…'
          : 'Connecting to leader controls…';
      case 'connected':
        return 'Connected to the leader feed.';
      case 'offline':
        return 'Offline. Waiting to reconnect to the leader feed…';
      case 'revoked': {
        const reason =
          this.revocationReason() ??
          'Leader access was revoked. Ask an admin to restore your Leader role.';
        return `${reason} Waiting for the role to be restored…`;
      }
      case 'error':
        return 'The leader feed could not be created.';
      default:
        return super.getStatus(state);
    }
  }

  protected override isMessageValid(message: unknown): message is LeaderSocketMessage {
    if (!isRecord(message)) {
      return false;
    }

    switch (message['event']) {
      case 'snapshot':
        return isLeaderSnapshot(message);
      case 'upsert':
        return isPlayer(message['player']);
      case 'remove':
        return typeof message['playerId'] === 'string';
      case 'self':
        return isPlayer(message['leader']) && isLeaderType(message['leader'].type);
      case 'flag':
        return typeof message['isFlagFound'] === 'boolean';
      case 'revoked':
        return message['reason'] === undefined || typeof message['reason'] === 'string';
      default:
        return false;
    }
  }

  protected override handleMessage(message: LeaderSocketMessage): void {
    switch (message.event) {
      case 'snapshot': {
        const accessWasRevoked = this.revocationReason() !== null;
        this.applySnapshot(message);
        if (accessWasRevoked) {
          this.revocationReason.set(null);
          this.state.set('connected');
          this.statusMessage.set('Leader access restored. Connected to the leader feed.');
        }
        return;
      }
      case 'upsert':
        if (isLeaderType(message.player.type)) {
          this.removePlayer(message.player.id);
        } else {
          this.players.update((players) => upsertPlayer(players, message.player));
        }
        return;
      case 'remove':
        this.removePlayer(message.playerId);
        return;
      case 'self':
        this.leader.set(message.leader);
        return;
      case 'flag':
        this.isFlagFound.set(message.isFlagFound);
        return;
      case 'revoked':
        this.revoke(
          message.reason || 'Leader access was revoked. Ask an admin to restore your Leader role.',
        );
        return;
      default:
      // The inbound type guard rejects unknown events.
    }
  }

  private removePlayer(playerId: string): void {
    this.players.update((players) => players.filter((player) => player.id !== playerId));
  }

  private recordRevocation(reason: string): void {
    this.revocationReason.set(reason);
    this.statusMessage.set(null);
    this.leader.set(null);
    this.players.set([]);
    this.isFlagFound.set(false);
    this.state.set('revoked');
  }

  private revoke(reason: string): void {
    this.recordRevocation(reason);
    this.reconnectWithBackoff('revoked');
  }
}

function isLeaderSnapshot(value: unknown): value is LeaderState {
  if (!isRecord(value)) {
    return false;
  }
  const leader = value['leader'];
  const players = value['players'];
  return (
    isPlayer(leader) &&
    isLeaderType(leader.type) &&
    Array.isArray(players) &&
    players.every((player) => isPlayer(player) && !isLeaderType(player.type)) &&
    typeof value['isFlagFound'] === 'boolean'
  );
}

function sortPlayers(players: Player[]): Player[] {
  return [...players].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

function upsertPlayer(players: Player[], player: Player): Player[] {
  const index = players.findIndex((current) => current.id === player.id);
  const updated = [...players];
  if (index === -1) {
    updated.push(player);
  } else {
    updated[index] = player;
  }
  return sortPlayers(updated);
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
