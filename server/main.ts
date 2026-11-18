// CasiWorks Pro - Start the local server, or manage API keys
//
//   npm run server                      serve the app and the API on http://127.0.0.1:5180
//   npm run server -- --port 6000       another port
//   npm run server -- key create NAME   make an API key for a script (shown once)
//   npm run server -- key list
//   npm run server -- key delete ID
//
// Data lives in $CASIWORKS_DATA, default ~/.casiworks. The app must be built
// first (npm run build); the API works without it.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// node:sqlite still prints an "experimental" warning on every start; it is expected
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning instanceof Error ? warning.message : warning).includes('SQLite')) return;
  (emit as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { createLocalServer } = await import('./app.ts');
const { Library } = await import('./library.ts');

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
// Settings from flags, then the environment (.env); an empty value counts as unset
const env = (name: string) => process.env[name]?.trim() || undefined;
const dataDir = resolve(flag('data') ?? env('CASIWORKS_DATA') ?? join(homedir(), '.casiworks'));
const port = Number(flag('port') ?? env('PORT') ?? 5180);
const distDir = resolve(flag('dist') ?? 'dist');

if (args[0] === 'key') {
  const lib = new Library(dataDir);
  try {
    if (args[1] === 'create' && args[2]) {
      const { key, secret } = lib.createKey(args.slice(2).join(' '));
      console.log(`API key "${key.name}" (${key.id})\n\n  ${secret}\n\nKeep it now: it is not shown again. Use it as  Authorization: Bearer ${key.prefix}…`);
    } else if (args[1] === 'list') {
      const keys = lib.listKeys();
      console.log(keys.length ? keys.map(k => `${k.id}  ${k.prefix}…  ${k.name}  (last used ${k.lastUsedAt ?? 'never'})`).join('\n') : 'No API keys');
    } else if (args[1] === 'delete' && args[2]) {
      lib.deleteKey(args[2]);
      console.log('Deleted');
    } else {
      console.log('Usage: npm run server -- key create NAME | key list | key delete ID');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    lib.close();
  }
} else {
  const app = createLocalServer({
    dataDir,
    distDir: existsSync(join(distDir, 'index.html')) ? distDir : undefined,
    // The Vite dev server proxies /api/v1 here
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`CasiWorks local server: http://127.0.0.1:${port}/  (API: /api/v1, data: ${dataDir})`);
    if (!existsSync(join(distDir, 'index.html'))) console.log('The app is not built: run `npm run build` to serve it here.');
  });
  const stop = () => { void app.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
