import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { PAC_WINDOW } from '../../core/browser-window.token';
import { LivePlayer, MapInfo, PlayerType, Representation } from '../../core/game.models';
import {
  CANVAS_PADDING,
  clampLabelX,
  convertCoords,
  getCanvasMetrics,
  isPlotInside,
  LABEL_FONT_SIZE,
  LABEL_OFFSET,
  MAP_PIXEL_SCALE,
  SPRITE_HEIGHT,
  SPRITE_LEFT_OFFSET,
  SPRITE_TOP_OFFSET,
  SPRITE_WIDTH,
} from '../../core/map.utils';

type SpriteName = 'pacman' | 'antipac' | 'ghost' | 'edible' | 'coin' | 'leader';

const SPRITE_PATHS: Record<SpriteName, string> = {
  pacman: '/static/game/pacman.png',
  antipac: '/static/game/anti_pacman.png',
  ghost: '/static/game/ghost.png',
  edible: '/static/game/edible.png',
  coin: '/static/game/coin.png',
  leader: '/static/game/leader.png',
};

@Component({
  selector: 'pac-game-canvas',
  templateUrl: './game-canvas.component.html',
  styleUrl: './game-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameCanvasComponent {
  private readonly browserWindow = inject(PAC_WINDOW);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly imagesReady = signal(false);

  readonly map = input.required<MapInfo>();
  readonly players = input.required<Record<string, LivePlayer>>();
  readonly selfId = input.required<string>();

  constructor() {
    afterNextRender(() => void this.loadImages());
    effect(() => {
      const ready = this.imagesReady();
      const map = this.map();
      const players = this.players();
      const selfId = this.selfId();
      const canvas = this.canvas();
      if (ready) {
        this.draw(canvas.nativeElement, map, players, selfId);
      }
    });
  }

  private async loadImages(): Promise<void> {
    if (!this.browserWindow) {
      return;
    }

    const paths: Record<string, string> = { map: '/static/game/map.svg', ...SPRITE_PATHS };
    try {
      await Promise.all(
        Object.entries(paths).map(
          ([name, path]) =>
            new Promise<void>((resolve, reject) => {
              const image = new this.browserWindow!.Image();
              image.addEventListener('load', () => {
                this.images.set(name, image);
                resolve();
              });
              image.addEventListener('error', () => reject(new Error(`Could not load ${path}`)));
              image.src = path;
            }),
        ),
      );
      this.imagesReady.set(true);
    } catch {
      this.imagesReady.set(false);
    }
  }

  private draw(
    canvas: HTMLCanvasElement,
    map: MapInfo,
    players: Record<string, LivePlayer>,
    selfId: string,
  ): void {
    const context = canvas.getContext('2d');
    const mapImage = this.images.get('map');
    if (!context || !mapImage) {
      return;
    }

    const metrics = getCanvasMetrics(map);
    canvas.width = metrics.canvasWidth;
    canvas.height = metrics.canvasHeight;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      mapImage,
      CANVAS_PADDING.left,
      CANVAS_PADDING.top,
      metrics.mapWidth,
      metrics.mapHeight,
    );
    context.font = `${LABEL_FONT_SIZE}px Inter, sans-serif`;
    context.textAlign = 'center';
    context.fillStyle = '#fff';

    for (const [id, livePlayer] of Object.entries(players)) {
      if (livePlayer.player.type === PlayerType.Hidden) {
        continue;
      }
      const spriteName = this.getSpriteName(livePlayer);
      const sprite = spriteName ? this.images.get(spriteName) : null;
      const plot = convertCoords(map, livePlayer.coordinate);
      if (!sprite || !plot || !isPlotInside(map, plot)) {
        continue;
      }

      const anchorX = CANVAS_PADDING.left + plot.x * MAP_PIXEL_SCALE;
      const anchorY = CANVAS_PADDING.top + plot.y * MAP_PIXEL_SCALE;
      context.drawImage(
        sprite,
        anchorX - SPRITE_LEFT_OFFSET,
        anchorY - SPRITE_TOP_OFFSET,
        SPRITE_WIDTH,
        SPRITE_HEIGHT,
      );

      const label = `${livePlayer.player.name} (${id === selfId ? 'You' : id})`;
      const labelX = clampLabelX(anchorX, context.measureText(label).width, canvas.width);
      context.fillText(label, labelX, anchorY - LABEL_OFFSET);
    }
  }

  private getSpriteName(livePlayer: LivePlayer): SpriteName | null {
    if (livePlayer.player.type === PlayerType.Leader) {
      return livePlayer.player.reps === Representation.Pacman ? 'coin' : 'leader';
    }

    const sprites: Partial<Record<Representation, SpriteName>> = {
      [Representation.Pacman]: 'pacman',
      [Representation.Antipac]: 'antipac',
      [Representation.Ghost]: 'ghost',
      [Representation.Edible]: 'edible',
    };
    return sprites[livePlayer.player.reps] ?? null;
  }
}
