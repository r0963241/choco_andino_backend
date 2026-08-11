const express = require('express');
const router = express.Router();

module.exports = function (db) {
  const validStatuses = ['pending', 'confirmed', 'cancelled', 'declined', 'completed'];
  const ownerModerationStatuses = ['confirmed', 'declined'];

  function formatDateForMessage(value) {
    if (!value) {
      return 'unknown date';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return String(value);
    }

    return parsed.toISOString().slice(0, 10);
  }

  router.post('/', async (req, res) => {
    const {
      visitor_id,
      accommodation_id,
      booking_date,
      check_in_date,
      check_out_date,
      adults = 1,
      kids = 0,
      babies = 0,
      status = 'pending'
    } = req.body;

    if (!visitor_id || !accommodation_id) {
      return res.status(400).json({ message: 'visitor_id and accommodation_id are required.' });
    }

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Status must be pending, confirmed, or cancelled.' });
    }

    const parsedVisitorId = Number(visitor_id);
    const parsedAccommodationId = Number(accommodation_id);
    const parsedAdults = Number(adults);
    const parsedKids = Number(kids);
    const parsedBabies = Number(babies);

    if (!Number.isInteger(parsedVisitorId) || parsedVisitorId <= 0) {
      return res.status(400).json({ message: 'visitor_id must be a valid positive number.' });
    }

    if (!Number.isInteger(parsedAccommodationId) || parsedAccommodationId <= 0) {
      return res.status(400).json({ message: 'accommodation_id must be a valid positive number.' });
    }

    if (!Number.isInteger(parsedAdults) || parsedAdults < 1 || !Number.isInteger(parsedKids) || parsedKids < 0 || !Number.isInteger(parsedBabies) || parsedBabies < 0) {
      return res.status(400).json({ message: 'Guest counts are invalid. Adults must be at least 1, and kids/babies cannot be negative.' });
    }

    const effectiveCheckIn = check_in_date || booking_date;
    const effectiveCheckOut = check_out_date;
    const checkInDate = new Date(effectiveCheckIn);
    const checkOutDate = new Date(effectiveCheckOut);

    if (!effectiveCheckIn || Number.isNaN(checkInDate.getTime())) {
      return res.status(400).json({ message: 'check_in_date must be a valid date.' });
    }

    if (!effectiveCheckOut || Number.isNaN(checkOutDate.getTime())) {
      return res.status(400).json({ message: 'check_out_date must be a valid date.' });
    }

    if (checkOutDate <= checkInDate) {
      return res.status(400).json({ message: 'check_out_date must be after check_in_date.' });
    }

    try {
      const [visitors] = await db.query(
        'SELECT id, role FROM users WHERE id = ? LIMIT 1',
        [parsedVisitorId]
      );

      if (!visitors.length) {
        return res.status(404).json({ message: 'Visitor account not found.' });
      }

      if (visitors[0].role !== 'visitor') {
        return res.status(403).json({ message: 'Only visitor accounts can create bookings.' });
      }

      const [accommodations] = await db.query(
        `SELECT id, title, status, max_guests, max_adults, max_kids, max_babies
         FROM accommodations
         WHERE id = ? AND property_id IS NOT NULL AND status = 'approved'
         LIMIT 1`,
        [parsedAccommodationId]
      );

      if (!accommodations.length) {
        return res.status(404).json({ message: 'Accommodation not found or not available for booking.' });
      }

      const accommodation = accommodations[0];
      const hasMaxGuests = Number.isFinite(Number(accommodation.max_guests));
      const hasMaxAdults = Number.isFinite(Number(accommodation.max_adults));
      const hasMaxKids = Number.isFinite(Number(accommodation.max_kids));
      const hasMaxBabies = Number.isFinite(Number(accommodation.max_babies));
      const totalGuests = parsedAdults + parsedKids + parsedBabies;

      if (hasMaxAdults && parsedAdults > Number(accommodation.max_adults)) {
        return res.status(400).json({ message: `This accommodation allows a maximum of ${accommodation.max_adults} adults.` });
      }

      if (hasMaxKids && parsedKids > Number(accommodation.max_kids)) {
        return res.status(400).json({ message: `This accommodation allows a maximum of ${accommodation.max_kids} kids.` });
      }

      if (hasMaxBabies && parsedBabies > Number(accommodation.max_babies)) {
        return res.status(400).json({ message: `This accommodation allows a maximum of ${accommodation.max_babies} babies.` });
      }

      if (hasMaxGuests && totalGuests > Number(accommodation.max_guests)) {
        return res.status(400).json({ message: `This accommodation allows up to ${accommodation.max_guests} total guests.` });
      }

      const [conflicts] = await db.query(
        `SELECT id, check_in_date, check_out_date, booking_date, status
         FROM bookings
         WHERE accommodation_id = ?
           AND status IN ('pending', 'confirmed')
           AND COALESCE(check_in_date, booking_date) < ?
           AND COALESCE(check_out_date, DATE_ADD(COALESCE(check_in_date, booking_date), INTERVAL 1 DAY)) > ?
         LIMIT 1`,
        [parsedAccommodationId, effectiveCheckOut, effectiveCheckIn]
      );

      if (conflicts.length) {
        const conflict = conflicts[0];
        const conflictStart = conflict.check_in_date || conflict.booking_date;
        const conflictEnd = conflict.check_out_date || conflictStart;
        return res.status(409).json({
          message: `This accommodation is not available for those dates. It already has booking #${conflict.id} from ${formatDateForMessage(conflictStart)} to ${formatDateForMessage(conflictEnd)}.`
        });
      }

      const [result] = await db.query(
        `INSERT INTO bookings (visitor_id, accommodation_id, booking_date, check_in_date, check_out_date, adults, kids, babies, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [parsedVisitorId, parsedAccommodationId, effectiveCheckIn, effectiveCheckIn, effectiveCheckOut, parsedAdults, parsedKids, parsedBabies, status]
      );

      const [rows] = await db.query(
        `SELECT b.id, b.visitor_id, b.accommodation_id, b.booking_date, b.check_in_date, b.check_out_date, b.adults, b.kids, b.babies, b.status,
                a.title AS accommodation_title, a.location AS accommodation_location, a.price_per_night,
                COALESCE(a.image_url, parent.image_url) AS image_url
         FROM bookings b
         LEFT JOIN accommodations a ON a.id = b.accommodation_id
         LEFT JOIN accommodations parent ON parent.id = a.property_id
         WHERE b.id = ?
         LIMIT 1`,
        [result.insertId]
      );

      return res.status(201).json({
        message: 'Booking saved successfully.',
        booking: rows[0]
      });
    } catch (error) {
      console.error('Error saving booking:', error);
      return res.status(500).json({ message: 'Server error while saving booking.' });
    }
  });

  router.get('/visitor/:visitorId', async (req, res) => {
    const parsedVisitorId = Number(req.params.visitorId);
    if (!Number.isInteger(parsedVisitorId) || parsedVisitorId <= 0) {
      return res.status(400).json({ message: 'visitorId must be a valid positive number.' });
    }

    try {
      const [rows] = await db.query(
        `SELECT b.id, b.visitor_id, b.accommodation_id, b.booking_date, b.check_in_date, b.check_out_date, b.adults, b.kids, b.babies, b.status,
                a.title AS accommodation_title, a.location AS accommodation_location, a.price_per_night,
                COALESCE(a.image_url, parent.image_url) AS image_url
         FROM bookings b
         LEFT JOIN accommodations a ON a.id = b.accommodation_id
         LEFT JOIN accommodations parent ON parent.id = a.property_id
         WHERE b.visitor_id = ?
         ORDER BY b.booking_date DESC, b.id DESC`,
        [parsedVisitorId]
      );

      return res.status(200).json(rows);
    } catch (error) {
      console.error('Error loading visitor bookings:', error);
      return res.status(500).json({ message: 'Server error while fetching bookings.' });
    }
  });

  router.get('/owner/:ownerId', async (req, res) => {
    const parsedOwnerId = Number(req.params.ownerId);
    if (!Number.isInteger(parsedOwnerId) || parsedOwnerId <= 0) {
      return res.status(400).json({ message: 'ownerId must be a valid positive number.' });
    }

    const requestedStatus = req.query.status || 'pending';
    if (requestedStatus !== 'all' && !validStatuses.includes(requestedStatus)) {
      return res.status(400).json({ message: 'Status filter must be pending, confirmed, cancelled, declined, completed, or all.' });
    }

    try {
      const statusClause = requestedStatus === 'all' ? '' : 'AND b.status = ?';
      const params = requestedStatus === 'all' ? [parsedOwnerId] : [parsedOwnerId, requestedStatus];
      const [rows] = await db.query(
        `SELECT b.id, b.visitor_id, b.accommodation_id, b.booking_date, b.check_in_date, b.check_out_date, b.adults, b.kids, b.babies, b.status,
                a.title AS accommodation_title, a.location AS accommodation_location, a.price_per_night,
                COALESCE(a.image_url, parent.image_url) AS image_url,
                v.name AS visitor_name, v.email AS visitor_email,
                parent.title AS property_title
         FROM bookings b
         INNER JOIN accommodations a ON a.id = b.accommodation_id
         LEFT JOIN accommodations parent ON parent.id = a.property_id
         LEFT JOIN users v ON v.id = b.visitor_id
         WHERE a.owner_id = ?
         ${statusClause}
         ORDER BY b.booking_date DESC, b.id DESC`,
        params
      );

      return res.status(200).json(rows);
    } catch (error) {
      console.error('Error loading owner booking requests:', error);
      return res.status(500).json({ message: 'Server error while fetching owner booking requests.' });
    }
  });

  router.patch('/:bookingId/status', async (req, res) => {
    const parsedBookingId = Number(req.params.bookingId);
    const parsedOwnerId = Number(req.body.owner_id);
    const nextStatus = req.body.status;

    if (!Number.isInteger(parsedBookingId) || parsedBookingId <= 0) {
      return res.status(400).json({ message: 'bookingId must be a valid positive number.' });
    }

    if (!Number.isInteger(parsedOwnerId) || parsedOwnerId <= 0) {
      return res.status(400).json({ message: 'owner_id is required and must be a valid positive number.' });
    }

    if (!ownerModerationStatuses.includes(nextStatus)) {
      return res.status(400).json({ message: 'Status must be confirmed or declined.' });
    }

    try {
      const [rows] = await db.query(
        `SELECT b.id, b.status
         FROM bookings b
         INNER JOIN accommodations a ON a.id = b.accommodation_id
         WHERE b.id = ? AND a.owner_id = ?
         LIMIT 1`,
        [parsedBookingId, parsedOwnerId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: 'Booking not found for this owner.' });
      }

      if (rows[0].status !== 'pending') {
        return res.status(409).json({ message: `Booking already processed with status ${rows[0].status}.` });
      }

      await db.query(
        'UPDATE bookings SET status = ? WHERE id = ?',
        [nextStatus, parsedBookingId]
      );

      return res.status(200).json({ message: `Booking ${nextStatus}.` });
    } catch (error) {
      console.error('Error updating booking status by owner:', error);
      return res.status(500).json({ message: 'Server error while updating booking status.' });
    }
  });

  return router;
};