import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { LeaderState, Player, PlayerStatus, PlayerType } from '../../core/game.models';
import { LeaderSocketService } from '../../core/sockets/leader-socket.service';
import { LeaderOverlayComponent } from './leader-overlay.component';

describe('LeaderOverlayComponent', () => {
  let fixture: ComponentFixture<LeaderOverlayComponent>;
  const genericLeader: Player = {
    id: 'LEAD',
    name: 'Lee',
    type: PlayerType.Leader,
    status: PlayerStatus.Disconnected,
  };
  const initialPlayers: Player[] = [
    { id: 'ANTI', name: 'Antipac', type: PlayerType.Antipac, status: PlayerStatus.Connected },
    { id: 'GHOST', name: 'Ghost', type: PlayerType.Ghost, status: PlayerStatus.Connected },
    { id: 'HIDE', name: 'Hidden', type: PlayerType.Hidden, status: PlayerStatus.Connected },
    { id: 'OFF', name: 'Offline', type: PlayerType.Ghost, status: PlayerStatus.Disconnected },
  ];
  const leaderSocket = {
    leader: signal<Player | null>(null),
    players: signal<Player[]>([]),
    isFlagFound: signal(false),
    status: signal('Connected to the leader feed.'),
    start: vi.fn(),
    stop: vi.fn(),
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
  const stateForLeader = (type: PlayerType, isFlagFound = false): LeaderState => ({
    ...defaultState,
    leader: { ...genericLeader, type },
    isFlagFound,
  });
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
    leaderSocket.stop.mockClear();
    leaderSocket.applySnapshot.mockClear();
    api.getLeaderState.mockReset();
    api.getLeaderState.mockReturnValue(of(defaultState));
    api.updateLeaderPlayer.mockReset();
    api.updateLeaderPlayer.mockReturnValue(of(undefined));
    api.updateFlag.mockReset();
    api.updateFlag.mockReturnValue(of(undefined));

    await TestBed.configureTestingModule({
      imports: [LeaderOverlayComponent],
      providers: [{ provide: ApiService, useValue: api }],
    })
      .overrideComponent(LeaderOverlayComponent, {
        set: { providers: [{ provide: LeaderSocketService, useValue: leaderSocket }] },
      })
      .compileComponents();
  });

  async function render(active: boolean, state: LeaderState = defaultState): Promise<HTMLElement> {
    api.getLeaderState.mockReturnValueOnce(of(state));
    fixture = TestBed.createComponent(LeaderOverlayComponent);
    fixture.componentRef.setInput('active', active);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders nothing when inactive', async () => {
    const page = await render(false);
    expect(page.querySelector('.leader-overlay')).toBeNull();
    expect(leaderSocket.start).not.toHaveBeenCalled();
  });

  it('loads state, identifies the leader, and gives every leader Ghost and Hidden controls', async () => {
    const page = await render(true);
    expect(api.getLeaderState).toHaveBeenCalledOnce();
    expect(leaderSocket.start).toHaveBeenCalledOnce();
    expect(page.querySelector('.leader-overlay__heading')?.textContent).toContain('Lee — Leader');
    expect(page.querySelectorAll('.player-card')).toHaveLength(initialPlayers.length);
    expect(page.querySelectorAll('#overlay-type-GHOST-3, #overlay-type-GHOST-0')).toHaveLength(2);
    expect(page.querySelector('#overlay-type-GHOST-2')).toBeNull();
    expect(page.textContent).not.toContain('read-only');
  });

  it('shows Antipac controls for every listed player and enables them only for Ghosts', async () => {
    const page = await render(true, stateForLeader(PlayerType.AntiPacLeader));
    expect(page.querySelectorAll('[id$="-2"]')).toHaveLength(initialPlayers.length);
    expect(page.querySelector('#overlay-type-GHOST-2')).not.toBeNull();
    expect(page.querySelector('#overlay-type-OFF-2')).not.toBeNull();
    expect(page.querySelector<HTMLButtonElement>('#overlay-type-ANTI-2')?.disabled).toBe(true);
    expect(page.querySelector<HTMLButtonElement>('#overlay-type-GHOST-2')?.disabled).toBe(false);
    expect(page.querySelector<HTMLButtonElement>('#overlay-type-OFF-2')?.disabled).toBe(false);
  });

  it('filters players by a case-insensitive ID search', async () => {
    const page = await render(true);
    const search = page.querySelector<HTMLInputElement>('#leader-player-search');
    search!.value = 'hIdE';
    search!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(page.querySelectorAll('.player-card')).toHaveLength(1);
    expect(page.textContent).toContain('Hidden');

    search!.value = 'missing';
    search!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(page.querySelectorAll('.player-card')).toHaveLength(0);
    expect(page.textContent).toContain('No players match that ID.');
  });

  it('optimistically enforces one Antipac', async () => {
    const page = await render(true, stateForLeader(PlayerType.AntiPacLeader));
    page.querySelector<HTMLButtonElement>('#overlay-type-GHOST-2')?.click();
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
    api.updateLeaderPlayer.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 409 })),
    );
    const page = await render(true, stateForLeader(PlayerType.AntiPacLeader));
    page.querySelector<HTMLButtonElement>('#overlay-type-GHOST-2')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(leaderSocket.players().find((player) => player.id === 'ANTI')?.type).toBe(
      PlayerType.Antipac,
    );
    expect(leaderSocket.players().find((player) => player.id === 'GHOST')?.type).toBe(
      PlayerType.Ghost,
    );
    expect(page.querySelector('.action-status')?.textContent).toContain(
      'no longer has an assignable role',
    );
    expect(page.querySelector<HTMLButtonElement>('#overlay-type-GHOST-3')?.disabled).toBe(true);
  });

  it.each([
    [PlayerType.Leader, 'GHOST'],
    [PlayerType.AntiPacLeader, 'GHOST'],
    [PlayerType.FlagLeader, 'OFF'],
  ])('allows leader type %s to assign Hidden to player %s, including offline players', async (type, playerId) => {
    const page = await render(true, stateForLeader(type));
    const button = page.querySelector<HTMLButtonElement>(`#overlay-type-${playerId}-0`);

    expect(button?.disabled).toBe(false);
    button?.click();
    await fixture.whenStable();

    expect(api.updateLeaderPlayer).toHaveBeenCalledWith(playerId, PlayerType.Hidden);
    expect(leaderSocket.players().find((player) => player.id === playerId)?.type).toBe(
      PlayerType.Hidden,
    );
  });

  it('disables the current role and rolls back a failed role update', async () => {
    const page = await render(true);
    leaderSocket.players.update((players) =>
      players.map((player) =>
        player.id === 'GHOST' ? { ...player, type: PlayerType.Hidden } : player,
      ),
    );
    fixture.detectChanges();

    page.querySelector<HTMLButtonElement>('#overlay-type-GHOST-0')?.click();
    expect(api.updateLeaderPlayer).not.toHaveBeenCalled();

    api.updateLeaderPlayer.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 403 })),
    );
    page.querySelector<HTMLButtonElement>('#overlay-type-HIDE-3')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(leaderSocket.players().find((player) => player.id === 'HIDE')?.type).toBe(
      PlayerType.Hidden,
    );
    expect(page.querySelector('.action-status')?.textContent).toContain(
      'does not have this capability',
    );
  });

  it('shows Flag Leader control as a pressed button and rolls it back on failure', async () => {
    api.updateFlag.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 403 })));
    const page = await render(true, stateForLeader(PlayerType.FlagLeader, true));
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

  it('uses secondary button styling while the flag has not been found', async () => {
    const page = await render(true, stateForLeader(PlayerType.FlagLeader));

    const button = page.querySelector<HTMLButtonElement>('button.flag-control');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.classList.contains('button-secondary')).toBe(true);
  });

  it('reacts live when a specialized leader is downgraded to generic Leader', async () => {
    await render(true, stateForLeader(PlayerType.AntiPacLeader));
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('[id$="-2"]').length).toBe(
      initialPlayers.length,
    );

    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.Leader });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('[id$="-2"]').length).toBe(0);
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('[id$="-0"]').length).toBe(
      initialPlayers.length,
    );
  });
});
