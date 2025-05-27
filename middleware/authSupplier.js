// middleware/authSupplier.js
const jwt = require('jsonwebtoken');

const authSupplier = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7, authHeader.length); // Remove "Bearer "
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.supplier = decoded; // Add decoded supplier info (supplierId, name, email) to request object
            next(); // Proceed to the next middleware or route handler
        } catch (error) {
            console.error("JWT verification error:", error.message);
            return res.status(401).json({ error: 'Invalid or expired token.' });
        }
    } else {
        return res.status(401).json({ error: 'Authorization header missing or malformed.' });
    }
};

module.exports = authSupplier;