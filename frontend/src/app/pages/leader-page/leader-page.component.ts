import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { Player, PlayerStatus, PlayerType, typeLabel } from '../../core/game.models';
import { LeaderSocketService } from '../../core/leader-socket.service';

@Component({
  selector: 'pac-leader-page',
  templateUrl: './leader-page.component.html',
  styleUrl: './leader-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [LeaderSocketService],
})
export class LeaderPageComponent {
  private readonly api = inject(ApiService);
  protected readonly socket = inject(LeaderSocketService);

  protected readonly leader = this.socket.leader;
  protected readonly players = this.socket.players;
  protected readonly isFlagFound = this.socket.isFlagFound;
  protected readonly status = signal('Loading leader controls…');
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
  protected readonly isReadOnlyLeader = computed(() => this.leader()?.type === PlayerType.Leader);

  constructor() {
    afterNextRender(() => void this.initialize());
  }

  protected isConnected(player: Player): boolean {
    return player.status === PlayerStatus.Connected;
  }

  protected isEligible(player: Player): boolean {
    return (
      this.isConnected(player) &&
      (player.type === PlayerType.Ghost ||
        player.type === PlayerType.Edible ||
        player.type === PlayerType.Antipac)
    );
  }

  protected isTypeSelected(player: Player, playerType: PlayerType): boolean {
    return playerType === PlayerType.Ghost
      ? player.type === PlayerType.Ghost || player.type === PlayerType.Edible
      : player.type === playerType;
  }

  protected isPlayerSaving(playerId: string): boolean {
    return this.savingPlayerIds().has(playerId);
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

  protected async updateType(player: Player, playerType: PlayerType, event: Event): Promise<void> {
    if (
      !this.isAntiPacLeader() ||
      !this.isEligible(player) ||
      this.isPlayerSaving(player.id) ||
      this.isTypeSelected(player, playerType) ||
      (playerType !== PlayerType.Ghost && playerType !== PlayerType.Antipac)
    ) {
      return;
    }

    const radioGroup = (event.currentTarget as HTMLInputElement).closest('.player-types');
    const previousTypes = this.applyLocalTypeSelection(player.id, playerType);
    this.setPlayerSaving(player.id, true);
    this.status.set(`Updating ${player.name} (${player.id})…`);
    try {
      await firstValueFrom(this.api.updateLeaderPlayer(player.id, playerType));
      this.status.set(`Updated ${player.name} (${player.id}).`);
    } catch (error) {
      this.restoreLocalTypes(previousTypes);
      this.restoreTypeSelection(radioGroup, previousTypes.get(player.id) ?? player.type);
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
    this.socket.start();
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

  private restoreTypeSelection(radioGroup: Element | null, playerType: PlayerType): void {
    const selectedType = playerType === PlayerType.Edible ? PlayerType.Ghost : playerType;
    for (const input of radioGroup?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ??
      []) {
      input.checked = Number(input.value) === selectedType;
    }
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
          return `Could not ${action}: that player is offline or no longer eligible. Refresh the player list.`;
      }
    }
    return `Could not ${action}. Check the connection and try again.`;
  }
}
