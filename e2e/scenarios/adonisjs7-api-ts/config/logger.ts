import env from '#start/env';
import { defineConfig, targets } from '@adonisjs/core/logger';

const loggerConfig = defineConfig({
  default: 'app',
  loggers: {
    app: {
      enabled: true,
      name: 'e2e',
      level: env.get('LOG_LEVEL'),
      transport: { targets: [targets.file({ destination: 1 })] },
    },
  },
});

export default loggerConfig;

declare module '@adonisjs/core/types' {
  export interface LoggersList extends InferLoggers<typeof loggerConfig> {}
}
