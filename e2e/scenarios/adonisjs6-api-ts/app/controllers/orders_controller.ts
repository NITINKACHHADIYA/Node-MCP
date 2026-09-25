import type { HttpContext } from '@adonisjs/core/http';
import { createOrderValidator } from '#validators/order';

type Order = { id: string; sku: string; quantity: number; status: string };
const orders = new Map<string, Order>([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);

export default class OrdersController {
  show({ params, response }: HttpContext) {
    const order = orders.get(params.id);
    return order ?? response.notFound({ error: 'Not found' });
  }

  async store({ request, response }: HttpContext) {
    const data = await request.validateUsing(createOrderValidator);
    const order = { id: String(orders.size + 1), ...data, status: 'pending' };
    orders.set(order.id, order);
    return response.created(order);
  }

  destroy({ params }: HttpContext) {
    return { id: params.id, status: 'cancelled' };
  }

  stats() {
    return { orders: orders.size };
  }
}
