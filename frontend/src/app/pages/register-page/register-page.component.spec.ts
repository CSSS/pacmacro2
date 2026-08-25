import { Location } from '@angular/common';
import { WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';

import { ApiService } from '../../core/api.service';
import { CredentialsService } from '../../core/credentials.service';
import { RegisterPageComponent } from './register-page.component';

describe('RegisterPageComponent', () => {
  const api = {
    registerAdmin: vi.fn(() => of(void 0)),
    registerPlayer: vi.fn(() => of({ id: 'ABCD' })),
  };
  const credentials = { save: vi.fn(), savePlayerName: vi.fn(), getPlayerName: vi.fn(() => '') };
  const location = { getState: vi.fn(() => ({})) };
  const router = { navigateByUrl: vi.fn(() => Promise.resolve(true)) };

  beforeEach(() => {
    vi.clearAllMocks();
    location.getState.mockReturnValue({});
    TestBed.configureTestingModule({
      imports: [RegisterPageComponent],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: CredentialsService, useValue: credentials },
        { provide: Location, useValue: location },
        { provide: Router, useValue: router },
      ],
    });
  });

  it('keeps player registration on the player endpoint', async () => {
    const component = TestBed.createComponent(RegisterPageComponent)
      .componentInstance as unknown as RegisterPageHarness;
    component.registrationModel.set({
      name: 'Test2',
    });

    await component.submit(submitEvent());

    expect(api.registerPlayer).toHaveBeenCalledWith('Test2');
    expect(api.registerAdmin).not.toHaveBeenCalled();
    expect(credentials.save).toHaveBeenCalledWith({ id: 'ABCD' });
    expect(credentials.savePlayerName).toHaveBeenCalledWith('Test2');
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
    expect(credentials.savePlayerName).not.toHaveBeenCalled();
  });

  it('pre-fills the name from the saved player name', () => {
    credentials.getPlayerName.mockReturnValue('SavedPlayer');
    const component = TestBed.createComponent(RegisterPageComponent)
      .componentInstance as unknown as RegisterPageHarness;

    expect(component.registrationModel().name).toBe('SavedPlayer');
  });

  it('shows the shutdown message when routed from a stopped server', () => {
    location.getState.mockReturnValue({ serverStopped: true });
    const component = TestBed.createComponent(RegisterPageComponent)
      .componentInstance as unknown as RegisterPageHarness;

    expect(component.status()).toBe('The server stopped. Register to join the next game.');
  });
});

interface RegisterPageHarness {
  registrationModel: WritableSignal<{
    name: string;
  }>;
  status: WritableSignal<string>;
  submit(event: SubmitEvent): Promise<void>;
}

function submitEvent(): SubmitEvent {
  return { preventDefault: vi.fn() } as unknown as SubmitEvent;
}
