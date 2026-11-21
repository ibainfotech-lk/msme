-- F.16.5.2: additive, fail-closed trial reservation infrastructure.
-- CI disposable MySQL 8.4 only until reviewed; do not deploy locally/production.
-- No HTTP endpoint, subscription activation, payment settlement or trial grant is created.
CREATE TABLE `verified_business_identities` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `identity_fingerprint` CHAR(64) NOT NULL,
  `verification_method` VARCHAR(50) NOT NULL,
  `evidence_reference_sha256` CHAR(64) NOT NULL,
  `verified_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_verified_identity_business` (`business_id`),
  KEY `idx_verified_identity_fingerprint` (`identity_fingerprint`),
  CONSTRAINT `fk_verified_identity_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `introductory_trial_grants` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `identity_fingerprint` CHAR(64) NOT NULL,
  `checkout_order_id` CHAR(36) NOT NULL,
  `status` ENUM('RESERVED', 'ACTIVATED') NOT NULL DEFAULT 'RESERVED',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `activated_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_intro_trial_business` (`business_id`),
  UNIQUE KEY `uq_intro_trial_identity` (`identity_fingerprint`),
  UNIQUE KEY `uq_intro_trial_checkout` (`checkout_order_id`),
  UNIQUE KEY `uq_intro_trial_checkout_tenant` (`business_id`, `checkout_order_id`),
  KEY `idx_intro_trial_status_created` (`status`, `created_at`),
  CONSTRAINT `fk_intro_trial_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_intro_trial_checkout_tenant`
    FOREIGN KEY (`business_id`, `checkout_order_id`)
    REFERENCES `checkout_orders`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
