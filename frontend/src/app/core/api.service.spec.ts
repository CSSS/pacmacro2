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
    });
  });

  it('registers a player and reads the response', () => {
    api.registerPlayer(PlayerType.Leader, 'Test').subscribe();
    const request = http.expectOne('/api/player/register');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ type: 1, name: 'Test' });
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
});
