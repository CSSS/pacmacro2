import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { Player, PlayerStatus, PlayerType, typeLabel } from '../../core/game.models';
import { LeaderSocketService } from '../../core/sockets/leader-socket.service';

@Component({
  selector: 'pac-leader-overlay',
  templateUrl: './leader-overlay.component.html',
  styleUrl: './leader-overlay.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [LeaderSocketService],
})
export class LeaderOverlayComponent {
  private readonly api = inject(ApiService);
  protected readonly socket = inject(LeaderSocketService);

  readonly active = input.required<boolean>();

  protected readonly leader = this.socket.leader;
  protected readonly players = this.socket.players;
  protected readonly isFlagFound = this.socket.isFlagFound;
  protected readonly status = signal('Loading leader controls…');
  protected readonly collapsed = signal(false);
  protected readonly playerSearch = signal('');
  protected readonly refreshing = signal(false);
  protected readonly flagSaving = signal(false);
  private readonly savingPlayerIds = signal<ReadonlySet<string>>(new Set());

  protected readonly PlayerType = PlayerType;
  protected readonly leaderHeading = computed(() => {
    const leader = this.leader();
    return leader ? `${leader.name} — ${typeLabel(leader.type)}` : 'Leader';
  });
  protected readonly isAntiPacLeader = computed(
    () => this.leader()?.type === PlayerType.AntiPacLeader,
  );
  protected readonly isFlagLeader = computed(() => this.leader()?.type === PlayerType.FlagLeader);
  protected readonly filteredPlayers = computed(() => {
    const search = this.playerSearch().trim().toLowerCase();
    return search
      ? this.players().filter((player) => player.id.toLowerCase().includes(search))
      : this.players();
  });

  constructor() {
    effect(() => {
      const active = this.active();
      untracked(() => {
        if (active) {
          void this.initialize();
        } else {
          this.socket.stop();
          this.collapsed.set(false);
        }
      });
    });
  }

  protected isConnected(player: Player): boolean {
    return player.status === PlayerStatus.Connected;
  }

  protected canAssignType(player: Player, playerType: PlayerType): boolean {
    if (!this.leader() || this.isPlayerSaving(player.id) || player.type === playerType) {
      return false;
    }
    if (playerType === PlayerType.Antipac) {
      return this.isAntiPacLeader() && player.type === PlayerType.Ghost;
    }
    return playerType === PlayerType.Ghost || playerType === PlayerType.Hidden;
  }

  protected isPlayerSaving(playerId: string): boolean {
    return this.savingPlayerIds().has(playerId);
  }

  protected searchPlayers(event: Event): void {
    this.playerSearch.set((event.target as HTMLInputElement).value);
  }

  protected async refreshState(announce = true): Promise<void> {
    if (this.refreshing()) {
      return;
    }
    this.refreshing.set(true);
    if (announce) {
      this.status.set('Refreshing leader state…');
    }
    try {
      const snapshot = await firstValueFrom(this.api.getLeaderState());
      if (!this.socket.applySnapshot(snapshot)) {
        throw new Error('Invalid leader snapshot');
      }
      this.status.set(announce ? 'Leader state refreshed.' : 'Leader controls loaded.');
    } catch (error) {
      this.status.set(this.actionError(error, 'load leader controls'));
    } finally {
      this.refreshing.set(false);
    }
  }

  protected async updateType(player: Player, playerType: PlayerType): Promise<void> {
    if (!this.canAssignType(player, playerType)) {
      return;
    }

    const previousTypes = this.applyLocalTypeSelection(player.id, playerType);
    this.setPlayerSaving(player.id, true);
    this.status.set(`Updating ${player.name} (${player.id})…`);
    try {
      await firstValueFrom(this.api.updateLeaderPlayer(player.id, playerType));
      this.status.set(`Updated ${player.name} (${player.id}).`);
    } catch (error) {
      this.restoreLocalTypes(previousTypes);
      this.status.set(this.actionError(error, `update ${player.name} (${player.id})`));
    } finally {
      this.setPlayerSaving(player.id, false);
    }
  }

  protected async toggleFlagFound(): Promise<void> {
    if (!this.isFlagLeader() || this.flagSaving()) {
      return;
    }
    const previous = this.isFlagFound();
    const next = !previous;
    this.isFlagFound.set(next);
    this.flagSaving.set(true);
    this.status.set(next ? 'Marking the flag as found…' : 'Marking the flag as not found…');
    try {
      await firstValueFrom(this.api.updateFlag(next));
      this.status.set(next ? 'The flag is marked found.' : 'The flag is marked not found.');
    } catch (error) {
      this.isFlagFound.set(previous);
      this.status.set(this.actionError(error, 'update flag state'));
    } finally {
      this.flagSaving.set(false);
    }
  }

  private async initialize(): Promise<void> {
    await this.refreshState(false);
    if (this.active()) {
      this.socket.start();
    }
  }

  private applyLocalTypeSelection(
    playerId: string,
    playerType: PlayerType,
  ): ReadonlyMap<string, PlayerType> {
    const previousTypes = new Map<string, PlayerType>();
    this.players.update((players) =>
      players.map((player) => {
        if (player.id === playerId) {
          previousTypes.set(player.id, player.type);
          return { ...player, type: playerType };
        }
        if (playerType === PlayerType.Antipac && player.type === PlayerType.Antipac) {
          previousTypes.set(player.id, player.type);
          return { ...player, type: PlayerType.Ghost };
        }
        return player;
      }),
    );
    return previousTypes;
  }

  private restoreLocalTypes(previousTypes: ReadonlyMap<string, PlayerType>): void {
    this.players.update((players) =>
      players.map((player) => {
        const previousType = previousTypes.get(player.id);
        return previousType === undefined ? player : { ...player, type: previousType };
      }),
    );
  }

  private setPlayerSaving(playerId: string, saving: boolean): void {
    this.savingPlayerIds.update((ids) => {
      const updated = new Set(ids);
      if (saving) {
        updated.add(playerId);
      } else {
        updated.delete(playerId);
      }
      return updated;
    });
  }

  private actionError(error: unknown, action: string): string {
    if (error instanceof HttpErrorResponse) {
      switch (error.status) {
        case 401:
          return `Could not ${action}: this browser no longer has a current Leader identity. Reopen the game or ask an admin to restore the role.`;
        case 403:
          return `Could not ${action}: your current Leader role does not have this capability.`;
        case 404:
          return `Could not ${action}: that player no longer exists. Refresh the player list.`;
        case 409:
          return `Could not ${action}: that player no longer has an assignable role. Refresh the player list.`;
      }
    }
    return `Could not ${action}. Check the connection and try again.`;
  }
}
