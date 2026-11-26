-- F.17.5i Prisma 7.10.1 validation correction.
-- These two tables already enforce uniqueness of their individual child IDs.
-- Add explicit composite unique indexes to match tenant-scoped one-to-one
-- Prisma relations without weakening existing composite foreign keys.
-- Additive and intended for disposable CI MySQL 8.4 only until approved.
ALTER TABLE `cash_transaction_create_requests`
  ADD UNIQUE KEY `uq_cash_create_tenant_transaction` (`business_id`, `cash_transaction_id`);

ALTER TABLE `registration_legal_acceptances`
  ADD UNIQUE KEY `uq_registration_legal_tenant_checkout` (`business_id`, `checkout_order_id`);
