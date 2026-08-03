import { afterNextRender, ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { CredentialsService, DEFAULT_PLAYER_PASSWORD } from '../../core/credentials.service';
import { BrandHeaderComponent } from '../../shared/brand-header/brand-header.component';

@Component({
  selector: 'pac-login-page',
  imports: [BrandHeaderComponent, RouterLink],
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPageComponent {
  private readonly credentials = inject(CredentialsService);
  private readonly router = inject(Router);

  protected readonly playerId = signal('');
  protected readonly status = signal('');

  constructor() {
    afterNextRender(() => this.playerId.set(this.credentials.get().id));
  }

  protected async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const id = this.playerId().trim().toUpperCase();
    if (!id) {
      this.status.set('Enter your player ID.');
      return;
    }

    const current = this.credentials.get();
    this.credentials.save({ id, password: current.password || DEFAULT_PLAYER_PASSWORD });
    await this.router.navigateByUrl('/');
  }
}
