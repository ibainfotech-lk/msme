-- Migration 007: Checkout-order idempotency
-- Existing checkout_orders must be empty before deployment.
-- Every new checkout order must have an idempotency key.

ALTER TABLE `checkout_orders`
    ADD COLUMN `idempotency_key` VARCHAR(191) NOT NULL;

CREATE UNIQUE INDEX `checkout_orders_idempotency_key_key`
    ON `checkout_orders` (`idempotency_key`);