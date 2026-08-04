import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'PacMacro',
    loadComponent: () =>
      import('./pages/game-page/game-page.component').then((module) => module.GamePageComponent),
  },
  {
    path: 'register',
    title: 'Register | PacMacro',
    loadComponent: () =>
      import('./pages/register-page/register-page.component').then(
        (module) => module.RegisterPageComponent,
      ),
  },
  {
    path: 'admin',
    title: 'Admin | PacMacro',
    loadComponent: () =>
      import('./pages/admin-page/admin-page.component').then((module) => module.AdminPageComponent),
  },
  { path: '**', redirectTo: '' },
];
