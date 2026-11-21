
-- Noteto Step 8J.97B
-- Migration: 20261117_004_otp_verifications
-- Target: MySQL 8.4 / noteto_dev
-- Creates storage for hashed, expiring phone OTP challenges.

CREATE TABLE `otp_verifications` (
    `id` CHAR(36)
        COLLATE utf8mb4_unicode_ci NOT NULL,

    `phone` VARCHAR(20)
        COLLATE utf8mb4_unicode_ci NOT NULL,

    `otp_hash` VARCHAR(255)
        COLLATE utf8mb4_unicode_ci NOT NULL,

    `attempts` INT UNSIGNED NOT NULL DEFAULT 0,

    `expires_at` DATETIME(3) NOT NULL,

    `created_at` DATETIME(3)
        NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),

    UNIQUE KEY `uq_otp_verifications_phone` (`phone`),

    KEY `idx_otp_verifications_expires_at` (`expires_at`)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
