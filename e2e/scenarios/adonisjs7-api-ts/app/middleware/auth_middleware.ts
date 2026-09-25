import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';

/** Bearer-token auth, standing in for @adonisjs/auth in this test app. */
export default class AuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (ctx.request.header('authorization') !== 'Bearer e2e-token') {
      return ctx.response.unauthorized({ error: 'Unauthorized' });
    }
    return next();
  }
}
