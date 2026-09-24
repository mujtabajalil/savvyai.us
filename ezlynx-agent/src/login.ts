/**
 * Login helper.
 *
 * EZLynx sessions are short-lived, so re-authentication is routine. Credentials
 * and MFA are never automated — this only opens the window, waits for you to
 * finish, and then checkpoints the session to disk so headless runs can reuse it.
 *
 * The device-trust cookie survives across logins, so repeat logins normally
 * need only username + password, not MFA again.
 */

import { CamofoxClient } from './camofox/client.js';
import { pageBlockedExpr, type BlockedPage } from './camofox/dom.js';
import { pollUntil, sleep } from './camofox/waits.js';
import type { Logger } from './log/logger.js';

export interface LoginOptions {
  client: CamofoxClient;
  ezlynxBaseUrl: string;
  logger: Logger;
  /** How long to wait for the person to finish logging in. */
  timeoutMs?: number;
  print: (line?: string) => void;
}

export type SessionState = 'authenticated' | 'login-required' | 'unreachable';

/** Is the persisted session still good? Cheap enough to run before a long job. */
export async function checkSession(
  client: CamofoxClient,
  ezlynxBaseUrl: string,
  logger: Logger,
): Promise<SessionState> {
  try {
    await client.health();
  } catch {
    return 'unreachable';
  }

  const tab = await client.createTab(`${ezlynxBaseUrl}/web/dashboard`);
  try {
    await client.waitForPage(tab.tabId, { timeout: 30_000 });
    const blocked = await client.evaluate<BlockedPage>(tab.tabId, pageBlockedExpr());
    if (blocked.blocked && blocked.kind === 'login') return 'login-required';

    const url = await client.currentUrl(tab.tabId);
    return /\/auth\/account\/login/i.test(url) ? 'login-required' : 'authenticated';
  } catch (err) {
    logger.warn('session check failed', { error: String(err) });
    return 'login-required';
  } finally {
    await client.closeTab(tab.tabId).catch(() => undefined);
  }
}

/**
 * Open the login page and wait for the person to finish.
 *
 * Requires camofox to be running with CAMOFOX_INTERACTIVE=desktop, otherwise
 * there is no window to type into.
 */
export async function interactiveLogin(options: LoginOptions): Promise<boolean> {
  const { client, ezlynxBaseUrl, logger, print } = options;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;

  const tab = await client.createTab(`${ezlynxBaseUrl}/auth/account/login`);
  logger.info('login tab opened', { tabId: tab.tabId });

  print('');
  print('A Camoufox window should now be showing the EZLynx login page.');
  print('Log in there, including MFA if prompted. Nothing is typed for you.');
  print('');
  print('If no window appeared, camofox is not running in desktop mode. Restart it with:');
  print('  set "CAMOFOX_INTERACTIVE=desktop" && npm start     (from camofox/)');
  print('');
  print('Waiting for you to finish...');

  try {
    await pollUntil(
      async () => {
        const url = await client.currentUrl(tab.tabId).catch(() => '');
        if (!url || /\/auth\/account\/login/i.test(url)) return null;
        return url;
      },
      { timeoutMs, intervalMs: 3_000, label: 'login to complete', logger },
    );
  } catch {
    print('\nTimed out waiting for login. Nothing was saved.');
    await client.closeTab(tab.tabId).catch(() => undefined);
    return false;
  }

  // Let EZLynx finish setting its cookies before the state is captured.
  await sleep(3_000);
  print('\nLogin detected. Saving the session...');

  await client.closeTab(tab.tabId).catch(() => undefined);

  // Destroying the session triggers the persistence plugin's checkpoint, which
  // is what writes the cookies to disk for later headless runs.
  await client.destroySession().catch((err) => logger.warn('session checkpoint failed', { error: String(err) }));

  print('Session saved.');
  print('');
  print('Now restart camofox in headless mode for automation — desktop mode cannot');
  print('drive the browser reliably on Windows (native clicks need window focus):');
  print('  set "CAMOFOX_INTERACTIVE=off" && npm start');
  return true;
}
