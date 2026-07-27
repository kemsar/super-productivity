import { IS_ELECTRON } from '../../app.constants';
import { environment } from '../../../environments/environment';

export interface SyncEnvContext {
  /** Whether we're running inside Electron (the only place the mismatch exists). */
  isElectron: boolean;
  /**
   * True when the Electron window loaded the packaged app over `file://`
   * (the production window), false for the `http://localhost` dev window.
   * This decides which local IndexedDB store is in use.
   */
  isProdWindow: boolean;
  /**
   * `environment.production` baked into the Angular bundle at BUILD time.
   * This decides the remote SYNC FOLDER (`/` for prod, `/DEV/` for dev) — see
   * `sync-providers.factory.ts`.
   */
  isProdBundle: boolean;
}

/**
 * Detects a dev/prod environment mismatch that would sync the WRONG remote
 * folder for the current local store — the root cause of a real data-loss
 * incident where a development Angular bundle was loaded by the packaged
 * (`file://`) Electron window.
 *
 * Two independent switches must agree:
 *   - window URL → local store: `file://` (prod) vs `http://localhost` (dev)
 *   - `environment.production` → sync folder: `/` (prod) vs `/DEV/` (dev)
 *
 * If a `file://` (real-data) window runs a dev bundle, it syncs your real store
 * to `/DEV/` and pulls the dev dataset back over it. The reverse pushes dev data
 * to your real folder. Either way data is cross-contaminated and can be wiped,
 * so callers must refuse to sync when this returns a message.
 *
 * Pure and fully injectable so it can be unit-tested without a browser/Electron.
 * Only Electron is affected — the web has a single origin, so returns null there.
 */
export const checkSyncEnvMismatch = (ctx: SyncEnvContext): string | null => {
  if (!ctx.isElectron) {
    return null;
  }
  if (ctx.isProdWindow === ctx.isProdBundle) {
    return null;
  }
  return ctx.isProdWindow
    ? 'Refusing to sync: a DEVELOPMENT build is running in the packaged (production) ' +
        'app window. It would sync your real data to the /DEV/ folder and pull dev ' +
        'data back over it. Rebuild with `npm run build` before launching the packaged app.'
    : 'Refusing to sync: a PRODUCTION build is running in the dev app window. It would ' +
        'sync dev data to your real sync folder. Use `ng serve` + `npm start` for development.';
};

/**
 * Runtime wrapper around {@link checkSyncEnvMismatch} that reads the live
 * environment. Returns a human-readable reason when sync must be blocked, else
 * null. Cheap enough to call on every sync attempt / provider access.
 */
export const getSyncEnvMismatch = (): string | null =>
  checkSyncEnvMismatch({
    isElectron: IS_ELECTRON,
    isProdWindow: typeof location !== 'undefined' && location.protocol === 'file:',
    isProdBundle: environment.production,
  });
