-- CreateTable
CREATE TABLE `payment_reconciliation_evidence` (
    `id` CHAR(36) NOT NULL,
    `payment_id` CHAR(36) NOT NULL,
    `webhook_event_id` CHAR(36) NULL,
    `gateway` VARCHAR(50) NOT NULL,
    `source` ENUM('PROVIDER_STATUS_QUERY', 'WEBHOOK_REPORT', 'MANUAL_BANK_RECORD') NOT NULL,
    `source_reference` VARCHAR(191) NOT NULL,
    `observed_at` DATETIME(3) NOT NULL,
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `claimed_business_id` VARCHAR(191) NOT NULL,
    `claimed_checkout_order_id` VARCHAR(191) NOT NULL,
    `merchant_reference` VARCHAR(191) NOT NULL,
    `amount_lkr` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `gateway_order_id` VARCHAR(191) NULL,
    `gateway_transaction_id` VARCHAR(191) NULL,
    `outcome` ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NOT_FOUND', 'INCONCLUSIVE') NOT NULL,
    `payload_sha256` CHAR(64) NOT NULL,
    `assessment` ENUM('NOT_ASSESSED', 'MATCHED_FOR_REVIEW', 'INCONCLUSIVE', 'ESCALATE') NOT NULL DEFAULT 'NOT_ASSESSED',
    `assessment_reason` VARCHAR(191) NULL,
    `authentication_status` ENUM('UNVERIFIED', 'AUTHENTICATED', 'REJECTED') NOT NULL DEFAULT 'UNVERIFIED',
    `authenticated_at` DATETIME(3) NULL,

    INDEX `idx_recon_payment_received`(`payment_id`, `received_at`),
    INDEX `idx_recon_auth_received`(`authentication_status`, `received_at`),
    INDEX `idx_recon_webhook`(`webhook_event_id`),
    UNIQUE INDEX `uq_recon_source_reference`(`gateway`, `source`, `source_reference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_evidence` ADD CONSTRAINT `payment_reconciliation_evidence_payment_id_fkey` FOREIGN KEY (`payment_id`) REFERENCES `platform_payment_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_reconciliation_evidence` ADD CONSTRAINT `payment_reconciliation_evidence_webhook_event_id_fkey` FOREIGN KEY (`webhook_event_id`) REFERENCES `payment_webhook_events`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
