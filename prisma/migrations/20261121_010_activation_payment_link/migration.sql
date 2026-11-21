-- F.16: Idempotent mock settlement subscription linkage.
-- Create-only database change. DO NOT apply to a real database until
-- separately reviewed and tested against a disposable clone.
-- The payment record already exists when the subscription is activated.
ALTER TABLE `business_subscriptions`
  ADD COLUMN `activation_payment_id` CHAR(36) NULL;

CREATE UNIQUE INDEX `business_subscriptions_activation_payment_id_key`
  ON `business_subscriptions` (`activation_payment_id`);

ALTER TABLE `business_subscriptions`
  ADD CONSTRAINT `business_subscriptions_activation_payment_id_fkey`
  FOREIGN KEY (`activation_payment_id`)
  REFERENCES `platform_payment_transactions`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
