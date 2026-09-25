await import('reflect-metadata');
const { Ignitor, prettyPrintError } = await import('@adonisjs/core/ignitor');

const APP_ROOT = new URL('../', import.meta.url);
const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href);
  }
  return import(filePath);
};

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.booting(async () => {
      await import('#start/env');
    });
    app.listen('SIGTERM', () => app.terminate());
  })
  .httpServer()
  .start()
  .then(() => console.log('READY'))
  .catch((error) => {
    process.exitCode = 1;
    prettyPrintError(error);
  });
