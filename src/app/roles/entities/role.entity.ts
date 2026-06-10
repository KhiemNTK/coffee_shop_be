import { Role as RolePrisma } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RoleEntity implements RolePrisma {
  @ApiProperty({
    description: 'Unique identifier of the role',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Display name of the role',
    example: 'Admin',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Detailed description of what this role can do',
    example: 'Full access to the system',
  })
  description!: string | null;

  @ApiProperty({
    description:
      'Indicates if this is a default system role (cannot be deleted)',
    example: true,
  })
  isSystemRole!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiPropertyOptional()
  deletedAt!: Date | null;
}
