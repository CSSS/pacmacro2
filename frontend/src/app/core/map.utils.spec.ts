import { clampLabelX, convertCoords, getCanvasMetrics, isPlotInside } from './map.utils';
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

  it('sizes the canvas to the map dimensions', () => {
    expect(getCanvasMetrics(map)).toEqual({
      mapWidth: 1024,
      mapHeight: 512,
      canvasWidth: 1024,
      canvasHeight: 512,
    });
  });

  it('clamps long labels to the canvas width', () => {
    expect(clampLabelX(0, 120, 300)).toBe(64);
    expect(clampLabelX(300, 120, 300)).toBe(236);
  });
});
