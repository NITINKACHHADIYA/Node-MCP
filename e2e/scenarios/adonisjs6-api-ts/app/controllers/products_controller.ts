import type { HttpContext } from '@adonisjs/core/http';

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];

export default class ProductsController {
  index({ request }: HttpContext) {
    const q = String(request.input('q', '')).toLowerCase();
    return { items: products.filter((p) => p.name.toLowerCase().includes(q)) };
  }
}
