-- Noteto F.17.4b: effective-dated, human-reviewed TAX SOURCE metadata only.
-- No rates, reliefs, tax calculations, payments or tax liability produced here.
-- No browser/API may create/update these rows. All fields require independent review.
CREATE TABLE `tax_rule_source_reviews` (
  `id` CHAR(36) NOT NULL,
  `source_code` VARCHAR(64) NOT NULL,
  `revision` INT UNSIGNED NOT NULL,
  `taxpayer_scope` ENUM('INDIVIDUAL','COMPANY','OTHER_ENTITY') NOT NULL,
  `assessment_year_start` INT UNSIGNED NOT NULL,
  `effective_from` DATE NOT NULL,
  `effective_to` DATE NOT NULL,
  `source_title` VARCHAR(250) NOT NULL,
  `source_uri` VARCHAR(700) NOT NULL,
  `source_sha256` CHAR(64) NOT NULL,
  `review_status` ENUM('DRAFT','REVIEWED','REVOKED') NOT NULL DEFAULT 'DRAFT',
  `reviewed_by_user_id` CHAR(36) NULL,
  `reviewed_at` DATETIME(3) NULL,
  `review_note` VARCHAR(500) NOT NULL DEFAULT '',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tax_rule_source_code_revision` (`source_code`,`revision`),
  KEY `idx_tax_rule_source_scope_year_status`
    (`taxpayer_scope`,`assessment_year_start`,`review_status`),
  KEY `idx_tax_rule_source_reviewed_by` (`reviewed_by_user_id`),
  CONSTRAINT `fk_tax_rule_source_reviewer`
    FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_tax_rule_source_year`
    CHECK (`assessment_year_start` >= 2025),
  CONSTRAINT `chk_tax_rule_source_revision`
    CHECK (`revision` >= 1),
  CONSTRAINT `chk_tax_rule_source_effective_dates`
    CHECK (`effective_to` >= `effective_from`),
  -- MySQL 8.4 error 3823: a CHECK cannot refer to a column used by
  -- the reviewer foreign key's referential action. Check only reviewed_at
  -- here; validate non-NULL reviewer identity in the restricted review
  -- workflow and fail-closed read service instead.
  CONSTRAINT `chk_tax_rule_source_review_timestamp`
    CHECK (
      (`review_status` = 'DRAFT' AND `reviewed_at` IS NULL)
      OR
      (`review_status` IN ('REVIEWED','REVOKED') AND `reviewed_at` IS NOT NULL)
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
