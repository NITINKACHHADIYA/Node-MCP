import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { McpModule } from 'mcp-expose/nestjs';
import { DebugController, OrdersController, ProductsController } from './shop.controller.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    McpModule.forRoot({ name: 'shop-api', version: '1.0.0' }),
  ],
  controllers: [ProductsController, OrdersController, DebugController],
})
export class AppModule {}
