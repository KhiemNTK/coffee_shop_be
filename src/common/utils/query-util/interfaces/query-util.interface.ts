export enum Operator {
  AND = 'AND',
  OR = 'OR',
}

export interface BuildSearchParams<T> {
  search: Partial<Record<keyof T, any>>;
  operator?: Operator;
}
