-- F.16.5.4l — provider notice receipt storage foundation.
-- No production ingestion/verification, no automatic hold or restoration.
CREATE TABLE `subscription_hold_notice_receipts` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `subscription_id` CHAR(36) NOT NULL,
  `provider` VARCHAR(60) NOT NULL,
  `delivery_channel` ENUM('SMS', 'EMAIL', 'WHATSAPP') NOT NULL,
  `provider_delivery_reference` VARCHAR(191) NOT NULL,
  `provider_event_sha256` CHAR(64) NOT NULL,
  `notice_template_version` VARCHAR(40) NOT NULL,
  `terms_version` VARCHAR(40) NOT NULL,
  `billing_statement_sha256` CHAR(64) NOT NULL,
  `delivered_at` DATETIME(3) NOT NULL,
  `verified_at` DATETIME(3) NULL,
  `grace_ends_at` DATETIME(3) NOT NULL,
  `provenance_status` ENUM('UNVERIFIED', 'VERIFIED') NOT NULL DEFAULT 'UNVERIFIED',
  `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hold_notice_provider_delivery` (`provider`, `provider_delivery_reference`),
  KEY `idx_hold_notice_business_time` (`business_id`, `subscription_id`, `delivered_at`),
  CONSTRAINT `fk_hold_notice_subscription_tenant`
    FOREIGN KEY (`business_id`, `subscription_id`)
    REFERENCES `business_subscriptions`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_hold_notice_grace_after_delivery`
    CHECK (`grace_ends_at` > `delivered_at`),
  CONSTRAINT `chk_hold_notice_verified_timestamp`
    CHECK (`provenance_status` = 'UNVERIFIED'
       OR (`verified_at` IS NOT NULL AND `verified_at` >= `delivered_at`))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Important: Setting provenance_status='VERIFIED' manually is NOT provider
-- authentication. Only a future authenticated provider adapter may record it.
-- Runtime DB accounts must lack direct UPDATE/INSERT permissions until then.
