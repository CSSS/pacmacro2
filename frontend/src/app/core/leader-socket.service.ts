import { DestroyRef, inject, Service, signal } from '@angular/core';

import { PAC_WINDOW } from './browser-window.token';
import {
  isLeaderType,
  isPlayerStatus,
  isPlayerType,
  LeaderSocketMessage,
  LeaderState,
  Player,
} from './game.models';

export type LeaderSocketState =
  'idle' | 'connecting' | 'connected' | 'offline' | 'error' | 'revoked';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 10000] as const;
const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSING = 2;

@Service({ autoProvided: false })
export class LeaderSocketService {
  private readonly browserWindow = inject(PAC_WINDOW);
  private readonly destroyRef = inject(DestroyRef);
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private active = false;
  private intentionallyClosed = false;
  private revocationReason: string | null = null;

  readonly leader = signal<Player | null>(null);
  readonly players = signal<Player[]>([]);
  readonly isFlagFound = signal(false);
  readonly state = signal<LeaderSocketState>('idle');
  readonly status = signal('Leader feed is not connected.');

  constructor() {
    this.destroyRef.onDestroy(() => this.stop());
  }

  start(): void {
    if (!this.browserWindow || this.active) {
      return;
    }
    this.active = true;
    this.intentionallyClosed = false;
    this.connect();
  }

  stop(): void {
    this.active = false;
    this.intentionallyClosed = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WEB_SOCKET_CLOSING) {
      socket.close(1000, 'Leader page closed');
    }
    this.revocationReason = null;
    this.state.set('idle');
    this.status.set('Leader feed is not connected.');
  }

  applySnapshot(snapshot: LeaderState): boolean {
    if (
      !isPlayer(snapshot?.leader) ||
      !isLeaderType(snapshot.leader.type) ||
      !Array.isArray(snapshot.players) ||
      snapshot.players.some((player) => !isPlayer(player) || isLeaderType(player.type)) ||
      typeof snapshot.isFlagFound !== 'boolean'
    ) {
      return false;
    }
    this.leader.set(snapshot.leader);
    this.players.set(sortPlayers(snapshot.players));
    this.isFlagFound.set(snapshot.isFlagFound);
    return true;
  }

  private connect(): void {
    if (!this.browserWindow || !this.active) {
      return;
    }
    if (this.socket && this.socket.readyState <= WEB_SOCKET_OPEN) {
      return;
    }
    if (this.browserWindow.navigator.onLine === false) {
      this.state.set('offline');
      this.status.set('Offline. Waiting to reconnect to the leader feed…');
      this.scheduleReconnect();
      return;
    }

    this.clearReconnectTimer();
    this.state.set('connecting');
    this.status.set(
      this.reconnectAttempt ? 'Reconnecting to the leader feed…' : 'Connecting to leader controls…',
    );
    const protocol = this.browserWindow.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${this.browserWindow.location.host}/api/leader/ws`;

    let socket: WebSocket;
    try {
      socket = new this.browserWindow.WebSocket(url);
    } catch {
      this.state.set('error');
      this.status.set('The leader feed could not be created.');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.leader.set(null);
      this.players.set([]);
      this.isFlagFound.set(false);
      this.reconnectAttempt = 0;
      this.state.set('connected');
      this.status.set('Connected to the leader feed.');
    });
    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        this.state.set('error');
        this.status.set(
          'Could not authenticate the leader feed. Open the game with a current Leader identity, then retry.',
        );
      }
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      if (event.code === 1008) {
        this.revoke('Leader access was revoked. Ask an admin to restore your Leader role.');
        return;
      }
      if (!this.intentionallyClosed && this.active) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.browserWindow || this.reconnectTimer !== null || !this.active) {
      return;
    }
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt += 1;
    this.status.set(
      this.browserWindow.navigator.onLine === false
        ? `Offline. Retrying in ${delay / 1000} s…`
        : this.revocationReason
          ? `${this.revocationReason} Waiting for the role to be restored; retrying automatically in ${delay / 1000} s…`
          : `Leader feed lost. Retrying in ${delay / 1000} s…`,
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
    let message: LeaderSocketMessage;
    try {
      message = JSON.parse(event.data) as LeaderSocketMessage;
    } catch {
      this.status.set('Ignored an invalid leader update.');
      return;
    }

    if (message.event === 'snapshot') {
      const accessWasRevoked = this.revocationReason !== null;
      if (!this.applySnapshot(message)) {
        this.status.set('Ignored an invalid leader snapshot.');
      } else if (accessWasRevoked) {
        this.revocationReason = null;
        this.state.set('connected');
        this.status.set('Leader access restored. Connected to the leader feed.');
      }
      return;
    }
    if (message.event === 'upsert' && isPlayer(message.player)) {
      if (isLeaderType(message.player.type)) {
        this.removePlayer(message.player.id);
      } else {
        this.players.update((players) => upsertPlayer(players, message.player));
      }
      return;
    }
    if (message.event === 'remove' && typeof message.playerId === 'string') {
      this.removePlayer(message.playerId);
      return;
    }
    if (message.event === 'self' && isPlayer(message.leader) && isLeaderType(message.leader.type)) {
      this.leader.set(message.leader);
      return;
    }
    if (message.event === 'flag' && typeof message.isFlagFound === 'boolean') {
      this.isFlagFound.set(message.isFlagFound);
      return;
    }
    if (message.event === 'revoked') {
      this.revoke(
        message.reason || 'Leader access was revoked. Ask an admin to restore your Leader role.',
      );
    }
  }

  private removePlayer(playerId: string): void {
    this.players.update((players) => players.filter((player) => player.id !== playerId));
  }

  private revoke(reason: string): void {
    this.revocationReason = reason;
    this.intentionallyClosed = false;
    this.clearReconnectTimer();
    this.leader.set(null);
    this.players.set([]);
    this.state.set('revoked');
    this.status.set(`${reason} Waiting for the role to be restored…`);
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WEB_SOCKET_CLOSING) {
      socket.close(1000, 'Leader access revoked');
    }
    this.scheduleReconnect();
  }
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
