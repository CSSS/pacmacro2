import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';

import { PAC_WINDOW } from './browser-window.token';
import { Credentials } from './game.models';

export const DEFAULT_PLAYER_PASSWORD = '1234';

export function readCookie(cookieHeader: string, name: string): string {
  const prefix = `${name}=`;
  const value = cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix))
    ?.slice(prefix.length);

  if (!value) {
    return '';
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

@Injectable({ providedIn: 'root' })
export class CredentialsService {
  private readonly document = inject(DOCUMENT);
  private readonly browserWindow = inject(PAC_WINDOW);

  get(): Credentials {
    if (!this.browserWindow) {
      return { id: '', password: DEFAULT_PLAYER_PASSWORD };
    }

    return {
      id: readCookie(this.document.cookie, 'id'),
      password: readCookie(this.document.cookie, 'password') || DEFAULT_PLAYER_PASSWORD,
    };
  }

  save(credentials: Credentials): void {
    if (!this.browserWindow) {
      return;
    }

    const secure = this.browserWindow.location.protocol === 'https:' ? '; Secure' : '';
    const attributes = `; Path=/; SameSite=Lax${secure}`;
    this.document.cookie = `id=${encodeURIComponent(credentials.id)}${attributes}`;
    this.document.cookie = `password=${encodeURIComponent(credentials.password)}${attributes}`;
  }
}
