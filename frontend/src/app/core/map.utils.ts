import { Coordinate, MapInfo, Plot } from './game.models';

export const MAP_PIXEL_SCALE = 32;
export const SPRITE_WIDTH = 96;
export const SPRITE_HEIGHT = 96;
export const SPRITE_LEFT_OFFSET = 48;
export const SPRITE_TOP_OFFSET = 88;
export const LABEL_OFFSET = 112;
export const LABEL_FONT_SIZE = 20;
export const CANVAS_PADDING = {
  left: SPRITE_LEFT_OFFSET,
  right: SPRITE_WIDTH - SPRITE_LEFT_OFFSET,
  top: LABEL_OFFSET + LABEL_FONT_SIZE + 4,
  bottom: SPRITE_HEIGHT - SPRITE_TOP_OFFSET,
} as const;

export interface CanvasMetrics {
  mapWidth: number;
  mapHeight: number;
  canvasWidth: number;
  canvasHeight: number;
}

export function convertCoords(map: MapInfo, coordinate: Coordinate): Plot | null {
  const values = [
    map.min.latitude,
    map.min.longitude,
    map.max.latitude,
    map.max.longitude,
    map.width,
    map.height,
    coordinate.latitude,
    coordinate.longitude,
  ];

  if (!values.every(Number.isFinite)) {
    return null;
  }

  const latitudeRange = map.max.latitude - map.min.latitude;
  const longitudeRange = map.max.longitude - map.min.longitude;
  if (latitudeRange <= 0 || longitudeRange <= 0 || map.width <= 0 || map.height <= 0) {
    return null;
  }

  return {
    x: ((coordinate.longitude - map.min.longitude) / longitudeRange) * map.width,
    y: map.height - ((coordinate.latitude - map.min.latitude) / latitudeRange) * map.height,
  };
}

export function isPlotInside(map: MapInfo, plot: Plot): boolean {
  return plot.x >= 0 && plot.x <= map.width && plot.y >= 0 && plot.y <= map.height;
}

export function getCanvasMetrics(map: MapInfo): CanvasMetrics {
  const mapWidth = map.width * MAP_PIXEL_SCALE;
  const mapHeight = map.height * MAP_PIXEL_SCALE;
  return {
    mapWidth,
    mapHeight,
    canvasWidth: mapWidth + CANVAS_PADDING.left + CANVAS_PADDING.right,
    canvasHeight: mapHeight + CANVAS_PADDING.top + CANVAS_PADDING.bottom,
  };
}

export function clampLabelX(x: number, textWidth: number, canvasWidth: number): number {
  const margin = 4;
  const halfWidth = Math.min(textWidth / 2, Math.max(0, canvasWidth / 2 - margin));
  return Math.min(canvasWidth - halfWidth - margin, Math.max(halfWidth + margin, x));
}
