// telegram-app-backend/middleware/authDeliveryAgent.js
const jwt = require('jsonwebtoken');

const authDeliveryAgent = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        try {
            const decoded = jwt.verify(token, process.env.JWT_DELIVERY_SECRET); // Use DELIVERY secret
            req.deliveryAgent = decoded; // Add decoded info (deliveryAgentId, supplierId, name, role)
            next();
        } catch (error) {
            console.error("Delivery Agent JWT verification error:", error.message);
            return res.status(401).json({ error: 'Invalid or expired delivery token.' });
        }
    } else {
        return res.status(401).json({ error: 'Delivery authorization header missing or malformed.' });
    }
};
module.exports = authDeliveryAgent;