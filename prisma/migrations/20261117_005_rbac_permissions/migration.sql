
-- Noteto RBAC Permission Catalogue
-- Migration: 20261117_005_rbac_permissions
-- Preserves existing users, businesses and memberships.

INSERT INTO permissions (id, `key`, description)
VALUES
(UUID(), 'business.read', 'View business information'),
(UUID(), 'business.manage', 'Manage business settings'),
(UUID(), 'transactions.read', 'View transactions'),
(UUID(), 'transactions.create', 'Create transactions'),
(UUID(), 'transactions.update', 'Update transactions'),
(UUID(), 'transactions.delete', 'Delete transactions'),
(UUID(), 'reports.read', 'View financial reports'),
(UUID(), 'invoices.read', 'View invoices'),
(UUID(), 'invoices.manage', 'Create and manage invoices'),
(UUID(), 'members.read', 'View business members'),
(UUID(), 'members.manage', 'Manage business members and roles'),
(UUID(), 'billing.manage', 'Manage subscriptions and billing');

-- Assign all initial permissions to existing OWNER roles.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'OWNER'
  AND r.is_system_role = 1;
