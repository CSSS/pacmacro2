import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { GameSocketService } from '../../core/sockets/game-socket.service';
import { MapInfo } from '../../core/game.models';
import { AdminMapPageComponent } from './admin-map-page.component';

describe('AdminMapPageComponent', () => {
  let fixture: ComponentFixture<AdminMapPageComponent>;
  const map: MapInfo = {
    min: { latitude: 49.27, longitude: -122.92 },
    max: { latitude: 49.28, longitude: -122.9 },
    width: 32,
    height: 32,
    isFlagFound: false,
  };
  const gameSocket = {
    players: signal({}),
    status: signal('Not connected.'),
    isFlagFound: signal(false),
    setInitialState: vi.fn(),
    startViewer: vi.fn((onConnected: () => void) => onConnected()),
    resume: vi.fn(),
    suspend: vi.fn(),
    stop: vi.fn(),
  };
  const api = {
    getMap: vi.fn(() => of(map)),
  };

  beforeEach(async () => {
    gameSocket.startViewer.mockClear();
    gameSocket.resume.mockClear();
    gameSocket.suspend.mockClear();
    gameSocket.stop.mockClear();
    gameSocket.status.set('Not connected.');
    api.getMap.mockReset();
    api.getMap.mockReturnValue(of(map));

    await TestBed.configureTestingModule({
      imports: [AdminMapPageComponent],
      providers: [{ provide: ApiService, useValue: api }],
    })
      .overrideComponent(AdminMapPageComponent, {
        set: { providers: [{ provide: GameSocketService, useValue: gameSocket }] },
      })
      .compileComponents();
  });

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(AdminMapPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('loads the map, starts viewer mode, and matches the regular map structure', async () => {
    const page = await render();

    expect(api.getMap).toHaveBeenCalledOnce();
    expect(gameSocket.startViewer).toHaveBeenCalledOnce();
    expect(page.querySelector('pac-brand-header')).not.toBeNull();
    expect(page.querySelector('main.game-page.admin-map-page')).not.toBeNull();
    expect(page.querySelector('h1')?.textContent?.trim()).toBe('PacMacro');
    expect(page.querySelector('.game-page__status')).not.toBeNull();
    expect(page.querySelector('pac-game-canvas')).not.toBeNull();
  });

  it('omits player identity, geolocation, controls, and wake-lock elements', async () => {
    const page = await render();

    expect(page.querySelectorAll('.game-page__status p')).toHaveLength(2);
    expect(page.querySelector('.game-page__wake-lock')).toBeNull();
    expect(page.querySelector('.game-page__wake-status')).toBeNull();
    expect(page.querySelector('input, button, label')).toBeNull();
    expect(page.textContent).not.toContain('(You)');
  });

  it('shows a map-loading error and does not start the viewer socket', async () => {
    api.getMap.mockReturnValue(throwError(() => new Error('map unavailable')));
    const page = await render();

    expect(page.textContent).toContain('Could not load the PacMacro map');
    expect(gameSocket.startViewer).not.toHaveBeenCalled();
    expect(page.querySelector('pac-game-canvas')).toBeNull();
  });
});
