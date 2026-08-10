import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { Observable } from 'rxjs';

import {
  LeaderState,
  MapInfo,
  Player,
  PlayerRegistrationResponse,
  PlayerType,
} from './game.models';

@Service()
export class ApiService {
  private readonly http = inject(HttpClient);

  getMap(): Observable<MapInfo> {
    return this.http.get<MapInfo>('/api/game/map.json');
  }

  registerPlayer(name: string): Observable<PlayerRegistrationResponse> {
    return this.http.post<PlayerRegistrationResponse>('/api/player/register', {
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

  updatePlayer(playerId: string, playerType: PlayerType): Observable<void> {
    return this.http.post<void>(
      `/api/admin/update/${encodeURIComponent(playerId)}`,
      { type: playerType },
      {
        withCredentials: true,
      },
    );
  }

  resetGame(): Observable<void> {
    return this.http.post<void>('/api/admin/reset', null, { withCredentials: true });
  }

  getLeaderState(): Observable<LeaderState> {
    return this.http.get<LeaderState>('/api/leader/state.json', { withCredentials: true });
  }

  updateLeaderPlayer(playerId: string, playerType: PlayerType): Observable<void> {
    return this.http.post<void>(
      `/api/leader/update/${encodeURIComponent(playerId)}`,
      { type: playerType },
      { withCredentials: true },
    );
  }

  updateFlag(isFlagFound: boolean): Observable<void> {
    return this.http.post<void>('/api/leader/flag', { isFlagFound }, { withCredentials: true });
  }
}
