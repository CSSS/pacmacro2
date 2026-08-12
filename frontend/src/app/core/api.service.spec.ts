import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ApiService } from './api.service';
import { PlayerType } from './game.models';

describe('ApiService', () => {
  let api: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('loads the map from the same-origin API', () => {
    api.getMap().subscribe();
    http.expectOne('/api/game/map.json').flush({
      min: { latitude: 0, longitude: 0 },
      max: { latitude: 1, longitude: 1 },
      width: 32,
      height: 32,
      isFlagFound: false,
    });
  });

  it('registers a player and reads the response', () => {
    api.registerPlayer('Test').subscribe();
    const request = http.expectOne('/api/player/register');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'Test' });
    expect(request.request.detectContentTypeHeader()).toBe('application/json');
    request.flush({ id: 'ABCD' });
  });

  it('registers the admin separately and requests cookie credentials', () => {
    api.registerAdmin('Test2', 'top-secret').subscribe();
    const request = http.expectOne('/api/admin/register');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({ name: 'Test2', pass: 'top-secret' });
    expect(request.request.detectContentTypeHeader()).toBe('application/json');
    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('fetches the current player list', () => {
    api.getPlayers().subscribe();
    const request = http.expectOne('/api/player/list.json');

    expect(request.request.method).toBe('GET');
    request.flush([]);
  });

  it('updates one player type with admin credentials', () => {
    api.updatePlayer('AB CD', PlayerType.Leader).subscribe();
    const request = http.expectOne('/api/admin/update/AB%20CD');

    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({ type: PlayerType.Leader });
    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('resets the game with admin credentials', () => {
    api.resetGame().subscribe();
    const request = http.expectOne('/api/admin/reset');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toBeNull();
    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('updates flag state with admin credentials', () => {
    api.updateAdminFlag(true).subscribe();
    const request = http.expectOne('/api/admin/flag');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({ isFlagFound: true });
    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('loads leader state and sends capability updates', () => {
    api.getLeaderState().subscribe();
    const stateRequest = http.expectOne('/api/leader/state.json');
    expect(stateRequest.request.method).toBe('GET');
    expect(stateRequest.request.withCredentials).toBe(true);
    stateRequest.flush({
      leader: { id: 'LEAD', name: 'Leader', type: PlayerType.AntiPacLeader, status: 1 },
      players: [],
      isFlagFound: false,
    });

    api.updateLeaderPlayer('AB CD', PlayerType.Antipac).subscribe();
    const updateRequest = http.expectOne('/api/leader/update/AB%20CD');
    expect(updateRequest.request.method).toBe('POST');
    expect(updateRequest.request.withCredentials).toBe(true);
    expect(updateRequest.request.body).toEqual({ type: PlayerType.Antipac });
    updateRequest.flush(null, { status: 204, statusText: 'No Content' });

    api.updateFlag(true).subscribe();
    const flagRequest = http.expectOne('/api/leader/flag');
    expect(flagRequest.request.method).toBe('POST');
    expect(flagRequest.request.withCredentials).toBe(true);
    expect(flagRequest.request.body).toEqual({ isFlagFound: true });
    flagRequest.flush(null, { status: 204, statusText: 'No Content' });
  });
});
