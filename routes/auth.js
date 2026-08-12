const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// We pass the database pool into this file when we import it in index.js
module.exports = function(db) {

    // 1. REGISTER ENDPOINT (POST /api/auth/register)
    function isAtLeast18(dateOfBirthValue) {
        if (!dateOfBirthValue) {
            return false;
        }

        const birthDate = new Date(dateOfBirthValue);
        if (Number.isNaN(birthDate.getTime())) {
            return false;
        }

        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const monthDifference = today.getMonth() - birthDate.getMonth();

        if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate())) {
            age -= 1;
        }

        return age >= 18;
    }

    router.post('/register', async (req, res) => {
        const { name, email, password, role, date_of_birth } = req.body;

        // Basic input validation checks
        if (!name || !email || !password || !date_of_birth) {
            return res.status(400).json({ message: 'Name, email, password, and date of birth are required.' });
        }

        if (!isAtLeast18(date_of_birth)) {
            return res.status(400).json({ message: 'You must be at least 18 years old to register.' });
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
                'INSERT INTO users (name, email, password, role, date_of_birth, is_active) VALUES (?, ?, ?, ?, ?, 1)',
                [name, email, hashedPassword, userRole, date_of_birth]
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
            const [users] = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
            if (users.length === 0) {
                return res.status(401).json({ message: 'Invalid credentials.' });
            }

            if (Number(users[0].is_active) === 0) {
                return res.status(401).json({ message: 'Account deleted. Contact admin to re-open it.' });
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
                role: user.role,
                profile_photo: user.profile_photo || null
            };

            // Sign the token using the hidden secret key. It expires in 2 hours.
            const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '2h' });

            // Send the digital passport back to the frontend waiter
            res.status(200).json({
                message: 'Login successful!',
                token: token,
                user: {
                    id: user.id,
                    name: user.name,
                    role: user.role,
                    email: user.email,
                    profile_photo: user.profile_photo || null,
                    date_of_birth: user.date_of_birth || null
                }
            });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ message: 'Server error during login.' });
        }
    });

    router.get('/user/:userId', async (req, res) => {
        const parsedUserId = Number(req.params.userId);

        if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
            return res.status(400).json({ message: 'userId must be a valid positive number.' });
        }

        try {
            const [users] = await db.query(
                'SELECT id, name, email, role, profile_photo FROM users WHERE id = ? LIMIT 1',
                [parsedUserId]
            );

            if (!users.length) {
                return res.status(404).json({ message: 'User not found.' });
            }

            return res.status(200).json(users[0]);
        } catch (error) {
            console.error('Error fetching user profile:', error);
            return res.status(500).json({ message: 'Server error while fetching user profile.' });
        }
    });

    router.patch('/user/:userId', async (req, res) => {
        const parsedUserId = Number(req.params.userId);
        const { name, password, profile_photo, date_of_birth } = req.body;

        if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
            return res.status(400).json({ message: 'userId must be a valid positive number.' });
        }

        const updates = [];
        const values = [];

        if (name && typeof name === 'string' && name.trim()) {
            updates.push('name = ?');
            values.push(name.trim());
        }

        if (typeof profile_photo === 'string' && profile_photo.trim()) {
            updates.push('profile_photo = ?');
            values.push(profile_photo.trim());
        }

        if (typeof date_of_birth !== 'undefined' && date_of_birth !== null && date_of_birth !== '') {
            const birthDate = new Date(date_of_birth);
            if (Number.isNaN(birthDate.getTime())) {
                return res.status(400).json({ message: 'Date of birth must be a valid date.' });
            }

            const today = new Date();
            let age = today.getFullYear() - birthDate.getFullYear();
            const monthDifference = today.getMonth() - birthDate.getMonth();

            if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthDate.getDate())) {
                age -= 1;
            }

            if (age < 18) {
                return res.status(400).json({ message: 'You must be at least 18 years old.' });
            }

            updates.push('date_of_birth = ?');
            values.push(date_of_birth);
        }

        if (password && typeof password === 'string' && password.trim()) {
            const hashedPassword = await bcrypt.hash(password.trim(), 10);
            updates.push('password = ?');
            values.push(hashedPassword);
        }

        if (!updates.length) {
            return res.status(400).json({ message: 'No profile changes were provided.' });
        }

        try {
            values.push(parsedUserId);
            await db.query(
                `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
                values
            );

            const [users] = await db.query(
                'SELECT id, name, email, role, profile_photo, date_of_birth FROM users WHERE id = ? LIMIT 1',
                [parsedUserId]
            );

            return res.status(200).json({
                message: 'Profile updated successfully.',
                user: users[0]
            });
        } catch (error) {
            console.error('Error updating user profile:', error);
            return res.status(500).json({ message: 'Server error while updating profile.' });
        }
    });

    router.delete('/user/:userId', async (req, res) => {
        const parsedUserId = Number(req.params.userId);
        const { password } = req.body || {};

        if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
            return res.status(400).json({ message: 'userId must be a valid positive number.' });
        }

        if (!password || typeof password !== 'string' || !password.trim()) {
            return res.status(400).json({ message: 'Password confirmation is required to deactivate your account.' });
        }

        try {
            const [users] = await db.query('SELECT id, password, is_active FROM users WHERE id = ? LIMIT 1', [parsedUserId]);
            if (!users.length) {
                return res.status(404).json({ message: 'User not found.' });
            }

            if (Number(users[0].is_active) === 0) {
                return res.status(409).json({ message: 'This account is already inactive.' });
            }

            const isMatch = await bcrypt.compare(password.trim(), users[0].password);
            if (!isMatch) {
                return res.status(401).json({ message: 'Incorrect password. Account was not deactivated.' });
            }

            await db.query('UPDATE users SET is_active = 0 WHERE id = ?', [parsedUserId]);
            return res.status(200).json({ message: 'Account deleted. Contact admin to re-open it.' });
        } catch (error) {
            console.error('Error deactivating user account:', error);
            return res.status(500).json({ message: 'Server error while deactivating account.' });
        }
    });

    return router;
};