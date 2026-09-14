import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import { PAC_WINDOW } from '../../core/browser-window.token';
import { GameState } from '../../core/game.models';

interface ClockAnchor {
  clientTime: number;
  serverTime: number;
}

export function remainingCountdownSeconds(state: GameState, serverNow: number): number | null {
  if (state.phase === 'not_started' || state.endTime === null) {
    return null;
  }
  if (state.phase === 'ended') {
    return 0;
  }
  if (state.phase === 'paused') {
    return Math.max(0, Math.ceil((state.endTime - state.serverTime) / 1000));
  }
  return Math.max(0, Math.ceil((state.endTime - serverNow) / 1000));
}

export function formatCountdown(seconds: number | null): string {
  if (seconds === null) {
    return '--:--';
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

@Component({
  selector: 'pac-game-timer',
  templateUrl: './game-timer.component.html',
  styleUrl: './game-timer.component.scss',
  host: {
    '[class.game-timer-host--overlay]': 'overlay()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameTimerComponent {
  private readonly browserWindow = inject(PAC_WINDOW);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clientNow = signal(this.currentClientTime());
  private readonly clockAnchor = signal<ClockAnchor>({ clientTime: 0, serverTime: 0 });

  readonly state = input.required<GameState>();
  readonly overlay = input(false);

  protected readonly remainingSeconds = computed(() => {
    const anchor = this.clockAnchor();
    const elapsed = Math.max(0, this.clientNow() - anchor.clientTime);
    return remainingCountdownSeconds(this.state(), anchor.serverTime + elapsed);
  });
  protected readonly displayTime = computed(() => formatCountdown(this.remainingSeconds()));
  protected readonly hasEnded = computed(
    () => this.state().phase === 'ended' || (this.state().phase !== 'paused' && this.remainingSeconds() === 0),
  );
  protected readonly label = computed(() => {
    if (this.state().phase === 'not_started') {
      return 'Waiting for game to start';
    }

    if (this.state().phase === 'paused') {
      return 'Game paused';
    }

    if (this.state().isFlagFound) {
      return 'Pac-Man has the flag';
    }
    return this.hasEnded() ? 'Game ended' : 'Game time remaining';
  });
  protected readonly urgent = computed(() => {
    const remaining = this.remainingSeconds();
    return remaining !== null && remaining > 0 && remaining <= 60;
  });
  protected readonly accessibleTime = computed(() => `${this.label()}: ${this.displayTime()}`);

  constructor() {
    effect(() => {
      const state = this.state();
      const clientTime = this.currentClientTime();
      untracked(() => {
        this.clientNow.set(clientTime);
        this.clockAnchor.set({ clientTime, serverTime: state.serverTime });
      });
    });
    afterNextRender(() => {
      if (!this.browserWindow) {
        return;
      }
      const interval = this.browserWindow.setInterval(
        () => this.clientNow.set(this.currentClientTime()),
        250,
      );
      this.destroyRef.onDestroy(() => this.browserWindow?.clearInterval(interval));
    });
  }

  private currentClientTime(): number {
    return this.browserWindow?.Date.now() ?? Date.now();
  }
}
