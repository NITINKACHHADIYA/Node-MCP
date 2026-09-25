/**
 * Koa example.  Run:  npm run build && npx tsx examples/koa/server.ts
 */
import Router from '@koa/router';
import Koa from 'koa';
import { koaMcp, mcpTool } from 'mcp-expose/koa';

const app = new Koa();
const router = new Router({ prefix: '/api' });

router.get('/weather/:city', mcpTool({ name: 'get_weather', description: 'Current weather for a city.' }), (ctx) => {
  ctx.body = { city: ctx.params.city, tempC: 21, conditions: 'sunny' };
});

// Mount the MCP endpoint and tell it which routers to scan.
app.use(koaMcp({ name: 'weather-api', routers: [router] }));
app.use(router.routes()).use(router.allowedMethods());

app.listen(3000, () => console.log('MCP on http://localhost:3000/mcp'));
