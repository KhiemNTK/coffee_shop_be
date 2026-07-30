import type { Operator } from '../utils/query-util/interfaces/query-util.interface';

export interface BuildSearchParams<T> {
  search: Partial<Record<keyof T, any>>;
  operator?: Operator;
}
