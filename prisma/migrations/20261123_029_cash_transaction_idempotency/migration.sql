-- Noteto F.17.1: idempotent manual cash-basis income/expense entry creation.
-- Additive, disposable CI MySQL 8.4 only until the production rollout is approved.
-- No triggers, invoices, banking, report generation or subscription changes.
CREATE TABLE `cash_transaction_create_requests` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `cash_transaction_id` CHAR(36) NOT NULL,
  `created_by_user_id` CHAR(36) NOT NULL,
  `idempotency_key` VARCHAR(100) NOT NULL,
  `request_sha256` CHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cash_create_business_key` (`business_id`, `idempotency_key`),
  UNIQUE KEY `uq_cash_create_transaction` (`cash_transaction_id`),
  KEY `idx_cash_create_user_time` (`created_by_user_id`, `created_at`),
  CONSTRAINT `fk_cash_create_tenant_transaction`
    FOREIGN KEY (`business_id`, `cash_transaction_id`)
    REFERENCES `cash_transactions`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_cash_create_actor`
    FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
