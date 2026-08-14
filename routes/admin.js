const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

module.exports = function (db) {
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
         ORDER BY id DESC`
      );

      return res.status(200).json(rows);
    } catch (error) {
      console.error('Admin fetch users error:', error);
      return res.status(500).json({ message: 'Server error while fetching users.' });
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

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'userId must be a valid positive number.' });
    }

    try {
      const [users] = await db.query(
        'SELECT id, name, email, role, is_active FROM users WHERE id = ? LIMIT 1',
        [userId]
      );

      if (!users.length) {
        return res.status(404).json({ message: 'User not found.' });
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

      return res.status(200).json({
        message: 'User account removed and anonymized. Confirmed/completed bookings were preserved.',
        preservedBookings: preservedCount
      });
    } catch (error) {
      console.error('Admin delete user error:', error);
      return res.status(500).json({ message: 'Server error while removing user account.' });
    }
  });

  return router;
};
