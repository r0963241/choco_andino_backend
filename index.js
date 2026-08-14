// 1. IMPORT REQUIRED LIBRARIES
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); // Loads variables from your hidden .env file

const app = express();

// 2. MIDDLEWARE CONFIGURATIONS
app.use(cors());          // Allows my Vue.js frontend to securely talk to this API
app.use(express.json());  // Enables my server to read incoming JSON data from forms
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({ storage });

// 3. DATABASE CONNECTION CONFIGURATION
// This uses a "Pool", which keeps open connections ready for fast data querying
const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'choco_andino_db',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function ensureUserSchema() {
    const requiredColumns = [
        { name: 'profile_photo', definition: 'VARCHAR(255) NULL DEFAULT NULL' },
        { name: 'is_active', definition: 'TINYINT(1) NOT NULL DEFAULT 1' },
        { name: 'date_of_birth', definition: 'DATE NULL DEFAULT NULL' }
    ];

    for (const column of requiredColumns) {
        const [existingColumns] = await db.query(
            `SELECT COLUMN_NAME
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'users'
               AND COLUMN_NAME = ?`,
            [column.name]
        );

        if (!existingColumns.length) {
            await db.query(`ALTER TABLE users ADD COLUMN ${column.name} ${column.definition}`);
            console.log(`Added missing users.${column.name} column.`);
        }
    }
}

async function ensureAccommodationSchema() {
    const requiredColumns = [
        { name: 'property_id', definition: 'INT NULL' },
        { name: 'address', definition: 'VARCHAR(255) NULL' },
        { name: 'property_type', definition: 'VARCHAR(50) NULL' },
        { name: 'unit_count', definition: 'INT NULL' },
        { name: 'has_ac', definition: 'TINYINT(1) DEFAULT 0' },
        { name: 'has_parking', definition: 'TINYINT(1) DEFAULT 0' },
        { name: 'has_room_service', definition: 'TINYINT(1) DEFAULT 0' },
        { name: 'has_private_wc', definition: 'TINYINT(1) DEFAULT 0' },
        { name: 'accommodation_type', definition: 'VARCHAR(20) NULL' },
        { name: 'bed_type', definition: 'VARCHAR(20) NULL' },
        { name: 'max_guests', definition: 'INT NULL' },
        { name: 'max_adults', definition: 'INT NULL' },
        { name: 'max_kids', definition: 'INT NULL' },
        { name: 'max_babies', definition: 'INT NULL' }
    ];

    for (const column of requiredColumns) {
        const [existingColumns] = await db.query(
            `SELECT COLUMN_NAME
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'accommodations'
               AND COLUMN_NAME = ?`,
            [column.name]
        );

        if (!existingColumns.length) {
            await db.query(`ALTER TABLE accommodations ADD COLUMN ${column.name} ${column.definition}`);
            console.log(`Added missing accommodations.${column.name} column.`);
        }
    }
}

async function ensureBookingSchema() {
    const requiredColumns = [
        { name: 'check_in_date', definition: 'DATE NULL' },
        { name: 'check_out_date', definition: 'DATE NULL' },
        { name: 'adults', definition: 'INT NULL DEFAULT 1' },
        { name: 'kids', definition: 'INT NULL DEFAULT 0' },
        { name: 'babies', definition: 'INT NULL DEFAULT 0' },
        { name: 'total_price', definition: 'DECIMAL(10,2) NULL DEFAULT 0' },
        { name: 'action', definition: 'VARCHAR(50) NULL' },
        { name: 'action_at', definition: 'DATETIME NULL' }
    ];

    for (const column of requiredColumns) {
        const [existingColumns] = await db.query(
            `SELECT COLUMN_NAME
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'bookings'
               AND COLUMN_NAME = ?`,
            [column.name]
        );

        if (!existingColumns.length) {
            await db.query(`ALTER TABLE bookings ADD COLUMN ${column.name} ${column.definition}`);
            console.log(`Added missing bookings.${column.name} column.`);
        }
    }
}

async function backfillBookingReportingFields() {
    // Populate missing totals from dates and accommodation nightly price.
    await db.query(
        `UPDATE bookings b
         LEFT JOIN accommodations a ON a.id = b.accommodation_id
         SET b.total_price = COALESCE(
             ROUND(COALESCE(a.price_per_night, 0) * GREATEST(DATEDIFF(b.check_out_date, b.check_in_date), 1), 2),
             0
         )
         WHERE b.total_price IS NULL
            OR b.total_price = 0`
    );

    // Populate missing action values from status so older rows can be reported.
    await db.query(
        `UPDATE bookings
         SET action = CASE
             WHEN status = 'confirmed' THEN 'owner_confirmed'
             WHEN status = 'declined' THEN 'owner_declined'
             WHEN status = 'cancelled' THEN 'visitor_cancelled'
             ELSE 'created'
         END
         WHERE action IS NULL OR action = ''`
    );

    // If action exists but timestamp is missing, default to booking creation date.
    await db.query(
        `UPDATE bookings
         SET action_at = booking_date
         WHERE action_at IS NULL`
    );
}

let autoCompleteJobRunning = false;

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

async function autoCompletePastBookings() {
    if (autoCompleteJobRunning) {
        return;
    }

    autoCompleteJobRunning = true;
    try {
        const [rows] = await db.query(
            `SELECT id
             FROM bookings
             WHERE status = 'confirmed'
               AND DATE(COALESCE(check_out_date, DATE_ADD(COALESCE(check_in_date, booking_date), INTERVAL 1 DAY))) < CURDATE()
             LIMIT 500`
        );

        if (!rows.length) {
            return;
        }

        const bookingIds = rows.map((row) => row.id);
        await db.query(
            `UPDATE bookings
             SET status = 'completed', action = 'system_auto_completed', action_at = NOW()
             WHERE id IN (?)`,
            [bookingIds]
        );

        console.log(`Automation job completed ${bookingIds.length} booking(s).`);
        await sendAutomationWebhook('bookings_auto_completed', {
            booking_ids: bookingIds,
            count: bookingIds.length
        });
    } catch (error) {
        console.error('Error running auto-complete booking automation job:', error.message);
    } finally {
        autoCompleteJobRunning = false;
    }
}

function scheduleBookingAutomationJobs() {
    // Every hour at minute 0.
    cron.schedule('0 * * * *', () => {
        autoCompletePastBookings();
    });
}

// 4. ROUTE MOUNTING
const authRoutes = require('./routes/auth.js')(db);
const accommodationRoutes = require('./routes/accommodations.js')(db);
const bookingRoutes = require('./routes/bookings.js')(db);
const adminRoutes = require('./routes/admin.js')(db);
app.use('/api/auth', authRoutes);
app.use('/api/accommodations', accommodationRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/admin', adminRoutes);

app.post('/api/upload-image', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No image file provided.' });
    }

    const imageUrl = `http://localhost:3000/uploads/${req.file.filename}`;
    res.status(200).json({ imageUrl });
});

// 5. FIRST REST API ENDPOINT (READ - GET)
// When my Vue frontend requests this URL, it fetches all approved site accommodations
app.get('/api/accommodations', async (req, res) => {
    try {
        // Query the database safely
        const [rows] = await db.query(
            "SELECT id, owner_id, property_id, title, description, price_per_night, location, status, image_url, property_type, accommodation_type, bed_type, max_guests, max_adults, max_kids, max_babies FROM accommodations WHERE status = 'approved' AND property_id IS NOT NULL AND price_per_night > 0"
        );

        const accommodationsWithImage = rows.map((cabin) => ({
            ...cabin,
            image_url: cabin.image_url || 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=80'
        }));

        // Send the database rows back to the frontend browser as clean JSON data
        res.status(200).json(accommodationsWithImage);
    } catch (error) {
        // Clear student error logging
        console.error('Error fetching accommodations:', error);
        res.status(500).json({ message: 'Server error pulling accommodation data.' });
    }
});

// 6. START THE SERVER ON MY LOCAL MACHINE
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        const connection = await db.getConnection();
        connection.release();
        console.log('Successfully connected to the Chocó Andino MySQL database!');

        // Ensure schema upgrades complete before any request can hit routes.
        await ensureUserSchema();
        await ensureAccommodationSchema();
        await ensureBookingSchema();
        await backfillBookingReportingFields();
        await autoCompletePastBookings();
        scheduleBookingAutomationJobs();

        app.listen(PORT, () => {
            console.log(`Express Backend Server running locally at: http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Database connection failed! Error details:', err.message);
        console.log('TIP: Check if  XAMPP MySQL is active and my password in .env is correct.');
        process.exit(1);
    }
}

startServer();