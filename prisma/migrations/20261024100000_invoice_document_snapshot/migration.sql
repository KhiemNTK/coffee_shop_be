BEGIN;

ALTER TABLE "Invoice" ADD COLUMN "documentSnapshot" JSONB;

-- Backfill preserves what is still available, not the original historical names.
UPDATE "Invoice" i SET "documentSnapshot" = jsonb_build_object(
  'version', 1,
  'source', 'LEGACY_BACKFILL',
  'tableId', s."tableId",
  'tableName', t."name",
  'issuedByName', (SELECT e."fullName" FROM "Employee" e WHERE e."id" = i."employeeId"),
  'promotionName', (SELECT p."name" FROM "Promotion" p WHERE p."id" = i."promotionId"),
  'items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'orderItemId', oi."id",
      'menuItemId', oi."menuItemId",
      'name', m."name",
      'quantity', oi."quantity",
      'unitPrice', oi."priceAtTime"::text,
      'note', oi."note",
      'selectedOptions', oi."selectedOptions"
    ) ORDER BY oi."createdAt", oi."id")
    FROM "OrderItem" oi JOIN "MenuItem" m ON m."id" = oi."menuItemId"
    WHERE oi."invoiceId" = i."id"
  ), '[]'::jsonb)
)
FROM "OrderSession" s
LEFT JOIN "DiningTable" t ON t."id" = s."tableId"
WHERE s."id" = i."orderSessionId";

ALTER TABLE "Invoice" ADD CONSTRAINT "invoice_document_snapshot_shape" CHECK (
  "documentSnapshot" IS NULL OR (
    jsonb_typeof("documentSnapshot") = 'object'
    AND "documentSnapshot"->>'version' = '1'
    AND jsonb_typeof("documentSnapshot"->'items') = 'array'
  ) IS TRUE
);

CREATE FUNCTION preserve_invoice_document_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."documentSnapshot" IS NOT NULL
    AND NEW."documentSnapshot" IS DISTINCT FROM OLD."documentSnapshot" THEN
    RAISE EXCEPTION 'Invoice document snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invoice_document_snapshot_immutable
BEFORE UPDATE OF "documentSnapshot" ON "Invoice"
FOR EACH ROW EXECUTE FUNCTION preserve_invoice_document_snapshot();

COMMIT;
