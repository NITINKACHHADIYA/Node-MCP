import router from '@adonisjs/core/services/router';
import server from '@adonisjs/core/services/server';

server.errorHandler(() => import('#exceptions/handler'));

server.use([() => import('#middleware/force_json_response_middleware')]);

router.use([() => import('@adonisjs/core/bodyparser_middleware')]);

export const middleware = router.named({
  auth: () => import('#middleware/auth_middleware'),
});
