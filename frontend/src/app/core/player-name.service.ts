import { inject, Service, signal } from '@angular/core';
import { PAC_WINDOW } from './browser-window.token';

const PLAYER_NAME_KEY = 'playerName';

@Service()
export class PlayerNameService {
  private readonly browserWindow = inject(PAC_WINDOW);
  private readonly statusMessage = signal<string | null>(null);

  get(): string {
    try {
      return this.browserWindow?.localStorage.getItem(PLAYER_NAME_KEY) ?? '';
    } catch {
      return '';
    }
  }

  save(name: string): void {
    try {
      this.browserWindow?.localStorage.setItem(PLAYER_NAME_KEY, name);
    } catch {
      this.statusMessage.set('Could not save your name for auto-re-registration.');
    }
  }
}
