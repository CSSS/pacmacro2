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

  it('freezes the countdown while paused despite local clock drift', () => {
    const paused: GameState = {
      isFlagFound: false,
      phase: 'paused',
      startTime: 1_000_000,
      endTime: 1_600_000,
      serverTime: 1_000_000,
    };

    expect(remainingCountdownSeconds(paused, 1_000_000)).toBe(600);
    expect(remainingCountdownSeconds(paused, 1_010_000)).toBe(600);
    expect(remainingCountdownSeconds(paused, 1_610_000)).toBe(600);
  });

  it('keeps the same paused remaining across server rebroadcasts', () => {
    const before: GameState = {
      isFlagFound: false,
      phase: 'paused',
      startTime: 1_000_000,
      endTime: 1_600_000,
      serverTime: 1_000_000,
    };
    const after: GameState = {
      isFlagFound: false,
      phase: 'paused',
      startTime: 1_000_000,
      endTime: 1_630_000,
      serverTime: 1_030_000,
    };

    expect(remainingCountdownSeconds(after, 1_030_000)).toBe(
      remainingCountdownSeconds(before, 1_000_000),
    );
  });

  it('displays a frozen paused timer that does not tick locally', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const page = render({
      isFlagFound: false,
      phase: 'paused',
      startTime: 1_000_000,
      endTime: 1_600_000,
      serverTime: 1_000_000,
    });

    expect(page.textContent).toContain('Game paused');
    expect(page.textContent).toContain('10:00');

    vi.advanceTimersByTime(5_000);
    fixture.detectChanges();

    expect(page.textContent).toContain('10:00');
    expect(page.textContent).toContain('Game paused');
  });

  it('applies the compact overlay mode when requested', () => {
    fixture = TestBed.createComponent(GameTimerComponent);
    fixture.componentRef.setInput('state', {
      isFlagFound: false,
      phase: 'not_started',
      startTime: null,
      endTime: null,
      serverTime: 1_000,
    });
    fixture.componentRef.setInput('overlay', true);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList).toContain('game-timer-host--overlay');
    expect(host.querySelector('.game-timer--overlay')).not.toBeNull();
  });
});
