const express = require('express');
const router = express.Router();

module.exports = function (db) {
  const validStatuses = ['pending', 'confirmed', 'cancelled', 'declined', 'completed'];
  const ownerModerationStatuses = ['confirmed', 'declined'];

  async function sendAutomationWebhook(eventType, payload) {
    const webhookUrl = process.env.AUTOMATION_WEBHOOK_URL;
    if (!webhookUrl || typeof fetch !== 'function') {
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event_type: eventType,
          source: 'choco_andino_backend',
          occurred_at: new Date().toISOString(),
          payload
        })
      });

      if (!response.ok) {
        console.error(`Automation webhook failed with status ${response.status} for event ${eventType}.`);
      }
    } catch (error) {
      console.error(`Automation webhook error for event ${eventType}:`, error.message);
    }
  }

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

  function calculateNights(checkInValue, checkOutValue) {
    const checkIn = new Date(checkInValue);
    const checkOut = new Date(checkOutValue);
    const utcCheckIn = Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate());
    const utcCheckOut = Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate());
    const diffDays = Math.floor((utcCheckOut - utcCheckIn) / (24 * 60 * 60 * 1000));
    return Math.max(1, diffDays);
  }

  function getDominantStayMonth(checkInValue, checkOutValue) {
    const effectiveCheckIn = checkInValue || null;
    const effectiveCheckOut = checkOutValue || effectiveCheckIn;

    if (!effectiveCheckIn) {
      return null;
    }

    const startDate = new Date(effectiveCheckIn);
    if (Number.isNaN(startDate.getTime())) {
      return null;
    }

    const endDate = new Date(effectiveCheckOut);
    if (Number.isNaN(endDate.getTime())) {
      return `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    const startUtc = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
    const endUtc = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));

    if (endUtc <= startUtc) {
      return `${startUtc.getUTCFullYear()}-${String(startUtc.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    const monthNights = new Map();
    const cursor = new Date(startUtc);

    while (cursor < endUtc) {
      const monthKey = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
      monthNights.set(monthKey, (monthNights.get(monthKey) || 0) + 1);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    let dominantMonth = null;
    let maxNights = -1;

    for (const [monthKey, nights] of monthNights.entries()) {
      if (nights > maxNights) {
        dominantMonth = monthKey;
        maxNights = nights;
      }
    }

    return dominantMonth || `${startUtc.getUTCFullYear()}-${String(startUtc.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function buildMonthlyRevenueReport(rows) {
    const reportMap = new Map();

    for (const row of rows) {
      const propertyId = Number(row.property_id || row.accommodation_id || 0);
      const propertyTitle = row.property_title || row.accommodation_title || `Property #${propertyId}`;
      const reportMonth = getDominantStayMonth(row.check_in_date || row.booking_date, row.check_out_date);

      if (!reportMonth) {
        continue;
      }

      const key = `${reportMonth}|${propertyId}|${propertyTitle}`;

      if (!reportMap.has(key)) {
        reportMap.set(key, {
          report_month: reportMonth,
          property_id: propertyId,
          property_title: propertyTitle,
          total_bookings: 0,
          confirmed_bookings: 0,
          cancelled_bookings: 0,
          declined_bookings: 0,
          revenue_total: 0
        });
      }

      const bucket = reportMap.get(key);
      bucket.total_bookings += 1;

      if (row.status === 'cancelled') {
        bucket.cancelled_bookings += 1;
      } else if (row.status === 'declined') {
        bucket.declined_bookings += 1;
      }

      if (row.status === 'confirmed' || row.status === 'completed') {
        bucket.confirmed_bookings += 1;
        bucket.revenue_total += Number(row.total_price || 0);
      }
    }

    return Array.from(reportMap.values()).sort((a, b) => {
      if (b.report_month !== a.report_month) {
        return b.report_month.localeCompare(a.report_month);
      }

      return String(a.property_title).localeCompare(String(b.property_title));
    });
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
        `SELECT id, status, price_per_night, max_guests, max_adults, max_kids, max_babies
         FROM accommodations
         WHERE id = ? AND property_id IS NOT NULL AND status = 'approved'
         LIMIT 1`,
        [parsedAccommodationId]
      );

      if (!accommodations.length) {
        return res.status(404).json({ message: 'Accommodation not found or not available for booking.' });
      }

      const accommodation = accommodations[0];
      const nights = calculateNights(effectiveCheckIn, effectiveCheckOut);
      const totalPrice = Number((Number(accommodation.price_per_night || 0) * nights).toFixed(2));
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
        `INSERT INTO bookings (visitor_id, accommodation_id, booking_date, check_in_date, check_out_date, adults, kids, babies, total_price, action, action_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [parsedVisitorId, parsedAccommodationId, effectiveCheckIn, effectiveCheckIn, effectiveCheckOut, parsedAdults, parsedKids, parsedBabies, totalPrice, 'created', status]
      );

      const [rows] = await db.query(
        `SELECT b.id, b.visitor_id, b.accommodation_id, b.booking_date, b.check_in_date, b.check_out_date, b.adults, b.kids, b.babies, b.total_price, b.action, b.action_at, b.status,
                a.price_per_night, a.accommodation_type, a.bed_type, a.accommodation_image_url,
                p.title, p.location, p.address, p.description, p.property_type, p.image_url, p.has_ac, p.has_parking, p.has_room_service, p.has_private_wc
         FROM bookings b
         LEFT JOIN accommodations a ON a.id = b.accommodation_id
         LEFT JOIN properties p ON p.id = a.property_id
         WHERE b.id = ?
         LIMIT 1`,
        [result.insertId]
      );

      sendAutomationWebhook('booking_created', {
        booking_id: result.insertId,
        visitor_id: parsedVisitorId,
        accommodation_id: parsedAccommodationId,
        check_in_date: effectiveCheckIn,
        check_out_date: effectiveCheckOut,
        total_price: totalPrice,
        status
      });

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
        `SELECT b.id, b.visitor_id, b.accommodation_id, b.booking_date, b.check_in_date, b.check_out_date, b.adults, b.kids, b.babies, b.total_price, b.action, b.action_at, b.status,
                a.price_per_night, a.accommodation_type, a.bed_type, a.accommodation_image_url,
                p.title, p.location, p.address, p.description, p.property_type, p.image_url, p.has_ac, p.has_parking, p.has_room_service, p.has_private_wc
         FROM bookings b
         LEFT JOIN accommodations a ON a.id = b.accommodation_id
         LEFT JOIN properties p ON p.id = a.property_id
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
        `SELECT b.id, b.visitor_id, b.accommodation_id, b.booking_date, b.check_in_date, b.check_out_date, b.adults, b.kids, b.babies, b.total_price, b.action, b.action_at, b.status,
                a.price_per_night, a.accommodation_type, a.bed_type, a.accommodation_image_url,
                p.title, p.location, p.address, p.description, p.property_type, p.image_url, p.has_ac, p.has_parking, p.has_room_service, p.has_private_wc,
                v.name AS visitor_name, v.email AS visitor_email
         FROM bookings b
         INNER JOIN accommodations a ON a.id = b.accommodation_id
         LEFT JOIN properties p ON p.id = a.property_id
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

  router.get('/owner/:ownerId/revenue/monthly', async (req, res) => {
    const parsedOwnerId = Number(req.params.ownerId);
    if (!Number.isInteger(parsedOwnerId) || parsedOwnerId <= 0) {
      return res.status(400).json({ message: 'ownerId must be a valid positive number.' });
    }

    try {
      const [rows] = await db.query(
        `SELECT b.id, b.status, b.booking_date, b.check_in_date, b.check_out_date, b.total_price,
                a.property_id,
                p.title AS property_title,
                a.accommodation_type
         FROM bookings b
         INNER JOIN accommodations a ON a.id = b.accommodation_id
         LEFT JOIN properties p ON p.id = a.property_id
         WHERE a.owner_id = ?
         ORDER BY COALESCE(b.check_in_date, b.booking_date) DESC, b.id DESC`,
        [parsedOwnerId]
      );

      return res.status(200).json(buildMonthlyRevenueReport(rows));
    } catch (error) {
      console.error('Error loading owner monthly revenue report:', error);
      return res.status(500).json({ message: 'Server error while fetching owner monthly revenue report.' });
    }
  });

  router.get('/revenue/monthly', async (_req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT b.id, b.status, b.booking_date, b.check_in_date, b.check_out_date, b.total_price,
                a.property_id,
                p.title AS property_title,
                a.owner_id,
                u.name AS owner_name,
                a.accommodation_type
         FROM bookings b
         INNER JOIN accommodations a ON a.id = b.accommodation_id
         LEFT JOIN properties p ON p.id = a.property_id
         LEFT JOIN users u ON u.id = a.owner_id
         ORDER BY COALESCE(b.check_in_date, b.booking_date) DESC, b.id DESC`,
        []
      );

      return res.status(200).json(buildMonthlyRevenueReport(rows));
    } catch (error) {
      console.error('Error loading global monthly revenue report:', error);
      return res.status(500).json({ message: 'Server error while fetching monthly revenue report.' });
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
        'UPDATE bookings SET status = ?, action = ?, action_at = NOW() WHERE id = ?',
        [nextStatus, nextStatus === 'confirmed' ? 'owner_confirmed' : 'owner_declined', parsedBookingId]
      );

      sendAutomationWebhook('booking_status_updated', {
        booking_id: parsedBookingId,
        owner_id: parsedOwnerId,
        status: nextStatus,
        action: nextStatus === 'confirmed' ? 'owner_confirmed' : 'owner_declined'
      });

      return res.status(200).json({ message: `Booking ${nextStatus}.` });
    } catch (error) {
      console.error('Error updating booking status by owner:', error);
      return res.status(500).json({ message: 'Server error while updating booking status.' });
    }
  });

  router.patch('/:bookingId/cancel', async (req, res) => {
    const parsedBookingId = Number(req.params.bookingId);
    const parsedVisitorId = Number(req.body.visitor_id);

    if (!Number.isInteger(parsedBookingId) || parsedBookingId <= 0) {
      return res.status(400).json({ message: 'bookingId must be a valid positive number.' });
    }

    if (!Number.isInteger(parsedVisitorId) || parsedVisitorId <= 0) {
      return res.status(400).json({ message: 'visitor_id is required and must be a valid positive number.' });
    }

    try {
      const [rows] = await db.query(
        `SELECT id, status, COALESCE(check_in_date, booking_date) AS effective_check_in
         FROM bookings
         WHERE id = ? AND visitor_id = ?
         LIMIT 1`,
        [parsedBookingId, parsedVisitorId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: 'Booking not found for this visitor.' });
      }

      const booking = rows[0];
      if (!['pending', 'confirmed'].includes(String(booking.status || '').toLowerCase())) {
        return res.status(409).json({ message: `Booking cannot be cancelled from status ${booking.status}.` });
      }

      const [dateValidation] = await db.query(
        `SELECT CASE WHEN CURDATE() < DATE(COALESCE(check_in_date, booking_date)) THEN 1 ELSE 0 END AS can_cancel
         FROM bookings
         WHERE id = ?
         LIMIT 1`,
        [parsedBookingId]
      );

      if (!dateValidation.length || Number(dateValidation[0].can_cancel) !== 1) {
        return res.status(409).json({ message: 'Booking can only be cancelled before the check-in date.' });
      }

      await db.query(
        'UPDATE bookings SET status = ?, action = ?, action_at = NOW() WHERE id = ?',
        ['cancelled', 'visitor_cancelled', parsedBookingId]
      );

      sendAutomationWebhook('booking_cancelled', {
        booking_id: parsedBookingId,
        visitor_id: parsedVisitorId,
        status: 'cancelled',
        action: 'visitor_cancelled'
      });

      return res.status(200).json({ message: 'Booking cancelled successfully.' });
    } catch (error) {
      console.error('Error cancelling booking by visitor:', error);
      return res.status(500).json({ message: 'Server error while cancelling booking.' });
    }
  });

  return router;
};