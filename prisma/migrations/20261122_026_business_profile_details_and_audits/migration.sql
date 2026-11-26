-- F.16.5.4i: profile details and transactional profile edit audit.
-- No customer-finance tables are changed. Development-only until reviewed.
CREATE TABLE `business_profile_details` (
  `business_id` CHAR(36) NOT NULL,
  `display_name` VARCHAR(150) NOT NULL DEFAULT '',
  `contact_email` VARCHAR(191) NOT NULL DEFAULT '',
  `address` VARCHAR(350) NOT NULL DEFAULT '',
  `version` INT UNSIGNED NOT NULL DEFAULT 0,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`business_id`),
  CONSTRAINT `fk_profile_details_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_profile_details_version` CHECK (`version` >= 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `business_profile_edit_audits` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `edited_by_user_id` CHAR(36) NOT NULL,
  `old_version` INT UNSIGNED NOT NULL,
  `new_version` INT UNSIGNED NOT NULL,
  `old_profile` JSON NOT NULL,
  `new_profile` JSON NOT NULL,
  `edited_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_profile_revision` (`business_id`, `new_version`),
  KEY `idx_profile_audit_business_time` (`business_id`, `edited_at`),
  CONSTRAINT `fk_profile_audit_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_profile_audit_actor`
    FOREIGN KEY (`edited_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_profile_audit_revision` CHECK (`new_version` = `old_version` + 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The verified/legal business name, registration type, registered email,
-- OTP phone, subscriptions, payments, and accounting entries are not editable
-- through this metadata table. No privileged MySQL triggers are created.
