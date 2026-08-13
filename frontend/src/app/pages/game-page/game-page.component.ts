import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { PAC_WINDOW } from '../../core/browser-window.token';
import { CredentialsService } from '../../core/credentials.service';
import { GameSocketService } from '../../core/sockets/game-socket.service';
import { GeolocationService } from '../../core/geolocation.service';
import { isLeaderType, MapInfo, typeLabel } from '../../core/game.models';
import { WakeLockService } from '../../core/wake-lock.service';
import { GameCanvasComponent } from '../../game/game-canvas/game-canvas.component';
import { BrandHeaderComponent } from '../../shared/brand-header/brand-header.component';

@Component({
  selector: 'pac-game-page',
  imports: [BrandHeaderComponent, GameCanvasComponent],
  providers: [GameSocketService, GeolocationService, WakeLockService],
  templateUrl: './game-page.component.html',
  styleUrl: './game-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GamePageComponent {
  private readonly api = inject(ApiService);
  private readonly browserWindow = inject(PAC_WINDOW);
  private readonly credentials = inject(CredentialsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  protected readonly socket = inject(GameSocketService);
  protected readonly geolocation = inject(GeolocationService);
  protected readonly wakeLock = inject(WakeLockService);
  protected readonly map = signal<MapInfo | null>(null);
  protected readonly selfId = signal('');
  protected readonly pageStatus = signal('Loading the game map…');
  protected readonly selfSummary = computed(() => {
    const player = this.socket.players()[this.selfId()]?.player;
    return player ? `${player.name} (${player.id}) is ${typeLabel(player.type)}` : '';
  });
  protected readonly showLeaderLink = computed(() => {
    const player = this.socket.players()[this.selfId()]?.player;
    return player ? isLeaderType(player.type) : false;
  });

  private readonly onVisibilityChange = () => {
    void this.wakeLock.handleVisibilityChange();
  };
  private readonly onOnline = () => this.socket.resume();
  private readonly onOffline = () => {
    this.geolocation.stop();
    this.socket.suspend('Offline. Waiting for a network connection…');
  };

  constructor() {
    afterNextRender(() => void this.initialize());
    this.destroyRef.onDestroy(() => this.cleanup());
  }

  protected async toggleWakeLock(event: Event): Promise<void> {
    await this.wakeLock.setEnabled((event.target as HTMLInputElement).checked);
  }

  private async initialize(): Promise<void> {
    if (!this.browserWindow) {
      return;
    }

    const credentials = this.credentials.get();
    if (!credentials.id) {
      await this.router.navigateByUrl('/register');
      return;
    }
    this.selfId.set(credentials.id);
    this.wakeLock.initialize();

    try {
      const map = await firstValueFrom(this.api.getMap());
      this.map.set(map);
      this.socket.setInitialState(map);
    } catch {
      this.pageStatus.set(
        'Could not load the PacMacro map. Check the API connection and try again.',
      );
      return;
    }

    this.pageStatus.set('Map loaded. Connecting to the game…');
    this.browserWindow.document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.browserWindow.addEventListener('online', this.onOnline);
    this.browserWindow.addEventListener('offline', this.onOffline);
    this.socket.start(credentials.id, () => {
      this.pageStatus.set('Connected to PacMacro.');
      this.geolocation.start((coordinate) => this.socket.sendCoordinate(coordinate));
    });
  }

  private cleanup(): void {
    this.geolocation.stop();
    this.socket.stop();
    void this.wakeLock.release();
    if (this.browserWindow) {
      this.browserWindow.document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.browserWindow.removeEventListener('online', this.onOnline);
      this.browserWindow.removeEventListener('offline', this.onOffline);
    }
  }
}
