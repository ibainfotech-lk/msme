-- F.17.5i: developer/CI-only OTP dispatch journal. Additive migration.
-- No OTP plaintext, SMS message, API token, phone number or bank fields stored.
-- Intentionally NO foreign key to otp_verifications: a successfully verified
-- challenge is deleted by the existing OTP verification lifecycle.
-- This is NOT a production release approval or live SMS integration.
CREATE TABLE `otp_dispatch_records` (
  `id` CHAR(36) NOT NULL,
  `challenge_id` CHAR(36) NOT NULL,
  `request_key` VARCHAR(100) NOT NULL,
  `request_sha256` CHAR(64) NOT NULL,
  `recipient_hmac_sha256` CHAR(64) NOT NULL,
  `provider` ENUM('ESMS') NOT NULL DEFAULT 'ESMS',
  `status` ENUM('RESERVED','DISPATCH_UNKNOWN','ACKNOWLEDGED','DELIVERED','FAILED') NOT NULL DEFAULT 'RESERVED',
  `attempt_count` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `provider_uid` VARCHAR(128) NULL,
  `challenge_expires_at` DATETIME(3) NOT NULL,
  `attempted_at` DATETIME(3) NULL,
  `finalized_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_otp_dispatch_challenge` (`challenge_id`),
  UNIQUE KEY `uq_otp_dispatch_key` (`request_key`),
  UNIQUE KEY `uq_otp_dispatch_provider_uid` (`provider_uid`),
  KEY `idx_otp_dispatch_status_created` (`status`,`created_at`),
  KEY `idx_otp_dispatch_expiry` (`challenge_expires_at`),
  CONSTRAINT `chk_otp_dispatch_single_attempt` CHECK (`attempt_count` <= 1),
  CONSTRAINT `chk_otp_dispatch_fingerprints`
    CHECK (CHAR_LENGTH(`request_sha256`) = 64 AND CHAR_LENGTH(`recipient_hmac_sha256`) = 64)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Append-only lifecycle facts. This journal does not authorize any resend,
-- authenticate any user, activate any subscription, or prove SMS delivery.
CREATE TABLE `otp_dispatch_events` (
  `id` CHAR(36) NOT NULL,
  `dispatch_id` CHAR(36) NOT NULL,
  `event_type` ENUM('RESERVED','SEND_CLAIMED','ACKNOWLEDGED','DELIVERED','FAILED') NOT NULL,
  `provider_uid` VARCHAR(128) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_otp_dispatch_event_once` (`dispatch_id`,`event_type`),
  KEY `idx_otp_dispatch_event_time` (`dispatch_id`,`created_at`),
  CONSTRAINT `fk_otp_dispatch_event_record`
    FOREIGN KEY (`dispatch_id`) REFERENCES `otp_dispatch_records`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
