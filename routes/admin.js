const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

module.exports = function (db) {
  // Primary admin ID from environment
  const PRIMARY_ADMIN_ID = Number(process.env.PRIMARY_ADMIN_ID);

  function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ message: 'Missing admin token.' });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.role !== 'admin') {
        return res.status(403).json({ message: 'Admin access required.' });
      }

      req.user = decoded;
      return next();
    } catch (error) {
      return res.status(401).json({ message: 'Invalid or expired token.' });
    }
  }

  router.get('/users', requireAdmin, async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT id, name, email, role, is_active, date_of_birth, profile_photo
         FROM users
         WHERE NOT (name LIKE 'Deleted User %' OR email LIKE 'deleted-%')
         ORDER BY id DESC`
      );

      return res.status(200).json(rows);
    } catch (error) {
      console.error('Admin fetch users error:', error);
      return res.status(500).json({ message: 'Server error while fetching users.' });
    }
  });

  // Get user deletion history - MUST come before parameterized /users/:userId routes
  router.get('/users/deletion-history', requireAdmin, async (req, res) => {
    try {
      const [history] = await db.query(
        `SELECT id, deleted_user_id, deleted_user_name, deleted_user_email, deleted_user_role, 
                deleted_by_admin_id, deleted_by_admin_name, deletion_method, deletion_status, 
                deletion_reason, deleted_at
         FROM user_deletion_history
         ORDER BY deleted_at DESC
         LIMIT 100`
      );

      return res.status(200).json(history);
    } catch (error) {
      console.error('Error fetching deletion history:', error);
      return res.status(500).json({ message: 'Server error while fetching deletion history.' });
    }
  });

  // Get deletion history statistics
  router.get('/users/deletion-history/stats', requireAdmin, async (req, res) => {
    try {
      const [stats] = await db.query(
        `SELECT
          COUNT(*) AS total_deletions,
          SUM(CASE WHEN deletion_status = 'success' THEN 1 ELSE 0 END) AS successful_deletions,
          SUM(CASE WHEN deletion_status = 'failed' THEN 1 ELSE 0 END) AS failed_deletions,
          SUM(CASE WHEN deletion_method = 'soft' THEN 1 ELSE 0 END) AS soft_deletions,
          SUM(CASE WHEN deletion_method = 'hard' THEN 1 ELSE 0 END) AS hard_deletions
         FROM user_deletion_history`
      );

      return res.status(200).json(stats[0] || {});
    } catch (error) {
      console.error('Error fetching deletion stats:', error);
      return res.status(500).json({ message: 'Server error while fetching deletion statistics.' });
    }
  });

  router.patch('/users/:userId/role', requireAdmin, async (req, res) => {
    const userId = Number(req.params.userId);
    const { role } = req.body || {};

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'userId must be a valid positive number.' });
    }

    if (!['visitor', 'owner', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'Role must be one of: visitor, owner, admin.' });
    }

    try {
      const [users] = await db.query('SELECT id, role FROM users WHERE id = ? LIMIT 1', [userId]);

      if (!users.length) {
        return res.status(404).json({ message: 'User not found.' });
      }

      await db.query('UPDATE users SET role = ? WHERE id = ?', [role, userId]);

      const [updatedUsers] = await db.query(
        'SELECT id, name, email, role, is_active FROM users WHERE id = ? LIMIT 1',
        [userId]
      );

      return res.status(200).json({
        message: 'User role updated successfully.',
        user: updatedUsers[0]
      });
    } catch (error) {
      console.error('Admin change user role error:', error);
      return res.status(500).json({ message: 'Server error while updating user role.' });
    }
  });

  router.patch('/users/:userId/status', requireAdmin, async (req, res) => {
    const userId = Number(req.params.userId);
    const { is_active } = req.body || {};

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'userId must be a valid positive number.' });
    }

    if (userId === PRIMARY_ADMIN_ID) {
      return res.status(403).json({ message: 'The primary admin account cannot be disabled or deleted.' });
    }

    if (is_active !== 0 && is_active !== 1) {
      return res.status(400).json({ message: 'is_active must be 0 or 1.' });
    }

    try {
      const [users] = await db.query('SELECT id, is_active FROM users WHERE id = ? LIMIT 1', [userId]);

      if (!users.length) {
        return res.status(404).json({ message: 'User not found.' });
      }

      await db.query('UPDATE users SET is_active = ? WHERE id = ?', [Number(is_active), userId]);

      return res.status(200).json({
        message: 'User status updated successfully.',
        userId,
        is_active: Number(is_active)
      });
    } catch (error) {
      console.error('Admin change user status error:', error);
      return res.status(500).json({ message: 'Server error while updating user status.' });
    }
  });

  router.delete('/users/:userId', requireAdmin, async (req, res) => {
    const userId = Number(req.params.userId);
    const actingAdminId = req.user?.id;
    const adminReason = String(req.body?.adminReason || '').trim();

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'userId must be a valid positive number.' });
    }

    if (userId === PRIMARY_ADMIN_ID) {
      return res.status(403).json({ message: `User ID ${PRIMARY_ADMIN_ID} (primary admin) cannot be deleted.` });
    }

    try {
      const [users] = await db.query(
        'SELECT id, name, email, role, is_active FROM users WHERE id = ? LIMIT 1',
        [userId]
      );

      if (!users.length) {
        return res.status(404).json({ message: 'User not found.' });
      }

      const targetUser = users[0];

      // Prevent non-primary admins from deleting other admins
      if (targetUser.role === 'admin' && actingAdminId !== PRIMARY_ADMIN_ID) {
        await db.query(
          `INSERT INTO user_deletion_history (deleted_user_id, deleted_user_name, deleted_user_email, deleted_user_role, deleted_by_admin_id, deleted_by_admin_name, deletion_method, deletion_status, deletion_reason)
           SELECT ?, ?, ?, ?, ?, name, 'soft', 'failed', 'Only primary admin can delete admin accounts'
           FROM users WHERE id = ? LIMIT 1`,
          [userId, targetUser.name, targetUser.email, targetUser.role, actingAdminId, actingAdminId]
        );
        return res.status(403).json({ message: 'Only the primary admin can delete admin accounts.' });
      }

      const [bookingStats] = await db.query(
        `SELECT
          COUNT(*) AS total_bookings,
          SUM(CASE WHEN status IN ('confirmed', 'completed') THEN 1 ELSE 0 END) AS preserved_confirmed_completed
         FROM bookings
         WHERE visitor_id = ?`,
        [userId]
      );

      const preservedCount = Number(bookingStats?.[0]?.preserved_confirmed_completed || 0);

      const [adminInfo] = await db.query(
        'SELECT name FROM users WHERE id = ? LIMIT 1',
        [actingAdminId]
      );
      const adminName = adminInfo?.[0]?.name || 'Unknown Admin';

      await db.query(
        `UPDATE users
         SET
           name = ?,
           email = ?,
           password = NULL,
           role = 'visitor',
           profile_photo = NULL,
           date_of_birth = NULL,
           is_active = 0
         WHERE id = ?`,
        [`Deleted User ${userId}`, `deleted-${userId}@anonymous.local`, userId]
      );

      const deletionReason = adminReason
        ? `Admin reason: ${adminReason}. User anonymized. ${preservedCount} confirmed/completed bookings preserved`
        : `User anonymized. ${preservedCount} confirmed/completed bookings preserved`;

      await db.query(
        `INSERT INTO user_deletion_history (deleted_user_id, deleted_user_name, deleted_user_email, deleted_user_role, deleted_by_admin_id, deleted_by_admin_name, deletion_method, deletion_status, deletion_reason)
         VALUES (?, ?, ?, ?, ?, ?, 'soft', 'success', ?)`,
        [userId, targetUser.name, targetUser.email, targetUser.role, actingAdminId, adminName, deletionReason]
      );

      return res.status(200).json({
        message: 'User account removed and anonymized. Confirmed/completed bookings were preserved.',
        preservedBookings: preservedCount
      });
    } catch (error) {
      console.error('Admin delete user error:', error);
      return res.status(500).json({ message: 'Server error while removing user account.' });
    }
  });

  router.delete('/users/:userId/force-admin-hard-delete', requireAdmin, async (req, res) => {
    const actingAdminId = Number(req.user?.id);
    const targetUserId = Number(req.params.userId);

    if (!Number.isInteger(actingAdminId) || actingAdminId <= 0) {
      return res.status(403).json({ message: 'Primary admin identity is missing.' });
    }

    if (actingAdminId !== PRIMARY_ADMIN_ID) {
      return res.status(403).json({ message: `Only the primary admin (ID ${PRIMARY_ADMIN_ID}) can use this emergency override.` });
    }

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ message: 'Target userId must be a valid positive number.' });
    }

    if (targetUserId === PRIMARY_ADMIN_ID) {
      await db.query(
        `INSERT INTO user_deletion_history (deleted_user_id, deleted_user_name, deleted_user_email, deleted_user_role, deleted_by_admin_id, deleted_by_admin_name, deletion_method, deletion_status, deletion_reason)
         VALUES (?, 'Protected User', 'protected@system.local', 'admin', ?, 'Primary Admin', 'hard', 'failed', ?)`,[targetUserId, actingAdminId, `User ID ${PRIMARY_ADMIN_ID} is protected and cannot be deleted`]
      );
      return res.status(403).json({ message: `User ID ${PRIMARY_ADMIN_ID} (primary admin) is protected and cannot be deleted.` });
    }

    try {
      const [users] = await db.query(
        'SELECT id, role, name, email FROM users WHERE id = ? LIMIT 1',
        [targetUserId]
      );

      if (!users.length) {
        return res.status(404).json({ message: 'Target admin user not found.' });
      }

      if (String(users[0].role || '').trim().toLowerCase() !== 'admin') {
        await db.query(
          `INSERT INTO user_deletion_history (deleted_user_id, deleted_user_name, deleted_user_email, deleted_user_role, deleted_by_admin_id, deleted_by_admin_name, deletion_method, deletion_status, deletion_reason)
           VALUES (?, ?, ?, ?, ?, 'Primary Admin', 'hard', 'failed', 'Target is not an admin account')`
        );
        return res.status(400).json({ message: 'This emergency hard-delete route is only for admin accounts.' });
      }

      await db.query('DELETE FROM users WHERE id = ?', [targetUserId]);

      // Log successful hard deletion
      await db.query(
        `INSERT INTO user_deletion_history (deleted_user_id, deleted_user_name, deleted_user_email, deleted_user_role, deleted_by_admin_id, deleted_by_admin_name, deletion_method, deletion_status, deletion_reason)
         VALUES (?, ?, ?, ?, ?, 'Primary Admin', 'hard', 'success', 'Admin account permanently hard deleted')`
      );

      return res.status(200).json({
        message: 'Undesirable admin account was hard deleted by the primary admin.',
        deletedUser: {
          id: users[0].id,
          name: users[0].name,
          email: users[0].email
        }
      });
    } catch (error) {
      console.error('Primary admin force delete error:', error);
      return res.status(500).json({ message: 'Server error while hard deleting the admin profile.' });
    }
  });

  return router;
};
