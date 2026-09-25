import { Module } from '@nestjs/common';
import { McpModule } from 'mcp-expose/nestjs';
import { OrdersController } from './orders.controller.js';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'orders-api',
      version: '1.0.0',
      instructions: 'Tools for looking up and placing orders.',
    }),
  ],
  controllers: [OrdersController],
})
export class AppModule {}
