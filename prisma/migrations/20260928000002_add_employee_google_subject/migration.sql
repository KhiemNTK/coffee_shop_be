ALTER TABLE "Employee" ADD COLUMN "googleSubject" VARCHAR(255);

CREATE UNIQUE INDEX "Employee_googleSubject_key" ON "Employee"("googleSubject");
