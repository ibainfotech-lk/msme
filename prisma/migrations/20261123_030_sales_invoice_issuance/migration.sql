-- Noteto F.17.2 — Issue business-scoped sales invoices without cashbook posting.
-- Development / disposable CI only. NO triggers, no bank/merchant payment,
-- no VAT calculation, no auto income posting and no production rollout.
CREATE TABLE `sales_invoices` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `subscription_id` CHAR(36) NOT NULL,
  `created_by_user_id` CHAR(36) NOT NULL,
  `invoice_number` VARCHAR(40) NOT NULL,
  `billing_month` DATE NOT NULL,
  `invoice_sequence` INT UNSIGNED NOT NULL,
  `issued_on` DATE NOT NULL,
  `customer_name` VARCHAR(150) NOT NULL,
  `customer_email` VARCHAR(191) NULL,
  `notes` VARCHAR(500) NOT NULL DEFAULT '',
  `total_lkr` DECIMAL(12,2) NOT NULL,
  `status` ENUM('ISSUED') NOT NULL DEFAULT 'ISSUED',
  `idempotency_key` VARCHAR(100) NOT NULL,
  `request_sha256` CHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_invoice_business_id` (`business_id`, `id`),
  UNIQUE KEY `uq_sales_invoice_business_number` (`business_id`, `invoice_number`),
  UNIQUE KEY `uq_sales_invoice_month_sequence` (`business_id`, `billing_month`, `invoice_sequence`),
  UNIQUE KEY `uq_sales_invoice_business_idempotency` (`business_id`, `idempotency_key`),
  KEY `idx_sales_invoice_business_issued` (`business_id`, `created_at`, `id`),
  CONSTRAINT `fk_sales_invoice_business`
    FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_sales_invoice_subscription_tenant`
    FOREIGN KEY (`business_id`, `subscription_id`)
    REFERENCES `business_subscriptions`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_sales_invoice_creator`
    FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_sales_invoice_positive` CHECK (`total_lkr` > 0.00),
  CONSTRAINT `chk_sales_invoice_sequence` CHECK (`invoice_sequence` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `sales_invoice_lines` (
  `id` CHAR(36) NOT NULL,
  `business_id` CHAR(36) NOT NULL,
  `invoice_id` CHAR(36) NOT NULL,
  `line_number` INT UNSIGNED NOT NULL,
  `description` VARCHAR(200) NOT NULL,
  `quantity` DECIMAL(10,2) NOT NULL,
  `unit_price_lkr` DECIMAL(12,2) NOT NULL,
  `line_total_lkr` DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sales_invoice_line_number` (`invoice_id`, `line_number`),
  KEY `idx_sales_invoice_lines_tenant_invoice` (`business_id`, `invoice_id`),
  CONSTRAINT `fk_sales_invoice_line_tenant`
    FOREIGN KEY (`business_id`, `invoice_id`)
    REFERENCES `sales_invoices`(`business_id`, `id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_sales_invoice_line_quantity` CHECK (`quantity` > 0.00),
  CONSTRAINT `chk_sales_invoice_line_unit_price` CHECK (`unit_price_lkr` >= 0.00),
  CONSTRAINT `chk_sales_invoice_line_total` CHECK (`line_total_lkr` >= 0.00)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
