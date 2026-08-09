const express = require('express');
const router = express.Router();

module.exports = function (db) {
  const validStatuses = ['pending', 'approved', 'rejected'];

  router.post('/', async (req, res) => {
    const {
      owner_id,
      title,
      description,
      price_per_night,
      location,
      address = null,
      property_type = null,
      unit_count = null,
      has_ac = false,
      has_parking = false,
      has_room_service = false,
      has_private_wc = false,
      status = 'pending',
      image_url = null
    } = req.body;

    console.log('Accommodation payload received:', req.body);

    if (!title || !description || !location || price_per_night === undefined || price_per_night === '') {
      return res.status(400).json({ message: 'Title, description, location, and price are required.' });
    }

    const parsedPrice = Number(price_per_night);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ message: 'Price must be a positive number.' });
    }

    const totalUnits = Number(unit_count) || 0;

    try {
      // Enforce moderation gate: owners can create one initial pending submission,
      // but cannot add more listings until at least one is approved.
      if (owner_id) {
        const [statusCounts] = await db.query(
          `SELECT
             SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
             COUNT(*) AS total_count
           FROM accommodations
           WHERE owner_id = ?`,
          [owner_id]
        );

        const approvedCount = Number(statusCounts?.[0]?.approved_count || 0);
        const totalCount = Number(statusCounts?.[0]?.total_count || 0);

        if (approvedCount === 0 && totalCount > 0) {
          return res.status(403).json({
            message: 'Your first property is still pending approval. Please wait for admin approval before adding more accommodations.'
          });
        }
      }

      const [result] = await db.query(
        `INSERT INTO accommodations (owner_id, title, description, price_per_night, location, address, property_type, unit_count, has_ac, has_parking, has_room_service, has_private_wc, status, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [owner_id || null, title, description, parsedPrice, location, address, property_type, unit_count, has_ac ? 1 : 0, has_parking ? 1 : 0, has_room_service ? 1 : 0, has_private_wc ? 1 : 0, status, image_url]
      );

      const [rows] = await db.query(
        `SELECT a.id, a.owner_id, a.title, a.description, a.price_per_night, a.location, a.address, a.property_type, a.unit_count, a.has_ac, a.has_parking, a.has_room_service, a.has_private_wc, a.status, a.image_url, a.created_at,
                u.name AS owner_name, u.email AS owner_email
         FROM accommodations a
         LEFT JOIN users u ON u.id = a.owner_id
         WHERE a.id = ?`,
        [result.insertId]
      );

      res.status(201).json({
        message: 'Accommodation saved successfully.',
        accommodation: rows[0]
      });
    } catch (error) {
      console.error('Error saving accommodation:', error);
      res.status(500).json({ message: 'Server error while saving accommodation.' });
    }
  });

  router.get('/owner/:ownerId', async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT a.id, a.owner_id, a.title, a.description, a.price_per_night, a.location, a.address, a.property_type, a.unit_count, a.has_ac, a.has_parking, a.has_room_service, a.has_private_wc, a.status, a.image_url, a.created_at,
                u.name AS owner_name, u.email AS owner_email
         FROM accommodations a
         LEFT JOIN users u ON u.id = a.owner_id
         WHERE a.owner_id = ?
         ORDER BY a.id DESC`,
        [req.params.ownerId]
      );

      res.status(200).json(rows);
    } catch (error) {
      console.error('Error fetching owner accommodations:', error);
      res.status(500).json({ message: 'Server error while fetching owner accommodations.' });
    }
  });
  router.get('/pending', async (req, res) => {
    const requestedStatus = req.query.status || 'pending';
    if (requestedStatus !== 'all' && !validStatuses.includes(requestedStatus)) {
      return res.status(400).json({ message: 'Status filter must be pending, approved, rejected, or all.' });
    }

    try {
      const statusClause = requestedStatus === 'all' ? '' : 'WHERE a.status = ?';
      const queryParams = requestedStatus === 'all' ? [] : [requestedStatus];
      const [rows] = await db.query(
        `SELECT a.id, a.owner_id, a.title, a.description, a.price_per_night, a.location, a.address, a.property_type, a.unit_count, a.has_ac, a.has_parking, a.has_room_service, a.has_private_wc, a.status, a.image_url, a.created_at,
                u.name AS owner_name, u.email AS owner_email
         FROM accommodations a
         LEFT JOIN users u ON u.id = a.owner_id
         ${statusClause}
         ORDER BY a.id DESC`,
        queryParams
      );

      res.status(200).json(rows);
    } catch (error) {
      console.error('Error fetching pending accommodations:', error);
      res.status(500).json({ message: 'Server error while fetching pending accommodations.' });
    }
  });

  router.patch('/:id/status', async (req, res) => {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be approved or rejected.' });
    }

    try {
      await db.query('UPDATE accommodations SET status = ? WHERE id = ?', [status, req.params.id]);
      res.status(200).json({ message: `Accommodation ${status}.` });
    } catch (error) {
      console.error('Error updating accommodation status:', error);
      res.status(500).json({ message: 'Server error while updating accommodation status.' });
    }
  });
  return router;
};
