const express = require('express');
const router = express.Router();

module.exports = function (db) {
  const validStatuses = ['pending', 'approved', 'rejected'];
  const validAccommodationTypes = ['room', 'cabin'];
  const validBedTypes = ['single', 'double', 'triple'];

  const propertySelect = `SELECT p.id, p.owner_id, p.title, p.description, p.location, p.address, p.property_type, p.unit_count, p.has_ac, p.has_parking, p.has_room_service, p.has_private_wc, p.status, p.image_url, p.created_at,
                                 u.name AS owner_name, u.email AS owner_email
                          FROM properties p
                          LEFT JOIN users u ON u.id = p.owner_id`;

  const accommodationSelect = `SELECT a.id, a.owner_id, a.property_id, a.price_per_night, a.status, a.accommodation_image_url, a.created_at, a.updated_at,
                                      a.accommodation_type, a.bed_type, a.max_guests, a.max_adults, a.max_kids, a.max_babies,
                                      owner.name AS owner_name, owner.email AS owner_email,
                                      parent.id AS parent_property_id, parent.title, parent.description, parent.address, parent.property_type,
                                      parent.unit_count, parent.has_ac, parent.has_parking, parent.has_room_service, parent.has_private_wc,
                                      parent.location, parent.image_url, parent.status AS property_status
                               FROM accommodations a
                               LEFT JOIN users owner ON owner.id = a.owner_id
                               LEFT JOIN properties parent ON parent.id = a.property_id`;

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
           FROM properties
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
        `INSERT INTO properties (owner_id, title, address, property_type, unit_count, location, description, has_ac, has_parking, has_room_service, has_private_wc, image_url, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          owner_id || null,
          title,
          address,
          property_type,
          totalUnits,
          location,
          description,
          has_ac ? 1 : 0,
          has_parking ? 1 : 0,
          has_room_service ? 1 : 0,
          has_private_wc ? 1 : 0,
          image_url,
          status
        ]
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
         WHERE p.owner_id = ?
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
      const statusClause = requestedStatus === 'all' ? 'WHERE 1 = 1' : 'WHERE p.status = ?';
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
      const propertyId = Number(req.params.id);
      const [existing] = await db.query(
        'SELECT id FROM properties WHERE id = ? LIMIT 1',
        [propertyId]
      );

      if (!existing.length) {
        return res.status(404).json({ message: 'Property not found.' });
      }

      await db.query('UPDATE properties SET status = ? WHERE id = ?', [status, propertyId]);

      res.status(200).json({ message: `Property ${status}.` });
    } catch (error) {
      console.error('Error updating property status:', error);
      res.status(500).json({ message: 'Server error while updating property status.' });
    }
  });

  router.patch('/properties/:id', async (req, res) => {
    const propertyId = Number(req.params.id);
    const { owner_id, title, description, location, address, property_type, unit_count, has_ac, has_parking, has_room_service, has_private_wc, image_url } = req.body || {};

    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return res.status(400).json({ message: 'Property ID is invalid.' });
    }

    if (!Number.isInteger(Number(owner_id)) || Number(owner_id) <= 0) {
      return res.status(400).json({ message: 'owner_id is required and must be a valid positive number.' });
    }

    const updates = [];
    const propertyUpdates = [];
    const values = [];
    const propertyValues = [];

    if (typeof title === 'string' && title.trim()) {
      updates.push('title = ?');
      propertyUpdates.push('title = ?');
      values.push(title.trim());
      propertyValues.push(title.trim());
    }

    if (typeof description === 'string' && description.trim()) {
      updates.push('description = ?');
      propertyUpdates.push('description = ?');
      values.push(description.trim());
      propertyValues.push(description.trim());
    }

    if (typeof location === 'string' && location.trim()) {
      updates.push('location = ?');
      propertyUpdates.push('location = ?');
      values.push(location.trim());
      propertyValues.push(location.trim());
    }

    if (typeof address !== 'undefined') {
      updates.push('address = ?');
      propertyUpdates.push('address = ?');
      const safeAddress = address && String(address).trim() ? String(address).trim() : null;
      values.push(safeAddress);
      propertyValues.push(safeAddress);
    }

    if (typeof property_type === 'string' && property_type.trim()) {
      updates.push('property_type = ?');
      propertyUpdates.push('property_type = ?');
      values.push(property_type.trim());
      propertyValues.push(property_type.trim());
    }

    if (typeof unit_count !== 'undefined' && unit_count !== null && unit_count !== '') {
      const parsedUnits = Number(unit_count);
      if (!Number.isFinite(parsedUnits) || parsedUnits <= 0) {
        return res.status(400).json({ message: 'unit_count must be a positive number.' });
      }
      updates.push('unit_count = ?');
      propertyUpdates.push('unit_count = ?');
      values.push(parsedUnits);
      propertyValues.push(parsedUnits);
    }

    if (typeof has_ac !== 'undefined') {
      updates.push('has_ac = ?');
      propertyUpdates.push('has_ac = ?');
      const boolValue = Boolean(has_ac) ? 1 : 0;
      values.push(boolValue);
      propertyValues.push(boolValue);
    }

    if (typeof has_parking !== 'undefined') {
      updates.push('has_parking = ?');
      propertyUpdates.push('has_parking = ?');
      const boolValue = Boolean(has_parking) ? 1 : 0;
      values.push(boolValue);
      propertyValues.push(boolValue);
    }

    if (typeof has_room_service !== 'undefined') {
      updates.push('has_room_service = ?');
      propertyUpdates.push('has_room_service = ?');
      const boolValue = Boolean(has_room_service) ? 1 : 0;
      values.push(boolValue);
      propertyValues.push(boolValue);
    }

    if (typeof has_private_wc !== 'undefined') {
      updates.push('has_private_wc = ?');
      propertyUpdates.push('has_private_wc = ?');
      const boolValue = Boolean(has_private_wc) ? 1 : 0;
      values.push(boolValue);
      propertyValues.push(boolValue);
    }

    if (typeof image_url !== 'undefined') {
      updates.push('image_url = ?');
      propertyUpdates.push('image_url = ?');
      const safeImageUrl = image_url && String(image_url).trim() ? String(image_url).trim() : null;
      values.push(safeImageUrl);
      propertyValues.push(safeImageUrl);
    }

    if (!updates.length) {
      return res.status(400).json({ message: 'No property changes were provided.' });
    }

    try {
      const [existing] = await db.query(
        'SELECT id, owner_id FROM properties WHERE id = ? LIMIT 1',
        [propertyId]
      );

      if (!existing.length) {
        return res.status(404).json({ message: 'Property not found.' });
      }

      if (Number(existing[0].owner_id) !== Number(owner_id)) {
        return res.status(403).json({ message: 'You can only update your own property details.' });
      }

      values.push(propertyId, Number(owner_id));
      propertyValues.push(propertyId, Number(owner_id));

      await db.query(
        `UPDATE properties SET ${propertyUpdates.join(', ')} WHERE id = ? AND owner_id = ?`,
        propertyValues
      );

      const [updatedRows] = await db.query(
        `${propertySelect}
         WHERE p.id = ?`,
        [propertyId]
      );

      return res.status(200).json({
        message: 'Property updated successfully.',
        property: updatedRows[0]
      });
    } catch (error) {
      console.error('Error updating property details:', error);
      return res.status(500).json({ message: 'Server error while updating property details.' });
    }
  });

  router.post('/', async (req, res) => {
    const {
      owner_id,
      property_id,
      price_per_night,
      accommodation_type,
      bed_type,
      max_adults,
      max_kids,
      max_babies,
      accommodation_image_url = null,
      status = 'approved'
    } = req.body;

    if (!property_id || !accommodation_type || !bed_type || price_per_night === undefined || price_per_night === '') {
      return res.status(400).json({ message: 'Property ID, accommodation type, bed type, and price are required.' });
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
         WHERE p.id = ? AND p.owner_id = ? AND p.status = 'approved'`,
        [property_id, owner_id]
      );

      if (!properties.length) {
        return res.status(403).json({ message: 'You can only add accommodations to your approved properties.' });
      }

      const property = properties[0];
      const [result] = await db.query(
        `INSERT INTO accommodations (
           owner_id, property_id, price_per_night, status, accommodation_image_url,
           accommodation_type, bed_type, max_guests, max_adults, max_kids, max_babies
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          owner_id || null,
          property_id,
          parsedPrice,
          status,
          accommodation_image_url,
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

  // Blocks edit/delete while a booking is still pending, confirmed, or completed.
  async function hasActiveBooking(accommodationId) {
    const [rows] = await db.query(
      `SELECT id FROM bookings WHERE accommodation_id = ? AND status IN ('pending', 'confirmed', 'completed') LIMIT 1`,
      [accommodationId]
    );
    return rows.length > 0;
  }

  router.put('/:id', async (req, res) => {
    const accommodationId = Number(req.params.id);
    const {
      owner_id,
      accommodation_type,
      bed_type,
      price_per_night,
      max_adults,
      max_kids,
      max_babies,
      accommodation_image_url
    } = req.body;

    if (!Number.isFinite(accommodationId) || accommodationId <= 0) {
      return res.status(400).json({ message: 'accommodation id must be a valid positive number.' });
    }

    if (!accommodation_type || !bed_type || price_per_night === undefined || price_per_night === '') {
      return res.status(400).json({ message: 'Accommodation type, bed type, and price are required.' });
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
      const [existing] = await db.query(
        'SELECT id, owner_id FROM accommodations WHERE id = ? LIMIT 1',
        [accommodationId]
      );

      if (!existing.length) {
        return res.status(404).json({ message: 'Accommodation not found.' });
      }

      if (Number(existing[0].owner_id) !== Number(owner_id)) {
        return res.status(403).json({ message: 'You can only edit your own accommodations.' });
      }

      if (await hasActiveBooking(accommodationId)) {
        return res.status(409).json({ message: 'This accommodation cannot be edited while it has a pending, confirmed, or completed booking.' });
      }

      await db.query(
        `UPDATE accommodations SET
           accommodation_type = ?, bed_type = ?, price_per_night = ?, accommodation_image_url = ?,
           max_guests = ?, max_adults = ?, max_kids = ?, max_babies = ?
         WHERE id = ? AND owner_id = ?`,
        [
          accommodation_type,
          bed_type,
          parsedPrice,
          accommodation_image_url || null,
          totalGuests,
          adults,
          kids,
          babies,
          accommodationId,
          owner_id
        ]
      );

      const [rows] = await db.query(
        `${accommodationSelect}
         WHERE a.id = ?`,
        [accommodationId]
      );

      return res.status(200).json({
        message: 'Accommodation updated successfully.',
        accommodation: rows[0]
      });
    } catch (error) {
      console.error('Error updating accommodation:', error);
      return res.status(500).json({ message: 'Server error while updating accommodation.' });
    }
  });

  router.delete('/:id', async (req, res) => {
    const accommodationId = Number(req.params.id);
    const ownerId = req.body.owner_id ?? req.query.owner_id;

    if (!Number.isFinite(accommodationId) || accommodationId <= 0) {
      return res.status(400).json({ message: 'accommodation id must be a valid positive number.' });
    }

    try {
      const [existing] = await db.query(
        'SELECT id, owner_id FROM accommodations WHERE id = ? LIMIT 1',
        [accommodationId]
      );

      if (!existing.length) {
        return res.status(404).json({ message: 'Accommodation not found.' });
      }

      if (Number(existing[0].owner_id) !== Number(ownerId)) {
        return res.status(403).json({ message: 'You can only delete your own accommodations.' });
      }

      if (await hasActiveBooking(accommodationId)) {
        return res.status(409).json({ message: 'This accommodation cannot be deleted while it has a pending, confirmed, or completed booking.' });
      }

      await db.query('DELETE FROM accommodations WHERE id = ? AND owner_id = ?', [accommodationId, ownerId]);

      return res.status(200).json({ message: 'Accommodation deleted successfully.' });
    } catch (error) {
      console.error('Error deleting accommodation:', error);
      return res.status(500).json({ message: 'Server error while deleting accommodation.' });
    }
  });

  return router;
};
