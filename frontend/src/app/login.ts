import { Component, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Auth } from './auth';
import { LogoMark } from './logo-mark';

@Component({
  selector: 'app-login',
  imports: [RouterLink, LogoMark],
  template: `
    <header class="nav">
      <div class="page nav-inner">
        <a class="brand" routerLink="/"><app-logo-mark />savvyai</a>
      </div>
    </header>

    <main class="page">
      <div class="card">
        <h1>Sign in</h1>
        <form (submit)="submit($event, user.value, pass.value)">
          <div class="field">
            <label for="user">Username</label>
            <input #user id="user" name="username" autocomplete="username"
                   [attr.aria-invalid]="failed() || null" [attr.aria-describedby]="failed() ? 'signin-error' : null">
          </div>
          <div class="field">
            <label for="pass">Password</label>
            <input #pass id="pass" name="password" type="password" autocomplete="current-password"
                   [attr.aria-invalid]="failed() || null" [attr.aria-describedby]="failed() ? 'signin-error' : null">
          </div>
          @if (failed()) {
            <p class="error small" id="signin-error" role="alert">
              That username and password do not match. Check both and try again.
            </p>
          }
          <button class="btn btn-primary" type="submit">Sign in to the workspace</button>
        </form>
      </div>
    </main>
  `,
  styles: `
    main { padding-block: var(--s-8); }
    .card { max-inline-size: 30rem; }
    h1 { margin-block-end: var(--s-6); }
    form { display: grid; gap: var(--s-5); justify-items: start; }
    .field { inline-size: 100%; }
    .error { margin: 0; color: var(--bad); }
  `,
})
export class Login {
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  protected readonly failed = signal(false);

  /** Where the auth guard wanted to go, via ?next=. */
  readonly next = input<string>();

  protected async submit(event: Event, user: string, pass: string): Promise<void> {
    event.preventDefault();
    if (!(await this.auth.signIn(user.trim(), pass))) {
      this.failed.set(true);
      return;
    }
    // ?next= is attacker-supplied: only same-origin paths, never a protocol-relative host.
    const next = this.next();
    const target = next?.startsWith('/') && !next.startsWith('//') ? next : '/app';
    this.router.navigateByUrl(target);
  }
}
