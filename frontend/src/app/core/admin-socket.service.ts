import { DestroyRef, inject, Service, signal } from '@angular/core';

import { PAC_WINDOW } from './browser-window.token';
import { AdminSocketMessage, isPlayerStatus, isPlayerType, Player } from './game.models';

export type AdminSocketState = 'idle' | 'connecting' | 'connected' | 'offline' | 'error';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 10000] as const;
const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSING = 2;

@Service({ autoProvided: false })
export class AdminSocketService {
  private readonly browserWindow = inject(PAC_WINDOW);
  private readonly destroyRef = inject(DestroyRef);
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private active = false;
  private intentionallyClosed = false;

  readonly players = signal<Player[]>([]);
  readonly state = signal<AdminSocketState>('idle');
  readonly status = signal('Admin player feed is not connected.');

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
      socket.close(1000, 'Admin page closed');
    }
    this.state.set('idle');
    this.status.set('Admin player feed is not connected.');
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
      this.status.set('Offline. Waiting to reconnect to the admin player feed…');
      this.scheduleReconnect();
      return;
    }

    this.clearReconnectTimer();
    this.state.set('connecting');
    this.status.set(
      this.reconnectAttempt ? 'Reconnecting to the admin player feed…' : 'Connecting to players…',
    );

    const protocol = this.browserWindow.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${this.browserWindow.location.host}/api/admin/ws`;

    let socket: WebSocket;
    try {
      socket = new this.browserWindow.WebSocket(url);
    } catch {
      this.state.set('error');
      this.status.set('The admin player feed could not be created.');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.players.set([]);
      this.reconnectAttempt = 0;
      this.state.set('connected');
      this.status.set('Connected');
    });
    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        this.state.set('error');
        this.status.set('Could not authenticate or connect to the admin player feed.');
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

    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt += 1;
    if (this.browserWindow.navigator.onLine === false) {
      this.state.set('offline');
      this.status.set(`Offline. Retrying in ${delay / 1000} s…`);
    } else {
      this.status.set(`Admin player feed lost. Retrying in ${delay / 1000} s…`);
    }
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

    let message: AdminSocketMessage;
    try {
      message = JSON.parse(event.data) as AdminSocketMessage;
    } catch {
      this.status.set('Ignored an invalid admin update.');
      return;
    }

    if (message.event === 'snapshot' && Array.isArray(message.players)) {
      const players = message.players.filter(isPlayer);
      if (players.length !== message.players.length) {
        return;
      }
      this.players.set(sortPlayers(players));
      return;
    }

    if (message.event === 'upsert' && isPlayer(message.player)) {
      this.players.update((players) => {
        const existingIndex = players.findIndex((player) => player.id === message.player.id);
        const updatedPlayers = [...players];
        if (existingIndex === -1) {
          updatedPlayers.push(message.player);
        } else {
          updatedPlayers[existingIndex] = message.player;
        }
        return sortPlayers(updatedPlayers);
      });
    }
  }
}

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
