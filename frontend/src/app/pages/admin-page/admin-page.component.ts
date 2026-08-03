import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/api.service';
import {
  PLAYER_TYPES,
  Player,
  PlayerType,
  REPRESENTATIONS,
  Representation,
} from '../../core/game.models';

interface PlayerDraft extends Player {}

@Component({
  selector: 'pac-admin-page',
  imports: [FormsModule],
  templateUrl: './admin-page.component.html',
  styleUrl: './admin-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPageComponent {
  private readonly api = inject(ApiService);

  protected readonly adminId = signal('');
  protected readonly adminPassword = signal('');
  protected readonly players = signal<PlayerDraft[]>([]);
  protected readonly status = signal('Ready.');
  protected readonly loading = signal(false);
  protected readonly playerTypes = PLAYER_TYPES;
  protected readonly representations = REPRESENTATIONS;
  protected readonly PlayerType = PlayerType;

  protected async loadPlayers(): Promise<void> {
    this.loading.set(true);
    this.status.set('Loading players…');
    try {
      const players = await firstValueFrom(this.api.getPlayers());
      this.players.set(players.map((player) => ({ ...player })));
      this.status.set(`Loaded ${players.length} player${players.length === 1 ? '' : 's'}.`);
    } catch {
      this.status.set('Could not load players from the API.');
    } finally {
      this.loading.set(false);
    }
  }

  protected setType(playerId: string, type: PlayerType): void {
    this.players.update((players) =>
      players.map((player) => (player.id === playerId ? { ...player, type } : player)),
    );
  }

  protected setRepresentation(playerId: string, reps: Representation): void {
    this.players.update((players) =>
      players.map((player) => (player.id === playerId ? { ...player, reps } : player)),
    );
  }

  protected async updatePlayer(player: PlayerDraft): Promise<void> {
    if (!this.hasCredentials()) {
      return;
    }
    this.status.set(`Updating ${player.id}…`);
    try {
      await firstValueFrom(
        this.api.updatePlayer(
          player.id,
          this.adminId().trim(),
          this.adminPassword(),
          player.type,
          player.reps,
        ),
      );
      this.status.set(`Updated ${player.name} (${player.id}).`);
    } catch {
      this.status.set(
        `Could not update ${player.name} (${player.id}). Check the admin credentials.`,
      );
    }
  }

  protected async makeGhostsEdible(): Promise<void> {
    await this.bulkUpdate(
      (player) => player.type !== PlayerType.Admin && player.reps === Representation.Ghost,
      Representation.Edible,
      'ghosts edible',
    );
  }

  protected async makeAllNothing(): Promise<void> {
    await this.bulkUpdate(
      (player) => player.type !== PlayerType.Admin,
      Representation.Nothing,
      'players invisible',
    );
  }

  private async bulkUpdate(
    predicate: (player: PlayerDraft) => boolean,
    reps: Representation,
    description: string,
  ): Promise<void> {
    if (!this.hasCredentials()) {
      return;
    }

    let latestPlayers: Player[];
    try {
      latestPlayers = await firstValueFrom(this.api.getPlayers());
    } catch {
      this.status.set('Could not load the latest players before the bulk update.');
      return;
    }

    const targets = latestPlayers.filter(predicate);
    if (!targets.length) {
      this.status.set(`No players need updating to make ${description}.`);
      return;
    }

    this.status.set(`Updating ${targets.length} players…`);
    const results = await Promise.allSettled(
      targets.map((player) =>
        firstValueFrom(
          this.api.updatePlayer(
            player.id,
            this.adminId().trim(),
            this.adminPassword(),
            player.type,
            reps,
          ),
        ),
      ),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    this.status.set(
      failed
        ? `Updated ${targets.length - failed} of ${targets.length} players; ${failed} failed.`
        : `Updated ${targets.length} players successfully.`,
    );
    this.players.set([]);
  }

  private hasCredentials(): boolean {
    if (!this.adminId().trim() || !this.adminPassword()) {
      this.status.set('Enter the admin ID and password first.');
      return false;
    }
    return true;
  }
}
