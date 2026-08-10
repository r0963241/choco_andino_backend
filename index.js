// 1. IMPORT REQUIRED LIBRARIES
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
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

// 4. ROUTE MOUNTING
const authRoutes = require('./routes/auth.js')(db);
const accommodationRoutes = require('./routes/accommodations.js')(db);
app.use('/api/auth', authRoutes);
app.use('/api/accommodations', accommodationRoutes);
// Test the database connection instantly when starting the server
db.getConnection()
    .then(async (connection) => {
        connection.release();
        console.log('Successfully connected to the Chocó Andino MySQL database!');
        await ensureAccommodationSchema();
    })
    .catch((err) => {
        console.error('Database connection failed! Error details:', err.message);
        console.log('TIP: Check if  XAMPP MySQL is active and my password in .env is correct.');
    });

app.post('/api/upload-image', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No image file provided.' });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    res.status(200).json({ imageUrl });
});

// 5. FIRST REST API ENDPOINT (READ - GET)
// When my Vue frontend requests this URL, it fetches all approved site accommodations
app.get('/api/accommodations', async (req, res) => {
    try {
        // Query the database safely
        const [rows] = await db.query(
            "SELECT id, owner_id, property_id, title, description, price_per_night, location, status, image_url, accommodation_type, bed_type, max_guests FROM accommodations WHERE status = 'approved' AND price_per_night > 0"
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
app.listen(PORT, () => {
    console.log(`Express Backend Server running locally at: http://localhost:${PORT}`);
});