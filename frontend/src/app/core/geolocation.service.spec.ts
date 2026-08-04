import { isAccurateEnough, MAX_LOCATION_ACCURACY_METRES } from './geolocation.service';

describe('geolocation accuracy policy', () => {
  it(`accepts readings at or below ${MAX_LOCATION_ACCURACY_METRES} metres`, () => {
    expect(isAccurateEnough(0)).toBe(true);
    expect(isAccurateEnough(MAX_LOCATION_ACCURACY_METRES)).toBe(true);
  });

  it('rejects inaccurate and invalid readings', () => {
    expect(isAccurateEnough(MAX_LOCATION_ACCURACY_METRES + 0.01)).toBe(false);
    expect(isAccurateEnough(-1)).toBe(false);
    expect(isAccurateEnough(Number.NaN)).toBe(false);
  });
});
