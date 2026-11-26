-- F.16.5.4a ADDITIVE arrears ledger (no monthly charge generation or payment).
-- CI disposable MySQL only; review and backfill before any production deploy.
-- The billing service cannot quote until reviewed historical months are present.
-- Do not assume a lapse in a subscription automatically creates a bill.
ALTER TABLE `platform_payment_transactions`
  ADD UNIQUE KEY `uq_payment_business_id` (`business_id`, `id`);

CREATE TABLE `subscription_monthly_dues` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `subscription_id` CHAR(36) NOT NULL,
  `billing_month` DATE NOT NULL,
  `due_at` DATETIME(3) NOT NULL,
  `charge_lkr` DECIMAL(12,2) NOT NULL,
  `waived_lkr` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `status` ENUM('OPEN','SETTLED','WAIVED','VOID') NOT NULL DEFAULT 'OPEN',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_monthly_due_subscription_month` (`subscription_id`, `billing_month`),
  UNIQUE KEY `uq_monthly_due_tenant_id` (`business_id`, `id`),
  KEY `idx_monthly_due_business_due` (`business_id`, `due_at`, `status`),
  CONSTRAINT `fk_monthly_due_subscription_tenant`
    FOREIGN KEY (`business_id`, `subscription_id`)
    REFERENCES `business_subscriptions`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_monthly_due_amounts` CHECK (
    `charge_lkr` >= 0.00 AND `waived_lkr` >= 0.00 AND
    `waived_lkr` <= `charge_lkr`
  ),
  CONSTRAINT `chk_monthly_due_first_day` CHECK (DAYOFMONTH(`billing_month`) = 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `subscription_due_allocations` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `monthly_due_id` CHAR(36) NOT NULL,
  `payment_id` CHAR(36) NOT NULL,
  `amount_lkr` DECIMAL(12,2) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_due_allocation_pair` (`monthly_due_id`, `payment_id`),
  KEY `idx_due_allocation_business_due` (`business_id`, `monthly_due_id`),
  KEY `idx_due_allocation_business_payment` (`business_id`, `payment_id`),
  CONSTRAINT `fk_due_allocation_due_tenant`
    FOREIGN KEY (`business_id`, `monthly_due_id`)
    REFERENCES `subscription_monthly_dues`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_due_allocation_payment_tenant`
    FOREIGN KEY (`business_id`, `payment_id`)
    REFERENCES `platform_payment_transactions`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_due_allocation_positive` CHECK (`amount_lkr` > 0.00)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
