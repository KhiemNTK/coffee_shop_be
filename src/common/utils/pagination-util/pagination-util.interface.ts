import z from 'zod';
import { createZodDto } from 'nestjs-zod';

export enum PagingDefault {
  ITEM_PER_PAGE = 10,
  PAGE = 1,
}
export class Pagination extends createZodDto(
  z.object({
    itemPerPage: z.coerce.number().min(1).default(PagingDefault.ITEM_PER_PAGE),
    page: z.coerce.number().min(1).default(PagingDefault.PAGE),
    select: z.string().optional(),
  }),
) {}
