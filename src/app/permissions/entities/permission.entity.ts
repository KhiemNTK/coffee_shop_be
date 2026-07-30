import { Permission as PermissionPrisma } from '@prisma/client';

export class PermissionEntity implements PermissionPrisma {
  id!: string;
  name!: string;
  description!: string | null;
  key!: string;
  isSystemPermission!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
  deletedAt!: Date | null;
}
