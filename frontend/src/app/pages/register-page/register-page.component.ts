import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { CredentialsService, DEFAULT_PLAYER_PASSWORD } from '../../core/credentials.service';
import { PlayerType } from '../../core/game.models';
import { BrandHeaderComponent } from '../../shared/brand-header/brand-header.component';

@Component({
  selector: 'pac-register-page',
  imports: [BrandHeaderComponent, RouterLink],
  templateUrl: './register-page.component.html',
  styleUrl: './register-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterPageComponent {
  private readonly api = inject(ApiService);
  private readonly credentials = inject(CredentialsService);
  private readonly router = inject(Router);

  protected readonly playerType = signal(PlayerType.Froshee);
  protected readonly name = signal('');
  protected readonly status = signal('');
  protected readonly submitting = signal(false);
  protected readonly PlayerType = PlayerType;

  protected async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.submitting()) {
      return;
    }

    const name = this.name().trim();
    if (!name) {
      this.status.set('Enter your name.');
      return;
    }

    this.submitting.set(true);
    this.status.set('Registering…');
    try {
      const id = (
        await firstValueFrom(this.api.register(this.playerType(), name, DEFAULT_PLAYER_PASSWORD))
      ).trim();
      if (!id) {
        throw new Error('The API returned an empty player ID.');
      }
      this.credentials.save({ id, password: DEFAULT_PLAYER_PASSWORD });
      await this.router.navigateByUrl('/');
    } catch {
      this.status.set('Registration failed. Check your details and the API connection.');
    } finally {
      this.submitting.set(false);
    }
  }
}
