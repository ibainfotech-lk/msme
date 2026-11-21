-- DropForeignKey


-- DropIndex


-- AlterTable


-- AlterTable
ALTER TABLE `businesses` ADD COLUMN `current_subscription_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `subscription_plans` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `price_lkr` DECIMAL(12, 2) NOT NULL,
    `billing_interval` ENUM('MONTHLY', 'YEARLY') NOT NULL DEFAULT 'MONTHLY',
    `invoice_limit` INTEGER NOT NULL DEFAULT 30,
    `trial_days` INTEGER NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `subscription_plans_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `business_subscriptions` (
    `id` CHAR(36) NOT NULL,
    `business_id` CHAR(36) NOT NULL,
    `plan_id` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `starts_at` DATETIME(3) NULL,
    `trial_ends_at` DATETIME(3) NULL,
    `current_period_start` DATETIME(3) NULL,
    `current_period_end` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `business_subscriptions_business_id_status_idx`(`business_id`, `status`),
    INDEX `business_subscriptions_status_current_period_end_idx`(`status`, `current_period_end`),
    INDEX `business_subscriptions_plan_id_idx`(`plan_id`),
    UNIQUE INDEX `business_subscriptions_business_id_id_key`(`business_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `checkout_orders` (
    `id` CHAR(36) NOT NULL,
    `business_id` CHAR(36) NOT NULL,
    `plan_id` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `amount_lkr` DECIMAL(12, 2) NOT NULL,
    `gateway_order_id` VARCHAR(191) NULL,
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `checkout_orders_gateway_order_id_key`(`gateway_order_id`),
    INDEX `checkout_orders_business_id_status_idx`(`business_id`, `status`),
    INDEX `checkout_orders_created_at_idx`(`created_at`),
    UNIQUE INDEX `checkout_orders_business_id_id_key`(`business_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_payment_transactions` (
    `id` CHAR(36) NOT NULL,
    `business_id` CHAR(36) NOT NULL,
    `checkout_order_id` CHAR(36) NOT NULL,
    `idempotency_key` VARCHAR(191) NOT NULL,
    `gateway` VARCHAR(50) NOT NULL,
    `gateway_transaction_id` VARCHAR(191) NULL,
    `amount_lkr` DECIMAL(12, 2) NOT NULL,
    `status` ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `verified_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `platform_payment_transactions_idempotency_key_key`(`idempotency_key`),
    INDEX `platform_payment_transactions_business_id_status_idx`(`business_id`, `status`),
    INDEX `platform_payment_transactions_checkout_order_id_idx`(`checkout_order_id`),
    UNIQUE INDEX `platform_payment_transactions_gateway_gateway_transaction_id_key`(`gateway`, `gateway_transaction_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_codes` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `free_months` INTEGER NOT NULL,
    `max_redemptions` INTEGER NULL,
    `redemption_count` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('ACTIVE', 'INACTIVE', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    `starts_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `promotion_codes_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_webhook_events` (
    `id` CHAR(36) NOT NULL,
    `gateway` VARCHAR(50) NOT NULL,
    `gateway_event_id` VARCHAR(191) NOT NULL,
    `event_type` VARCHAR(100) NOT NULL,
    `status` ENUM('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED') NOT NULL DEFAULT 'RECEIVED',
    `payload` JSON NOT NULL,
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) NULL,
    `error_message` TEXT NULL,

    INDEX `payment_webhook_events_status_received_at_idx`(`status`, `received_at`),
    UNIQUE INDEX `payment_webhook_events_gateway_gateway_event_id_key`(`gateway`, `gateway_event_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_redemptions` (
    `id` CHAR(36) NOT NULL,
    `promotion_code_id` CHAR(36) NOT NULL,
    `business_id` CHAR(36) NOT NULL,
    `free_months_granted` INTEGER NOT NULL,
    `redeemed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `promotion_redemptions_business_id_redeemed_at_idx`(`business_id`, `redeemed_at`),
    UNIQUE INDEX `promotion_redemptions_promotion_code_id_business_id_key`(`promotion_code_id`, `business_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscription_entitlements` (
    `id` CHAR(36) NOT NULL,
    `subscription_id` CHAR(36) NOT NULL,
    `feature_key` VARCHAR(100) NOT NULL,
    `is_enabled` BOOLEAN NOT NULL DEFAULT true,
    `usage_limit` INTEGER NULL,
    `warning_threshold` INTEGER NULL,
    `period_start` DATETIME(3) NOT NULL,
    `period_end` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `subscription_entitlements_feature_key_is_enabled_idx`(`feature_key`, `is_enabled`),
    INDEX `subscription_entitlements_subscription_id_period_end_idx`(`subscription_id`, `period_end`),
    UNIQUE INDEX `subscription_entitlements_subscription_id_feature_key_period_key`(`subscription_id`, `feature_key`, `period_start`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscription_events` (
    `id` CHAR(36) NOT NULL,
    `subscription_id` CHAR(36) NOT NULL,
    `event_type` ENUM('CREATED', 'TRIAL_STARTED', 'ACTIVATED', 'RENEWED', 'PAYMENT_FAILED', 'PAST_DUE', 'EXPIRED', 'CANCELLED', 'PLAN_CHANGED', 'PROMOTION_APPLIED') NOT NULL,
    `previous_status` ENUM('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED') NULL,
    `new_status` ENUM('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELLED') NULL,
    `description` VARCHAR(500) NULL,
    `metadata` JSON NULL,
    `occurred_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `subscription_events_subscription_id_occurred_at_idx`(`subscription_id`, `occurred_at`),
    INDEX `subscription_events_event_type_occurred_at_idx`(`event_type`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `businesses_current_subscription_id_key` ON `businesses`(`current_subscription_id`);

-- CreateIndex
CREATE UNIQUE INDEX `businesses_id_current_subscription_id_key` ON `businesses`(`id`, `current_subscription_id`);

-- AddForeignKey
ALTER TABLE `businesses` ADD CONSTRAINT `businesses_id_current_subscription_id_fkey` FOREIGN KEY (`id`, `current_subscription_id`) REFERENCES `business_subscriptions`(`business_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey


-- AddForeignKey
ALTER TABLE `business_subscriptions` ADD CONSTRAINT `business_subscriptions_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_subscriptions` ADD CONSTRAINT `business_subscriptions_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `subscription_plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checkout_orders` ADD CONSTRAINT `checkout_orders_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checkout_orders` ADD CONSTRAINT `checkout_orders_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `subscription_plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `platform_payment_transactions` ADD CONSTRAINT `platform_payment_transactions_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `platform_payment_transactions` ADD CONSTRAINT `platform_payment_transactions_business_id_checkout_order_id_fkey` FOREIGN KEY (`business_id`, `checkout_order_id`) REFERENCES `checkout_orders`(`business_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `promotion_redemptions` ADD CONSTRAINT `promotion_redemptions_promotion_code_id_fkey` FOREIGN KEY (`promotion_code_id`) REFERENCES `promotion_codes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `promotion_redemptions` ADD CONSTRAINT `promotion_redemptions_business_id_fkey` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscription_entitlements` ADD CONSTRAINT `subscription_entitlements_subscription_id_fkey` FOREIGN KEY (`subscription_id`) REFERENCES `business_subscriptions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscription_events` ADD CONSTRAINT `subscription_events_subscription_id_fkey` FOREIGN KEY (`subscription_id`) REFERENCES `business_subscriptions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
