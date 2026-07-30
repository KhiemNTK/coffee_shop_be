import { Employee as EmployeePrisma } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import { Decimal } from '@prisma/client/runtime/library';

export class EmployeeEntity implements EmployeePrisma {
  @ApiProperty({
    description: 'ID of the employee',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({ example: 'nguyenvana@example.com' })
  email!: string;

  @ApiPropertyOptional({ example: 'https://avatar.com/user.png' })
  avatarUrl!: string | null;

  @ApiProperty({ example: 'Nguyễn Văn A' })
  fullName!: string;

  @ApiPropertyOptional()
  address!: string | null;

  @ApiPropertyOptional()
  phoneNumber!: string | null;

  @ApiProperty()
  username!: string;

  @Exclude()
  password!: string;

  @ApiPropertyOptional()
  salary!: Decimal | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiPropertyOptional()
  deletedAt!: Date | null;

  @ApiProperty()
  positionId!: string;
}
