export const SYSTEM_ROLE_NAMES = {
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  CASHIER: 'CASHIER',
  WAITER: 'WAITER',
  KITCHEN: 'KITCHEN',
  INVENTORY_STAFF: 'INVENTORY_STAFF',
} as const;

export const DEFAULT_EMPLOYEE_ROLE_NAME = SYSTEM_ROLE_NAMES.WAITER;

export const PermissionKeys = {
  PERMISSIONS_READ: '/permissions_read',
  PERMISSIONS_CREATE: '/permissions_create',
  PERMISSIONS_UPDATE: '/permissions_update',
  PERMISSIONS_DELETE: '/permissions_delete',

  ROLES_READ: '/roles_read',
  ROLES_CREATE: '/roles_create',
  ROLES_UPDATE: '/roles_update',
  ROLES_DELETE: '/roles_delete',
  ROLE_PERMISSIONS_READ: '/roles_permissions_read',
  ROLE_PERMISSIONS_UPDATE: '/roles_permissions_update',

  EMPLOYEES_READ: '/employees_read',
  EMPLOYEES_CREATE: '/employees_create',
  EMPLOYEES_UPDATE: '/employees_update',
  EMPLOYEES_DELETE: '/employees_delete',
  EMPLOYEE_ROLES_READ: '/employees_roles_read',
  EMPLOYEE_ROLES_UPDATE: '/employees_roles_update',

  POSITIONS_READ: '/positions_read',
  POSITIONS_CREATE: '/positions_create',
  POSITIONS_UPDATE: '/positions_update',
  POSITIONS_DELETE: '/positions_delete',

  DINING_TABLES_READ: '/dining-tables_read',
  DINING_TABLES_CREATE: '/dining-tables_create',
  DINING_TABLES_UPDATE: '/dining-tables_update',
  DINING_TABLES_DELETE: '/dining-tables_delete',

  ORDERS_SESSIONS_READ: '/orders_sessions_read',
  ORDERS_SESSIONS_CREATE: '/orders_sessions_create',
  ORDERS_SESSIONS_CANCEL: '/orders_sessions_cancel',
  ORDERS_ITEMS_CREATE: '/orders_items_create',
  ORDERS_ITEMS_UPDATE_STATUS: '/orders_items_update-status',
  ORDERS_ITEMS_CANCEL: '/orders_items_cancel',
  ORDERS_TABLES_TRANSFER: '/orders_tables_transfer',
  ORDERS_TABLES_MERGE: '/orders_tables_merge',
  ORDERS_TABLES_SPLIT: '/orders_tables_split',
  ORDERS_TABLES_CLEAR: '/orders_tables_clear',

  MENU_READ: '/menu_read',
  MENU_CREATE: '/menu_create',
  MENU_UPDATE: '/menu_update',
  MENU_DELETE: '/menu_delete',

  INVENTORY_READ: '/inventory_read',
  INVENTORY_CREATE: '/inventory_create',
  INVENTORY_UPDATE: '/inventory_update',
  INVENTORY_DELETE: '/inventory_delete',

  INVOICES_READ: '/invoices_read',
  INVOICES_CREATE: '/invoices_create',
  INVOICES_UPDATE: '/invoices_update',
  INVOICES_DELETE: '/invoices_delete',

  RESERVATIONS_READ: '/reservations_read',
  RESERVATIONS_CREATE: '/reservations_create',
  RESERVATIONS_UPDATE: '/reservations_update',
  RESERVATIONS_DELETE: '/reservations_delete',

  PROMOTIONS_READ: '/promotions_read',
  PROMOTIONS_CREATE: '/promotions_create',
  PROMOTIONS_UPDATE: '/promotions_update',
  PROMOTIONS_DELETE: '/promotions_delete',

  EQUIPMENT_READ: '/equipment_read',
  EQUIPMENT_CREATE: '/equipment_create',
  EQUIPMENT_UPDATE: '/equipment_update',
  EQUIPMENT_DELETE: '/equipment_delete',

  SYSTEM_SETTINGS_READ: '/system-settings_read',
  SYSTEM_SETTINGS_CREATE: '/system-settings_create',
  SYSTEM_SETTINGS_UPDATE: '/system-settings_update',
  SYSTEM_SETTINGS_DELETE: '/system-settings_delete',
} as const;
