import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { PAC_WINDOW } from '../../core/browser-window.token';
import { GameSocketService } from '../../core/sockets/game-socket.service';
import { MapInfo } from '../../core/game.models';
import { GameCanvasComponent } from '../../game/game-canvas/game-canvas.component';
import { BrandHeaderComponent } from '../../shared/brand-header/brand-header.component';

@Component({
  selector: 'pac-admin-map-page',
  imports: [BrandHeaderComponent, GameCanvasComponent],
  providers: [GameSocketService],
  templateUrl: './admin-map-page.component.html',
  styleUrl: './admin-map-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminMapPageComponent {
  private readonly api = inject(ApiService);
  private readonly browserWindow = inject(PAC_WINDOW);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly socket = inject(GameSocketService);
  protected readonly map = signal<MapInfo | null>(null);
  protected readonly pageStatus = signal('Loading the game map…');

  private readonly onOnline = () => this.socket.resume();
  private readonly onOffline = () =>
    this.socket.suspend('Offline. Waiting for a network connection…');

  constructor() {
    afterNextRender(() => void this.initialize());
    this.destroyRef.onDestroy(() => this.cleanup());
  }

  private async initialize(): Promise<void> {
    if (!this.browserWindow) {
      return;
    }

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

    this.pageStatus.set('Map loaded. Connecting to the admin viewer…');
    this.browserWindow.addEventListener('online', this.onOnline);
    this.browserWindow.addEventListener('offline', this.onOffline);
    this.socket.startViewer(() => this.pageStatus.set('Connected to PacMacro.'));
  }

  private cleanup(): void {
    this.socket.stop();
    if (this.browserWindow) {
      this.browserWindow.removeEventListener('online', this.onOnline);
      this.browserWindow.removeEventListener('offline', this.onOffline);
    }
  }
}
