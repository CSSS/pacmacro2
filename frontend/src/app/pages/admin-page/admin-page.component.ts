import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { AdminSocketService } from '../../core/admin-socket.service';
import { ApiService } from '../../core/api.service';
import {
  PLAYER_TYPES,
  Player,
  PlayerStatus,
  PlayerType,
  REPRESENTATIONS,
  Representation,
} from '../../core/game.models';

@Component({
  selector: 'pac-admin-page',
  imports: [FormsModule],
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
  protected readonly status = signal('Admin authentication is supplied by a secure cookie.');
  protected readonly playerTypes = PLAYER_TYPES;
  protected readonly representations = REPRESENTATIONS;
  protected readonly PlayerType = PlayerType;
  protected readonly hasConnectedPlayers = computed(() =>
    this.players().some((player) => this.isConnected(player)),
  );

  constructor() {
    afterNextRender(() => this.adminSocket.start());
  }

  protected isConnected(player: Player): boolean {
    return player.status === PlayerStatus.Connected;
  }

  protected setType(playerId: string, type: PlayerType): void {
    this.players.update((players) =>
      players.map((player) =>
        player.id === playerId && this.isConnected(player) ? { ...player, type } : player,
      ),
    );
  }

  protected setRepresentation(playerId: string, reps: Representation): void {
    this.players.update((players) =>
      players.map((player) =>
        player.id === playerId && this.isConnected(player) ? { ...player, reps } : player,
      ),
    );
  }

  protected async updatePlayer(player: Player): Promise<void> {
    if (!this.isConnected(player)) {
      this.status.set(`${player.name} (${player.id}) is offline and cannot be updated.`);
      return;
    }

    this.status.set(`Updating ${player.id}…`);
    try {
      await firstValueFrom(this.api.updatePlayer(player.id, player.type, player.reps));
      this.status.set(`Updated ${player.name} (${player.id}).`);
    } catch {
      this.status.set(
        `Could not update ${player.name} (${player.id}). Register as admin in this browser first.`,
      );
    }
  }

  protected async makeGhostsEdible(): Promise<void> {
    await this.bulkUpdate(
      (player) => player.reps === Representation.Ghost,
      Representation.Edible,
      'ghosts edible',
    );
  }

  protected async makeAllNothing(): Promise<void> {
    await this.bulkUpdate(() => true, Representation.Nothing, 'players invisible');
  }

  private async bulkUpdate(
    predicate: (player: Player) => boolean,
    reps: Representation,
    description: string,
  ): Promise<void> {
    const targets = this.players().filter(
      (player) => this.isConnected(player) && predicate(player),
    );
    if (!targets.length) {
      this.status.set(`No players need updating to make ${description}.`);
      return;
    }

    this.status.set(`Updating ${targets.length} players…`);
    const results = await Promise.allSettled(
      targets.map((player) => firstValueFrom(this.api.updatePlayer(player.id, player.type, reps))),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    this.status.set(
      failed
        ? `Updated ${targets.length - failed} of ${targets.length} players; ${failed} failed. Register as admin again if the session expired.`
        : `Updated ${targets.length} players successfully.`,
    );
  }
}
