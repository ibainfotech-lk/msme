-- F.16.5.3: identity-level claim ledger for trials AND promotion reservations.
-- Review and run only in disposable CI MySQL 8.4 until separately approved.
-- Never marks a checkout paid or a business ACTIVE.
-- If legacy offers conflict on identity, migration deliberately fails closed.
CREATE TABLE `identity_offer_claims` (
  `identity_fingerprint` CHAR(64) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `offer_kind` ENUM('TRIAL', 'PROMOTION') NOT NULL,
  `reservation_id` CHAR(36) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`identity_fingerprint`),
  UNIQUE KEY `uq_offer_kind_reservation` (`offer_kind`, `reservation_id`),
  KEY `idx_offer_claim_business` (`business_id`),
  CONSTRAINT `fk_offer_claim_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Keep historic promotion_redemptions compatible: existing rows default APPLIED
-- and their optional fingerprint/checkout remain NULL until reviewed.
-- New reservations always supply BOTH fields and use RESERVED status.
ALTER TABLE `promotion_redemptions`
  ADD COLUMN `identity_fingerprint` CHAR(64) NULL,
  ADD COLUMN `checkout_order_id` CHAR(36) NULL,
  ADD COLUMN `reservation_status` ENUM('RESERVED', 'APPLIED') NOT NULL DEFAULT 'APPLIED';

CREATE UNIQUE INDEX `uq_promo_identity`
  ON `promotion_redemptions` (`identity_fingerprint`);
CREATE UNIQUE INDEX `uq_promo_checkout_tenant`
  ON `promotion_redemptions` (`business_id`, `checkout_order_id`);

ALTER TABLE `promotion_redemptions`
  ADD CONSTRAINT `fk_promo_checkout_tenant`
    FOREIGN KEY (`business_id`, `checkout_order_id`)
    REFERENCES `checkout_orders`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill known trial reservations into the shared one-offer-per-identity ledger.
INSERT INTO `identity_offer_claims`
  (`identity_fingerprint`, `business_id`, `offer_kind`, `reservation_id`, `created_at`)
SELECT `identity_fingerprint`, `business_id`, 'TRIAL', `id`, `created_at`
FROM `introductory_trial_grants`;

-- Backfill promotions where previously reviewed identity evidence exists.
-- Duplicate identities deliberately stop the migration for manual review.
INSERT INTO `identity_offer_claims`
  (`identity_fingerprint`, `business_id`, `offer_kind`, `reservation_id`, `created_at`)
SELECT vbi.`identity_fingerprint`, pr.`business_id`, 'PROMOTION',
       pr.`id`, pr.`redeemed_at`
FROM `promotion_redemptions` pr
JOIN `verified_business_identities` vbi ON vbi.`business_id` = pr.`business_id`;
