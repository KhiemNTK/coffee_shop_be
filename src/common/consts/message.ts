export const AUTH_ERRORS = {
  USER_NOT_FOUND: 'User not found',
  USER_ALREADY_EXISTS: 'User already exists',
  EMAIL_ALREADY_EXISTS: 'Email already exists',
  USERNAME_ALREADY_EXISTS: 'Username already exists',
  INVALID_TOKEN: 'Invalid token',
  INVALID_SECRET_KEY: 'Invalid secret key',
  INACTIVE_EMPLOYEE: 'Employee account is inactive',
};

export const AUTHORIZATION_ERRORS = {
  PERMISSION_DENIED: 'Permission denied',
  PERMISSION_NOT_FOUND: 'Permission not found',
  PERMISSION_KEY_EXISTS: 'Permission key already exists',
  ROLE_NAME_EXISTS: 'Role name already exists',
  INVALID_PERMISSION_IDS: 'One or more permission IDs are invalid',
  INVALID_ROLE_IDS: 'One or more role IDs are invalid',
  DUPLICATE_PERMISSION_IDS: 'Duplicate permission IDs are not allowed',
  DUPLICATE_ROLE_IDS: 'Duplicate role IDs are not allowed',
  SYSTEM_PERMISSION_CANNOT_BE_MODIFIED: 'System permission cannot be modified',
  SYSTEM_PERMISSION_CANNOT_BE_DELETED: 'System permission cannot be deleted',
  SYSTEM_ROLE_CANNOT_BE_MODIFIED: 'System role cannot be modified',
};

export const SYSTEM_ERRORS = {
  INVALID_DEFAULT_POSITION: 'Default position not found',
  POSITION_NOT_FOUND: 'Position not found',
  ROLE_NOT_FOUND: 'Role not found',
  SYSTEM_ROLE_CANNOT_BE_DELETED: 'System role cannot be deleted',
  WORKSHEETS_IS_EMPTY: 'Worksheets is empty',
  FILE_NOT_FOUND: 'File not found',
};

export const TABLE_ERRORS = {
  CANNOT_MOVE_TO_SAME_TABLE: 'Cannot move to the same table',
  TARGET_TABLE_NOT_FOUND_OR_OCCUPIED:
    'Target table does not exist or is occupied',
  CURRENT_TABLE_NO_SERVING_DATA: 'Current table has no serving data',
  TARGET_TABLE_CANNOT_BE_IN_SOURCE_LIST:
    'Target table cannot be in the source table list',
  TARGET_TABLE_NO_INVOICE_TO_MERGE:
    'Target table does not have an invoice to merge',
  NO_ITEMS_FROM_SOURCE_TO_MERGE: 'No items from the source table to merge',
  SOURCE_TABLE_NO_VALID_INVOICE: 'Source table has no valid invoice',
  TARGET_TABLE_UNAVAILABLE: 'Target table is unavailable',
  MOVE_TABLE_SUCCESS: 'Table moved successfully',
};
