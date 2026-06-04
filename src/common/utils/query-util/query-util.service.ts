import { Injectable } from '@nestjs/common';
import { BuildSearchParams, Operator } from './interfaces/query-util.interface';

@Injectable()
export class QueryUtilService {
  convertFieldsSelectOption<T>(
    value?: string | null,
  ): Record<keyof T, boolean> | undefined {
    if (!value?.trim()) return undefined;

    return value.split(',').reduce(
      (acc, field) => {
        const trimmedField = field.trim();
        if (trimmedField) {
          acc[trimmedField as keyof T] = true;
        }
        return acc;
      },
      {} as Record<keyof T, boolean>,
    );
  }

  private buildSearchConditions(
    search: Record<string, any>,
  ): Record<string, any>[] {
    if (!search) return [];

    return Object.entries(search)
      .filter(
        ([_, value]) => value !== undefined && value !== null && value !== '',
      )
      .map(([key, value]) => {
        if (typeof value === 'string') {
          return {
            [key]: {
              contains: value.trim(),
              mode: 'insensitive',
            },
          };
        }

        return { [key]: value };
      });
  }

  buildSearchQuery<T>({
    search,
    operator = Operator.OR,
  }: BuildSearchParams<T>) {
    if (!search || Object.keys(search).length === 0) {
      return {};
    }

    const conditions = this.buildSearchConditions(search);

    if (conditions.length === 0) {
      return {};
    }

    return operator === Operator.OR ? { OR: conditions } : { AND: conditions };
  }
}
