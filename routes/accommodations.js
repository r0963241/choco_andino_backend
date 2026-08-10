const express = require('express');
const router = express.Router();

module.exports = function (db) {
  const validStatuses = ['pending', 'approved', 'rejected'];
  const validAccommodationTypes = ['room', 'cabin'];
  const validBedTypes = ['single', 'double', 'triple'];

  const propertySelect = `SELECT p.id, p.owner_id, p.title, p.description, p.price_per_night, p.location, p.address, p.property_type, p.unit_count, p.has_ac, p.has_parking, p.has_room_service, p.has_private_wc, p.status, p.image_url, p.created_at,
                                 u.name AS owner_name, u.email AS owner_email
                          FROM accommodations p
                          LEFT JOIN users u ON u.id = p.owner_id`;

  const accommodationSelect = `SELECT a.id, a.owner_id, a.property_id, a.title, a.description, a.price_per_night, a.location, a.address, a.property_type, a.unit_count, a.has_ac, a.has_parking, a.has_room_service, a.has_private_wc, a.status, a.image_url, a.created_at,
                                      a.accommodation_type, a.bed_type, a.max_guests, a.max_adults, a.max_kids, a.max_babies,
                                      owner.name AS owner_name, owner.email AS owner_email,
                                      parent.title AS property_name, parent.address AS property_address, parent.property_type AS parent_property_type,
                                      parent.location AS property_location, parent.description AS property_description, parent.price_per_night AS property_price_per_night
                               FROM accommodations a
                               LEFT JOIN users owner ON owner.id = a.owner_id
                               LEFT JOIN accommodations parent ON parent.id = a.property_id`;

  function getOccupancyLimits(accommodationType, bedType) {
    if (accommodationType === 'cabin') {
      if (bedType === 'triple') {
        return {
          maxAdults: 3,
          maxKids: 3,
          maxBabies: 3,
          maxGuests: 9,
          combinedKidsBabiesLimit: 6
        };
      }

      return {
        maxAdults: 2,
        maxKids: 2,
        maxBabies: 2,
        maxGuests: 6,
        combinedKidsBabiesLimit: 4
      };
    }

    if (bedType === 'single') {
      return {
        maxAdults: 1,
        maxKids: 1,
        maxBabies: 1,
        maxGuests: 2,
        combinedKidsBabiesLimit: 1
      };
    }

    if (bedType === 'double') {
      return {
        maxAdults: 2,
        maxKids: 2,
        maxBabies: 2,
        maxGuests: 4,
        combinedKidsBabiesLimit: 2
      };
    }

    return {
      maxAdults: 3,
      maxKids: 0,
      maxBabies: 0,
      maxGuests: 3,
      combinedKidsBabiesLimit: 0
    };
  }

  function parseCount(value) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
  }

  router.post('/properties', async (req, res) => {
    const {
      owner_id,
      title,
      description,
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

    console.log('Property payload received:', req.body);

    if (!title || !description || !location) {
      return res.status(400).json({ message: 'Title, description, and location are required.' });
    }

    const totalUnits = Number(unit_count) || 0;

    try {
      // Owners can submit their first property, but additional properties require
      // at least one already-approved property.
      if (owner_id) {
        const [statusCounts] = await db.query(
          `SELECT
             SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
             COUNT(*) AS total_count
           FROM accommodations
           WHERE owner_id = ? AND property_id IS NULL`,
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
        `INSERT INTO accommodations (owner_id, property_id, title, description, price_per_night, location, address, property_type, unit_count, has_ac, has_parking, has_room_service, has_private_wc, status, image_url)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [owner_id || null, title, description, 0, location, address, property_type, totalUnits, has_ac ? 1 : 0, has_parking ? 1 : 0, has_room_service ? 1 : 0, has_private_wc ? 1 : 0, status, image_url]
      );

      const [rows] = await db.query(
        `${propertySelect}
         WHERE p.id = ?`,
        [result.insertId]
      );

      res.status(201).json({
        message: 'Property saved successfully.',
        property: rows[0]
      });
    } catch (error) {
      console.error('Error saving property:', error);
      res.status(500).json({ message: 'Server error while saving property.' });
    }
  });

  router.get('/properties/owner/:ownerId', async (req, res) => {
    try {
      const [rows] = await db.query(
        `${propertySelect}
         WHERE p.owner_id = ? AND p.property_id IS NULL
         ORDER BY p.id DESC`,
        [req.params.ownerId]
      );

      res.status(200).json(rows);
    } catch (error) {
      console.error('Error fetching owner properties:', error);
      res.status(500).json({ message: 'Server error while fetching owner properties.' });
    }
  });

  router.get('/properties/pending', async (req, res) => {
    const requestedStatus = req.query.status || 'pending';
    if (requestedStatus !== 'all' && !validStatuses.includes(requestedStatus)) {
      return res.status(400).json({ message: 'Status filter must be pending, approved, rejected, or all.' });
    }

    try {
      const statusClause = requestedStatus === 'all' ? 'WHERE p.property_id IS NULL' : 'WHERE p.property_id IS NULL AND p.status = ?';
      const queryParams = requestedStatus === 'all' ? [] : [requestedStatus];
      const [rows] = await db.query(
        `${propertySelect}
         ${statusClause}
         ORDER BY p.id DESC`,
        queryParams
      );

      res.status(200).json(rows);
    } catch (error) {
      console.error('Error fetching pending properties:', error);
      res.status(500).json({ message: 'Server error while fetching pending properties.' });
    }
  });

  router.patch('/properties/:id/status', async (req, res) => {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be approved or rejected.' });
    }

    try {
      await db.query('UPDATE accommodations SET status = ? WHERE id = ? AND property_id IS NULL', [status, req.params.id]);
      res.status(200).json({ message: `Property ${status}.` });
    } catch (error) {
      console.error('Error updating property status:', error);
      res.status(500).json({ message: 'Server error while updating property status.' });
    }
  });

  router.post('/', async (req, res) => {
    const {
      owner_id,
      property_id,
      title,
      description,
      price_per_night,
      accommodation_type,
      bed_type,
      max_adults,
      max_kids,
      max_babies,
      image_url = null,
      status = 'approved'
    } = req.body;

    if (!property_id || !title || !description || !accommodation_type || !bed_type || price_per_night === undefined || price_per_night === '') {
      return res.status(400).json({ message: 'Property, title, description, accommodation type, bed type, and price are required.' });
    }

    if (!validAccommodationTypes.includes(accommodation_type)) {
      return res.status(400).json({ message: 'Accommodation type must be room or cabin.' });
    }

    if (!validBedTypes.includes(bed_type)) {
      return res.status(400).json({ message: 'Bed type must be single, double, or triple.' });
    }

    const parsedPrice = Number(price_per_night);
    const adults = parseCount(max_adults);
    const kids = parseCount(max_kids);
    const babies = parseCount(max_babies);

    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ message: 'Price must be a positive number.' });
    }

    if ([adults, kids, babies].some((value) => Number.isNaN(value))) {
      return res.status(400).json({ message: 'Occupancy values must be valid positive numbers or zero.' });
    }

    const limits = getOccupancyLimits(accommodation_type, bed_type);
    const totalGuests = adults + kids + babies;

    if (adults > limits.maxAdults) {
      return res.status(400).json({ message: `This ${accommodation_type} allows a maximum of ${limits.maxAdults} adults.` });
    }

    if (kids > limits.maxKids) {
      return res.status(400).json({ message: `This ${accommodation_type} allows a maximum of ${limits.maxKids} kids.` });
    }

    if (babies > limits.maxBabies) {
      return res.status(400).json({ message: `This ${accommodation_type} allows a maximum of ${limits.maxBabies} babies.` });
    }

    if (kids + babies > limits.combinedKidsBabiesLimit) {
      return res.status(400).json({ message: 'This accommodation exceeds the allowed kids and babies combination.' });
    }

    if (totalGuests === 0 || totalGuests > limits.maxGuests) {
      return res.status(400).json({ message: `This ${accommodation_type} supports up to ${limits.maxGuests} total guests.` });
    }

    try {
      const [properties] = await db.query(
        `${propertySelect}
         WHERE p.id = ? AND p.owner_id = ? AND p.property_id IS NULL AND p.status = 'approved'`,
        [property_id, owner_id]
      );

      if (!properties.length) {
        return res.status(403).json({ message: 'You can only add accommodations to your approved properties.' });
      }

      const property = properties[0];
      const [result] = await db.query(
        `INSERT INTO accommodations (
           owner_id, property_id, title, description, price_per_night, location, address, property_type, unit_count,
           has_ac, has_parking, has_room_service, has_private_wc, status, image_url,
           accommodation_type, bed_type, max_guests, max_adults, max_kids, max_babies
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          owner_id || null,
          property_id,
          title,
          description,
          parsedPrice,
          property.location,
          property.address,
          property.property_type,
          1,
          property.has_ac ? 1 : 0,
          property.has_parking ? 1 : 0,
          property.has_room_service ? 1 : 0,
          property.has_private_wc ? 1 : 0,
          status,
          image_url,
          accommodation_type,
          bed_type,
          totalGuests,
          adults,
          kids,
          babies
        ]
      );

      const [rows] = await db.query(
        `${accommodationSelect}
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
        `${accommodationSelect}
         WHERE a.owner_id = ? AND a.property_id IS NOT NULL
         ORDER BY a.id DESC`,
        [req.params.ownerId]
      );

      res.status(200).json(rows);
    } catch (error) {
      console.error('Error fetching owner accommodations:', error);
      res.status(500).json({ message: 'Server error while fetching owner accommodations.' });
    }
  });

  return router;
};
