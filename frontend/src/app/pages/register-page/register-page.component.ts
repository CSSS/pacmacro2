import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  form,
  FormField,
  hidden,
  maxLength,
  pattern,
  required,
  submit as submitForm,
} from '@angular/forms/signals';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { CredentialsService } from '../../core/credentials.service';
import { PlayerType } from '../../core/game.models';
import { BrandHeaderComponent } from '../../shared/brand-header/brand-header.component';

interface RegistrationModel {
  playerType: string;
  name: string;
  adminPassword: string;
}

@Component({
  selector: 'pac-register-page',
  imports: [BrandHeaderComponent, FormField],
  templateUrl: './register-page.component.html',
  styleUrl: './register-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterPageComponent {
  private readonly api = inject(ApiService);
  private readonly credentials = inject(CredentialsService);
  private readonly router = inject(Router);

  protected readonly registrationModel = signal<RegistrationModel>({
    playerType: String(PlayerType.Froshee),
    name: '',
    adminPassword: '',
  });

  protected readonly registrationForm = form(this.registrationModel, (registration) => {
    required(registration.playerType);
    required(registration.name, { message: 'Enter your name.' });
    pattern(registration.name, /\S/, { message: 'Enter your name.' });
    maxLength(registration.name, 80, { message: 'Your name must be 80 characters or fewer.' });
    hidden(registration.adminPassword, {
      when: ({ valueOf }) => Number(valueOf(registration.playerType)) !== PlayerType.Admin,
    });
    required(registration.adminPassword, {
      message: 'Enter the administrator password.',
      when: ({ valueOf }) => Number(valueOf(registration.playerType)) === PlayerType.Admin,
    });
  });

  protected readonly status = signal('');

  /**
   * For the player type dropdown.
   */
  protected readonly playerTypeOptions = PlayerType;

  protected async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await submitForm(this.registrationForm, {
      action: async () => this.register(),
      onInvalid: () => {
        const firstError = this.registrationForm().errorSummary()[0];
        this.status.set(firstError?.message ?? 'Check the registration details and try again.');
      },
    });
  }

  private async register(): Promise<void> {
    const { playerType, name, adminPassword } = this.registrationForm().value();
    const registrationType = Number(playerType) as PlayerType;
    const trimmedName = name.trim();
    this.status.set('Registering...');

    try {
      if (registrationType === PlayerType.Admin) {
        await firstValueFrom(this.api.registerAdmin(trimmedName, adminPassword));
        await this.router.navigateByUrl('/admin');
        return;
      }

      const response = await firstValueFrom(this.api.registerPlayer(registrationType, trimmedName));
      const id = response.id.trim();
      if (!id) {
        throw new Error('The API returned an empty player ID.');
      }
      this.credentials.save({ id });
      await this.router.navigateByUrl('/');
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.status.set('The administrator password is incorrect.');
      } else {
        this.status.set('Registration failed. Check your details and the API connection.');
      }
    }
  }
}
