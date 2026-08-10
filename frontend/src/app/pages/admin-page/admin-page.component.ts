import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AdminSocketService } from '../../core/admin-socket.service';
import { ApiService } from '../../core/api.service';
import {
  isLeaderType,
  PLAYER_TYPES,
  Player,
  PlayerStatus,
  PlayerType,
} from '../../core/game.models';

@Component({
  selector: 'pac-admin-page',
  templateUrl: './admin-page.component.html',
  styleUrl: './admin-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [AdminSocketService],
})
export class AdminPageComponent {
  private readonly api = inject(ApiService);
  private readonly adminSocket = inject(AdminSocketService);

  protected readonly players = this.adminSocket.players;
  protected readonly connectionStatus = this.adminSocket.status;
  protected readonly status = signal('');
  protected readonly loadingPlayers = signal(false);
  protected readonly bulkUpdating = signal(false);
  protected readonly playerTypes = PLAYER_TYPES;
  protected readonly PlayerType = PlayerType;
  private readonly savingPlayerIds = signal<ReadonlySet<string>>(new Set());
  protected readonly updatesInProgress = computed(
    () => this.bulkUpdating() || this.savingPlayerIds().size > 0,
  );
  protected readonly hasConnectedGhosts = computed(() =>
    this.players().some((player) => this.isConnected(player) && player.type === PlayerType.Ghost),
  );

  constructor() {
    afterNextRender(() => this.adminSocket.start());
  }

  protected isConnected(player: Player): boolean {
    return player.status === PlayerStatus.Connected;
  }

  protected async refreshPlayers(): Promise<void> {
    this.loadingPlayers.set(true);
    this.status.set('Fetching the current player list…');
    try {
      const players = await firstValueFrom(this.api.getPlayers());
      this.players.set(players.map((player) => ({ ...player })));
      this.status.set(`Fetched ${players.length} player${players.length === 1 ? '' : 's'}.`);
    } catch {
      this.status.set('Could not fetch the current player list.');
    } finally {
      this.loadingPlayers.set(false);
    }
  }

  protected isTypeSelected(player: Player, playerType: PlayerType): boolean {
    return playerType === PlayerType.Ghost
      ? player.type === PlayerType.Ghost || player.type === PlayerType.Edible
      : player.type === playerType;
  }

  protected isPlayerControlDisabled(player: Player): boolean {
    return (
      !this.isConnected(player) || this.bulkUpdating() || this.savingPlayerIds().has(player.id)
    );
  }

  protected async updateType(player: Player, playerType: PlayerType, event: Event): Promise<void> {
    if (this.isPlayerControlDisabled(player) || this.isTypeSelected(player, playerType)) {
      return;
    }

    const radioGroup = (event.currentTarget as HTMLInputElement).closest('.player-types');
    this.status.set(`Updating ${player.id}…`);
    this.setPlayerSaving(player.id, true);
    const previousTypes = this.applyLocalTypeSelection(player.id, playerType);
    try {
      await firstValueFrom(this.api.updatePlayer(player.id, playerType));
      this.status.set(`Updated ${player.name} (${player.id}).`);
    } catch {
      this.restoreLocalTypes(previousTypes);
      this.restoreTypeSelection(radioGroup, previousTypes.get(player.id) ?? player.type);
      this.status.set(
        `Could not update ${player.name} (${player.id}). Register as admin in this browser first.`,
      );
    } finally {
      this.setPlayerSaving(player.id, false);
    }
  }

  protected async makeGhostsEdible(): Promise<void> {
    await this.bulkUpdate(
      (player) => this.isConnected(player) && player.type === PlayerType.Ghost,
      PlayerType.Edible,
      'connected Ghosts',
    );
  }

  protected async resetGame(): Promise<void> {
    if (this.updatesInProgress()) {
      return;
    }
    this.bulkUpdating.set(true);
    this.status.set('Resetting the game…');
    try {
      await firstValueFrom(this.api.resetGame());
      this.players.update((players) =>
        players.map((player) =>
          isLeaderType(player.type) ? player : { ...player, type: PlayerType.Ghost },
        ),
      );
      this.status.set('Reset the game successfully.');
    } catch {
      this.status.set('Could not reset the game. Register as admin in this browser first.');
    } finally {
      this.bulkUpdating.set(false);
    }
  }

  private async bulkUpdate(
    predicate: (player: Player) => boolean,
    playerType: PlayerType,
    targetDescription: string,
  ): Promise<void> {
    if (this.updatesInProgress()) {
      return;
    }
    const targets = this.players().filter(predicate);
    if (!targets.length) {
      this.status.set(`No ${targetDescription} need updating.`);
      return;
    }

    this.bulkUpdating.set(true);
    this.status.set(`Updating ${targets.length} players…`);
    try {
      const results = await Promise.allSettled(
        targets.map((player) => firstValueFrom(this.api.updatePlayer(player.id, playerType))),
      );
      const succeededIds = new Set(
        targets
          .filter((_, index) => results[index].status === 'fulfilled')
          .map((player) => player.id),
      );
      this.updateLocalTypes(succeededIds, playerType);
      const failed = targets.length - succeededIds.size;
      this.status.set(
        failed
          ? `Updated ${succeededIds.size} of ${targets.length} players; ${failed} failed. Register as admin again if the session expired.`
          : `Updated ${targets.length} players successfully.`,
      );
    } finally {
      this.bulkUpdating.set(false);
    }
  }

  private setPlayerSaving(playerId: string, saving: boolean): void {
    this.savingPlayerIds.update((playerIds) => {
      const updated = new Set(playerIds);
      if (saving) {
        updated.add(playerId);
      } else {
        updated.delete(playerId);
      }
      return updated;
    });
  }

  private updateLocalTypes(playerIds: ReadonlySet<string>, playerType: PlayerType): void {
    this.players.update((players) =>
      players.map((player) =>
        playerIds.has(player.id) ? { ...player, type: playerType } : player,
      ),
    );
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
        if (this.isUniqueType(playerType) && player.type === playerType) {
          previousTypes.set(player.id, player.type);
          return {
            ...player,
            type:
              playerType === PlayerType.AntiPacLeader || playerType === PlayerType.FlagLeader
                ? PlayerType.Leader
                : PlayerType.Ghost,
          };
        }
        return player;
      }),
    );
    return previousTypes;
  }

  private isUniqueType(playerType: PlayerType): boolean {
    return (
      playerType === PlayerType.Pacman ||
      playerType === PlayerType.Antipac ||
      playerType === PlayerType.AntiPacLeader ||
      playerType === PlayerType.FlagLeader
    );
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
}
