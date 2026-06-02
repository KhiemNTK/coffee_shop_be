import { Injectable } from '@nestjs/common';
import { PagingDefault } from './pagination-util.interface';

@Injectable()
export class PaginationUtilService {
  paging({
    itemPerPage = PagingDefault.ITEM_PER_PAGE,
    page = PagingDefault.PAGE,
    totalItems = 0,
  }: {
    itemPerPage?: number;
    page?: number;
    totalItems?: number;
  }) {
    const skip = Math.max((page - 1) * itemPerPage, 0);
    const totalPages = Math.ceil(totalItems / itemPerPage);

    return {
      skip,
      itemPerPage,
      totalPages,
      totalItems,
      format: <T>(list: T[]) => ({
        list,
        totalPages,
        totalItems,
        currentPage: page,
      }),
    };
  }
}
