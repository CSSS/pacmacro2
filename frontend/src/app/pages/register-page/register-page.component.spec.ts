import { WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { CredentialsService } from '../../core/credentials.service';
import { PlayerNameService } from '../../core/player-name.service';
import { RegisterPageComponent } from './register-page.component';

describe('RegisterPageComponent', () => {
  const api = {
    registerAdmin: vi.fn(() => of(void 0)),
    registerPlayer: vi.fn(() => of({ id: 'ABCD' })),
  };
  const credentials = { save: vi.fn() };
  const playerName = { save: vi.fn() };
  const router = { navigateByUrl: vi.fn(() => Promise.resolve(true)) };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [RegisterPageComponent],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: CredentialsService, useValue: credentials },
        { provide: PlayerNameService, useValue: playerName },
        { provide: Router, useValue: router },
      ],
    });
  });

  it('keeps player registration on the player endpoint', async () => {
    const component = TestBed.createComponent(RegisterPageComponent)
      .componentInstance as unknown as RegisterPageHarness;
    component.registrationModel.set({
      name: '  Test2  ',
    });

    await component.submit(submitEvent());

    expect(api.registerPlayer).toHaveBeenCalledWith('Test2');
    expect(api.registerAdmin).not.toHaveBeenCalled();
    expect(credentials.save).toHaveBeenCalledWith({ id: 'ABCD' });
    expect(playerName.save).toHaveBeenCalledWith('Test2');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('uses Signal Forms validation before calling the API', async () => {
    const component = TestBed.createComponent(RegisterPageComponent)
      .componentInstance as unknown as RegisterPageHarness;
    component.registrationModel.set({
      name: '   ',
    });

    await component.submit(submitEvent());

    expect(api.registerPlayer).not.toHaveBeenCalled();
    expect(credentials.save).not.toHaveBeenCalled();
    expect(playerName.save).not.toHaveBeenCalled();
  });
});

interface RegisterPageHarness {
  registrationModel: WritableSignal<{
    name: string;
  }>;
  submit(event: SubmitEvent): Promise<void>;
}

function submitEvent(): SubmitEvent {
  return { preventDefault: vi.fn() } as unknown as SubmitEvent;
}
