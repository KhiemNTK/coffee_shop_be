import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BuildSearchParams, Operator } from './interfaces/query-util.interface';

const selectableFields = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    new Set(
      model.fields
        .filter(
          (field) =>
            field.kind !== 'object' &&
            !['password', 'googleSubject'].includes(field.name),
        )
        .map((field) => field.name),
    ),
  ]),
);

@Injectable()
export class QueryUtilService {
  convertFieldsSelectOption<T>(
    value: string | null | undefined,
    model: Prisma.ModelName,
  ): Record<keyof T, boolean> | undefined {
    if (!value?.trim()) return undefined;

    const fields = [...new Set(value.split(',').map((field) => field.trim()))];
    const allowed = selectableFields.get(model);
    if (fields.some((field) => !allowed?.has(field))) {
      throw new BadRequestException('Invalid selectable fields requested.');
    }

    return fields.reduce(
      (acc, field) => {
        acc[field as keyof T] = true;
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
