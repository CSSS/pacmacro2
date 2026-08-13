import { Service, signal } from '@angular/core';
import { TransportState, WebSocketService } from './websocket.service';
import { AdminSocketMessage, isPlayerStatus, isPlayerType, isRecord, Player } from '../game.models';

function sortPlayers(players: Player[]): Player[] {
  return [...players].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
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

/**
 * Service the admin uses to connect to the server and listen to player updates.
 */
@Service({ autoProvided: false })
export class AdminSocketService extends WebSocketService<AdminSocketMessage> {
  protected override CONNECT_PATH = '/api/admin/ws';
  protected override SERVICE_NAME = 'AdminSocketService';

  readonly players = signal<Player[]>([]);
  readonly isFlagFound = signal(false);
  readonly ready = signal(false);

  protected override onSocketOpen(): void {
    this.ready.set(false);
  }

  protected override onSocketClose(): void {
    this.ready.set(false);
  }

  protected override onDisconnect(): void {
    this.ready.set(false);
  }

  protected override shouldReconnect(closeEvent: CloseEvent): boolean {
    return closeEvent.code !== WebSocketService.POLICY_VIOLATION_CODE;
  }

  protected override getStatus(state: TransportState): string {
    return state === 'error'
      ? 'Admin player feed rejected. Register as admin again in this browser.'
      : super.getStatus(state);
  }

  protected override isMessageValid(msg: unknown): msg is AdminSocketMessage {
    if (!isRecord(msg)) {
      return false;
    }

    switch (msg['event']) {
      case 'snapshot': {
        return (
          Array.isArray(msg['players']) &&
          msg['players'].every(isPlayer) &&
          typeof msg['isFlagFound'] === 'boolean'
        );
      }
      case 'upsert': {
        return isPlayer(msg['player']);
      }
      case 'flag': {
        return typeof msg['isFlagFound'] === 'boolean';
      }
      default: {
        return false;
      }
    }
  }

  protected override handleMessage(msg: AdminSocketMessage): void {
    switch (msg.event) {
      case 'snapshot': {
        this.players.set(sortPlayers(msg.players));
        this.isFlagFound.set(msg.isFlagFound);
        this.ready.set(true);
        return;
      }
      case 'upsert': {
        this.players.update((players) => {
          const existingIndex = players.findIndex((player) => player.id === msg.player.id);
          const updatedPlayers = [...players];
          if (existingIndex === -1) {
            updatedPlayers.push(msg.player);
          } else {
            updatedPlayers[existingIndex] = msg.player;
          }
          return sortPlayers(updatedPlayers);
        });
        return;
      }
      case 'flag': {
        this.isFlagFound.set(msg.isFlagFound);
        return;
      }
      default:
      // We should never reach this due to the typeguard.
    }
  }
}
