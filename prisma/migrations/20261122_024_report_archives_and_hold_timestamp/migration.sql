-- F.16.5.4d: archived report integrity and audited hold timestamp (CI ONLY).
-- Additive only. No report generation, payment, or subscription state transitions.
-- A PAST_DUE subscription without a reviewed held_at remains fail-closed.
ALTER TABLE `business_subscriptions`
  ADD COLUMN `held_at` DATETIME(3) NULL;

CREATE TABLE `archived_report_snapshots` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `subscription_id` CHAR(36) NOT NULL,
  `generated_by_user_id` CHAR(36) NOT NULL,
  `report_type` ENUM('DAILY','WEEKLY','YEARLY') NOT NULL,
  `period_start` DATE NOT NULL,
  `period_end` DATE NOT NULL,
  `content_type` VARCHAR(40) NOT NULL DEFAULT 'application/pdf',
  `content_sha256` CHAR(64) NOT NULL,
  `content_length` INT UNSIGNED NOT NULL,
  `pdf_bytes` MEDIUMBLOB NOT NULL,
  `generated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_report_archive_tenant_id` (`business_id`, `id`),
  KEY `idx_report_archive_business_generated` (`business_id`, `generated_at`),
  KEY `idx_report_archive_subscription_generated` (`subscription_id`, `generated_at`),
  CONSTRAINT `fk_report_archive_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_report_archive_subscription_tenant`
    FOREIGN KEY (`business_id`, `subscription_id`)
    REFERENCES `business_subscriptions`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_report_archive_generator`
    FOREIGN KEY (`generated_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_archive_length` CHECK (`content_length` BETWEEN 1 AND 4194304),
  CONSTRAINT `chk_archive_period` CHECK (`period_start` <= `period_end`),
  CONSTRAINT `chk_archive_pdf_type` CHECK (`content_type` = 'application/pdf')
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Do not create UPDATE/DELETE triggers here. MySQL 8.4 installations with
-- binary logging can reject trigger creation (ERROR 1419) for an
-- unprivileged application migration account. Do not grant SUPER or enable
-- log_bin_trust_function_creators as a workaround.
--
-- Until separately reviewed object-storage immutability and database
-- least-privilege grants are in place, archive immutability is NOT a
-- database-level guarantee. The internal read service checks SHA-256 but
-- cannot protect against a database writer replacing both bytes and hash.
-- This migration is for ephemeral development CI, not production rollout.
