/**
 * Where the built SPA lives, relative to the repo root. `vite.config.ts` writes it here via
 * `outDir`, and `resolveWebRoot` in `app.ts` looks for it here. Shared so the two cannot
 * drift apart silently: a change to one without the other would have the server 404
 * everything despite a successful build.
 */
export const WEB_BUILD_DIR = ['dist', 'web'] as const
