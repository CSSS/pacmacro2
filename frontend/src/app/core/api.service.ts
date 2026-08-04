import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { Observable } from 'rxjs';

import {
  MapInfo,
  Player,
  PlayerRegistrationResponse,
  PlayerType,
  Representation,
} from './game.models';

@Service()
export class ApiService {
  private readonly http = inject(HttpClient);

  getMap(): Observable<MapInfo> {
    return this.http.get<MapInfo>('/api/game/map.json');
  }

  registerPlayer(type: PlayerType, name: string): Observable<PlayerRegistrationResponse> {
    return this.http.post<PlayerRegistrationResponse>('/api/player/register', {
      type,
      name,
    });
  }

  registerAdmin(name: string, password: string): Observable<void> {
    return this.http.post<void>(
      '/api/admin/register',
      { name, pass: password },
      { withCredentials: true },
    );
  }

  getPlayers(): Observable<Player[]> {
    return this.http.get<Player[]>('/api/player/list.json');
  }

  updatePlayer(playerId: string, type: PlayerType, reps: Representation): Observable<void> {
    return this.http.post<void>(
      `/api/admin/update/${encodeURIComponent(playerId)}`,
      { type, reps },
      {
        withCredentials: true,
      },
    );
  }
}
