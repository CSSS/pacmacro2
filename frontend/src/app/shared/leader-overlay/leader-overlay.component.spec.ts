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

  async function render(active: boolean): Promise<HTMLElement> {
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

  it('loads state, identifies the leader, and gives generic Leaders a read-only panel', async () => {
    const page = await render(true);
    expect(api.getLeaderState).toHaveBeenCalledOnce();
    expect(leaderSocket.start).toHaveBeenCalledOnce();
    expect(page.querySelector('.leader-overlay__heading')?.textContent).toContain('Lee — Leader');
    expect(page.querySelectorAll('.player-card')).toHaveLength(initialPlayers.length);
    expect(page.querySelectorAll('.player-type')).toHaveLength(0);
    expect(page.textContent).toContain('read-only');
  });

  it('shows AntiPac controls only for connected Ghost, Edible, and Antipac players', async () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.AntiPacLeader });
    const page = await render(true);
    expect(page.querySelectorAll('.player-types')).toHaveLength(3);
    expect(page.querySelectorAll('.player-type')).toHaveLength(6);
    const edible = page
      .querySelector('#overlay-type-EDIB-3')
      ?.nextElementSibling?.textContent?.trim();
    expect(edible).toBe('Ghost');
    expect(page.querySelector<HTMLInputElement>('#overlay-type-EDIB-3')?.checked).toBe(true);
    expect(page.querySelector('#overlay-type-PAC-2')).toBeNull();
    expect(page.querySelector('#overlay-type-OFF-2')).toBeNull();
  });

  it('filters players by a case-insensitive ID search', async () => {
    const page = await render(true);
    const search = page.querySelector<HTMLInputElement>('#leader-player-search');
    search!.value = 'eDiB';
    search!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(page.querySelectorAll('.player-card')).toHaveLength(1);
    expect(page.textContent).toContain('Edible');
    expect(page.textContent).not.toContain('Ghost');

    search!.value = 'missing';
    search!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(page.querySelectorAll('.player-card')).toHaveLength(0);
    expect(page.textContent).toContain('No players match that ID.');
  });

  it('optimistically enforces one Antipac', async () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.AntiPacLeader });
    const page = await render(true);
    page.querySelector<HTMLInputElement>('#overlay-type-GHOST-2')?.click();
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
    const page = await render(true);
    page.querySelector<HTMLInputElement>('#overlay-type-GHOST-2')?.click();
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
    expect(page.querySelector<HTMLInputElement>('#overlay-type-GHOST-3')?.checked).toBe(true);
  });

  it('shows Flag Leader control as a pressed button and rolls it back on failure', async () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.FlagLeader });
    leaderSocket.isFlagFound.set(true);
    api.updateFlag.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 403 })));
    const page = await render(true);
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
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.FlagLeader });
    leaderSocket.isFlagFound.set(false);
    const page = await render(true);

    const button = page.querySelector<HTMLButtonElement>('button.flag-control');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.classList.contains('button-secondary')).toBe(true);
  });

  it('reacts live when a specialized leader is downgraded to generic Leader', async () => {
    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.AntiPacLeader });
    await render(true);
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.player-type').length).toBe(6);

    leaderSocket.leader.set({ ...genericLeader, type: PlayerType.Leader });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.player-type').length).toBe(0);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('read-only');
  });
});
