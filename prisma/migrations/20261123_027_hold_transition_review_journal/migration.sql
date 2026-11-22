-- F.16.5.4k — Append-only-by-application review journal foundation.
-- Development CI only: NO subscription status update, NO payment initiation.
-- No MySQL triggers: explicit least-privilege / tamper-evidence remains a
-- separately reviewed production prerequisite.
CREATE TABLE `subscription_hold_review_journal` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `subscription_id` CHAR(36) NOT NULL,
  `reviewer_user_id` CHAR(36) NOT NULL,
  `idempotency_key` VARCHAR(191) NOT NULL,
  `transition_type` ENUM('PLACE_HOLD', 'RESTORE_ACCESS') NOT NULL,
  `decision_status` ENUM('POLICY_READY') NOT NULL,
  `evidence_sha256` CHAR(64) NOT NULL,
  `statement_as_of` DATETIME(3) NOT NULL,
  `outstanding_lkr` DECIMAL(12,2) NOT NULL,
  `notice_reference` VARCHAR(191) NULL,
  `grace_ends_at` DATETIME(3) NULL,
  `review_reason` VARCHAR(500) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hold_review_idempotency_business` (`business_id`, `idempotency_key`),
  KEY `idx_hold_review_subscription_time` (`business_id`, `subscription_id`, `created_at`),
  KEY `idx_hold_review_actor_time` (`reviewer_user_id`, `created_at`),
  CONSTRAINT `fk_hold_review_subscription_tenant`
    FOREIGN KEY (`business_id`, `subscription_id`)
    REFERENCES `business_subscriptions`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_hold_review_reviewer`
    FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_hold_review_outstanding` CHECK (`outstanding_lkr` >= 0.00)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
