import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { McpTool } from 'mcp-expose/nestjs';
import { ApiKeyGuard } from './api-key.guard.js';

export class CreateOrderDto {
  @IsString()
  sku!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;

  @IsString()
  @IsOptional()
  note?: string;
}

@Controller('orders')
@UseGuards(ApiKeyGuard) // Your existing guard protects tool calls too.
export class OrdersController {
  private orders = [{ id: 1, sku: 'KB-01', quantity: 1, status: 'shipped' }];

  @Get()
  @McpTool({ description: 'List orders, optionally filtered by status (e.g. "shipped").' })
  list(@Query('status') status?: string) {
    return { orders: status ? this.orders.filter((o) => o.status === status) : this.orders };
  }

  @Get(':id')
  @McpTool({ description: 'Get one order by its numeric id.' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.orders.find((o) => o.id === id) ?? { error: 'not found' };
  }

  // Input schema is generated from CreateOrderDto; ValidationPipe still validates it.
  @Post()
  @McpTool({ name: 'create_order', description: 'Create an order. quantity must be 1-10.' })
  create(@Body() dto: CreateOrderDto) {
    const order = { id: this.orders.length + 1, status: 'pending', ...dto };
    this.orders.push(order);
    return order;
  }

  // No @McpTool -> invisible to agents.
  @Post(':id/refund')
  refund(@Param('id') id: string) {
    return { refunded: id };
  }
}
