import { DiningTable, TableStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class DiningTableEntity implements DiningTable {
  @ApiProperty({
    description: 'Unique UUID of the dining table',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Display name or label of the physical table',
    example: 'Table 01',
  })
  name!: string;

  @ApiProperty({
    description: 'Current operational status of the table',
    enum: TableStatus,
    example: TableStatus.EMPTY,
  })
  status!: TableStatus;

  @ApiProperty({
    description:
      'Timestamp indicating when the table was registered in the system',
  })
  createdAt!: Date;

  @ApiProperty({
    description:
      'Timestamp indicating when the table details were last modified',
  })
  updatedAt!: Date;

  @ApiPropertyOptional({
    description:
      'Timestamp of soft-deletion. Null indicates the table is active.',
    example: null,
    type: Date,
  })
  deletedAt!: Date | null;
}
