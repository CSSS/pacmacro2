import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GameState } from '../../core/game.models';
import {
  formatCountdown,
  GameTimerComponent,
  remainingCountdownSeconds,
} from './game-timer.component';

describe('GameTimerComponent', () => {
  let fixture: ComponentFixture<GameTimerComponent>;

  afterEach(() => {
    fixture?.destroy();
    vi.useRealTimers();
  });

  function render(state: GameState): HTMLElement {
    fixture = TestBed.createComponent(GameTimerComponent);
    fixture.componentRef.setInput('state', state);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('formats countdown values and clamps expired deadlines', () => {
    expect(formatCountdown(null)).toBe('--:--');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(601)).toBe('10:01');
    expect(
      remainingCountdownSeconds(
        {
          isFlagFound: false,
          phase: 'in_progress',
          startTime: 1_000,
          endTime: 601_000,
          serverTime: 1_000,
        },
        602_000,
      ),
    ).toBe(0);
  });

  it('shows the waiting and ended states', () => {
    const page = render({
      isFlagFound: false,
      phase: 'not_started',
      startTime: null,
      endTime: null,
      serverTime: 1_000,
    });
    expect(page.textContent).toContain('Waiting for game to start');
    expect(page.textContent).toContain('--:--');

    fixture.componentRef.setInput('state', {
      isFlagFound: false,
      phase: 'ended',
      startTime: 1_000,
      endTime: 1_201_000,
      serverTime: 1_201_000,
    });
    fixture.detectChanges();
    expect(page.textContent).toContain('Game ended');
    expect(page.textContent).toContain('00:00');
  });

  it('uses server time, counts down locally, and warns during the final minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const page = render({
      isFlagFound: false,
      phase: 'in_progress',
      startTime: 1_000_000,
      endTime: 1_061_000,
      serverTime: 1_000_000,
    });

    expect(page.textContent).toContain('01:01');
    expect(page.querySelector('.game-timer--urgent')).toBeNull();

    vi.advanceTimersByTime(1_000);
    fixture.detectChanges();
    expect(page.textContent).toContain('01:00');
    expect(page.querySelector('.game-timer--urgent')).not.toBeNull();
  });
});
