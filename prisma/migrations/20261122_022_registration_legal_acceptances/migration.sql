-- F.16.5: consent evidence for OTP-verified, payment-first registration.
-- ADDITIVE. Review and deploy only to the disposable GitHub Actions CI database.
-- This records legal agreement, not permission for marketing or payment settlement.
CREATE TABLE `registration_legal_acceptances` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `checkout_order_id` CHAR(36) NOT NULL,
  `terms_version` VARCHAR(40) NOT NULL,
  `privacy_notice_version` VARCHAR(40) NOT NULL,
  `acceptance_language` ENUM('en','ta','si') NOT NULL,
  `accepted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_registration_legal_checkout` (`checkout_order_id`),
  KEY `idx_registration_legal_user_time` (`user_id`, `accepted_at`),
  KEY `idx_registration_legal_business_time` (`business_id`, `accepted_at`),
  CONSTRAINT `fk_registration_legal_user`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_registration_legal_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_registration_legal_checkout_tenant`
    FOREIGN KEY (`business_id`, `checkout_order_id`)
    REFERENCES `checkout_orders`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
