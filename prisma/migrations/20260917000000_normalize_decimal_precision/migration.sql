-- Normalize monetary and quantity precision without silently rounding data.
-- Schedule this migration in a maintenance window because ALTER COLUMN TYPE
-- takes table locks and may rewrite large tables.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "salary" AS value FROM "Position"
      UNION ALL SELECT "balance" FROM "Fund"
      UNION ALL SELECT "price" FROM "MenuItem"
      UNION ALL SELECT "discountValue" FROM "Promotion"
      UNION ALL SELECT "maxDiscount" FROM "Promotion"
      UNION ALL SELECT "unitPrice" FROM "Equipment"
      UNION ALL SELECT "totalAmount" FROM "Equipment"
      UNION ALL SELECT "salary" FROM "Employee"
      UNION ALL SELECT "startingCash" FROM "CashierShift"
      UNION ALL SELECT "reportedEndingCash" FROM "CashierShift"
      UNION ALL SELECT "actualEndingCash" FROM "CashierShift"
      UNION ALL SELECT "unitPrice" FROM "InventoryTransaction"
      UNION ALL SELECT "totalAmount" FROM "InventoryTransaction"
      UNION ALL SELECT "priceAtTime" FROM "OrderItem"
      UNION ALL SELECT "subTotal" FROM "Invoice"
      UNION ALL SELECT "discountAmount" FROM "Invoice"
      UNION ALL SELECT "totalAmount" FROM "Invoice"
      UNION ALL SELECT "amountTendered" FROM "Invoice"
      UNION ALL SELECT "changeAmount" FROM "Invoice"
      UNION ALL SELECT "taxAmount" FROM "Invoice"
      UNION ALL SELECT "amount" FROM "CashTransaction"
    ) money_values
    WHERE value IS NOT NULL
      AND (abs(value) >= 10000000000000000 OR value <> round(value, 2))
  ) THEN
    RAISE EXCEPTION 'Money values exceed DECIMAL(18,2) precision or scale.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "stock" AS value FROM "InventoryItem"
      UNION ALL SELECT "quantity" FROM "MenuItemIngredient"
      UNION ALL SELECT "quantity" FROM "InventoryTransaction"
    ) quantity_values
    WHERE abs(value) >= 100000000000000
       OR value <> round(value, 4)
  ) THEN
    RAISE EXCEPTION 'Quantity values exceed DECIMAL(18,4) precision or scale.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Invoice"
    WHERE abs("taxRate") >= 1000 OR "taxRate" <> round("taxRate", 2)
  ) THEN
    RAISE EXCEPTION 'Invoice.taxRate values exceed DECIMAL(5,2) precision or scale.';
  END IF;
END $$;

ALTER TABLE "Position"
  ALTER COLUMN "salary" TYPE DECIMAL(18,2) USING "salary"::DECIMAL(18,2);
ALTER TABLE "Fund"
  ALTER COLUMN "balance" TYPE DECIMAL(18,2) USING "balance"::DECIMAL(18,2);
ALTER TABLE "MenuItem"
  ALTER COLUMN "price" TYPE DECIMAL(18,2) USING "price"::DECIMAL(18,2);
ALTER TABLE "Promotion"
  ALTER COLUMN "discountValue" TYPE DECIMAL(18,2) USING "discountValue"::DECIMAL(18,2),
  ALTER COLUMN "maxDiscount" TYPE DECIMAL(18,2) USING "maxDiscount"::DECIMAL(18,2);
ALTER TABLE "Equipment"
  ALTER COLUMN "unitPrice" TYPE DECIMAL(18,2) USING "unitPrice"::DECIMAL(18,2),
  ALTER COLUMN "totalAmount" TYPE DECIMAL(18,2) USING "totalAmount"::DECIMAL(18,2);
ALTER TABLE "Employee"
  ALTER COLUMN "salary" TYPE DECIMAL(18,2) USING "salary"::DECIMAL(18,2);
ALTER TABLE "InventoryItem"
  ALTER COLUMN "stock" TYPE DECIMAL(18,4) USING "stock"::DECIMAL(18,4);
ALTER TABLE "CashierShift"
  ALTER COLUMN "startingCash" TYPE DECIMAL(18,2) USING "startingCash"::DECIMAL(18,2),
  ALTER COLUMN "reportedEndingCash" TYPE DECIMAL(18,2) USING "reportedEndingCash"::DECIMAL(18,2),
  ALTER COLUMN "actualEndingCash" TYPE DECIMAL(18,2) USING "actualEndingCash"::DECIMAL(18,2);
ALTER TABLE "MenuItemIngredient"
  ALTER COLUMN "quantity" TYPE DECIMAL(18,4) USING "quantity"::DECIMAL(18,4);
ALTER TABLE "InventoryTransaction"
  ALTER COLUMN "quantity" TYPE DECIMAL(18,4) USING "quantity"::DECIMAL(18,4),
  ALTER COLUMN "unitPrice" TYPE DECIMAL(18,2) USING "unitPrice"::DECIMAL(18,2),
  ALTER COLUMN "totalAmount" TYPE DECIMAL(18,2) USING "totalAmount"::DECIMAL(18,2);
ALTER TABLE "OrderItem"
  ALTER COLUMN "priceAtTime" TYPE DECIMAL(18,2) USING "priceAtTime"::DECIMAL(18,2);
ALTER TABLE "Invoice"
  ALTER COLUMN "subTotal" TYPE DECIMAL(18,2) USING "subTotal"::DECIMAL(18,2),
  ALTER COLUMN "discountAmount" TYPE DECIMAL(18,2) USING "discountAmount"::DECIMAL(18,2),
  ALTER COLUMN "totalAmount" TYPE DECIMAL(18,2) USING "totalAmount"::DECIMAL(18,2),
  ALTER COLUMN "amountTendered" TYPE DECIMAL(18,2) USING "amountTendered"::DECIMAL(18,2),
  ALTER COLUMN "changeAmount" TYPE DECIMAL(18,2) USING "changeAmount"::DECIMAL(18,2),
  ALTER COLUMN "taxAmount" TYPE DECIMAL(18,2) USING "taxAmount"::DECIMAL(18,2),
  ALTER COLUMN "taxRate" TYPE DECIMAL(5,2) USING "taxRate"::DECIMAL(5,2);
ALTER TABLE "CashTransaction"
  ALTER COLUMN "amount" TYPE DECIMAL(18,2) USING "amount"::DECIMAL(18,2);

ALTER TABLE "Position"
  ADD CONSTRAINT "Position_salary_non_negative_check" CHECK ("salary" >= 0);
ALTER TABLE "MenuItem"
  ADD CONSTRAINT "MenuItem_price_non_negative_check" CHECK ("price" >= 0);
ALTER TABLE "Equipment"
  ADD CONSTRAINT "Equipment_quantity_positive_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "Equipment_unit_price_non_negative_check" CHECK ("unitPrice" >= 0),
  ADD CONSTRAINT "Equipment_total_amount_non_negative_check" CHECK ("totalAmount" >= 0);
ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_salary_non_negative_check" CHECK ("salary" IS NULL OR "salary" >= 0);
ALTER TABLE "CashierShift"
  ADD CONSTRAINT "CashierShift_cash_non_negative_check" CHECK (
    "startingCash" >= 0
    AND ("reportedEndingCash" IS NULL OR "reportedEndingCash" >= 0)
    AND ("actualEndingCash" IS NULL OR "actualEndingCash" >= 0)
  );
ALTER TABLE "MenuItemIngredient"
  ADD CONSTRAINT "MenuItemIngredient_quantity_positive_check" CHECK ("quantity" > 0);
ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_quantity_positive_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "OrderItem_price_non_negative_check" CHECK ("priceAtTime" >= 0);
ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_amounts_non_negative_check" CHECK (
    "subTotal" >= 0
    AND "discountAmount" >= 0
    AND "totalAmount" >= 0
    AND ("amountTendered" IS NULL OR "amountTendered" >= 0)
    AND ("changeAmount" IS NULL OR "changeAmount" >= 0)
    AND "taxAmount" >= 0
  ),
  ADD CONSTRAINT "Invoice_discount_not_above_subtotal_check" CHECK ("discountAmount" <= "subTotal"),
  ADD CONSTRAINT "Invoice_tax_rate_range_check" CHECK ("taxRate" >= 0 AND "taxRate" <= 100);
ALTER TABLE "CashTransaction"
  ADD CONSTRAINT "CashTransaction_amount_positive_check" CHECK ("amount" > 0);
