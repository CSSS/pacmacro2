import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ApiService } from './api.service';
import { PlayerType, Representation } from './game.models';

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

  it('submits the legacy registration fields', () => {
    api.register(PlayerType.Leader, 'Ada', '1234').subscribe();
    const request = http.expectOne('/api/player/register');
    expect(request.request.method).toBe('POST');
    expect(request.request.body.get('type')).toBe('1');
    expect(request.request.body.get('name')).toBe('Ada');
    expect(request.request.body.get('pass')).toBe('1234');
    request.flush('ABCD');
  });

  it('encodes the target ID and submits admin update fields', () => {
    api
      .updatePlayer('A/B', 'ADMIN', 'secret', PlayerType.Hidden, Representation.Edible)
      .subscribe();
    const request = http.expectOne('/api/admin/update/A%2FB');
    expect(request.request.body.get('id')).toBe('ADMIN');
    expect(request.request.body.get('pass')).toBe('secret');
    expect(request.request.body.get('type')).toBe('3');
    expect(request.request.body.get('reps')).toBe('4');
    request.flush('');
  });
});
