import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  sku!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}

export class SearchQuery {
  @IsString()
  @IsOptional()
  q?: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  limit?: number;
}
