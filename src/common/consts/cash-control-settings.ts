export const CashControlSettingKeys = {
  EXPENSE_APPROVAL_THRESHOLD: 'cash.expense_approval_threshold',
  SHIFT_DISCREPANCY_NOTE_THRESHOLD: 'cash.shift_discrepancy_note_threshold',
  HANDOVER_SETTLEMENT_SLA_HOURS: 'cash.handover_settlement_sla_hours',
} as const;

export const CashControlSettingDefaults = {
  EXPENSE_APPROVAL_THRESHOLD: 500_000,
  SHIFT_DISCREPANCY_NOTE_THRESHOLD: 10_000,
  HANDOVER_SETTLEMENT_SLA_HOURS: 24,
} as const;
