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

  KITCHEN_STATIONS_READ: '/kitchen-stations_read',
  KITCHEN_STATIONS_MANAGE: '/kitchen-stations_manage',
  KITCHEN_TICKETS_READ: '/kitchen-tickets_read',

  MENU_READ: '/menu_read',
  MENU_CREATE: '/menu_create',
  MENU_UPDATE: '/menu_update',
  MENU_DELETE: '/menu_delete',

  INVENTORY_READ: '/inventory_read',
  INVENTORY_CREATE: '/inventory_create',
  INVENTORY_UPDATE: '/inventory_update',
  INVENTORY_DELETE: '/inventory_delete',
  INVENTORY_STOCK_ADJUST: '/inventory_stock_adjust',
  INVENTORY_SUPPLIERS_READ: '/inventory_suppliers_read',
  INVENTORY_SUPPLIERS_MANAGE: '/inventory_suppliers_manage',
  INVENTORY_PURCHASE_RECEIPTS_READ: '/inventory_purchase-receipts_read',
  INVENTORY_PURCHASE_RECEIPTS_CREATE: '/inventory_purchase-receipts_create',
  INVENTORY_PURCHASE_RECEIPTS_POST: '/inventory_purchase-receipts_post',
  INVENTORY_STOCKTAKES_READ: '/inventory_stocktakes_read',
  INVENTORY_STOCKTAKES_CREATE: '/inventory_stocktakes_create',
  INVENTORY_STOCKTAKES_POST: '/inventory_stocktakes_post',

  INVOICES_READ: '/invoices_read',
  INVOICES_CREATE: '/invoices_create',
  INVOICES_UPDATE: '/invoices_update',
  INVOICES_DELETE: '/invoices_delete',

  PAYMENT_ATTEMPTS_CREATE: '/payment-attempts_create',
  PAYMENT_ATTEMPTS_READ: '/payment-attempts_read',
  PAYMENT_REFUNDS_CREATE: '/payment-refunds_create',
  PAYMENT_REFUNDS_READ: '/payment-refunds_read',
  PAYMENT_RECONCILIATION_READ: '/payment-reconciliation_read',
  PAYMENT_RECONCILIATION_MANAGE: '/payment-reconciliation_manage',

  PRINT_DEVICES_READ: '/print-devices_read',
  PRINT_DEVICES_MANAGE: '/print-devices_manage',
  PRINT_JOBS_READ: '/print-jobs_read',
  PRINT_JOBS_MANAGE: '/print-jobs_manage',
  RECEIPTS_REPRINT: '/receipts_reprint',

  RESERVATIONS_READ: '/reservations_read',
  RESERVATIONS_CREATE: '/reservations_create',
  RESERVATIONS_UPDATE: '/reservations_update',
  RESERVATIONS_DELETE: '/reservations_delete',
  RESERVATIONS_CANCEL: '/reservations_cancel',
  RESERVATIONS_CHECK_IN: '/reservations_check-in',

  PROMOTIONS_READ: '/promotions_read',
  PROMOTIONS_CREATE: '/promotions_create',
  PROMOTIONS_UPDATE: '/promotions_update',
  PROMOTIONS_DELETE: '/promotions_delete',

  EQUIPMENT_READ: '/equipment_read',
  EQUIPMENT_CREATE: '/equipment_create',
  EQUIPMENT_UPDATE: '/equipment_update',
  EQUIPMENT_DELETE: '/equipment_delete',
  EQUIPMENT_TRANSITION: '/equipment_transition',

  SYSTEM_SETTINGS_READ: '/system-settings_read',
  SYSTEM_SETTINGS_CREATE: '/system-settings_create',
  SYSTEM_SETTINGS_UPDATE: '/system-settings_update',
  SYSTEM_SETTINGS_DELETE: '/system-settings_delete',

  REPORTS_READ: '/reports_read',
  REPORTS_EXPORT: '/reports_export',
  REPORTS_CLOSE: '/reports_close',

  AUDIT_LOGS_READ: '/audit-logs_read',

  FUNDS_READ: '/funds_read',
  FUNDS_MANAGE: '/funds_manage',

  CASHIER_SHIFTS_CURRENT: '/cashier-shifts_current',
  CASHIER_SHIFTS_READ: '/cashier-shifts_read',
  CASHIER_SHIFTS_OPEN: '/cashier-shifts_open',
  CASHIER_SHIFTS_CLOSE: '/cashier-shifts_close',
  CASHIER_SHIFTS_TRANSACTIONS_CREATE: '/cashier-shifts_transactions-create',
  CASHIER_SHIFTS_EXPENSES_REVIEW: '/cashier-shifts_expenses-review',

  CASH_HANDOVERS_CREATE: '/cash-handovers_create',
  CASH_HANDOVERS_READ: '/cash-handovers_read',
  CASH_HANDOVERS_REVIEW: '/cash-handovers_review',
  CASH_HANDOVERS_SETTLE: '/cash-handovers_settle',

  BANK_RECONCILIATION_READ: '/bank-reconciliation_read',
  BANK_RECONCILIATION_IMPORT: '/bank-reconciliation_import',
  BANK_RECONCILIATION_MANAGE: '/bank-reconciliation_manage',
} as const;
