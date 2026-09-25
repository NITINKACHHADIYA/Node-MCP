import vine from '@vinejs/vine';

export const createOrderValidator = vine.compile(
  vine.object({
    sku: vine.string(),
    quantity: vine.number().withoutDecimals().range([1, 10]),
  }),
);
