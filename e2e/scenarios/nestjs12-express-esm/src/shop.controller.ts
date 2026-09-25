import { Body, Controller, Delete, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { McpTool } from 'mcp-expose/nestjs';
import { AuthGuard } from './auth.guard.js';
import { CreateOrderDto, SearchQuery } from './dto.js';

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
const orders = new Map<string, object>([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);

@Controller('products')
export class ProductsController {
  @Get()
  @McpTool({ name: 'search_products', description: 'Search products by name' })
  search(@Query() query: SearchQuery) {
    const q = (query.q ?? '').toLowerCase();
    return { items: products.filter((p) => p.name.toLowerCase().includes(q)).slice(0, query.limit ?? 10) };
  }
}

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  @Get(':id')
  @McpTool({ name: 'get_order', description: 'Get an order by id' })
  get(@Param('id') id: string) {
    return orders.get(id) ?? { error: 'not found' };
  }

  @Post()
  @McpTool({ name: 'create_order', description: 'Create an order' })
  create(@Body() dto: CreateOrderDto) {
    const order = { id: String(orders.size + 1), ...dto, status: 'pending' };
    orders.set(order.id, order);
    return order;
  }

  @Delete(':id')
  @McpTool({ name: 'cancel_order', description: 'Cancel an order' })
  cancel(@Param('id') id: string) {
    return { id, status: 'cancelled' };
  }

  @Get('admin/stats') // not exposed
  stats() {
    return { orders: orders.size };
  }
}

@Controller('debug')
export class DebugController {
  @Get('whoami')
  @McpTool({ name: 'whoami', description: 'Debug' })
  whoami(@Headers('x-mcp-tool') tool?: string) {
    return { tool: tool ?? null };
  }
}
