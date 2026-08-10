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
    path: 'leader',
    title: 'Leader | PacMacro',
    loadComponent: () =>
      import('./pages/leader-page/leader-page.component').then(
        (module) => module.LeaderPageComponent,
      ),
  },
  {
    path: 'admin/map',
    title: 'Admin Map | PacMacro',
    loadComponent: () =>
      import('./pages/admin-map-page/admin-map-page.component').then(
        (module) => module.AdminMapPageComponent,
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
