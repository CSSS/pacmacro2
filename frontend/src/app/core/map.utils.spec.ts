import {
  CANVAS_PADDING,
  clampLabelX,
  convertCoords,
  getCanvasMetrics,
  isPlotInside,
  LABEL_OFFSET,
  MAP_PIXEL_SCALE,
  SPRITE_HEIGHT,
  SPRITE_LEFT_OFFSET,
  SPRITE_TOP_OFFSET,
  SPRITE_WIDTH,
} from './map.utils';
import { MapInfo } from './game.models';

describe('map utilities', () => {
  const map: MapInfo = {
    min: { latitude: 10, longitude: 20 },
    max: { latitude: 20, longitude: 40 },
    width: 32,
    height: 16,
    isFlagFound: false,
  };

  it('converts the map corners and centre', () => {
    expect(convertCoords(map, { latitude: 10, longitude: 20 })).toEqual({ x: 0, y: 16 });
    expect(convertCoords(map, { latitude: 20, longitude: 40 })).toEqual({ x: 32, y: 0 });
    expect(convertCoords(map, { latitude: 15, longitude: 30 })).toEqual({ x: 16, y: 8 });
  });

  it('identifies points outside the playable area', () => {
    const plot = convertCoords(map, { latitude: 25, longitude: 30 });
    expect(plot).not.toBeNull();
    expect(isPlotInside(map, plot!)).toBe(false);
  });

  it('rejects invalid and zero-size coordinate bounds', () => {
    expect(convertCoords({ ...map, max: map.min }, map.min)).toBeNull();
    expect(convertCoords(map, { latitude: Number.NaN, longitude: 30 })).toBeNull();
  });

  it('keeps edge sprites and label baselines inside the padded canvas', () => {
    const metrics = getCanvasMetrics(map);
    const leftAnchor = CANVAS_PADDING.left;
    const rightAnchor = CANVAS_PADDING.left + map.width * MAP_PIXEL_SCALE;
    const topAnchor = CANVAS_PADDING.top;
    const bottomAnchor = CANVAS_PADDING.top + map.height * MAP_PIXEL_SCALE;

    expect(leftAnchor - SPRITE_LEFT_OFFSET).toBeGreaterThanOrEqual(0);
    expect(rightAnchor - SPRITE_LEFT_OFFSET + SPRITE_WIDTH).toBeLessThanOrEqual(
      metrics.canvasWidth,
    );
    expect(topAnchor - LABEL_OFFSET).toBeGreaterThan(0);
    expect(topAnchor - SPRITE_TOP_OFFSET).toBeGreaterThanOrEqual(0);
    expect(bottomAnchor - SPRITE_TOP_OFFSET + SPRITE_HEIGHT).toBeLessThanOrEqual(
      metrics.canvasHeight,
    );
  });

  it('clamps long labels to the canvas width', () => {
    expect(clampLabelX(0, 120, 300)).toBe(64);
    expect(clampLabelX(300, 120, 300)).toBe(236);
  });
});
