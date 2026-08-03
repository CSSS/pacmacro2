import { inject, Injectable, signal } from '@angular/core';

import { PAC_WINDOW } from './browser-window.token';
import { Coordinate } from './game.models';

export const MAX_LOCATION_ACCURACY_METRES = 100;

export function isAccurateEnough(
  accuracy: number,
  maximum = MAX_LOCATION_ACCURACY_METRES,
): boolean {
  return Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= maximum;
}

@Injectable()
export class GeolocationService {
  private readonly browserWindow = inject(PAC_WINDOW);
  private watchId: number | null = null;

  readonly accuracy = signal<number | null>(null);
  readonly lastAccepted = signal<Coordinate | null>(null);
  readonly status = signal('Waiting for location permission…');

  start(onAccepted: (coordinate: Coordinate) => void): void {
    this.stop();
    const geolocation = this.browserWindow?.navigator.geolocation;
    if (!geolocation) {
      this.status.set('Geolocation is not available in this browser.');
      return;
    }

    this.status.set('Finding an accurate location…');
    this.watchId = geolocation.watchPosition(
      (position) => {
        const accuracy = position.coords.accuracy;
        this.accuracy.set(accuracy);
        if (!isAccurateEnough(accuracy)) {
          this.status.set(
            `Location accuracy is ${Math.round(accuracy)} m; waiting for ${MAX_LOCATION_ACCURACY_METRES} m or better.`,
          );
          return;
        }

        const coordinate = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        if (![coordinate.latitude, coordinate.longitude].every(Number.isFinite)) {
          this.status.set('The device returned an invalid location.');
          return;
        }

        this.lastAccepted.set(coordinate);
        this.status.set(`Location accuracy: ${Math.round(accuracy)} m.`);
        onAccepted(coordinate);
      },
      (error) => {
        const messages: Record<number, string> = {
          1: 'Location permission was denied.',
          2: 'The device could not determine its location.',
          3: 'Location lookup timed out; trying again.',
        };
        this.status.set(messages[error.code] ?? 'Unable to read the device location.');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 },
    );
  }

  stop(): void {
    if (this.watchId !== null && this.browserWindow?.navigator.geolocation) {
      this.browserWindow.navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
  }
}
