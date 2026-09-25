import { Module } from '@nestjs/common';
import { McpModule } from 'mcp-expose/nestjs';
import { DebugController, OrdersController, ProductsController } from './shop.controller.js';

@Module({
  imports: [McpModule.forRoot({ name: 'shop-api', version: '1.0.0' })],
  controllers: [ProductsController, OrdersController, DebugController],
})
export class AppModule {}
