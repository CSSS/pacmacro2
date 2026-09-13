import { signal, WritableSignal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { GameState, Player, PlayerStatus, PlayerType } from '../../core/game.models';
import { AdminSocketService } from '../../core/sockets/admin-socket.service';
import { AdminPageComponent } from './admin-page.component';

describe('AdminPageComponent', () => {
  let fixture: ComponentFixture<AdminPageComponent>;
  const initialGameState: GameState = {
    isFlagFound: false,
    phase: 'not_started',
    startTime: null,
    endTime: null,
    serverTime: 1_000,
  };
  const initialPlayers: Player[] = [
    {
      id: 'AAAA',
      name: 'Ada',
      type: PlayerType.Pacman,
      status: PlayerStatus.Connected,
    },
    {
      id: 'BBBB',
      name: 'Ben',
      type: PlayerType.Edible,
      status: PlayerStatus.Disconnected,
    },
    {
      id: 'CCCC',
      name: 'Gia',
      type: PlayerType.Ghost,
      status: PlayerStatus.Connected,
    },
    {
      id: 'DDDD',
      name: 'Lee',
      type: PlayerType.Leader,
      status: PlayerStatus.Disconnected,
    },
  ];
  const adminSocket = {
    players: signal<Player[]>(initialPlayers.map((player) => ({ ...player }))),
    isFlagFound: signal(false),
    gameState: signal<GameState>({ ...initialGameState }),
    isReady: signal(true),
    status: signal('Connected'),
    removedPlayers: new Set<string>(),
    connect: vi.fn(),
  };
  const refreshedPlayers: Player[] = [
    {
      id: 'EEEE',
      name: 'Current player',
      type: PlayerType.Hidden,
      status: PlayerStatus.Connected,
    },
  ];
  const api = {
    verifyAdmin: vi.fn(() => of(void 0)),
    getPlayers: vi.fn(() => of(refreshedPlayers)),
    updatePlayer: vi.fn(() => of(undefined)),
    kickPlayer: vi.fn(() => of(undefined)),
    registerAdmin: vi.fn(() => of(void 0)),
    updateAdminFlag: vi.fn(() => of(undefined)),
    resetGame: vi.fn(() => of(undefined)),
    startGame: vi.fn(() => of(undefined)),
  };

  beforeEach(async () => {
    adminSocket.players.set(initialPlayers.map((player) => ({ ...player })));
    adminSocket.isFlagFound.set(false);
    adminSocket.gameState.set({ ...initialGameState });
    adminSocket.isReady.set(true);
    adminSocket.removedPlayers.clear();
    adminSocket.connect.mockClear();
    api.verifyAdmin.mockReset();
    api.verifyAdmin.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 401 })));
    api.getPlayers.mockReset();
    api.getPlayers.mockReturnValue(of(refreshedPlayers));
    api.updatePlayer.mockReset();
    api.updatePlayer.mockReturnValue(of(undefined));
    api.kickPlayer.mockReset();
    api.kickPlayer.mockReturnValue(of(undefined));
    api.registerAdmin.mockClear();
    api.registerAdmin.mockReturnValue(of(void 0));
    api.updateAdminFlag.mockReset();
    api.updateAdminFlag.mockReturnValue(of(undefined));
    api.resetGame.mockReset();
    api.resetGame.mockReturnValue(of(undefined));
    api.startGame.mockReset();
    api.startGame.mockReturnValue(of(undefined));

    await TestBed.configureTestingModule({
      imports: [AdminPageComponent],
      providers: [{ provide: ApiService, useValue: api }],
    })
      .overrideComponent(AdminPageComponent, {
        set: { providers: [{ provide: AdminSocketService, useValue: adminSocket }] },
      })
      .compileComponents();

    fixture = TestBed.createComponent(AdminPageComponent);
  });

  it('shows the sign-in form instead of the dashboard before authentication', () => {
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('.auth-card')).not.toBeNull();
    expect(page.querySelector('.player-list')).toBeNull();
    expect(api.verifyAdmin).toHaveBeenCalledOnce();
    expect(adminSocket.connect).not.toHaveBeenCalled();
  });

  it('restores the admin session and starts the player feed after verification', () => {
    api.verifyAdmin.mockReturnValue(of(void 0));
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    expect(api.verifyAdmin).toHaveBeenCalledOnce();
    expect(page.querySelector('.auth-card')).toBeNull();
    expect(page.querySelector('.player-list')).not.toBeNull();
    expect(adminSocket.connect).toHaveBeenCalledOnce();
  });

  it('requires the administrator password before calling the API', async () => {
    harness().loginModel.set({ password: '' });
    fixture.detectChanges();

    await harness().submit(submitEvent());
    fixture.detectChanges();

    expect(api.registerAdmin).not.toHaveBeenCalled();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('.form-status')?.textContent).toContain('administrator password');
  });

  it('keeps the sign-in form when the administrator password is incorrect', async () => {
    api.registerAdmin.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 401 })));
    harness().loginModel.set({ password: 'wrong' });
    fixture.detectChanges();

    await harness().submit(submitEvent());
    fixture.detectChanges();

    expect(api.registerAdmin).toHaveBeenCalledWith('wrong');
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('.auth-card')).not.toBeNull();
    expect(page.querySelector('.player-list')).toBeNull();
    expect(page.querySelector('.form-status')?.textContent).toContain('incorrect');
    expect(adminSocket.connect).not.toHaveBeenCalled();
  });

  it('reveals the dashboard and starts the player feed after a successful sign-in', async () => {
    harness().loginModel.set({ password: 'secret' });
    fixture.detectChanges();

    await harness().submit(submitEvent());
    fixture.detectChanges();

    expect(api.registerAdmin).toHaveBeenCalledWith('secret');
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('.auth-card')).toBeNull();
    expect(page.querySelector('.player-list')).not.toBeNull();
    expect(page.querySelector('pac-game-timer')).not.toBeNull();
    expect(page.querySelector('.game-timer-host--overlay')).toBeNull();
    expect(adminSocket.connect).toHaveBeenCalledOnce();
  });

  it('starts the admin player feed and preserves the new-tab map link', () => {
    api.verifyAdmin.mockReturnValue(of(void 0));
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    const link = page.querySelector<HTMLAnchorElement>('.admin-map-link');

    expect(adminSocket.connect).toHaveBeenCalledOnce();
    expect(link?.getAttribute('href')).toBe('/admin/map');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener');
  });

  it('disables Admin mutations until the socket snapshot is ready', () => {
    harness().authenticated.set(true);
    adminSocket.isReady.set(false);
    fixture.detectChanges();

    expect(findButton('Flag Found')?.disabled).toBe(true);
    expect(findButton('Reset Game')?.disabled).toBe(true);
    expect(findButton('Start Game — 20:00')?.disabled).toBe(true);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#type-AAAA-1')
        ?.disabled,
    ).toBe(true);

    adminSocket.isReady.set(true);
    fixture.detectChanges();

    expect(findButton('Flag Found')?.disabled).toBe(false);
    expect(findButton('Reset Game')?.disabled).toBe(false);
    expect(findButton('Start Game — 20:00')?.disabled).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#type-AAAA-1')
        ?.disabled,
    ).toBe(false);
  });

  it('starts the game and leaves flag capture available', async () => {
    harness().authenticated.set(true);
    fixture.detectChanges();

    expect(findButton('Start Game — 20:00')?.disabled).toBe(false);
    findButton('Start Game — 20:00')?.click();
    await fixture.whenStable();
    expect(api.startGame).toHaveBeenCalledOnce();

    adminSocket.gameState.set({
      isFlagFound: false,
      phase: 'in_progress',
      startTime: 1_000,
      endTime: 1_201_000,
      serverTime: 1_000,
    });
    fixture.detectChanges();
    expect(findButton('Start Game — 20:00')?.disabled).toBe(true);
    expect(findButton('Flag Found')?.disabled).toBe(false);
  });

  it('limits the custom game length to 60 minutes', async () => {
    harness().authenticated.set(true);
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      '#game-length',
    );
    expect(input?.max).toBe('60');

    if (!input) {
      throw new Error('Expected the game length input.');
    }
    input.value = '61';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(findButton('Start Game — 61:00')?.disabled).toBe(true);
    expect(api.startGame).not.toHaveBeenCalled();

    input.value = '60';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const startButton = findButton('Start Game — 60:00');
    expect(startButton?.disabled).toBe(false);

    startButton?.click();
    await fixture.whenStable();
    expect(api.startGame).toHaveBeenCalledWith(60);
  });

  it('renders the seven ordered type radios in independent groups', () => {
    harness().authenticated.set(true);
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    const cards = page.querySelectorAll<HTMLElement>('.player-card');
    const expectedLabels = [
      'Pacman',
      'Ghost',
      'Antipac',
      'Leader',
      'AntiPac Leader',
      'Flag Leader',
      'Hidden',
    ];
    const ids = new Set<string>();

    for (const [index, card] of [...cards].entries()) {
      const labels = [...card.querySelectorAll<HTMLLabelElement>('.player-types label')].map(
        (label) => label.textContent?.trim(),
      );
      const radios = card.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      expect(labels).toEqual(expectedLabels);
      expect(radios).toHaveLength(7);
      expect(new Set([...radios].map((radio) => radio.name))).toEqual(
        new Set([`type-${initialPlayers[index].id}`]),
      );
      for (const radio of radios) {
        ids.add(radio.id);
      }
    }

    expect(ids.size).toBe(initialPlayers.length * 7);
    expect(page.textContent).not.toContain('Update AAAA');
  });

  it('shows Edible as Ghost-selected and disables offline player radios', () => {
    harness().authenticated.set(true);
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    const cards = page.querySelectorAll<HTMLElement>('.player-card');
    const connectedRadios = cards[0].querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const edibleRadios = cards[1].querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const selectedLabel = cards[1]
      .querySelector<HTMLInputElement>('input[type="radio"]:checked')
      ?.nextElementSibling?.textContent?.trim();

    expect([...connectedRadios].every((radio) => !radio.disabled)).toBe(true);
    expect([...edibleRadios].every((radio) => radio.disabled)).toBe(true);
    expect(selectedLabel).toBe('Ghost');
  });

  it('applies a connected player radio selection immediately', async () => {
    harness().authenticated.set(true);
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    const antipac = page.querySelector<HTMLInputElement>('#type-AAAA-2');

    antipac?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.updatePlayer).toHaveBeenCalledWith('AAAA', PlayerType.Antipac);
    expect(adminSocket.players().find((player) => player.id === 'AAAA')?.type).toBe(
      PlayerType.Antipac,
    );
  });

  it('demotes the existing Pacman when another player is selected as Pacman', async () => {
    harness().authenticated.set(true);
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    page.querySelector<HTMLInputElement>('#type-CCCC-1')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.updatePlayer).toHaveBeenCalledWith('CCCC', PlayerType.Pacman);
    expect(adminSocket.players().find((player) => player.id === 'AAAA')?.type).toBe(
      PlayerType.Ghost,
    );
    expect(adminSocket.players().find((player) => player.id === 'CCCC')?.type).toBe(
      PlayerType.Pacman,
    );
  });

  it('demotes only the previous holder when assigning a specialized leader role', async () => {
    harness().authenticated.set(true);
    adminSocket.players.set([
      {
        id: 'AAAA',
        name: 'Existing',
        type: PlayerType.AntiPacLeader,
        status: PlayerStatus.Connected,
      },
      {
        id: 'CCCC',
        name: 'Target',
        type: PlayerType.Ghost,
        status: PlayerStatus.Connected,
      },
    ]);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    page.querySelector<HTMLInputElement>('#type-CCCC-6')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.updatePlayer).toHaveBeenCalledWith('CCCC', PlayerType.AntiPacLeader);
    expect(adminSocket.players().find((player) => player.id === 'AAAA')?.type).toBe(
      PlayerType.Leader,
    );
    expect(adminSocket.players().find((player) => player.id === 'CCCC')?.type).toBe(
      PlayerType.AntiPacLeader,
    );
  });

  it('restores server-backed selection when an immediate update fails', async () => {
    harness().authenticated.set(true);
    fixture.detectChanges();
    api.updatePlayer.mockReturnValueOnce(throwError(() => new Error('update failed')));
    const page = fixture.nativeElement as HTMLElement;
    page.querySelector<HTMLInputElement>('#type-AAAA-3')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(adminSocket.players().find((player) => player.id === 'AAAA')?.type).toBe(
      PlayerType.Pacman,
    );
    expect(page.querySelector('.admin-status')?.textContent).toContain('Could not update Ada');
    expect(page.querySelector<HTMLInputElement>('#type-AAAA-1')?.checked).toBe(true);
  });

  it('replaces the Ghost mutation with a shared Flag Found toggle', async () => {
    harness().authenticated.set(true);
    fixture.detectChanges();

    const button = findButton('Flag Found');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.classList.contains('button-secondary')).toBe(true);
    button?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.updateAdminFlag).toHaveBeenCalledWith(true);
    expect(api.updatePlayer).not.toHaveBeenCalled();
    expect(adminSocket.isFlagFound()).toBe(true);
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.classList.contains('button-secondary')).toBe(false);
  });

  it('rolls back a failed Admin flag update', async () => {
    harness().authenticated.set(true);
    adminSocket.isFlagFound.set(true);
    api.updateAdminFlag.mockReturnValueOnce(throwError(() => new Error('update failed')));
    fixture.detectChanges();
    const button = findButton('Flag Found');

    button?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.updateAdminFlag).toHaveBeenCalledWith(false);
    expect(adminSocket.isFlagFound()).toBe(true);
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.admin-status')?.textContent,
    ).toContain('Could not update flag state');
  });

  it('resets connected and offline non-Leaders to Ghost while preserving Leaders', async () => {
    harness().authenticated.set(true);
    adminSocket.isFlagFound.set(true);
    fixture.detectChanges();

    const button = findButton('Reset Game');
    button?.click();
    await fixture.whenStable();

    expect(api.resetGame).toHaveBeenCalledOnce();
    expect(api.updatePlayer).not.toHaveBeenCalled();
    expect(adminSocket.players().find((player) => player.id === 'AAAA')?.type).toBe(
      PlayerType.Ghost,
    );
    expect(adminSocket.players().find((player) => player.id === 'BBBB')?.type).toBe(
      PlayerType.Ghost,
    );
    expect(adminSocket.players().find((player) => player.id === 'DDDD')?.type).toBe(
      PlayerType.Leader,
    );
    expect(adminSocket.isFlagFound()).toBe(false);
  });

  it('cancels player removal when the native confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    harness().authenticated.set(true);
    fixture.detectChanges();

    findKickButton('AAAA')?.click();
    await fixture.whenStable();

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Ada (AAAA)'));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('register again'));
    expect(api.kickPlayer).not.toHaveBeenCalled();
    expect(adminSocket.players().some((player) => player.id === 'AAAA')).toBe(true);
  });

  it.each([
    ['connected', 'AAAA'],
    ['offline', 'BBBB'],
  ])('removes a %s player after confirmation', async (_label, playerId) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    harness().authenticated.set(true);
    fixture.detectChanges();

    findKickButton(playerId)?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.kickPlayer).toHaveBeenCalledWith(playerId);
    expect(adminSocket.players().some((player) => player.id === playerId)).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.admin-status')?.textContent,
    ).toContain('must register again');
  });

  it('drops a stale card when the player was already removed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.kickPlayer.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 404 })));
    harness().authenticated.set(true);
    fixture.detectChanges();

    findKickButton('AAAA')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(adminSocket.players().some((player) => player.id === 'AAAA')).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.admin-status')?.textContent,
    ).toContain('already removed');
  });

  it('keeps the player and reports a failed removal', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.kickPlayer.mockReturnValueOnce(throwError(() => new Error('request failed')));
    harness().authenticated.set(true);
    fixture.detectChanges();

    findKickButton('AAAA')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(adminSocket.players().some((player) => player.id === 'AAAA')).toBe(true);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.admin-status')?.textContent,
    ).toContain('Could not remove Ada (AAAA)');
  });

  it('disables every mutation while a removal request is active', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const response = new Subject<undefined>();
    api.kickPlayer.mockReturnValueOnce(response);
    harness().authenticated.set(true);
    fixture.detectChanges();

    findKickButton('AAAA')?.click();
    fixture.detectChanges();

    expect(findButton('Flag Found')?.disabled).toBe(true);
    expect(findButton('Reset Game')?.disabled).toBe(true);
    expect(
      [
        ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>(
          'input[type="radio"]',
        ),
      ].every((radio) => radio.disabled),
    ).toBe(true);
    expect(
      [
        ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
          '.player-card__kick',
        ),
      ].every((button) => button.disabled),
    ).toBe(true);

    response.next(undefined);
    response.complete();
    await fixture.whenStable();
  });

  it('renders accessible removal buttons outside each radio group', () => {
    harness().authenticated.set(true);
    fixture.detectChanges();

    const button = findKickButton('AAAA');
    expect(button?.type).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe('Remove Ada (AAAA)');
    expect(button?.title).toBe('Remove Ada (AAAA)');
    expect(button?.closest('[role="radiogroup"]')).toBeNull();
  });

  it('can manually refresh the current player list', async () => {
    harness().authenticated.set(true);
    adminSocket.isReady.set(false);
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    const refreshButton = findButton('Refresh Players');
    expect(refreshButton?.disabled).toBe(false);

    refreshButton?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.getPlayers).toHaveBeenCalledOnce();
    expect(page.querySelector('.player-card strong')?.textContent).toContain('Current player');
  });

  it('preserves a socket removal that arrives during a manual refresh', async () => {
    const response = new Subject<Player[]>();
    api.getPlayers.mockReturnValueOnce(response);
    harness().authenticated.set(true);
    fixture.detectChanges();

    findButton('Refresh Players')?.click();
    adminSocket.players.update((players) => players.filter((player) => player.id !== 'AAAA'));
    adminSocket.removedPlayers.add('AAAA');

    response.next([
      initialPlayers[0],
      {
        id: 'EEEE',
        name: 'Current player',
        type: PlayerType.Hidden,
        status: PlayerStatus.Connected,
      },
    ]);
    response.complete();
    await fixture.whenStable();
    fixture.detectChanges();

    const playerNames = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
        '.player-card strong',
      ),
    ].map((element) => element.textContent?.trim());
    expect(playerNames).toEqual(['Current player']);
  });

  function findButton(label: string): HTMLButtonElement | undefined {
    const page = fixture.nativeElement as HTMLElement;
    return [...page.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === label,
    );
  }

  function findKickButton(playerId: string): HTMLButtonElement | null {
    const page = fixture.nativeElement as HTMLElement;
    return page.querySelector<HTMLButtonElement>(`.player-card__kick[aria-label$="(${playerId})"]`);
  }

  function harness(): AdminPageHarness {
    return fixture.componentInstance as unknown as AdminPageHarness;
  }
});

interface AdminPageHarness {
  authenticated: WritableSignal<boolean>;
  loginModel: WritableSignal<{ password: string }>;
  submit(event: SubmitEvent): Promise<void>;
}

function submitEvent(): SubmitEvent {
  return { preventDefault: vi.fn() } as unknown as SubmitEvent;
}
