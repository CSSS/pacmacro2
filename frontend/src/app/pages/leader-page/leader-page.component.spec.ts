import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { LeaderState, Player, PlayerStatus, PlayerType } from '../../core/game.models';
import { LeaderSocketService } from '../../core/sockets/leader-socket.service';
import { LeaderPageComponent } from './leader-page.component';

describe('LeaderPageComponent', () => {
  let fixture: ComponentFixture<LeaderPageComponent>;
  const genericLeader: Player = {
    id: 'LEAD',
    name: 'Lee',
    type: PlayerType.Leader,
    status: PlayerStatus.Disconnected,
  };
  const initialPlayers: Player[] = [
    { id: 'ANTI', name: 'Antipac', type: PlayerType.Antipac, status: PlayerStatus.Connected },
    { id: 'GHOST', name: 'Ghost', type: PlayerType.Ghost, status: PlayerStatus.Connected },
    { id: 'EDIB', name: 'Edible', type: PlayerType.Edible, status: PlayerStatus.Connected },
    { id: 'PAC', name: 'Pacman', type: PlayerType.Pacman, status: PlayerStatus.Connected },
    { id: 'OFF', name: 'Offline', type: PlayerType.Ghost, status: PlayerStatus.Disconnected },
  ];
  const leaderSocket = {
    leader: signal<Player | null>(null),
    players: signal<Player[]>([]),
    isFlagFound: signal(false),
    status: signal('Connected to the leader feed.'),
    start: vi.fn(),
    applySnapshot: vi.fn((state: LeaderState) => {
      leaderSocket.leader.set({ ...state.leader });
      leaderSocket.players.set(state.players.map((player) => ({ ...player })));
      leaderSocket.isFlagFound.set(state.isFlagFound);
      return true;
    }),
  };
  const defaultState: LeaderState = {
    leader: genericLeader,
    players: initialPlayers,
    isFlagFound: false,
  };
  const api = {
    getLeaderState: vi.fn(() => of(defaultState)),
    updateLeaderPlayer: vi.fn(() => of(undefined)),
    updateFlag: vi.fn(() => of(undefined)),
  };

  beforeEach(async () => {
    leaderSocket.leader.set(null);
    leaderSocket.players.set([]);
    leaderSocket.isFlagFound.set(false);
    leaderSocket.start.mockClear();
    leaderSocket.applySnapshot.mockClear();
    api.getLeaderState.mockReset();
    api.getLeaderState.mockReturnValue(of(defaultState));
    api.updateLeaderPlayer.mockReset();
    api.updateLeaderPlayer.mockReturnValue(of(undefined));
    api.updateFlag.mockReset();
    api.updateFlag.mockReturnValue(of(undefined));

    await TestBed.configureTestingModule({
      imports: [LeaderPageComponent],
      providers: [{ provide: ApiService, useValue: api }],
    })
      .overrideComponent(LeaderPageComponent, {
        set: { providers: [{ provide: LeaderSocketService, useValue: leaderSocket }] },
      })
      .compileComponents();

    fixture = TestBed.createComponent(LeaderPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('loads state, identifies the leader, and gives generic Leaders a read-only panel', () => {
    const page = fixture.nativeElement as HTMLElement;
    expect(api.getLeaderState).toHaveBeenCalledOnce();
    expect(leaderSocket.start).toHaveBeenCalledOnce();
    expect(page.querySelector('h1')?.textContent).toContain('Lee — Leader');
    expect(page.querySelectorAll('.player-card')).toHaveLength(initialPlayers.length);
    expect(page.querySelectorAll('.player-type')).toHaveLength(0);
    expect(page.textContent).toContain('read-only');
    const mapLink = page.querySelector<HTMLAnchorElement>('.leader-actions a');
    expect(mapLink?.target).toBe('_blank');
    expect(mapLink?.rel).toBe('noopener');
  });

  it('shows AntiPac controls only for connected Ghost, Edible, and Antipac players', () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.AntiPacLeader });
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelectorAll('.player-types')).toHaveLength(3);
    expect(page.querySelectorAll('.player-type')).toHaveLength(6);
    const edible = page
      .querySelector('#leader-type-EDIB-3')
      ?.nextElementSibling?.textContent?.trim();
    expect(edible).toBe('Ghost');
    expect(page.querySelector<HTMLInputElement>('#leader-type-EDIB-3')?.checked).toBe(true);
    expect(page.querySelector('#leader-type-PAC-2')).toBeNull();
    expect(page.querySelector('#leader-type-OFF-2')).toBeNull();
  });

  it('optimistically enforces one Antipac', async () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.AntiPacLeader });
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    page.querySelector<HTMLInputElement>('#leader-type-GHOST-2')?.click();
    expect(leaderSocket.players().find((player) => player.id === 'ANTI')?.type).toBe(
      PlayerType.Ghost,
    );
    expect(leaderSocket.players().find((player) => player.id === 'GHOST')?.type).toBe(
      PlayerType.Antipac,
    );
    await fixture.whenStable();
    expect(api.updateLeaderPlayer).toHaveBeenCalledWith('GHOST', PlayerType.Antipac);
  });

  it('fully rolls back an ineligible update failure with actionable status', async () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.AntiPacLeader });
    api.updateLeaderPlayer.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 409 })),
    );
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    page.querySelector<HTMLInputElement>('#leader-type-GHOST-2')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(leaderSocket.players().find((player) => player.id === 'ANTI')?.type).toBe(
      PlayerType.Antipac,
    );
    expect(leaderSocket.players().find((player) => player.id === 'GHOST')?.type).toBe(
      PlayerType.Ghost,
    );
    expect(page.querySelector('.action-status')?.textContent).toContain(
      'offline or no longer eligible',
    );
    expect(page.querySelector<HTMLInputElement>('#leader-type-GHOST-3')?.checked).toBe(true);
  });

  it('shows Flag Leader control as a pressed button and rolls it back on failure', async () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.FlagLeader });
    leaderSocket.isFlagFound.set(true);
    api.updateFlag.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 403 })));
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    const button = page.querySelector<HTMLButtonElement>('button.flag-control');
    expect(button?.textContent?.trim()).toBe('Flag Found');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.classList.contains('button-secondary')).toBe(false);
    button?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.updateFlag).toHaveBeenCalledWith(false);
    expect(leaderSocket.isFlagFound()).toBe(true);
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(page.querySelector('.action-status')?.textContent).toContain(
      'does not have this capability',
    );
  });

  it('uses secondary button styling while the flag has not been found', () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.FlagLeader });
    leaderSocket.isFlagFound.set(false);
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button.flag-control',
    );
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.classList.contains('button-secondary')).toBe(true);
  });

  it('reacts live when a specialized leader is downgraded to generic Leader', () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.AntiPacLeader });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.player-type').length).toBe(6);

    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.Leader });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.player-type').length).toBe(0);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('read-only');
  });
});
