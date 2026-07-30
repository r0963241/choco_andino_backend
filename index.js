// 1. IMPORT REQUIRED LIBRARIES
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config(); // Loads variables from your hidden .env file

const app = express();

// 2. MIDDLEWARE CONFIGURATIONS
app.use(cors());          // Allows my Vue.js frontend to securely talk to this API
app.use(express.json());  // Enables my server to read incoming JSON data from forms



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

// 4. ROUTE MOUNTING
const authRoutes = require('./routes/auth.js')(db);
app.use('/api/auth', authRoutes);
// Test the database connection instantly when starting the server
db.getConnection()
    .then(() => console.log('Successfully connected to the Chocó Andino MySQL database!'))
    .catch((err) => {
        console.error('Database connection failed! Error details:', err.message);
        console.log('TIP: Check if  XAMPP MySQL is active and my password in .env is correct.');
    });

// 5. FIRST REST API ENDPOINT (READ - GET)
// When my Vue frontend requests this URL, it fetches all approved site accommodations
app.get('/api/accommodations', async (req, res) => {
    try {
        // Query the database safely
        const [rows] = await db.query("SELECT * FROM accommodations WHERE status = 'approved'");
        
        // Send the database rows back to the frontend browser as clean JSON data
        res.status(200).json(rows);
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