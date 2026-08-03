import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { MapInfo, Player, PlayerType, Representation } from './game.models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  getMap(): Observable<MapInfo> {
    return this.http.get<MapInfo>('/api/game/map.json');
  }

  register(type: PlayerType, name: string, password: string): Observable<string> {
    const body = new FormData();
    body.set('type', String(type));
    body.set('name', name);
    body.set('pass', password);
    return this.http.post('/api/player/register', body, { responseType: 'text' });
  }

  getPlayers(): Observable<Player[]> {
    return this.http.get<Player[]>('/api/player/list.json');
  }

  updatePlayer(
    playerId: string,
    adminId: string,
    adminPassword: string,
    type: PlayerType,
    reps: Representation,
  ): Observable<string> {
    const body = new FormData();
    body.set('id', adminId);
    body.set('pass', adminPassword);
    body.set('type', String(type));
    body.set('reps', String(reps));
    return this.http.post(`/api/admin/update/${encodeURIComponent(playerId)}`, body, {
      responseType: 'text',
    });
  }
}
