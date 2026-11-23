-- F.17.4c: draft-only, non-identifying tax preparation questionnaire.
-- User-provided answers are NOT verified legal/tax facts.
-- No TIN, NIC, income amounts, tax rates, tax payable, or approvals stored.
CREATE TABLE `taxpayer_intake_drafts` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `assessment_year_start` INT UNSIGNED NOT NULL,
  `taxpayer_category_claim` ENUM('UNKNOWN','INDIVIDUAL','COMPANY','OTHER_ENTITY','NOT_SURE') NOT NULL DEFAULT 'UNKNOWN',
  `residency_claim` ENUM('UNKNOWN','RESIDENT','NON_RESIDENT','NOT_SURE') NOT NULL DEFAULT 'UNKNOWN',
  `other_income_claim` ENUM('UNKNOWN','YES','NO','NOT_SURE') NOT NULL DEFAULT 'UNKNOWN',
  `capital_assets_claim` ENUM('UNKNOWN','YES','NO','NOT_SURE') NOT NULL DEFAULT 'UNKNOWN',
  `non_deductible_costs_claim` ENUM('UNKNOWN','YES','NO','NOT_SURE') NOT NULL DEFAULT 'UNKNOWN',
  `withholding_credits_claim` ENUM('UNKNOWN','YES','NO','NOT_SURE') NOT NULL DEFAULT 'UNKNOWN',
  `owner_is_taxpayer_claim` ENUM('UNKNOWN','YES','NO','NOT_SURE') NOT NULL DEFAULT 'UNKNOWN',
  `revision` INT UNSIGNED NOT NULL DEFAULT 1,
  `updated_by_user_id` CHAR(36) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tax_intake_business_year` (`business_id`,`assessment_year_start`),
  UNIQUE KEY `uq_tax_intake_tenant_id` (`business_id`,`id`),
  KEY `idx_tax_intake_editor` (`updated_by_user_id`),
  CONSTRAINT `fk_tax_intake_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_tax_intake_editor`
    FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_tax_intake_revision` CHECK (`revision` >= 1),
  CONSTRAINT `chk_tax_intake_year` CHECK (`assessment_year_start` >= 2025)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `taxpayer_intake_draft_audits` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `draft_id` CHAR(36) NOT NULL,
  `revision` INT UNSIGNED NOT NULL,
  `changed_by_user_id` CHAR(36) NOT NULL,
  `previous_claims_json` JSON NULL,
  `updated_claims_json` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tax_intake_audit_revision` (`draft_id`,`revision`),
  KEY `idx_tax_intake_audit_tenant` (`business_id`,`draft_id`,`revision`),
  KEY `idx_tax_intake_audit_actor` (`changed_by_user_id`),
  CONSTRAINT `fk_tax_intake_audit_draft_tenant`
    FOREIGN KEY (`business_id`,`draft_id`)
    REFERENCES `taxpayer_intake_drafts`(`business_id`,`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_tax_intake_audit_actor`
    FOREIGN KEY (`changed_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_tax_intake_audit_revision` CHECK (`revision` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The permission is created but deliberately NOT assigned to any tenant role.
-- Existing business owners need a separately reviewed explicit grant.
INSERT INTO `permissions` (`id`,`key`,`description`)
SELECT UUID(),'taxes.manage','Maintain UNVERIFIED taxpayer preparation drafts'
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `key`='taxes.manage');
