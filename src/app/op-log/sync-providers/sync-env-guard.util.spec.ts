import { checkSyncEnvMismatch } from './sync-env-guard.util';

describe('checkSyncEnvMismatch', () => {
  it('allows the matching prod combo (file:// window + prod bundle)', () => {
    expect(
      checkSyncEnvMismatch({ isElectron: true, isProdWindow: true, isProdBundle: true }),
    ).toBeNull();
  });

  it('allows the matching dev combo (localhost window + dev bundle)', () => {
    expect(
      checkSyncEnvMismatch({
        isElectron: true,
        isProdWindow: false,
        isProdBundle: false,
      }),
    ).toBeNull();
  });

  it('blocks a DEV bundle in the packaged (prod) window — the real data-loss combo', () => {
    const msg = checkSyncEnvMismatch({
      isElectron: true,
      isProdWindow: true,
      isProdBundle: false,
    });
    expect(msg).toContain('DEVELOPMENT build');
    expect(msg).toContain('/DEV/');
  });

  it('blocks a PROD bundle in the dev window (reverse mismatch)', () => {
    const msg = checkSyncEnvMismatch({
      isElectron: true,
      isProdWindow: false,
      isProdBundle: true,
    });
    expect(msg).toContain('PRODUCTION build');
  });

  it('never fires outside Electron (web has a single origin)', () => {
    for (const isProdWindow of [true, false]) {
      for (const isProdBundle of [true, false]) {
        expect(
          checkSyncEnvMismatch({ isElectron: false, isProdWindow, isProdBundle }),
        ).toBeNull();
      }
    }
  });
});
