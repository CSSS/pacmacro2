import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { AdminSocketService } from '../../core/admin-socket.service';
import { ApiService } from '../../core/api.service';
import { PlayerStatus, PlayerType, Representation } from '../../core/game.models';
import { AdminPageComponent } from './admin-page.component';

describe('AdminPageComponent', () => {
  let fixture: ComponentFixture<AdminPageComponent>;
  const adminSocket = {
    players: signal([
      {
        id: 'AAAA',
        type: PlayerType.Player,
        name: 'Ada',
        reps: Representation.Pacman,
        status: PlayerStatus.Connected,
      },
      {
        id: 'BBBB',
        type: PlayerType.Player,
        name: 'Ben',
        reps: Representation.Nothing,
        status: PlayerStatus.Disconnected,
      },
    ]),
    status: signal('Live player updates connected.'),
    start: vi.fn(),
  };
  const api = {
    updatePlayer: vi.fn(() => of(undefined)),
  };

  beforeEach(async () => {
    adminSocket.start.mockClear();
    await TestBed.configureTestingModule({
      imports: [AdminPageComponent],
      providers: [{ provide: ApiService, useValue: api }],
    })
      .overrideComponent(AdminPageComponent, {
        set: { providers: [{ provide: AdminSocketService, useValue: adminSocket }] },
      })
      .compileComponents();

    fixture = TestBed.createComponent(AdminPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('starts the admin player feed after rendering in the browser', () => {
    expect(adminSocket.start).toHaveBeenCalledOnce();
  });

  it('grays out disconnected players and disables their state controls', () => {
    const page = fixture.nativeElement as HTMLElement;
    const cards = page.querySelectorAll<HTMLElement>('.player-card');
    const offlineCard = cards[1];

    expect(offlineCard.classList.contains('player-card--offline')).toBe(true);
    expect(offlineCard.querySelector('.player-card__status')?.textContent).toContain('Offline');
    for (const control of offlineCard.querySelectorAll<HTMLSelectElement | HTMLButtonElement>(
      'select, button',
    )) {
      expect(control.disabled).toBe(true);
    }

    const connectedControls = cards[0].querySelectorAll<HTMLSelectElement | HTMLButtonElement>(
      'select, button',
    );
    expect([...connectedControls].every((control) => !control.disabled)).toBe(true);
  });
});
