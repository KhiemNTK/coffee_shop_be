import { TransferDiningTableSchema } from './transfer-dining-table.dto';
import { MergeDiningTableSchema } from './merge-dining-table.dto';
import { ClearDiningTableDto } from './clear-dining-table.dto';

describe('Table mutation identity contract', () => {
  const sourceTable = '86000000-0000-4000-8000-000000000001';
  const targetTable = '86000000-0000-4000-8000-000000000002';
  const sourceSession = '86000000-0000-4000-8000-000000000003';
  const targetSession = '86000000-0000-4000-8000-000000000004';

  it('fails closed for legacy clients without an observed session', () => {
    expect(
      TransferDiningTableSchema.safeParse({
        fromTableId: sourceTable,
        toTableId: targetTable,
      }).success,
    ).toBe(false);
    expect(
      MergeDiningTableSchema.safeParse({
        sourceTableIds: [sourceTable],
        destinationTableId: targetTable,
      }).success,
    ).toBe(false);
    expect(ClearDiningTableDto.schema.safeParse({}).success).toBe(false);
    expect(
      ClearDiningTableDto.schema.safeParse({ reason: 'Customer cancelled' })
        .success,
    ).toBe(false);
  });

  it('accepts an observed empty or occupied table only with a valid reason', () => {
    for (const expectedOrderSessionId of [null, sourceSession]) {
      const input = {
        expectedOrderSessionId,
        reason: '  Customer cancelled  ',
      };
      expect(ClearDiningTableDto.schema.parse(input)).toEqual({
        expectedOrderSessionId,
        reason: 'Customer cancelled',
      });
      for (const reason of [undefined, '', '   ', 'ab', 'a'.repeat(501)]) {
        expect(
          ClearDiningTableDto.schema.safeParse({ ...input, reason }).success,
        ).toBe(false);
      }
    }
  });

  it('requires distinct sessions and matching source-table/session counts', () => {
    const input = {
      sourceTableIds: [sourceTable],
      destinationTableId: targetTable,
      sourceOrderSessionIds: [sourceSession],
      destinationOrderSessionId: targetSession,
    };
    expect(MergeDiningTableSchema.safeParse(input).success).toBe(true);
    expect(
      MergeDiningTableSchema.safeParse({
        ...input,
        sourceOrderSessionIds: [sourceSession, sourceSession],
      }).success,
    ).toBe(false);
    expect(
      MergeDiningTableSchema.safeParse({
        ...input,
        destinationOrderSessionId: sourceSession,
      }).success,
    ).toBe(false);
  });
});
