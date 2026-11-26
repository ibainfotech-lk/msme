-- F.16.5.4e — UUID cash transaction ledger and atomic historical edit audit.
-- Additive schema for ephemeral CI only. No customer transactions or routes enabled.
-- Do NOT introduce privileged MySQL triggers (binary-log 1419) or run locally.
CREATE TABLE `cash_transactions` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `created_by_user_id` CHAR(36) NOT NULL,
  `transaction_type` ENUM('INCOME','EXPENSE') NOT NULL,
  `amount_lkr` DECIMAL(12,2) NOT NULL,
  `category` VARCHAR(100) NOT NULL,
  `description` VARCHAR(500) NOT NULL DEFAULT '',
  `occurred_on` DATE NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cash_transaction_business_id` (`business_id`, `id`),
  KEY `idx_cash_transactions_business_date` (`business_id`, `occurred_on`, `transaction_type`),
  CONSTRAINT `fk_cash_transaction_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_cash_transaction_creator`
    FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_cash_transactions_positive` CHECK (`amount_lkr` > 0.00),
  CONSTRAINT `chk_cash_transactions_version` CHECK (`version` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `cash_transaction_edit_audits` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `cash_transaction_id` CHAR(36) NOT NULL,
  `edited_by_user_id` CHAR(36) NOT NULL,
  `prior_version` INT UNSIGNED NOT NULL,
  `new_version` INT UNSIGNED NOT NULL,
  `old_amount_lkr` DECIMAL(12,2) NOT NULL,
  `new_amount_lkr` DECIMAL(12,2) NOT NULL,
  `old_category` VARCHAR(100) NOT NULL,
  `new_category` VARCHAR(100) NOT NULL,
  `old_description` VARCHAR(500) NOT NULL,
  `new_description` VARCHAR(500) NOT NULL,
  `old_occurred_on` DATE NOT NULL,
  `new_occurred_on` DATE NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `edited_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cash_edit_revision` (`cash_transaction_id`, `new_version`),
  KEY `idx_cash_edit_business_time` (`business_id`, `edited_at`),
  CONSTRAINT `fk_cash_edit_transaction_tenant`
    FOREIGN KEY (`business_id`, `cash_transaction_id`)
    REFERENCES `cash_transactions`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_cash_edit_actor`
    FOREIGN KEY (`edited_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_cash_edit_revision` CHECK (`new_version` = `prior_version` + 1),
  CONSTRAINT `chk_cash_edit_positive` CHECK (`old_amount_lkr` > 0.00 AND `new_amount_lkr` > 0.00)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
