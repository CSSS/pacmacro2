import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { form, FormField, required, submit as submitForm } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';

import { AdminSocketService } from '../../core/sockets/admin-socket.service';
import { ApiService } from '../../core/api.service';
import {
  isLeaderType,
  PLAYER_TYPES,
  Player,
  PlayerStatus,
  PlayerType,
} from '../../core/game.models';
import { BrandHeaderComponent } from '../../shared/brand-header/brand-header.component';
import { PAC_WINDOW } from '../../core/browser-window.token';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { GameTimerComponent } from '../../shared/game-timer/game-timer.component';

interface AdminLoginModel {
  password: string;
}

@Component({
  selector: 'pac-admin-page',
  imports: [FormField, BrandHeaderComponent, GameTimerComponent],
  templateUrl: './admin-page.component.html',
  styleUrl: './admin-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [AdminSocketService],
  host: {
    '[class.admin-authenticated]': 'authenticated()',
  },
})
export class AdminPageComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly adminSocket = inject(AdminSocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly browser = inject(PAC_WINDOW);

  protected readonly players = this.adminSocket.players;
  protected readonly isFlagFound = this.adminSocket.isFlagFound;
  protected readonly gameState = this.adminSocket.gameState;
  protected readonly socketReady = this.adminSocket.isReady;
  protected readonly connectionStatus = this.adminSocket.status;
  protected readonly authenticated = signal(false);
  protected readonly status = signal('');
  protected readonly loadingPlayers = signal(false);
  protected readonly bulkUpdating = signal(false);
  protected readonly flagSaving = signal(false);
  protected readonly timerSaving = signal(false);
  protected readonly timerRemainingSeconds = signal<number | null>(null);
  protected readonly playerTypes = PLAYER_TYPES;
  protected readonly PlayerType = PlayerType;
  private readonly savingPlayerIds = signal<ReadonlySet<string>>(new Set());
  protected readonly mutationInProgress = computed(
    () =>
      this.bulkUpdating() ||
      this.flagSaving() ||
      this.timerSaving() ||
      this.savingPlayerIds().size > 0 ||
      this.loadingPlayers(),
  );
  protected readonly updatesInProgress = computed(
    () => !this.socketReady() || this.mutationInProgress(),
  );
  protected readonly canStartGame = computed(() => this.gameState().phase === 'not_started');
  protected readonly canEmpowerAntipac = computed(
    () => this.gameState().phase === 'in_progress' && (this.timerRemainingSeconds() ?? 0) > 10 * 60,
  );

  protected readonly loginModel = signal<AdminLoginModel>({ password: '' });

  protected readonly loginForm = form(this.loginModel, (login) => {
    required(login.password, { message: 'Enter the administrator password.' });
  });

  ngOnInit(): void {
    if (!this.browser) {
      return;
    }

    this.api
      .verifyAdmin()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.authenticated.set(true);
          this.adminSocket.connect();
        },
        error: () => {
          return;
        },
      });
  }

  protected async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await submitForm(this.loginForm, {
      action: async () => this.login(),
      onInvalid: () => {
        const firstError = this.loginForm().errorSummary()[0];
        this.status.set(firstError?.message ?? 'Enter the administrator password.');
      },
    });
  }

  private async login(): Promise<void> {
    const { password } = this.loginForm().value();
    this.status.set('Signing in...');

    try {
      await firstValueFrom(this.api.registerAdmin(password));
      this.authenticated.set(true);
      this.adminSocket.connect();
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.status.set('The administrator password is incorrect.');
      } else {
        this.status.set('Could not sign in. Check the password and the API connection.');
      }
    }
  }

  protected isConnected(player: Player): boolean {
    return player.status === PlayerStatus.Connected;
  }

  protected async refreshPlayers(): Promise<void> {
    if (this.mutationInProgress()) {
      return;
    }
    this.loadingPlayers.set(true);
    this.status.set('Fetching the current player list…');
    try {
      const players = await firstValueFrom(this.api.getPlayers());
      this.players.set(players.filter((player) => !this.adminSocket.removedPlayers.has(player.id)));
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

  protected async toggleFlagFound(): Promise<void> {
    if (this.updatesInProgress()) {
      return;
    }
    const previous = this.isFlagFound();
    const next = !previous;
    this.isFlagFound.set(next);
    this.flagSaving.set(true);
    this.status.set(next ? 'Marking the flag as found…' : 'Marking the flag as not found…');
    try {
      await firstValueFrom(this.api.updateAdminFlag(next));
      this.status.set(next ? 'The flag is marked found.' : 'The flag is marked not found.');
    } catch {
      this.isFlagFound.set(previous);
      this.status.set('Could not update flag state. Register as admin in this browser first.');
    } finally {
      this.flagSaving.set(false);
    }
  }

  protected async startGame(): Promise<void> {
    if (this.updatesInProgress() || !this.canStartGame()) {
      return;
    }
    this.timerSaving.set(true);
    this.status.set('Starting the 20-minute game timer…');
    try {
      await firstValueFrom(this.api.startGame());
      this.status.set('The game timer started.');
    } catch (error) {
      this.status.set(
        error instanceof HttpErrorResponse && error.status === 409
          ? 'The game has already started. Reset it before starting again.'
          : 'Could not start the game timer. Register as admin in this browser first.',
      );
    } finally {
      this.timerSaving.set(false);
    }
  }

  protected async empowerAntipac(): Promise<void> {
    if (this.updatesInProgress() || !this.canEmpowerAntipac()) {
      return;
    }
    this.timerSaving.set(true);
    this.status.set('Setting the game timer to 10 minutes remaining…');
    try {
      await firstValueFrom(this.api.empowerAntipac());
      this.status.set('Antipac is empowered. 10 minutes remaining.');
    } catch (error) {
      this.status.set(
        error instanceof HttpErrorResponse && error.status === 409
          ? 'Antipac can only be empowered while the game is running.'
          : 'Could not empower Antipac. Register as admin in this browser first.',
      );
    } finally {
      this.timerSaving.set(false);
    }
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
      this.isFlagFound.set(false);
      this.timerRemainingSeconds.set(null);
      this.status.set('Reset the game successfully.');
    } catch {
      this.status.set('Could not reset the game. Register as admin in this browser first.');
    } finally {
      this.bulkUpdating.set(false);
    }
  }

  protected async kickPlayer(player: Player): Promise<void> {
    if (this.updatesInProgress()) {
      return;
    }

    const confirmed = this.browser?.confirm(
      `Remove ${player.name} (${player.id}) from PacMacro? They will need to register again to rejoin.`,
    );
    if (!confirmed) {
      return;
    }

    this.setPlayerSaving(player.id, true);
    this.status.set(`Removing ${player.name} (${player.id})…`);
    try {
      await firstValueFrom(this.api.kickPlayer(player.id));
      this.removeLocalPlayer(player.id);
      this.status.set(`Removed ${player.name} (${player.id}). They must register again to rejoin.`);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 404) {
        this.removeLocalPlayer(player.id);
        this.status.set(`${player.name} (${player.id}) was already removed.`);
      } else {
        this.status.set(`Could not remove ${player.name} (${player.id}). Try again.`);
      }
    } finally {
      this.setPlayerSaving(player.id, false);
    }
  }

  private removeLocalPlayer(playerId: string): void {
    this.players.update((players) => players.filter((player) => player.id !== playerId));
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
