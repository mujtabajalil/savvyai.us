import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { Auth } from './auth';
import { Landing } from './landing';
import { Login } from './login';
import { Workspace } from './workspace';
import { Connections } from './connections';
import { Chat } from './chat';

/** Signed-out visitors land here from a deep link. Keep the attempted URL or it is lost
 *  to the /app redirect. */
const signedIn: CanActivateFn = (_route, state) =>
  inject(Auth).user() !== null ||
  inject(Router).createUrlTree(['/login'], { queryParams: { next: state.url } });

export const routes: Routes = [
  { path: '', component: Landing },
  { path: 'login', component: Login },
  {
    path: 'app',
    component: Workspace,
    canActivate: [signedIn],
    children: [
      { path: 'connections', component: Connections },
      { path: 'chat', component: Chat },
      { path: 'chat/:id', component: Chat },
      { path: '', pathMatch: 'full', redirectTo: 'connections' },
    ],
  },
  { path: '**', redirectTo: '' },
];
