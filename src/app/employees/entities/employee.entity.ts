import { Employee as EmployeePrisma } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';

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
