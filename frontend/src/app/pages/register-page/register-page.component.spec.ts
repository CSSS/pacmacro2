import { WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { CredentialsService } from '../../core/credentials.service';
import { PlayerType } from '../../core/game.models';
import { RegisterPageComponent } from './register-page.component';

describe('RegisterPageComponent', () => {
  const api = {
    registerAdmin: vi.fn(() => of(void 0)),
    registerPlayer: vi.fn(() => of({ id: 'ABCD' })),
  };
  const credentials = { save: vi.fn() };
  const router = { navigateByUrl: vi.fn(() => Promise.resolve(true)) };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [RegisterPageComponent],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: CredentialsService, useValue: credentials },
        { provide: Router, useValue: router },
      ],
    });
  });

  it('registers an admin separately without saving player credentials', async () => {
    const component = TestBed.createComponent(RegisterPageComponent)
      .componentInstance as unknown as RegisterPageHarness;
    component.registrationModel.set({
      playerType: String(PlayerType.Admin),
      name: 'Test',
      adminPassword: 'top-secret',
    });

    await component.submit(submitEvent());

    expect(api.registerAdmin).toHaveBeenCalledWith('Test', 'top-secret');
    expect(api.registerPlayer).not.toHaveBeenCalled();
    expect(credentials.save).not.toHaveBeenCalled();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/admin');
  });

  it('keeps player registration on the player endpoint', async () => {
    const component = TestBed.createComponent(RegisterPageComponent)
      .componentInstance as unknown as RegisterPageHarness;
    component.registrationModel.set({
      playerType: String(PlayerType.Player),
      name: 'Test2',
      adminPassword: '',
    });

    await component.submit(submitEvent());

    expect(api.registerPlayer).toHaveBeenCalledWith(PlayerType.Player, 'Test2');
    expect(api.registerAdmin).not.toHaveBeenCalled();
    expect(credentials.save).toHaveBeenCalledWith({ id: 'ABCD' });
    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('uses Signal Forms validation before calling the API', async () => {
    const component = TestBed.createComponent(RegisterPageComponent)
      .componentInstance as unknown as RegisterPageHarness;
    component.registrationModel.set({
      playerType: String(PlayerType.Admin),
      name: 'Test',
      adminPassword: '',
    });

    await component.submit(submitEvent());

    expect(api.registerAdmin).not.toHaveBeenCalled();
    expect(api.registerPlayer).not.toHaveBeenCalled();
  });
});

interface RegisterPageHarness {
  registrationModel: WritableSignal<{
    playerType: string;
    name: string;
    adminPassword: string;
  }>;
  submit(event: SubmitEvent): Promise<void>;
}

function submitEvent(): SubmitEvent {
  return { preventDefault: vi.fn() } as unknown as SubmitEvent;
}
