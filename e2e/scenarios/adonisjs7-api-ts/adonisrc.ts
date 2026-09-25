import { defineConfig } from '@adonisjs/core/app';

export default defineConfig({
  commands: [() => import('@adonisjs/core/commands')],
  providers: [
    () => import('@adonisjs/core/providers/app_provider'),
    () => import('@adonisjs/core/providers/hash_provider'),
    () => import('@adonisjs/core/providers/vinejs_provider'),
  ],
  preloads: [() => import('#start/routes'), () => import('#start/kernel')],
});
