const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// We pass the database pool into this file when we import it in index.js
module.exports = function(db) {

    // 1. REGISTER ENDPOINT (POST /api/auth/register)
    router.post('/register', async (req, res) => {
        const { name, email, password, role } = req.body;

        // Basic input validation checks
        if (!name || !email || !password) {
            return res.status(400).json({ message: 'All fields are required.' });
        }

        try {
            // Check if the user already exists in the database
            const [existingUser] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
            if (existingUser.length > 0) {
                return res.status(400).json({ message: 'Email is already registered.' });
            }

            // Securely hash the password (scramble it 10 times)
            const hashedPassword = await bcrypt.hash(password, 10);

            // Assign default role as 'visitor' if none or an invalid one is specified
            const userRole = (role === 'owner' || role === 'admin') ? role : 'visitor';

            // Save the new user to the MySQL database
            await db.query(
                'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
                [name, email, hashedPassword, userRole]
            );

            res.status(201).json({ message: 'User registered successfully!' });
        } catch (error) {
            console.error('Registration error:', error);
            res.status(500).json({ message: 'Server error during registration.' });
        }
    });
    // 2. LOGIN ENDPOINT (POST /api/auth/login)
    router.post('/login', async (req, res) => {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Please provide email and password.' });
        }

        try {
            // Find the user by their email
            const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
            if (users.length === 0) {
                return res.status(401).json({ message: 'Invalid credentials.' });
            }

            const user = users[0];

            // Compare the typed password with the scrambled database password
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                return res.status(401).json({ message: 'Invalid credentials.' });
            }

            // Create the digital passport (JWT) payload
            const payload = {
                id: user.id,
                name: user.name,
                role: user.role
            };

            // Sign the token using the hidden secret key. It expires in 2 hours.
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '2h' });

            // Send the digital passport back to the frontend waiter
            res.status(200).json({
                message: 'Login successful!',
                token: token,
                user: { id: user.id, name: user.name, role: user.role }
            });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ message: 'Server error during login.' });
        }
    });

    return router;
};