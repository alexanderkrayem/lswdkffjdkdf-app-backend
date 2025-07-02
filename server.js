// server.js
require('dotenv').config(); // Load environment variables from .env file
const cron = require('node-cron');
const pricingEngine = require('./services/pricingEngine'); // Adjust path if you placed it elsewhere
const db = require('./config/db'); // Import the db config
const express = require('express');
const cors = require('cors');
const authSupplier = require('./middleware/authSupplier'); // <<< IMPORT
const app = express();
const PORT = process.env.PORT || 3001; // Use port from .env or default to 3001
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const authAdmin = require('./middleware/authAdmin'); // IMPORT THIS
const authDeliveryAgent = require('./middleware/authDeliveryAgent'); // IMPORT
const crypto = require('crypto'); // For HMAC SHA256 verification

const normalizeTextForMatching = (inputText) => {
    if (typeof inputText !== 'string' || !inputText) {
        return ''; // Return empty string for invalid input to avoid errors
    }
    let normalized = inputText;
    
    // 1. Convert to lowercase
    normalized = normalized.toLowerCase();
    
    // 2. Trim leading/trailing whitespace
    normalized = normalized.trim();
    
    // 3. Replace multiple spaces with a single space
    normalized = normalized.replace(/\s+/g, ' ');

    // 4. Basic unaccenting (very limited - for full support, use a library or DB function)
    // Example: (You'd need to expand this significantly for comprehensive unaccenting)
    // normalized = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // More generic diacritic removal
    // For Arabic, specific unaccenting rules apply which are complex in pure JS.
    // PostgreSQL's unaccent() is generally more reliable if you can apply it in the query
    // or have a pre-normalized column in master_products.

    // For now, we rely on the master_products.standardized_name_normalized already being fully normalized in the DB
    // and this JS function primarily handles case and spacing for the input term.
    return normalized;
};

// --- Middleware ---
// Enable CORS for all routes and origins (adjust for production later)
app.use(cors());
// Allow Express to parse JSON request bodies
app.use(express.json());

// --- Basic Routes (Placeholders) ---
// --- Routes ---
// ... existing routes ...

// Database connection test route

app.get('/', (req, res) => {
  res.send('Hello from Telegram App Backend!');
});

// In telegram-app-backend/server.js
app.get('/api/categories', async (req, res) => {
    try {
        const result = await db.query('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != \'\' ORDER BY category ASC');
        res.json(result.rows.map(row => row.category)); // Returns an array of category strings
    } catch (err) {
        console.error("Error fetching categories:", err);
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});
// server.js
// ... (other require statements, middleware, existing routes for products, suppliers, cart, profile, orders, favorites) ...

// --- NEW: Global Search API Endpoint ---

// server.js
// ... (other require statements, middleware, existing routes) ...

// telegram-app-backend/server.js
// [CITY_FILTER] UPDATED Global Search with city filtering
app.get('/api/search', async (req, res) => {
    // --- Get and validate cityId first ---
    const cityId = parseInt(req.query.cityId, 10);
    if (!cityId) {
        return res.status(400).json({ error: "A cityId query parameter is required for search." });
    }

    const searchTerm = req.query.searchTerm || '';
    const MIN_SEARCH_LENGTH = 3;
    const productPage = parseInt(req.query.page, 10) || 1;
    const productLimit = parseInt(req.query.limit, 10) || 10;
    const productOffset = (productPage - 1) * productLimit;

    if (searchTerm.trim().length < MIN_SEARCH_LENGTH) {
        return res.json({
            searchTerm: searchTerm,
            results: { products: { items: [], currentPage: 1, totalPages: 0, totalItems: 0 }, deals: [], suppliers: [] }
        });
    }

    const trimmedSearchTerm = searchTerm.trim();
    const trigramThreshold = 0.1;

    try {
        const productPromise = (async () => {
            const queryParams = [];
            // This SQL query is now more comprehensive to fetch the adjustment percentage
            const productsQuery = `
                SELECT
                    p.id, p.name, p.description, p.price AS supplier_base_price, 
                    p.discount_price AS supplier_discount_price, p.is_on_sale AS supplier_is_on_sale,
                    p.category, p.image_url, s_prod.name as supplier_name, p.supplier_id,
                    p.master_product_id, mp.display_name AS master_product_display_name,
                    mp.image_url AS master_product_image_url,
                    COALESCE(mp.current_price_adjustment_percentage, 0.0000) AS price_adjustment_percentage,
                    ts_rank_cd(p.tsv, q.query) AS rank
                FROM products p
                JOIN suppliers s_prod ON p.supplier_id = s_prod.id
                JOIN supplier_cities sc ON s_prod.id = sc.supplier_id
                LEFT JOIN master_products mp ON p.master_product_id = mp.id
                , LATERAL websearch_to_tsquery('pg_catalog.arabic', $1) AS q(query) -- Parameter 1: Search Term
                WHERE 
                    s_prod.is_active = TRUE
                    AND sc.city_id = $2 -- Parameter 2: City ID
                    AND (p.tsv @@ q.query OR similarity(COALESCE(mp.display_name, p.name), $1) > $3) -- Parameter 1 & 3
                ORDER BY rank DESC
                LIMIT $4 OFFSET $5; -- Parameter 4 & 5
            `;
            queryParams.push(trimmedSearchTerm, cityId, trigramThreshold, productLimit, productOffset);

            const countQuery = `
                SELECT COUNT(DISTINCT p.id) AS total_items 
                FROM products p
                JOIN suppliers s_prod ON p.supplier_id = s_prod.id
                JOIN supplier_cities sc ON s_prod.id = sc.supplier_id
                LEFT JOIN master_products mp ON p.master_product_id = mp.id
                , LATERAL websearch_to_tsquery('pg_catalog.arabic', $1) AS q(query)
                WHERE 
                    s_prod.is_active = TRUE
                    AND sc.city_id = $2
                    AND (p.tsv @@ q.query OR similarity(COALESCE(mp.display_name, p.name), $1) > $3);
            `;
            const countQueryParams = [trimmedSearchTerm, cityId, trigramThreshold];
            
            const [productsResult, productCountResult] = await Promise.all([
                db.query(productsQuery, queryParams),
                db.query(countQuery, countQueryParams)
            ]);
            
            // =================================================================
            // === THIS IS THE CORRECTED MAPPING LOGIC WITH PRICE CALCULATION ===
            // =================================================================
            const processedProducts = productsResult.rows.map(p => {
                // Calculate the effective selling price
                let basePriceForCalc = parseFloat(p.supplier_base_price);
                if (p.supplier_is_on_sale && p.supplier_discount_price !== null) {
                    basePriceForCalc = parseFloat(p.supplier_discount_price);
                }
                const adjustment = parseFloat(p.price_adjustment_percentage);
                const effectivePrice = basePriceForCalc * (1 + adjustment);

                // Return the final object shape that the frontend card expects
                return {
                    id: p.id,
                    name: p.master_product_display_name || p.name,
                    image_url: p.master_product_image_url || p.image_url,
                    supplier_name: p.supplier_name,
                    supplier_id: p.supplier_id,
                    effective_selling_price: parseFloat(effectivePrice.toFixed(2)),
                    // These fields are needed to show a "slashed" original price on the card
                    is_on_sale: p.supplier_is_on_sale,
                    discount_price: p.supplier_discount_price,
                };
            });

            return {
                items: processedProducts,
                currentPage: productPage,
                totalPages: Math.ceil(parseInt(productCountResult.rows[0].total_items, 10) / productLimit),
                totalItems: parseInt(productCountResult.rows[0].total_items, 10),
            };
        })();

        // Your existing logic for deals and suppliers
        const dealsPromise = (async () => { /* ... */ })();
        const suppliersPromise = (async () => { /* ... */ })();

        const [paginatedProducts, deals, suppliers] = await Promise.all([productPromise, dealsPromise, suppliersPromise]);

        res.json({
            searchTerm: searchTerm,
            results: { products: paginatedProducts, deals, suppliers }
        });

    } catch (err) {
        console.error(`Error during global search for term "${searchTerm}":`, err);
        res.status(500).json({ error: 'Failed to perform search' });
    }
});

// ... (rest of server.js, app.listen) ...
// telegram-app-backend/server.js
// ... (other require statements, middleware, existing routes) ...

// --- NEW: GET all active deals ---
// telegram-app-backend/server.js

// [CITY_FILTER] UPDATED GET all deals with city filtering
app.get('/api/deals', async (req, res) => {
    const cityId = parseInt(req.query.cityId, 10); // <-- [CITY_FILTER] Get cityId from query

    // [CITY_FILTER] cityId is now a mandatory parameter
    if (!cityId) {
        return res.status(400).json({ error: "A cityId query parameter is required." });
    }

    try {
        // [CITY_FILTER] The query is now more complex to handle both platform deals and city-specific supplier deals
        const query = `
            SELECT 
                d.id, d.title, d.description, d.discount_percentage, 
                d.start_date, d.end_date, d.product_id, d.supplier_id, d.image_url, 
                d.is_active, d.created_at,
                s.name AS supplier_name
            FROM deals d
            LEFT JOIN suppliers s ON d.supplier_id = s.id
            -- [CITY_FILTER] LEFT JOIN on supplier_cities to check location
            LEFT JOIN supplier_cities sc ON d.supplier_id = sc.supplier_id 
            WHERE 
                d.is_active = TRUE 
                AND (d.end_date IS NULL OR d.end_date >= CURRENT_DATE)
                AND (
                    -- Condition 1: The deal is a platform-wide deal (no supplier)
                    d.supplier_id IS NULL 
                    OR 
                    -- Condition 2: The deal has a supplier, AND that supplier is active AND serves the selected city
                    (d.supplier_id IS NOT NULL AND s.is_active = TRUE AND sc.city_id = $1)
                )
            -- We use GROUP BY to avoid duplicate deals if a supplier is in multiple cities (though our WHERE clause filters this)
            GROUP BY d.id, s.id 
            ORDER BY d.created_at DESC; 
        `;
        
        const result = await db.query(query, [cityId]); // [CITY_FILTER] Pass cityId as a parameter
        
        console.log(`[DEALS_LIST] Fetched ${result.rows.length} active deals for cityId ${cityId}.`);
        res.json(result.rows);
    } catch (err) {
        console.error("[DEALS_LIST] Error fetching deals:", err);
        res.status(500).json({ error: 'Failed to fetch deals' });
    }
});
// server.js
// ... (other require statements, middleware, existing /api/deals route) ...

// --- NEW: GET a single deal by ID ---
// e.g., /api/deals/123
app.get('/api/deals/:dealId', async (req, res) => {
    const { dealId } = req.params;

    if (isNaN(parseInt(dealId, 10))) {
        return res.status(400).json({ error: 'Invalid Deal ID format.' });
    }

    try {
        // Query to fetch the deal and potentially linked product/supplier names
        const query = `
            SELECT 
                d.id, 
                d.title, 
                d.description, 
                d.discount_percentage, 
                d.start_date, 
                d.end_date, 
                d.product_id, 
                p.name AS product_name, -- Name of the linked product
                p.image_url AS product_image_url, -- Image of the linked product
                p.price AS product_price,             -- <<< ADD THIS
    p.discount_price AS product_discount_price, -- <<< ADD THIS
    p.is_on_sale AS product_is_on_sale, -- <<< ADD THIS (or infer from deal)
                d.supplier_id,
                s.name AS supplier_name, -- Name of the linked supplier
                d.image_url, 
                d.is_active, 
                d.created_at
            FROM deals d
            LEFT JOIN products p ON d.product_id = p.id       -- Join to get linked product's name/image
            LEFT JOIN suppliers s ON d.supplier_id = s.id    -- Join to get linked supplier's name
            WHERE d.id = $1 AND d.is_active = TRUE;          -- Fetch only active deals, or remove d.is_active for all
        `;
        const result = await db.query(query, [dealId]);

        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: 'Deal not found or not active' });
        }
    } catch (err) {
        console.error(`Error fetching deal with ID ${dealId}:`, err);
        res.status(500).json({ error: 'Failed to fetch deal details' });
    }
});
// server.js
// ... (other require statements, middleware, existing /api/suppliers route) ...

// --- NEW: GET a single supplier by ID, including some of their products ---
// e.g., /api/suppliers/1
app.get('/api/suppliers/:supplierId', async (req, res) => {
    const { supplierId } = req.params;
    const PRODUCTS_LIMIT_IN_DETAIL = 6; // How many products to show in the supplier detail view

    if (isNaN(parseInt(supplierId, 10))) {
        return res.status(400).json({ error: 'Invalid Supplier ID format.' });
    }

    const client = await db.pool.connect(); // Use a client for multiple queries

    try {
        // --- Query 1: Get supplier details ---
        const supplierQuery = `
            SELECT 
                id, 
                name, 
                category, 
                location, 
                rating, 
                image_url, 
                description, -- Assuming you add a description column to suppliers table
                created_at
                -- Add phone, email, website if you add them to the suppliers table
            FROM suppliers 
            WHERE id = $1;
        `;
        const supplierResult = await client.query(supplierQuery, [supplierId]);

        if (supplierResult.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'Supplier not found' });
        }
        const supplierDetails = supplierResult.rows[0];

        // --- Query 2: Get some products for this supplier ---
        const productsQuery = `
            SELECT 
                id, 
                name, 
                price, 
                discount_price, 
                image_url, 
                is_on_sale,
                category AS product_category -- Alias to avoid conflict if supplier also has 'category'
            FROM products 
            WHERE supplier_id = $1
            ORDER BY created_at DESC -- Or by popularity, etc.
            LIMIT $2;
        `;
        const productsResult = await client.query(productsQuery, [supplierId, PRODUCTS_LIMIT_IN_DETAIL]);
        supplierDetails.products = productsResult.rows; // Add products array to supplierDetails

        // --- Query 3 (Optional): Get total count of products for this supplier to indicate if there are more ---
        const totalProductsCountQuery = 'SELECT COUNT(*) AS total_supplier_products FROM products WHERE supplier_id = $1;';
        const totalProductsCountResult = await client.query(totalProductsCountQuery, [supplierId]);
        const totalSupplierProducts = parseInt(totalProductsCountResult.rows[0].total_supplier_products, 10);
        
        supplierDetails.hasMoreProducts = totalSupplierProducts > PRODUCTS_LIMIT_IN_DETAIL;
        supplierDetails.totalProductsCount = totalSupplierProducts; // Also send total count

        res.json(supplierDetails);

    } catch (err) {
        console.error(`Error fetching supplier with ID ${supplierId}:`, err);
        res.status(500).json({ error: 'Failed to fetch supplier details' });
    } finally {
        if (client) {
            client.release(); // Release the client back to the pool
        }
    }
});

// ... (other routes, app.listen) ...
// ... (other routes, app.listen) ...ß
// ... (rest of server.js) ...
// GET all products (NOW WITH PAGINATION)
// telegram-app-backend/server.js

// [CITY_FILTER] UPDATED GET all products with city filtering
app.get('/api/products', async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const cityId = parseInt(req.query.cityId, 10); // <-- [CITY_FILTER] Get cityId from query
    
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, limit);
    const offset = (safePage - 1) * safeLimit;

    // [CITY_FILTER] cityId is now a mandatory parameter for this route
    if (!cityId) {
        return res.status(400).json({ error: "A cityId query parameter is required." });
    }

    try {
        const queryParams = [cityId]; // [CITY_FILTER] Start params with cityId
        let paramCount = 1;
        
        // [CITY_FILTER] The items query now JOINS supplier_cities
        let itemsQuery = `
            SELECT 
                p.id,
                p.name,
                p.description,
                p.price AS supplier_base_price,
                p.discount_price AS supplier_discount_price,
                p.category,
                p.image_url,
                p.is_on_sale AS supplier_is_on_sale,
                p.stock_level,
                p.created_at,
                p.supplier_id,
                s.name AS supplier_name,
                p.master_product_id,
                COALESCE(mp.current_price_adjustment_percentage, 0.0000) AS price_adjustment_percentage 
            FROM products p
            JOIN suppliers s ON p.supplier_id = s.id
            JOIN supplier_cities sc ON s.id = sc.supplier_id -- [CITY_FILTER] Join to filter by city
            LEFT JOIN master_products mp ON p.master_product_id = mp.id
        `;
        
        // [CITY_FILTER] The where clause now includes the city filter
        let whereClauses = ["s.is_active = TRUE", "sc.city_id = $1"];
        
        if (whereClauses.length > 0) {
            itemsQuery += ' WHERE ' + whereClauses.join(' AND ');
        }

        itemsQuery += ' ORDER BY p.created_at DESC';
        itemsQuery += ` LIMIT $${++paramCount} OFFSET $${++paramCount}`;
        queryParams.push(safeLimit, offset);

        const itemsResult = await db.query(itemsQuery, queryParams);
        
        const productsWithEffectivePrice = itemsResult.rows.map(p => {
            // Your existing price calculation logic is perfect and remains unchanged
            let basePriceForCalc = parseFloat(p.supplier_base_price);
            if (p.supplier_is_on_sale && p.supplier_discount_price !== null) {
                basePriceForCalc = parseFloat(p.supplier_discount_price);
            }
            const adjustment = parseFloat(p.price_adjustment_percentage);
            const effectivePrice = basePriceForCalc * (1 + adjustment);
            
            return {
                ...p,
                effective_selling_price: parseFloat(effectivePrice.toFixed(2))
            };
        });

        // [CITY_FILTER] The count query must also be updated to match the filtering logic
        let countQuery = `
            SELECT COUNT(DISTINCT p.id) AS total_items 
            FROM products p
            JOIN suppliers s ON p.supplier_id = s.id
            JOIN supplier_cities sc ON s.id = sc.supplier_id -- [CITY_FILTER] Join for count
        `;
        
        // [CITY_FILTER] The where clause for the count query
        let countWhereClauses = ["s.is_active = TRUE", "sc.city_id = $1"];
        
        if (countWhereClauses.length > 0) {
            countQuery += ' WHERE ' + countWhereClauses.join(' AND ');
        }
        
        // [CITY_FILTER] The count query now also needs the cityId parameter
        const countResult = await db.query(countQuery, [cityId]);
        const totalItems = parseInt(countResult.rows[0].total_items, 10);
        const totalPages = Math.ceil(totalItems / safeLimit);

        res.json({
            items: productsWithEffectivePrice,
            currentPage: safePage,
            totalPages: totalPages,
            totalItems: totalItems,
            limit: safeLimit
        });

    } catch (err) {
        console.error("Error fetching products with pagination:", err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});
// server.js
// ... (other require statements, middleware, existing /api/products route) ...
// server.js
// ... (other require statements, middleware, existing routes) ...

// --- NEW: GET multiple products by a list of IDs ---
// Expects a comma-separated string of product IDs in a query parameter
// e.g., /api/products/batch?ids=1,2,3,4
// telegram-app-backend/server.js

// telegram-app-backend/server.js

app.get('/api/products/batch', async (req, res) => {
    const idsString = req.query.ids;

    if (!idsString) {
        return res.status(400).json({ error: 'Product IDs are required.' });
    }

    const productIds = idsString.split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id) && id > 0);

    if (productIds.length === 0) {
        return res.status(400).json({ error: 'No valid Product IDs provided.' });
    }

    try {
        const query = `
            SELECT 
                p.id, 
                p.name, 
                p.description, 
                p.price AS supplier_base_price, 
                p.discount_price AS supplier_discount_price, 
                p.category, 
                p.image_url, 
                p.is_on_sale AS supplier_is_on_sale, 
                p.stock_level, 
                p.created_at,
                p.supplier_id,
                s.name AS supplier_name,
                p.master_product_id,
                COALESCE(mp.current_price_adjustment_percentage, 0.0000) AS price_adjustment_percentage,
                mp.display_name AS master_product_display_name,
                mp.image_url AS master_product_image_url 
            FROM products p
            LEFT JOIN suppliers s ON p.supplier_id = s.id
            LEFT JOIN master_products mp ON p.master_product_id = mp.id
            WHERE p.id = ANY($1::int[]) 
              AND s.is_active = TRUE; -- Only products from active suppliers
        `;
        const result = await db.query(query, [productIds]);

        const productsWithEffectivePrice = result.rows.map(p => {
            let basePriceForCalc = parseFloat(p.supplier_base_price);
            if (p.supplier_is_on_sale && p.supplier_discount_price !== null) {
                basePriceForCalc = parseFloat(p.supplier_discount_price);
            }
            const adjustment = parseFloat(p.price_adjustment_percentage);
            const effectivePrice = basePriceForCalc * (1 + adjustment);

            return {
                ...p,
                name: p.master_product_id && p.master_product_display_name ? p.master_product_display_name : p.name,
                image_url: p.master_product_id && p.master_product_image_url ? p.master_product_image_url : p.image_url,
                effective_selling_price: parseFloat(effectivePrice.toFixed(2)),
                // Optionally remove adjustment percentage from final response
                // price_adjustment_percentage: undefined 
            };
        });
        
        console.log(`[BATCH_PRODUCTS] Fetched ${productsWithEffectivePrice.length} products for IDs: ${productIds.join(',')}`);
        res.json(productsWithEffectivePrice);

    } catch (err) {
        console.error('[BATCH_PRODUCTS] Error fetching products by batch:', err);
        res.status(500).json({ error: 'Failed to fetch products by batch' });
    }
});

// ... (rest of server.js, app.listen) ...
// --- NEW: GET a single product by ID ---
// e.g., /api/products/123
// telegram-app-backend/server.js

app.get('/api/products/:productId', async (req, res) => {
    const { productId } = req.params;
    const parsedProductId = parseInt(productId, 10); // Parse once

    if (isNaN(parsedProductId)) {
        return res.status(400).json({ error: 'Invalid Product ID format.' });
    }

    try {
        const query = `
            SELECT 
                p.id, 
                p.name, 
                p.description, 
                p.price AS supplier_base_price, 
                p.discount_price AS supplier_discount_price, 
                p.category, 
                p.image_url, 
                p.is_on_sale AS supplier_is_on_sale, 
                p.stock_level, 
                p.created_at,
                p.supplier_id, 
                s.name AS supplier_name,
                s.location AS supplier_location,
                p.master_product_id,
                COALESCE(mp.current_price_adjustment_percentage, 0.0000) AS price_adjustment_percentage,
                mp.display_name AS master_product_display_name, -- Optional: get master display name
                mp.description AS master_product_description -- Optional: get master description
            FROM products p
            LEFT JOIN suppliers s ON p.supplier_id = s.id
            LEFT JOIN master_products mp ON p.master_product_id = mp.id
            WHERE p.id = $1 AND s.is_active = TRUE; -- Ensure supplier is active
        `;
        const result = await db.query(query, [parsedProductId]);

        if (result.rows.length > 0) {
            const product = result.rows[0];
            
            let basePriceForCalc = parseFloat(product.supplier_base_price);
            if (product.supplier_is_on_sale && product.supplier_discount_price !== null) {
                basePriceForCalc = parseFloat(product.supplier_discount_price);
            }
            const adjustment = parseFloat(product.price_adjustment_percentage);
            const effectivePrice = basePriceForCalc * (1 + adjustment);

            // Decide which name/description to show to the user: supplier's or master's?
            // For now, let's prioritize master if available and product is linked, else supplier's.
            const displayName = product.master_product_id && product.master_product_display_name 
                                ? product.master_product_display_name 
                                : product.name;
            const displayDescription = product.master_product_id && product.master_product_description
                                ? product.master_product_description
                                : product.description;

            const finalProductData = {
                ...product, // Spread original fields (includes supplier_base_price etc.)
                name: displayName, // Override name with display name
                description: displayDescription, // Override description
                effective_selling_price: parseFloat(effectivePrice.toFixed(2))
            };
            // delete finalProductData.price_adjustment_percentage;
            // delete finalProductData.master_product_display_name;
            // delete finalProductData.master_product_description;

            res.json(finalProductData);
        } else {
            res.status(404).json({ error: 'Product not found or its supplier is inactive.' });
        }
    } catch (err) {
        console.error(`Error fetching product with ID ${productId}:`, err);
        res.status(500).json({ error: 'Failed to fetch product details' });
    }
});

// ... (other routes, app.listen) ...

// --- NEW: GET all suppliers ---
// [CITY_FILTER] UPDATED GET all suppliers with city filtering
app.get('/api/suppliers', async (req, res) => {
    const cityId = parseInt(req.query.cityId, 10); // <-- [CITY_FILTER] Get cityId from query

    // [CITY_FILTER] cityId is now a mandatory parameter
    if (!cityId) {
        return res.status(400).json({ error: "A cityId query parameter is required." });
    }

    try {
        // [CITY_FILTER] The query now JOINS supplier_cities and filters by city_id
        const query = `
            SELECT 
                s.id, 
                s.name, 
                s.category, 
                s.rating, 
                s.image_url
                -- The old 'location' column is no longer needed here as we filter by city
            FROM suppliers s
            JOIN supplier_cities sc ON s.id = sc.supplier_id
            WHERE s.is_active = TRUE AND sc.city_id = $1 -- Filter by active suppliers and the selected city
            ORDER BY s.name ASC;
        `;
        
        const result = await db.query(query, [cityId]); // [CITY_FILTER] Pass cityId as a parameter

        res.json(result.rows);

    } catch (err) {
        console.error("Error fetching suppliers:", err);
        res.status(500).json({ error: 'Failed to fetch suppliers' });
    }
});

// server.js
// ... (other require statements, middleware, existing routes for products/suppliers) ...

// --- NEW: User Profile API Endpoints ---

// GET user profile
// Expects userId as a query parameter, e.g., /api/user/profile?userId=12345
// [CITY_FILTER] UPDATED GET user profile
app.get('/api/user/profile', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
  }

  try {
      // The query now joins with the cities table to get the name of the selected city
      const query = `
        SELECT 
            up.user_id, 
            up.full_name, 
            up.phone_number, 
            up.address_line1, 
            up.address_line2, 
            up.city AS address_city_text, -- The city for the shipping address
            up.selected_city_id,
            c.name as selected_city_name -- The name of the city the user chose for browsing
        FROM user_profiles up
        LEFT JOIN cities c ON up.selected_city_id = c.id
        WHERE up.user_id = $1;
      `;
      const result = await db.query(query, [userId]);

      if (result.rows.length > 0) {
          res.json(result.rows[0]); // Send the enhanced profile data
      } else {
          // It's crucial to return a specific structure so the frontend knows a profile doesn't exist
          res.status(404).json({ message: 'User profile not found' });
      }
  } catch (err) {
      console.error(`Error fetching profile for user ${userId}:`, err);
      res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// POST (Create or Update) user profile
// Expects profile data in request body: { userId, fullName, phoneNumber, addressLine1, addressLine2, city }
// [CITY_FILTER] UPDATED POST (Create or Update) user profile
// In server.js

// [CITY_FILTER] REVISED AND MORE ROBUST POST (Create or Update) user profile
// In server.js

// [CITY_FILTER] REVISED v3 POST (Create or Update) user profile
// In server.js

// [CITY_FILTER] REVISED v4 POST (Create or Update) user profile
app.post('/api/user/profile', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }
    
    console.log(`[PROFILE_SAVE] Received request for user ${userId} with body:`, req.body);

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const existingProfileResult = await client.query('SELECT user_id FROM user_profiles WHERE user_id = $1', [userId]);
        const profileExists = existingProfileResult.rows.length > 0;

        let query;
        let values;

        if (profileExists) {
            // --- UPDATE Logic ---
            const fieldsToUpdate = {};
            if (req.body.fullName !== undefined) fieldsToUpdate.full_name = req.body.fullName;
            if (req.body.phoneNumber !== undefined) fieldsToUpdate.phone_number = req.body.phoneNumber;
            if (req.body.addressLine1 !== undefined) fieldsToUpdate.address_line1 = req.body.addressLine1;
            if (req.body.addressLine2 !== undefined) fieldsToUpdate.address_line2 = req.body.addressLine2;
            if (req.body.city !== undefined) fieldsToUpdate.city = req.body.city;
            if (req.body.selected_city_id !== undefined) fieldsToUpdate.selected_city_id = req.body.selected_city_id;

            if (Object.keys(fieldsToUpdate).length === 0) {
                const currentProfile = await client.query('SELECT * FROM user_profiles WHERE user_id = $1', [userId]);
                await client.query('COMMIT');
                client.release();
                return res.status(200).json(currentProfile.rows[0]);
            }
            
            fieldsToUpdate.updated_at = new Date();
            const setClauses = Object.keys(fieldsToUpdate).map((key, index) => `${key} = $${index + 1}`).join(', ');
            values = [...Object.values(fieldsToUpdate), userId];
            query = `UPDATE user_profiles SET ${setClauses} WHERE user_id = $${values.length} RETURNING *;`;
            console.log(`[PROFILE_SAVE] Updating existing profile for user ${userId}.`);

        } else {
            // --- INSERT Logic (The Corrected Part) ---
            // When creating a new profile, especially from the city modal,
            // we must provide default values for any NOT NULL text columns.
            const {
                fullName = 'New User', // Provide a default name
                phoneNumber = '',     // Default to empty string
                addressLine1 = '',    // Default to empty string instead of NULL
                addressLine2 = null,    // This can be null if your DB allows it
                city = '',            // Default to empty string
                selected_city_id = null
            } = req.body;

            // Ensure that if a full form is submitted, the required fields are not empty
            // This logic is more for the final checkout save, but good to have here.
            if (req.body.addressLine1 !== undefined && !req.body.addressLine1) {
                 throw new Error("Address Line 1 cannot be empty when provided.");
            }
            if (req.body.city !== undefined && !req.body.city) {
                 throw new Error("City cannot be empty when provided.");
            }


            query = `
                INSERT INTO user_profiles (user_id, full_name, phone_number, address_line1, address_line2, city, selected_city_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *;
            `;
            // For the initial city selection, we use the defaults for address fields
            values = [
                userId, 
                req.body.fullName || fullName,
                req.body.phoneNumber || phoneNumber,
                req.body.addressLine1 || addressLine1,
                req.body.addressLine2 || addressLine2,
                req.body.city || city,
                req.body.selected_city_id || selected_city_id
            ];
            console.log(`[PROFILE_SAVE] Inserting new profile for user ${userId}.`);
        }
        
        console.log('[PROFILE_SAVE] Executing query:', query);
        console.log('[PROFILE_SAVE] With values:', values);

        const result = await client.query(query, values);
        const updatedProfile = result.rows[0];

        if (updatedProfile.selected_city_id) {
            const cityResult = await client.query('SELECT name FROM cities WHERE id = $1', [updatedProfile.selected_city_id]);
            updatedProfile.selected_city_name = cityResult.rows[0]?.name || null;
        } else {
            updatedProfile.selected_city_name = null;
        }

        await client.query('COMMIT');
        console.log(`[PROFILE_SAVE] Successfully saved profile for user ${userId}.`);
        res.status(200).json(updatedProfile);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[PROFILE_SAVE_ERROR] for user ${userId}:`, err);
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Invalid selected_city_id. This city does not exist.' });
        }
        res.status(500).json({ error: 'Failed to save user profile.' });
    } finally {
        if (client) client.release();
    }
});



// --- NEW: Orders API Endpoint ---

// POST Create a new order from user's cart
// Expects { userId } in request body
// telegram-app-backend/server.js

app.post('/api/orders', async (req, res) => {
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ error: 'User ID is required' });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        console.log(`[ORDER_CREATE_V2] Transaction BEGIN for user ${userId}`);

        // 1. Fetch cart items, including master_product_id and adjustment percentage
        const cartQuery = `
            SELECT
                ci.product_id,
                ci.quantity,
                p.price AS supplier_base_price,
                p.discount_price AS supplier_discount_price,
                p.is_on_sale AS supplier_is_on_sale,
                p.master_product_id,
                COALESCE(mp.current_price_adjustment_percentage, 0.0000) AS price_adjustment_percentage,
                s.is_active AS supplier_is_active -- Get supplier active status
            FROM cart_items ci
            JOIN products p ON ci.product_id = p.id
            JOIN suppliers s ON p.supplier_id = s.id -- Crucial JOIN for is_active check
            LEFT JOIN master_products mp ON p.master_product_id = mp.id
            WHERE ci.user_id = $1; 
            -- FOR UPDATE OF p, mp; -- Consider row-level locking if high concurrency on price changes
        `;
        const cartResult = await client.query(cartQuery, [userId]);
        
        // Filter out items from inactive suppliers *before* processing
        const validCartItems = cartResult.rows.filter(item => item.supplier_is_active);

        if (validCartItems.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            console.log(`[ORDER_CREATE_V2] No valid items in cart (all from inactive suppliers or cart empty) for user ${userId}.`);
            return res.status(400).json({ error: 'Cart is empty or contains only items from inactive suppliers.' });
        }

        // 2. Calculate total amount and prepare order items using effective selling price
        let totalOrderAmount = 0;
        const orderItemsData = validCartItems.map(item => {
            let basePriceForCalc = parseFloat(item.supplier_base_price);
            if (item.supplier_is_on_sale && item.supplier_discount_price !== null) {
                basePriceForCalc = parseFloat(item.supplier_discount_price);
            }
            const adjustment = parseFloat(item.price_adjustment_percentage);
            const priceAtTimeOfOrder = parseFloat((basePriceForCalc * (1 + adjustment)).toFixed(2));
            
            totalOrderAmount += priceAtTimeOfOrder * item.quantity;
            return {
                productId: item.product_id,
                quantity: item.quantity,
                price_at_time_of_order: priceAtTimeOfOrder // Store the final calculated price
            };
        });
        console.log(`[ORDER_CREATE_V2] Order for user ${userId}: Total=${totalOrderAmount.toFixed(2)}, Items=${orderItemsData.length}`);

        // 3. Insert into orders table
        const orderInsertQuery = `
            INSERT INTO orders (user_id, total_amount, status) VALUES ($1, $2, 'pending') RETURNING id;
        `;
        const orderInsertResult = await client.query(orderInsertQuery, [userId, totalOrderAmount.toFixed(2)]);
        const newOrderId = orderInsertResult.rows[0].id;

        // 4. Insert into order_items table
        const orderItemsInsertQuery = `
            INSERT INTO order_items (order_id, product_id, quantity, price_at_time_of_order, supplier_item_status)
            VALUES ${orderItemsData.map((_, index) => 
                `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5})`
            ).join(', ')};
        `;
        const orderItemsValues = orderItemsData.reduce((acc, item) => {
            acc.push(newOrderId, item.productId, item.quantity, item.price_at_time_of_order, 'pending'); // Default item status
            return acc;
        }, []);
        await client.query(orderItemsInsertQuery, orderItemsValues);

        // 5. Delete items from cart_items table
        const cartDeleteQuery = 'DELETE FROM cart_items WHERE user_id = $1';
        await client.query(cartDeleteQuery, [userId]);

        await client.query('COMMIT');
        console.log(`[ORDER_CREATE_V2] Transaction COMMIT for user ${userId}, OrderID=${newOrderId}`);
        res.status(201).json({ message: 'Order created successfully', orderId: newOrderId, totalAmount: totalOrderAmount.toFixed(2) });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error(`[ORDER_CREATE_V2] Transaction ROLLBACK for user ${userId} due to error:`, err);
        res.status(500).json({ error: 'Failed to create order' });
    } finally {
        if (client) client.release();
    }
});

// telegram-app-backend/server.js
// ... (other require statements, middleware, existing routes including POST /api/orders) ...

// telegram-app-backend/server.js
// Replace the existing GET /api/orders route with this:

app.get('/api/orders', async (req, res) => {
    const { userId } = req.query;

    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }

    try {
        // 1. Fetch all orders for the user
        const ordersQuery = `
            SELECT 
                id, 
                user_id, 
                total_amount, 
                status, 
                order_date
            FROM orders
            WHERE user_id = $1
            ORDER BY order_date DESC;
        `;
        const ordersResult = await db.query(ordersQuery, [userId]);
        const userOrders = ordersResult.rows;

        if (userOrders.length === 0) {
            return res.json([]); // Return empty array if no orders found
        }

        // 2. Get all order IDs from the fetched orders
        const orderIds = userOrders.map(order => order.id);

        // 3. Fetch all order items for these order IDs in a single query
        const orderItemsQuery = `
            SELECT 
                oi.order_id, -- Crucial for grouping
                oi.product_id, 
                oi.quantity, 
                oi.price_at_time_of_order,
                p.name AS product_name,
                p.image_url AS product_image_url
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = ANY($1::int[]); -- Use ANY to match multiple order IDs
        `;
        const allOrderItemsResult = await db.query(orderItemsQuery, [orderIds]);
        const allOrderItems = allOrderItemsResult.rows;

        // 4. Group order items by order_id (client-side)
        const itemsByOrderId = allOrderItems.reduce((acc, item) => {
            if (!acc[item.order_id]) {
                acc[item.order_id] = [];
            }
            acc[item.order_id].push({
                product_id: item.product_id,
                quantity: item.quantity,
                price_at_time_of_order: item.price_at_time_of_order,
                product_name: item.product_name,
                product_image_url: item.product_image_url
            });
            return acc;
        }, {});

        // 5. Combine orders with their grouped items
        const ordersWithItems = userOrders.map(order => ({
            ...order,
            items: itemsByOrderId[order.id] || [] // Ensure 'items' is always an array
        }));

        res.json(ordersWithItems);

    } catch (err) {
        console.error(`Error fetching orders for user ${userId}:`, err);
        res.status(500).json({ error: 'Failed to fetch order history' });
    }
});

// ... (rest of server.js, app.listen) ...
// --- Start the Server ---
// ... (app.listen code) ...

// server.js
// ... (other require statements, middleware, existing routes) ...

// --- NEW: Cart API Endpoints ---

// GET user's cart items
// Expects user_id as a query parameter, e.g., /api/cart?userId=12345
// telegram-app-backend/server.js

app.get('/api/cart', async (req, res) => {
    const userId = req.query.userId;

    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }

    try {
        const query = `
            SELECT
                ci.product_id,
                ci.quantity,
                p.name AS product_original_name, -- Supplier's name for the product
                p.price AS supplier_base_price,
                p.discount_price AS supplier_discount_price,
                p.image_url AS product_original_image_url, -- Supplier's image
                p.is_on_sale AS supplier_is_on_sale,
                p.supplier_id,
                s.is_active AS supplier_is_active,
                p.master_product_id,
                COALESCE(mp.current_price_adjustment_percentage, 0.0000) AS price_adjustment_percentage,
                mp.display_name AS master_product_display_name,
                mp.image_url AS master_product_image_url
            FROM cart_items ci
            JOIN products p ON ci.product_id = p.id
            JOIN suppliers s ON p.supplier_id = s.id -- Ensure supplier is joined
            LEFT JOIN master_products mp ON p.master_product_id = mp.id
            WHERE ci.user_id = $1 
              AND s.is_active = TRUE -- Only include items from active suppliers in cart calculation
            ORDER BY ci.added_at DESC;
        `;
        const result = await db.query(query, [userId]);

        const cartItemsWithEffectivePrice = result.rows
            .filter(item => item.supplier_is_active) // Ensure we only process items from active suppliers
            .map(item => {
                let basePriceForCalc = parseFloat(item.supplier_base_price);
                if (item.supplier_is_on_sale && item.supplier_discount_price !== null) {
                    basePriceForCalc = parseFloat(item.supplier_discount_price);
                }
                const adjustment = parseFloat(item.price_adjustment_percentage);
                const effectivePrice = basePriceForCalc * (1 + adjustment);

                return {
                    product_id: item.product_id,
                    quantity: item.quantity,
                    name: item.master_product_id && item.master_product_display_name ? item.master_product_display_name : item.product_original_name,
                    image_url: item.master_product_id && item.master_product_image_url ? item.master_product_image_url : item.product_original_image_url,
                    effective_selling_price: parseFloat(effectivePrice.toFixed(2)),
                    // Keep original prices if needed for display ("was $X, now $Y")
                    supplier_base_price: item.supplier_base_price, 
                    supplier_discount_price: item.supplier_discount_price,
                    supplier_is_on_sale: item.supplier_is_on_sale
                };
            });
        
        console.log(`[CART] Fetched ${cartItemsWithEffectivePrice.length} cart items for user ${userId} with effective prices.`);
        res.json(cartItemsWithEffectivePrice);

    } catch (err) {
        console.error(`[CART] Error fetching cart for user ${userId}:`, err);
        res.status(500).json({ error: 'Failed to fetch cart items' });
    }
});

app.get('/api/supplier/products', authSupplier, async (req, res) => { // <<< Use middleware
    const supplierId = req.supplier.supplierId; // Get supplierId from decoded JWT

    try {
        // TODO: Add pagination later if needed
        const query = 'SELECT * FROM products WHERE supplier_id = $1 ORDER BY created_at DESC';
        const result = await db.query(query, [supplierId]);
        res.json(result.rows);
    } catch (err) {
        console.error(`Error fetching products for supplier ${supplierId}:`, err);
        res.status(500).json({ error: 'Failed to fetch supplier products' });
    }
});

// POST - Add or update item in cart
// Expects { userId, productId, quantity } in request body
app.post('/api/cart', async (req, res) => {
  const { userId, productId, quantity } = req.body;

  // Basic validation
  if (!userId || !productId || quantity === undefined || quantity <= 0) {
      return res.status(400).json({ error: 'Missing or invalid userId, productId, or quantity' });
  }

  try {
      // Use INSERT ... ON CONFLICT to add or update quantity
      const query = `
          INSERT INTO cart_items (user_id, product_id, quantity)
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id, product_id)
          DO UPDATE SET quantity = cart_items.quantity + $3, added_at = NOW()
          RETURNING *; -- Return the added/updated row
      `;
      // Note: We're adding the passed quantity. If you always add 1, use '1' instead of '$3' for the increment.
      // For simplicity here, frontend will send quantity=1 for adding.
      const result = await db.query(query, [userId, productId, quantity]);

      res.status(201).json(result.rows[0]); // Send back the created/updated cart item

  } catch (err) {
      console.error(`Error adding/updating cart for user ${userId}:`, err);
      // TODO: Add more specific error handling (e.g., product not found if FK constraint fails)
      res.status(500).json({ error: 'Failed to update cart' });
  }
});

// DELETE - Remove item from cart
// Expects user_id as query param, productId in URL path e.g., /api/cart/item/101?userId=12345
app.delete('/api/cart/item/:productId', async (req, res) => {
  const userId = req.query.userId;
  const { productId } = req.params;

  if (!userId || !productId) {
      return res.status(400).json({ error: 'Missing userId or productId' });
  }

  try {
      const query = 'DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2 RETURNING *;';
      const result = await db.query(query, [userId, productId]);

      if (result.rowCount > 0) {
          res.status(200).json({ message: 'Item removed successfully', item: result.rows[0] });
      } else {
          res.status(404).json({ error: 'Item not found in cart for this user' });
      }
  } catch (err) {
       console.error(`Error deleting cart item for user ${userId}:`, err);
       res.status(500).json({ error: 'Failed to remove item from cart' });
  }
});

// --- SUPPLIER AUTHENTICATION ---
// Ensure bcrypt is required at the top: const bcrypt = require('bcrypt');
// Ensure jwt is required: const jwt = require('jsonwebtoken');
// Ensure db is available

app.post('/api/auth/supplier/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        // Fetch is_active along with other details
        const supplierResult = await db.query(
            'SELECT id, name, email, password_hash, is_active FROM suppliers WHERE email = $1', 
            [email.toLowerCase().trim()] // Added trim()
        );

        if (supplierResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const supplier = supplierResult.rows[0];

        // --- NEW: Check if supplier is active ---
        if (supplier.is_active === false) { // Explicitly check for false
            console.log(`Supplier login attempt failed for inactive account: ${email}`);
            return res.status(403).json({ error: 'Your account is currently suspended. Please contact support.' });
        }
        // --- END NEW ---

        const match = await bcrypt.compare(password, supplier.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        const tokenPayload = {
            supplierId: supplier.id,
            name: supplier.name,
            email: supplier.email,
        };
        const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '1d' });

        res.json({ 
            message: 'Login successful', 
            token,
            supplier: {
                id: supplier.id,
                name: supplier.name,
                email: supplier.email
                // Do NOT send is_active or password_hash to client here
            }
        });

    } catch (err) {
        console.error('Supplier login error:', err);
        res.status(500).json({ error: 'Internal server error during login.' });
    }
});

// TODO LATER: Add PUT endpoint to specifically SET quantity (useful for +/- buttons)
// PUT /api/cart/item/{productId} { userId, newQuantity } -> UPDATE cart_items SET quantity = newQuantity ...
// server.js
// ... (other require statements, middleware, existing cart routes GET, POST, DELETE) ...
// server.js
// ... (authSupplier middleware, GET /api/supplier/products route) ...

// POST - Create a new product for the authenticated supplier
// telegram-app-backend/server.js

// telegram-app-backend/server.js
// Ensure normalizeTextForMatching function is defined at the top of your file

// telegram-app-backend/server.js
// Ensure normalizeTextForMatching function is defined at the top of your file
// Ensure authSupplier middleware is imported

// Ensure normalizeTextForMatching function is defined above this or imported
// const normalizeTextForMatching = (inputText) => { /* ... */ };

app.post('/api/supplier/products', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;
    const { 
        name, 
        standardized_name_input, 
        description, 
        price, 
        discount_price,
        category, 
        image_url,
        is_on_sale,
        stock_level // This is the correct variable from req.body
    } = req.body;

    // --- Validation ---
    if (!name || name.trim() === '') return res.status(400).json({ error: 'Display name is required.' });
    if (!standardized_name_input || standardized_name_input.trim() === '') return res.status(400).json({ error: 'Standardized product name is required.' });
    
    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) return res.status(400).json({ error: 'Valid price is required and must be non-negative.' });
    
    if (!category || category.trim() === '') return res.status(400).json({ error: 'Category is required.' });

    const parsedDiscountPrice = discount_price ? parseFloat(discount_price) : null;
    if (parsedDiscountPrice !== null && (isNaN(parsedDiscountPrice) || parsedDiscountPrice < 0)) {
        return res.status(400).json({ error: 'Invalid discount price. Must be non-negative if provided.' });
    }
    if (parsedDiscountPrice !== null && parsedDiscountPrice >= parsedPrice) {
        return res.status(400).json({ error: 'Discount price must be less than the original price.' });
    }

    const parsedStockLevel = stock_level !== undefined && stock_level !== null ? parseInt(stock_level, 10) : 0;
    if (isNaN(parsedStockLevel) || parsedStockLevel < 0) {
        return res.status(400).json({ error: 'Invalid stock level. Must be a non-negative integer.' });
    }
    // --- End Validation ---

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const normalizedSupplierStandardName = normalizeTextForMatching(standardized_name_input);
        let masterProductIdToLink = null; // Initialize
        let linkingStatus = 'needs_admin_review'; // Default if no standardized name or no match
        const similarityThreshold = 0.7; // Tune this threshold (0.0 to 1.0)

        if (normalizedSupplierStandardName) {
            const matchMasterQuery = `
                SELECT id, similarity(standardized_name_normalized, $1) AS sim
                FROM master_products
                WHERE similarity(standardized_name_normalized, $1) >= $2 
                   OR standardized_name_normalized = $1 -- Also check for exact match after normalization
                ORDER BY sim DESC, 
                         CASE WHEN standardized_name_normalized = $1 THEN 0 ELSE 1 END -- Prioritize exact match
                LIMIT 1; 
            `;
            const masterMatchResult = await client.query(matchMasterQuery, [normalizedSupplierStandardName, similarityThreshold]);

            if (masterMatchResult.rows.length > 0) { // A match >= threshold OR an exact normalized match was found
                masterProductIdToLink = masterMatchResult.rows[0].id;
                linkingStatus = 'automatically_linked';
                console.log(`[PRODUCT_GROUPING] Auto-linking product "${name}" to existing master_product_id: ${masterProductIdToLink} for input: "${standardized_name_input}" with similarity ${masterMatchResult.rows[0].sim}`);
            } else {
                // No strong match, create a new master product
                console.log(`[PRODUCT_GROUPING] No strong master match for "${standardized_name_input}". Creating new master product.`);
                const createMasterQuery = `
                    INSERT INTO master_products (
                        standardized_name_normalized, 
                        display_name, 
                        description, 
                        image_url, 
                        brand,
                        category,
                        initial_seed_price -- Storing initial supplier price as base_platform_price
                        -- current_price_adjustment_percentage will use its DB DEFAULT (0.0)
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (standardized_name_normalized) DO NOTHING -- Avoid race condition if another process just created it
                    RETURNING id;
                `;
                // For brand, you might want a separate input or parse from description later
                const masterValues = [
                    normalizedSupplierStandardName,
                    name.trim(), // Use supplier's display name as initial master display name
                    description || null,
                    image_url || null,
                    null, // Placeholder for brand
                    category.trim(),
                    parsedPrice // Use the supplier's validated price as the initial base_platform_price
                ];
                let newMasterResult = await client.query(createMasterQuery, masterValues);

                if (newMasterResult.rows.length === 0) {
                    // This means ON CONFLICT DO NOTHING happened. The master product was likely just created by a concurrent request.
                    // Try to fetch it again.
                    console.log(`[PRODUCT_GROUPING] Master product with normalized name "${normalizedSupplierStandardName}" likely created concurrently. Fetching it.`);
                    newMasterResult = await client.query('SELECT id FROM master_products WHERE standardized_name_normalized = $1', [normalizedSupplierStandardName]);
                    if (newMasterResult.rows.length === 0) {
                         // This should be very rare if the ON CONFLICT logic is sound.
                        throw new Error('Failed to create or retrieve master product after ON CONFLICT.');
                    }
                }
                masterProductIdToLink = newMasterResult.rows[0].id;
                linkingStatus = 'auto_master_created'; // Or 'automatically_linked' if we consider it immediately linked
                console.log(`[PRODUCT_GROUPING] New/Existing master_product_id set: ${masterProductIdToLink}, base_platform_price set to ${parsedPrice}`);
            }
        } else { // No standardized_name_input provided by supplier
            linkingStatus = 'needs_admin_review'; // Requires admin to provide standardized name and link
            masterProductIdToLink = null;
            console.log(`[PRODUCT_GROUPING] No standardized_name_input provided by supplier. Status: 'needs_admin_review'`);
        }

        const insertProductQuery = `
            INSERT INTO products (
                supplier_id, name, standardized_name_input, description, price, 
                discount_price, category, image_url, is_on_sale, stock_level,
                master_product_id, linking_status, created_at, updated_at 
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
            RETURNING *;
        `;
        const productValues = [
            supplierId, name.trim(), standardized_name_input.trim(), // Store trimmed original standardized input
            description || null,
            parsedPrice, // Use the already parsed price
            parsedDiscountPrice, // Use the already parsed (or null) discount price
            category.trim(), image_url || null,
            is_on_sale === undefined ? false : Boolean(is_on_sale),
            parsedStockLevel, // Use the corrected and parsed stock_level
            masterProductIdToLink,
            linkingStatus
        ];

        const productResult = await client.query(insertProductQuery, productValues);
        await client.query('COMMIT');
        
        console.log(`[SUPPLIER_PRODUCT_ADD] Product ${productResult.rows[0].id} created by supplier ${supplierId}. Linked to master: ${masterProductIdToLink}, Status: ${linkingStatus}`);
        res.status(201).json(productResult.rows[0]);

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error(`[SUPPLIER_PRODUCT_ADD] Error creating product for supplier ${supplierId}:`, err);
        // Check for unique constraint violation on master_products standardized_name_normalized
        if (err.code === '23505' && err.constraint === 'master_products_standardized_name_normalized_key') {
             console.error("[PRODUCT_GROUPING] Unique constraint violation on master_products.standardized_name_normalized during insert. This shouldn't happen if ON CONFLICT is used correctly or if logic to fetch existing is sound.");
             return res.status(409).json({ error: 'A master product with this standardized name likely already exists or there was a conflict. Please try again or contact admin.' });
        }
        res.status(500).json({ error: 'Failed to create product.' });
    } finally {
        if (client) client.release();
    }
});
// server.js
// ... (authSupplier middleware, GET and POST /api/supplier/products routes) ...

// PUT - Update an existing product for the authenticated supplier
// server.js
// Ensure authSupplier middleware is imported: const authSupplier = require('./middleware/authSupplier');
// Ensure db object is available: const db = require('./config/db');

// PUT - Update an existing product for the authenticated supplier
// telegram-app-backend/server.js

// telegram-app-backend/server.js

app.put('/api/supplier/products/:productId', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;
    const { productId } = req.params;
    const {
        name, standardized_name_input, description, price, discount_price,
        category, image_url, is_on_sale, stock_level
    } = req.body;

    const parsedProductId = parseInt(productId, 10);
    // --- Validation (Keep your existing validations) ---
    // ... ensure all required fields are present, especially name and standardized_name_input ...
    if (isNaN(parsedProductId)) return res.status(400).json({ error: 'Invalid Product ID.' });
    if (!name || !standardized_name_input /* ... other checks ... */) {
        return res.status(400).json({ error: 'Required fields are missing or invalid.' });
    }


    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verify ownership and get current product data
        const productCheckResult = await client.query(
            'SELECT supplier_id, master_product_id, linking_status, standardized_name_input AS old_standardized_name FROM products WHERE id = $1',
            [parsedProductId]
        );
        if (productCheckResult.rows.length === 0) {
            await client.query('ROLLBACK'); client.release();
            return res.status(404).json({ error: 'Product not found.' });
        }
        const currentProduct = productCheckResult.rows[0];
        if (currentProduct.supplier_id !== supplierId) {
            await client.query('ROLLBACK'); client.release();
            return res.status(403).json({ error: 'Forbidden: You do not own this product.' });
        }

        let masterProductIdToSet = currentProduct.master_product_id;
        let linkingStatusToSet = currentProduct.linking_status;
        const normalizedNewStandardName = normalizeTextForMatching(standardized_name_input);
        const normalizedOldStandardName = normalizeTextForMatching(currentProduct.old_standardized_name);

        // 2. Re-evaluate master product link if standardized_name_input has changed significantly
        if (normalizedNewStandardName && normalizedNewStandardName !== normalizedOldStandardName) {
            console.log(`[PRODUCT_GROUPING_UPDATE] Standardized name changed for product ${parsedProductId}. Re-evaluating master link.`);
            const similarityThreshold = 0.7;
            const matchMasterQuery = `
                SELECT id, similarity(standardized_name_normalized, $1) AS sim
                FROM master_products
                WHERE similarity(standardized_name_normalized, $1) >= $2
                ORDER BY sim DESC LIMIT 1;
            `;
            const masterMatchResult = await client.query(matchMasterQuery, [normalizedNewStandardName, similarityThreshold]);

            if (masterMatchResult.rows.length > 0) {
                masterProductIdToSet = masterMatchResult.rows[0].id;
                linkingStatusToSet = 'automatically_linked'; // Or 'relinked_by_supplier_edit'
            } else {
                // If no match, create a new master product
                console.log(`[PRODUCT_GROUPING_UPDATE] No strong master match for new name "${normalizedNewStandardName}". Creating new master.`);
                const createMasterQuery = `
                    INSERT INTO master_products (standardized_name_normalized, display_name, description, image_url, brand, category, base_platform_price) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id;
                `;
                const masterValues = [normalizedNewStandardName, name.trim(), description || null, image_url || null, null, category.trim(), parseFloat(price)];
                const newMasterResult = await client.query(createMasterQuery, masterValues);
                masterProductIdToSet = newMasterResult.rows[0].id;
                linkingStatusToSet = 'auto_master_created'; // From edit
            }
        } else if (!normalizedNewStandardName) { // Supplier cleared the standardized name
             masterProductIdToSet = null;
             linkingStatusToSet = 'needs_admin_review';
        }


        // 3. Update the supplier's product
        const updateProductQuery = `
            UPDATE products SET 
                name = $1, standardized_name_input = $2, description = $3, price = $4, 
                discount_price = $5, category = $6, image_url = $7, is_on_sale = $8, 
                stock_level = $9, master_product_id = $10, linking_status = $11 
                -- updated_at will be handled by trigger
            WHERE id = $12 AND supplier_id = $13
            RETURNING *; 
        `;
        const productValues = [
            name.trim(), standardized_name_input, description || null, parseFloat(price),
            discount_price ? parseFloat(discount_price) : null, category.trim(), image_url || null,
            is_on_sale === undefined ? false : Boolean(is_on_sale),
            stock_level ? parseInt(stock_level, 10) : 0,
            masterProductIdToSet, linkingStatusToSet,
            parsedProductId, supplierId
        ];

        const updatedProductResult = await client.query(updateProductQuery, productValues);
        await client.query('COMMIT');
        
        console.log(`[SUPPLIER_PRODUCT_UPDATE] Product ${parsedProductId} updated by supplier ${supplierId}. Linked to master: ${masterProductIdToSet}, Status: ${linkingStatusToSet}`);
        res.status(200).json(updatedProductResult.rows[0]);

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error(`[SUPPLIER_PRODUCT_UPDATE] Error updating product ${parsedProductId} for supplier ${supplierId}:`, err);
        // Handle specific errors like unique constraint on master_products if necessary
        if (err.constraint === 'master_products_standardized_name_normalized_key' && err.code === '23505') {
             console.error("[PRODUCT_GROUPING_UPDATE] Unique constraint violation on master_products.standardized_name_normalized during update.");
             return res.status(409).json({ error: 'A master product with this standardized name already exists. Admin review may be needed.' });
        }
        res.status(500).json({ error: 'Failed to update product.' });
    } finally {
        if (client) client.release();
    }
});

// ... (DELETE for products will go here later) ...
app.delete('/api/supplier/products/:productId', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId; // From JWT
    const { productId } = req.params;

    const parsedProductId = parseInt(productId, 10);
    if (isNaN(parsedProductId)) {
        return res.status(400).json({ error: 'Invalid Product ID format.' });
    }

    try {
        // 1. Verify the product exists and belongs to the supplier before deleting
        const checkOwnerQuery = 'SELECT supplier_id FROM products WHERE id = $1';
        const ownerResult = await db.query(checkOwnerQuery, [parsedProductId]);

        if (ownerResult.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found.' });
        }
        if (ownerResult.rows[0].supplier_id !== supplierId) {
            return res.status(403).json({ error: 'Forbidden: You do not own this product to delete it.' });
        }

        // 2. If ownership confirmed, delete the product
        const deleteQuery = 'DELETE FROM products WHERE id = $1 AND supplier_id = $2 RETURNING id;'; // RETURNING id to confirm deletion
        const result = await db.query(deleteQuery, [parsedProductId, supplierId]);

        if (result.rowCount === 0) {
            // Should not happen if previous checks passed, but good for robustness
            console.error(`[SUPPLIER_PRODUCT_DELETE] Failed to delete product ${parsedProductId} even after ownership check.`);
            return res.status(404).json({ error: 'Product not found or delete failed unexpectedly.' });
        }

        console.log(`[SUPPLIER_PRODUCT_DELETE] Product ID ${parsedProductId} deleted successfully by supplier ID ${supplierId}.`);
        res.status(200).json({ message: 'Product deleted successfully.', deletedProductId: parsedProductId });
        // Alternatively, res.sendStatus(204) for No Content on successful delete.

    } catch (err) {
        console.error(`[SUPPLIER_PRODUCT_DELETE] Error deleting product ${parsedProductId} for supplier ${supplierId}:`, err);
        // Check for foreign key constraint errors if products are linked elsewhere (e.g., order_items)
        // and ON DELETE behavior isn't SET NULL or CASCADE
        if (err.code === '23503') { // Foreign key violation
            return res.status(409).json({ error: 'Cannot delete product. It is referenced in existing orders or other records. Please resolve dependencies first.' });
        }
        res.status(500).json({ error: 'Failed to delete product due to a server error.' });
    }
}); 
// ... (app.listen) ...
// ... (PUT and DELETE for products will go here later) ...
// ... (app.listen) ...
// --- NEW: PUT - Update quantity of a specific item in cart ---
// Expects userId in query, productId in URL path, { newQuantity } in request body
// e.g., PUT /api/cart/item/101?userId=12345  Body: { "newQuantity": 3 }
app.put('/api/cart/item/:productId', async (req, res) => {
    const userId = req.query.userId;
    const { productId } = req.params;
    const { newQuantity } = req.body;

    if (!userId || !productId || newQuantity === undefined) {
        return res.status(400).json({ error: 'Missing userId, productId, or newQuantity' });
    }

    const quantity = parseInt(newQuantity, 10);
    if (isNaN(quantity) || quantity < 0) { // Allow 0 for potential removal, though DELETE is cleaner for that
        return res.status(400).json({ error: 'Invalid newQuantity' });
    }

    // If quantity is 0, we can treat it as a delete or let the client call DELETE explicitly.
    // For simplicity, we'll let client call DELETE if they mean to remove.
    // If you want this PUT to handle removal with quantity 0, add that logic here.
    if (quantity === 0) {
         // Option 1: Error out and tell client to use DELETE
         return res.status(400).json({ error: 'Use DELETE endpoint to remove items (quantity cannot be 0 via PUT)'});
         // Option 2: Perform a delete (less RESTful for a PUT, but possible)
         // const deleteQuery = 'DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2 RETURNING *;';
         // ... handle delete ...
    }


    try {
        const query = `
            UPDATE cart_items
            SET quantity = $3, added_at = NOW()
            WHERE user_id = $1 AND product_id = $2
            RETURNING *;
        `;
        const result = await db.query(query, [userId, productId, quantity]);

        if (result.rowCount > 0) {
            res.status(200).json(result.rows[0]); // Send back the updated cart item
        } else {
            res.status(404).json({ error: 'Item not found in cart for this user to update' });
        }
    } catch (err) {
        console.error(`Error updating cart item quantity for user ${userId}:`, err);
        res.status(500).json({ error: 'Failed to update cart item quantity' });
    }
});

// --- NEW: Favorites API Endpoints ---

// GET user's favorite product IDs
// Expects userId as a query parameter, e.g., /api/favorites?userId=12345
app.get('/api/favorites', async (req, res) => {
    const { userId } = req.query;

    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }

    try {
        // Select only the product_id for efficiency if that's all the frontend needs initially
        const query = 'SELECT product_id FROM user_favorites WHERE user_id = $1 ORDER BY added_at DESC';
        const result = await db.query(query, [userId]);
        // Send an array of product_id values
        res.json(result.rows.map(row => row.product_id));
    } catch (err) {
        console.error(`Error fetching favorites for user ${userId}:`, err);
        res.status(500).json({ error: 'Failed to fetch favorites' });
    }
});

// POST - Add a product to user's favorites
// Expects { userId, productId } in request body
app.post('/api/favorites', async (req, res) => {
    const { userId, productId } = req.body;

    if (!userId || !productId) {
        return res.status(400).json({ error: 'User ID and Product ID are required' });
    }

    try {
        // Attempt to insert. If it violates PRIMARY KEY (user_id, product_id), it means it's already a favorite.
        const query = 'INSERT INTO user_favorites (user_id, product_id) VALUES ($1, $2) RETURNING *';
        const result = await db.query(query, [userId, productId]);
        res.status(201).json({ message: 'Product added to favorites', favorite: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') { // Unique violation error code in PostgreSQL
            return res.status(409).json({ error: 'Product already in favorites' }); // 409 Conflict
        }
        console.error(`Error adding favorite for user ${userId}, product ${productId}:`, err);
        res.status(500).json({ error: 'Failed to add favorite' });
    }
});

// DELETE - Remove a product from user's favorites
// Expects userId in query, productId in URL path e.g., /api/favorites/101?userId=12345
// OR { userId, productId } in request body (choose one style and stick to it)
// Let's use query params for consistency with GET, and productId in path for RESTfulness.
app.delete('/api/favorites/:productId', async (req, res) => {
    const { userId } = req.query;
    const { productId } = req.params;

    if (!userId || !productId) {
        return res.status(400).json({ error: 'User ID and Product ID are required' });
    }

    try {
        const query = 'DELETE FROM user_favorites WHERE user_id = $1 AND product_id = $2 RETURNING *';
        const result = await db.query(query, [userId, productId]);

        if (result.rowCount > 0) {
            res.status(200).json({ message: 'Product removed from favorites', removed: result.rows[0] });
        } else {
            // Not an error if trying to delete something not favorited, just wasn't there.
            res.status(404).json({ message: 'Favorite not found to remove' });
        }
    } catch (err) {
        console.error(`Error removing favorite for user ${userId}, product ${productId}:`, err);
        res.status(500).json({ error: 'Failed to remove favorite' });
    }
});
// server.js
// ... (other routes) ...

// --- NEW: GET Featured Items (from dedicated featured_items table) ---
// server.js
// ... (other require statements, middleware, existing routes) ...

// --- GET Featured Items (from dedicated featured_items table) ---
// server.js
// ... (other require statements, middleware, existing routes) ...

// telegram-app-backend/server.js

// [CITY_FILTER] UPDATED GET featured items with city filtering
app.get('/api/featured-items', async (req, res) => {
    const SLIDER_ITEM_LIMIT = 5;
    console.log(`[FEATURED_API_V3] Fetching up to ${SLIDER_ITEM_LIMIT} featured items.`);

    try {
        // Step 1: Get active feature definitions, already filtering by supplier status where possible
        // This query is now more complex to pre-filter based on supplier activity.
        const featuredDefinitionsQuery = `
            SELECT 
                fi.id AS feature_definition_id,
                fi.item_type, 
                fi.item_id, 
                fi.custom_title, 
                fi.custom_description, 
                fi.custom_image_url
            FROM featured_items fi
            LEFT JOIN products p_check ON fi.item_type = 'product' AND fi.item_id = p_check.id
            LEFT JOIN suppliers s_prod_check ON p_check.supplier_id = s_prod_check.id
            LEFT JOIN suppliers s_supp_check ON fi.item_type = 'supplier' AND fi.item_id = s_supp_check.id
            LEFT JOIN deals d_check ON fi.item_type = 'deal' AND fi.item_id = d_check.id
            LEFT JOIN suppliers s_deal_check ON d_check.supplier_id = s_deal_check.id
            WHERE fi.is_active = TRUE
              AND (fi.active_from IS NULL OR fi.active_from <= NOW())
              AND (fi.active_until IS NULL OR fi.active_until >= NOW())
              AND (
                    (fi.item_type = 'product' AND s_prod_check.is_active = TRUE) OR
                    (fi.item_type = 'supplier' AND s_supp_check.is_active = TRUE) OR
                    (fi.item_type = 'deal' AND (d_check.supplier_id IS NULL OR s_deal_check.is_active = TRUE)) OR
                    (fi.item_type NOT IN ('product', 'supplier', 'deal')) -- For any other types not supplier-dependent
                  )
            ORDER BY fi.display_order ASC, fi.created_at DESC
            LIMIT $1;
        `;
        const featuredDefsResult = await db.query(featuredDefinitionsQuery, [SLIDER_ITEM_LIMIT]);
        const featureDefinitions = featuredDefsResult.rows;

        console.log(`[FEATURED_API_V3] Found ${featureDefinitions.length} active feature definitions after initial supplier status filter.`);

        if (featureDefinitions.length === 0) {
            return res.json([]);
        }

        // Step 2: Hydration (same as before, but the input list is already pre-filtered)
        const hydrationPromises = featureDefinitions.map(async (definition) => {
            // ... (keep your existing hydration logic from the last version of this endpoint)
            // It will fetch details for product, deal, or supplier based on item_type
            // The items it tries to hydrate are already confirmed to be from active suppliers (or platform deals/items)
            // if they were product, supplier, or supplier-linked deal types.
            let title = definition.custom_title;
            let description = definition.custom_description;
            let imageUrl = definition.custom_image_url;
            let originalItemData = {}; 
            const needsHydration = !title || !description || !imageUrl;

            if (needsHydration) {
                try {
                    let originalItemResult;
                    if (definition.item_type === 'product') {
                        // Fetch supplier's base price, discount, sale status, and master adjustment
                const productDetailQuery = `
                    SELECT 
                        p.name, p.description, p.image_url, 
                        p.price AS supplier_base_price, 
                        p.discount_price AS supplier_discount_price, 
                        p.is_on_sale AS supplier_is_on_sale,
                        COALESCE(mp.current_price_adjustment_percentage, 0.0000) AS price_adjustment_percentage,
                        mp.display_name AS master_product_display_name,
                        mp.image_url AS master_product_image_url
                    FROM products p
                    LEFT JOIN master_products mp ON p.master_product_id = mp.id
                    WHERE p.id = $1; 
                `;
                // Note: The initial featuredDefinitionsQuery already ensures p.supplier_id links to an active supplier.
                       originalItemResult = await db.query(productDetailQuery, [definition.item_id]);

                if (originalItemResult.rows.length > 0) { 
                    const p_orig = originalItemResult.rows[0];
                    title = title || (p_orig.master_product_display_name || p_orig.name);
                    description = description || p_orig.description; // Or master_product_description
                    imageUrl = imageUrl || (p_orig.master_product_image_url || p_orig.image_url);
                     let basePriceForCalc = parseFloat(p_orig.supplier_base_price);
                    if (p_orig.supplier_is_on_sale && p_orig.supplier_discount_price !== null) {
                        basePriceForCalc = parseFloat(p_orig.supplier_discount_price);
                    }
                    const adjustment = parseFloat(p_orig.price_adjustment_percentage);
                    const effectivePrice = basePriceForCalc * (1 + adjustment);

                    originalItemData = { 
                        effective_selling_price: parseFloat(effectivePrice.toFixed(2)),
                        // You might want to include original_price if different for display ("Was X, Now Y")
                        // original_price: parseFloat(p_orig.supplier_base_price).toFixed(2), 
                        is_on_sale: p_orig.supplier_is_on_sale // Or a more complex logic if effective price < supplier base
                    };
                     }
                    } else if (definition.item_type === 'deal') {
                        originalItemResult = await db.query('SELECT title, description, image_url, discount_percentage, end_date FROM deals WHERE id = $1', [definition.item_id]);
                        if (originalItemResult.rows.length > 0) { const d = originalItemResult.rows[0]; title = title || d.title; description = description || d.description; imageUrl = imageUrl || d.image_url; originalItemData = { discount_percentage: d.discount_percentage, end_date: d.end_date };}
                    } else if (definition.item_type === 'supplier') {
                        originalItemResult = await db.query('SELECT name, category, image_url, rating, location FROM suppliers WHERE id = $1', [definition.item_id]);
                        if (originalItemResult.rows.length > 0) { const s = originalItemResult.rows[0]; title = title || s.name; description = description || s.category; imageUrl = imageUrl || s.image_url; originalItemData = { rating: s.rating, location: s.location };}
                    }
                } catch (hydrationError) {
                    console.error(`[FEATURED_API_V3] Hydration error for item_id ${definition.item_id} (type ${definition.item_type}):`, hydrationError.message);
                    return { ...definition, title: definition.custom_title || 'Error Loading', hydrationError: true };
                }
            }
            
            if (!title) {
                console.warn(`[FEATURED_API_V3] Item type=${definition.item_type}, id=${definition.item_id} has no title. Skipping.`);
                return null; 
            }
            return {
                feature_definition_id: definition.feature_definition_id, type: definition.item_type, id: definition.item_id,
                title, description, imageUrl, ...originalItemData
            };
        });

        const hydratedItems = await Promise.all(hydrationPromises);
        const finalValidItems = hydratedItems.filter(item => item !== null && !item.hydrationError);

        console.log(`[FEATURED_API_V3] Sending ${finalValidItems.length} items to client.`);
        console.log("[FEATURED_API_V3] Data being sent:", JSON.stringify(finalValidItems, null, 2));
        res.json(finalValidItems);

    } catch (err) {
        console.error("[FEATURED_API_V3] General error in /api/featured-items:", err);
        res.status(500).json({ error: 'Failed to fetch featured items' });
    }
});


// ... (app.listen) ...
// server.js
// ... (authSupplier middleware is imported) ...

// GET orders relevant to the authenticated supplier
app.get('/api/supplier/orders', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;

    // Pagination parameters (optional, but good for many orders)
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10; // Default 10 orders per page
    const offset = (page - 1) * limit;

    const client = await db.pool.connect(); // Use a client for multiple operations

    try {
        // Step 1: Find distinct order IDs that contain products from this supplier
        // Also get overall order details and customer info
        const distinctOrdersQuery = `
            SELECT DISTINCT
                o.id AS order_id,
                o.order_date,
                o.status AS order_status,
                o.total_amount AS order_total_amount, -- Total for the entire customer order
                up.full_name AS customer_name,
                up.phone_number AS customer_phone,
                up.address_line1 AS customer_address1,
                up.address_line2 AS customer_address2,
                up.city AS customer_city
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            LEFT JOIN user_profiles up ON o.user_id = up.user_id
            WHERE p.supplier_id = $1
            ORDER BY o.order_date DESC
            LIMIT $2 OFFSET $3;
        `;
        const distinctOrdersResult = await client.query(distinctOrdersQuery, [supplierId, limit, offset]);
        const orders = distinctOrdersResult.rows;

        if (orders.length === 0) {
            client.release();
            return res.json({
                items: [],
                currentPage: page,
                totalPages: 0,
                totalItems: 0
            });
        }

        // Step 2: For each order, fetch the specific items that belong to this supplier
        const orderIds = orders.map(o => o.order_id);
        const orderItemsQuery = `
            SELECT 
                oi.order_id,
                oi.id AS order_item_id,
                oi.product_id,
                p.name AS product_name,
                p.image_url AS product_image_url,
                oi.quantity,
                oi.price_at_time_of_order,
                oi.supplier_item_status -- Assuming you added this column
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = ANY($1::int[]) AND p.supplier_id = $2;
        `;
        const orderItemsResult = await client.query(orderItemsQuery, [orderIds, supplierId]);
        const itemsByOrderId = {};
        orderItemsResult.rows.forEach(item => {
            if (!itemsByOrderId[item.order_id]) {
                itemsByOrderId[item.order_id] = [];
            }
            itemsByOrderId[item.order_id].push(item);
        });

        // Step 3: Combine order details with their respective items and calculate supplier's portion value
        const responseOrders = orders.map(order => {
            const itemsForThisSupplier = itemsByOrderId[order.order_id] || [];
            const supplierOrderValue = itemsForThisSupplier.reduce((sum, item) => {
                return sum + (parseFloat(item.price_at_time_of_order) * item.quantity);
            }, 0);

            return {
                ...order,
                items_for_this_supplier: itemsForThisSupplier,
                supplier_order_value: supplierOrderValue.toFixed(2)
            };
        });

        // Step 4: Get total count of relevant orders for pagination metadata
        const totalRelevantOrdersCountQuery = `
            SELECT COUNT(DISTINCT o.id) AS total_items
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE p.supplier_id = $1;
        `;
        const totalCountResult = await client.query(totalRelevantOrdersCountQuery, [supplierId]);
        const totalItems = parseInt(totalCountResult.rows[0].total_items, 10);
        const totalPages = Math.ceil(totalItems / limit);

        res.json({
            items: responseOrders,
            currentPage: page,
            totalPages: totalPages,
            totalItems: totalItems
        });

    } catch (err) {
        console.error(`Error fetching orders for supplier ${supplierId}:`, err);
        res.status(500).json({ error: 'Failed to fetch supplier orders' });
    } finally {
        if (client) {
            client.release();
        }
    }
});
// server.js
// ... (bcrypt, jwt imports are already there) ...

// --- ADMIN AUTHENTICATION ---
app.post('/api/auth/admin/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        const adminResult = await db.query('SELECT id, email, password_hash, full_name, role FROM admins WHERE email = $1', [email.toLowerCase()]);

        if (adminResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials or not an admin.' });
        }

        const adminUser = adminResult.rows[0];

        if (adminUser.role !== 'admin') { // Extra check
            return res.status(403).json({ error: 'Access denied. Not an admin user.' });
        }

        const match = await bcrypt.compare(password, adminUser.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        // Generate JWT for Admin
        const tokenPayload = {
            adminId: adminUser.id, // Use adminId or userId
            email: adminUser.email,
            role: adminUser.role,
            name: adminUser.full_name
        };
        const token = jwt.sign(tokenPayload, process.env.JWT_ADMIN_SECRET, { expiresIn: '8h' }); // Admin token might have different expiry

        res.json({ 
            message: 'Admin login successful', 
            token,
            admin: {
                id: adminUser.id,
                email: adminUser.email,
                name: adminUser.full_name,
                role: adminUser.role
            }
        });

    } catch (err) {
        console.error('Admin login error:', err);
        res.status(500).json({ error: 'Internal server error during admin login.' });
    }
});
// ... (app.listen) ...
// ... (app.listen) ...
// --- ADMIN ROUTES ---
app.get('/api/admin/suppliers', authAdmin, async (req, res) => {
    console.log('[ADMIN] Authenticated admin:', req.admin); // Log to see if middleware works
    try {
        // For now, select core fields. Add 'is_active' if you create that column.
        const query = 'SELECT id, name, email, category, location, rating, created_at, is_active FROM suppliers ORDER BY created_at DESC';
        const result = await db.query(query);
        
        // For pagination (implement fully later if needed)
        // const totalItems = result.rows.length; // Simple count for now if no DB count
        
        res.json({
            items: result.rows,
            // currentPage: 1, 
            // totalPages: 1, 
            // totalItems: totalItems
        });
    } catch (err) {
        console.error("[ADMIN] Error fetching suppliers:", err);
        res.status(500).json({ error: 'Failed to fetch suppliers.' });
    }
});

// server.js
// ... (bcrypt is already imported)
// ... (authAdmin middleware is imported) ...

// --- ADMIN ROUTES (Continued) ---

// ... (GET /api/admin/suppliers) ...

// POST - Admin creates a new supplier
app.post('/api/admin/suppliers', authAdmin, async (req, res) => {
    const {
        name,
        email,
        password, // Admin will set an initial password
        category,
        location,
        rating, // Optional
        description, // Optional
        image_url, // Optional
        is_active = true // Default to active, admin can change later
    } = req.body;

    // --- Input Validation ---
    if (!name || !email || !password || !category) {
        return res.status(400).json({ error: 'Name, email, password, and category are required for new supplier.' });
    }
    // Add more specific validations (email format, password strength etc.)
    if (password.length < 6) { // Example password policy
         return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }
    // Validate email format (basic regex example)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid email format.' });
    }


    try {
        // Check if email already exists
        const existingSupplier = await db.query('SELECT id FROM suppliers WHERE email = $1', [email.toLowerCase()]);
        if (existingSupplier.rows.length > 0) {
            return res.status(409).json({ error: 'Email already registered for another supplier.' }); // 409 Conflict
        }

        // Hash the password
        const saltRounds = 10;
        const password_hash = await bcrypt.hash(password, saltRounds);

        const insertQuery = `
            INSERT INTO suppliers 
            (name, email, password_hash, category, location, rating, description, image_url, is_active, created_at, updated_at) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
            RETURNING id, name, email, category, location, rating, is_active, created_at; 
            -- Return a subset of fields, not the hash
        `;
        const values = [
            name.trim(),
            email.toLowerCase().trim(),
            password_hash,
            category.trim(),
            location || null,
            rating ? parseFloat(rating) : null,
            description || null,
            image_url || null,
            is_active === undefined ? true : Boolean(is_active) // Default to true
        ];

        const result = await db.query(insertQuery, values);
        const newSupplier = result.rows[0];

        console.log(`[ADMIN] New supplier created by admin ${req.admin.adminId}: ID ${newSupplier.id}, Email: ${newSupplier.email}`);
        res.status(201).json(newSupplier);

    } catch (err) {
        console.error("[ADMIN] Error creating supplier:", err);
        if (err.code === '23505' && err.constraint === 'suppliers_email_key') { // Check for unique constraint on email
             return res.status(409).json({ error: 'This email is already in use by another supplier.' });
        }
        res.status(500).json({ error: 'Failed to create supplier due to a server error.' });
    }
});
// ... (app.listen) ...
// ... (rest of server.js, app.listen)
// server.js
// ... (authAdmin is imported) ...

// --- ADMIN ROUTES (Continued) ---
// ... (GET /api/admin/suppliers, POST /api/admin/suppliers) ...

// PUT - Admin updates an existing supplier's details
app.put('/api/admin/suppliers/:supplierId', authAdmin, async (req, res) => {
    const { supplierId } = req.params;
    const parsedSupplierId = parseInt(supplierId, 10);

    if (isNaN(parsedSupplierId)) {
        return res.status(400).json({ error: 'Invalid Supplier ID format.' });
    }

    // Fields that an admin can update (password is not updated here)
    const {
        name,
        email, // Admin might need to change email
        category,
        location,
        rating,
        description,
        image_url,
        is_active 
    } = req.body;

    // Basic Validation
    if (!name || !email || !category) {
        return res.status(400).json({ error: 'Name, email, and category are required.' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid email format.' });
    }
    // Add other specific validations as needed...

    try {
        // Check if the new email (if changed) is already taken by ANOTHER supplier
        const existingSupplierByEmail = await db.query(
            'SELECT id FROM suppliers WHERE email = $1 AND id != $2',
            [email.toLowerCase(), parsedSupplierId]
        );
        if (existingSupplierByEmail.rows.length > 0) {
            return res.status(409).json({ error: 'This email is already in use by another supplier.' });
        }

        // The database trigger will handle 'updated_at = NOW()' automatically.
        const updateQuery = `
            UPDATE suppliers 
            SET 
                name = $1, 
                email = $2,
                category = $3, 
                location = $4, 
                rating = $5, 
                description = $6, 
                image_url = $7,
                is_active = $8 
                -- No password_hash update here
            WHERE id = $9
            RETURNING id, name, email, category, location, rating, is_active, description, image_url, created_at, updated_at;
        `;
        const values = [
            name.trim(),
            email.toLowerCase().trim(),
            category.trim(),
            location || null,
            rating ? parseFloat(rating) : null,
            description || null,
            image_url || null,
            is_active === undefined ? true : Boolean(is_active), // Default to true if not specified
            parsedSupplierId
        ];

        const result = await db.query(updateQuery, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found or update failed.' });
        }
        
        console.log(`[ADMIN] Supplier ID ${parsedSupplierId} updated by admin ${req.admin.adminId}.`);
        res.status(200).json(result.rows[0]);

    } catch (err) {
        console.error(`[ADMIN] Error updating supplier ${parsedSupplierId}:`, err);
        if (err.code === '23505' && err.constraint === 'suppliers_email_key') { 
             return res.status(409).json({ error: 'This email is already in use by another supplier.' });
        }
        res.status(500).json({ error: 'Failed to update supplier.' });
    }
});
// --- Start the Server ---
// ... (app.listen code) ...
// server.js
// ... (authAdmin middleware is imported) ...

// --- ADMIN ROUTES (Continued) ---

// ... (GET /api/admin/suppliers, POST /api/admin/suppliers, PUT /api/admin/suppliers/:supplierId) ...

// DELETE - Admin deletes a supplier
app.delete('/api/admin/suppliers/:supplierId', authAdmin, async (req, res) => {
    const { supplierId } = req.params;
    const parsedSupplierId = parseInt(supplierId, 10);

    if (isNaN(parsedSupplierId)) {
        return res.status(400).json({ error: 'Invalid Supplier ID format.' });
    }

    console.log(`[ADMIN] Attempting to delete supplier ID ${parsedSupplierId} by admin ${req.admin.adminId}.`);

    // Important: Consider what happens to products linked to this supplier.
    // If products.supplier_id has ON DELETE RESTRICT, this will fail if supplier has products.
    // If ON DELETE CASCADE, products will also be deleted (DANGEROUS).
    // If ON DELETE SET NULL, products.supplier_id will become NULL.

    try {
        // Check if supplier exists before attempting delete (optional, DB will error anyway)
        const checkQuery = 'SELECT id FROM suppliers WHERE id = $1';
        const checkResult = await db.query(checkQuery, [parsedSupplierId]);

        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found.' });
        }

        // Attempt to delete the supplier
        const deleteQuery = 'DELETE FROM suppliers WHERE id = $1 RETURNING id, name;'; // RETURNING to confirm
        const result = await db.query(deleteQuery, [parsedSupplierId]);

        if (result.rowCount === 0) {
            // This might happen if, for some reason, it existed moments ago but not now,
            // or if the ID was valid but deletion failed for an unexpected reason not caught by FK.
            return res.status(404).json({ error: 'Supplier not found or delete operation failed.' });
        }

        console.log(`[ADMIN] Supplier ID ${result.rows[0].id} (${result.rows[0].name}) deleted successfully by admin ${req.admin.adminId}.`);
        res.status(200).json({ message: `Supplier "${result.rows[0].name}" deleted successfully.`, deletedSupplierId: result.rows[0].id });
        // Or res.sendStatus(204) for No Content

    } catch (err) {
        console.error(`[ADMIN] Error deleting supplier ${parsedSupplierId}:`, err);
        
        // Handle foreign key constraint violation (PostgreSQL error code 23503)
        if (err.code === '23503') { 
            // You can inspect err.constraint_name if you want to be more specific about which constraint failed
            let detailMessage = 'This supplier cannot be deleted because they are referenced by other records';
            if (err.detail && err.detail.includes('products_supplier_id_fkey')) { // Check your actual FK name
                detailMessage += ' (e.g., existing products are linked to this supplier). Please reassign or delete those products first.';
            } else if (err.detail && err.detail.includes('deals_supplier_id_fkey')) {
                detailMessage += ' (e.g., existing deals are linked to this supplier). Please reassign or delete those deals first.';
            }
            // Add more checks for other potential foreign key constraints if needed

            return res.status(409).json({ error: detailMessage }); // 409 Conflict
        }
        
        res.status(500).json({ error: 'Failed to delete supplier due to a server error.' });
    }
});
// telegram-app-backend/server.js
// Ensure authAdmin is imported

// PUT - Toggle active status of a supplier (Admin only)
app.put('/api/admin/suppliers/:supplierId/toggle-active', authAdmin, async (req, res) => {
    const { supplierId } = req.params;
    const parsedSupplierId = parseInt(supplierId, 10);

    if (isNaN(parsedSupplierId)) {
        return res.status(400).json({ error: 'Invalid Supplier ID format.' });
    }

    try {
        // Fetch the current status first
        const currentSupplierResult = await db.query('SELECT id, name, email, is_active FROM suppliers WHERE id = $1', [parsedSupplierId]);

        if (currentSupplierResult.rows.length === 0) {
            return res.status(404).json({ error: 'Supplier not found.' });
        }

        const currentStatus = currentSupplierResult.rows[0].is_active;
        const newStatus = !currentStatus; // Toggle the status

        const updateResult = await db.query(
            'UPDATE suppliers SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, category, location, rating, is_active, created_at', // Return relevant fields
            [newStatus, parsedSupplierId]
        );
        
        // updated_at assumes you have a trigger or are setting it manually. 
        // If trigger exists, you can remove updated_at = NOW() from here.

        console.log(`[ADMIN] Supplier ID ${parsedSupplierId} status toggled to ${newStatus} by admin ${req.admin.adminId}`);
        res.status(200).json(updateResult.rows[0]); // Send back the updated supplier

    } catch (err) {
        console.error(`[ADMIN] Error toggling status for supplier ${parsedSupplierId}:`, err);
        res.status(500).json({ error: 'Failed to update supplier status.' });
    }
});

// telegram-app-backend/server.js
// Ensure authSupplier middleware is imported: const authSupplier = require('./middleware/authSupplier');
// Ensure db object is available: const db = require('./config/db');

// ... (existing supplier routes for products, auth) ...


// --- SUPPLIER DEAL MANAGEMENT ---

// GET all deals for the authenticated supplier
app.get('/api/supplier/deals', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;

    try {
        // Fetch deals created by this supplier
        // Also join with products if product_id is present to get product_name
        const query = `
            SELECT 
                d.id, d.title, d.description, d.discount_percentage,
                d.start_date, d.end_date, d.product_id, p.name as product_name,
                d.image_url, d.is_active, d.created_at
            FROM deals d
            LEFT JOIN products p ON d.product_id = p.id AND p.supplier_id = d.supplier_id -- Ensure product also belongs to supplier
            WHERE d.supplier_id = $1
            ORDER BY d.created_at DESC;
        `;
        // TODO: Add pagination if a supplier can have many deals

        const result = await db.query(query, [supplierId]);
        res.json(result.rows);

    } catch (err) {
        console.error(`[SUPPLIER_DEALS] Error fetching deals for supplier ${supplierId}:`, err);
        res.status(500).json({ error: 'Failed to fetch deals.' });
    }
});


// POST - Create a new deal for the authenticated supplier
app.post('/api/supplier/deals', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;
    const {
        title,
        description,
        discount_percentage, // Can be null
        start_date,          // Can be null (starts immediately if active)
        end_date,            // Can be null (no expiry)
        product_id,          // Can be null (deal not tied to a specific product)
        image_url,           // Can be null
        is_active = true     // Default to active, or could be false for "draft"
    } = req.body;

    // --- Validation ---
    if (!title || title.trim() === '') {
        return res.status(400).json({ error: 'Deal title is required.' });
    }
    if (discount_percentage !== undefined && discount_percentage !== null && (isNaN(parseFloat(discount_percentage)) || parseFloat(discount_percentage) <= 0 || parseFloat(discount_percentage) > 100)) {
        return res.status(400).json({ error: 'Discount percentage must be a number between 0 and 100 if provided.' });
    }
    // Basic date validation (can be more robust)
    if (start_date && isNaN(new Date(start_date).getTime())) {
        return res.status(400).json({ error: 'Invalid start date format.' });
    }
    if (end_date && isNaN(new Date(end_date).getTime())) {
        return res.status(400).json({ error: 'Invalid end date format.' });
    }
    if (start_date && end_date && new Date(start_date) >= new Date(end_date)) {
        return res.status(400).json({ error: 'End date must be after start date.' });
    }
    if (product_id !== undefined && product_id !== null && isNaN(parseInt(product_id, 10))) {
        return res.status(400).json({ error: 'Invalid product ID format.' });
    }

    const client = await db.pool.connect(); // Use client for transaction if product check is complex

    try {
        // If product_id is provided, verify it belongs to this supplier
        if (product_id) {
            const productCheckQuery = 'SELECT id FROM products WHERE id = $1 AND supplier_id = $2';
            const productCheckResult = await client.query(productCheckQuery, [parseInt(product_id, 10), supplierId]);
            if (productCheckResult.rows.length === 0) {
                client.release();
                return res.status(403).json({ error: 'Forbidden: The selected product does not belong to you or does not exist.' });
            }
        }

        const insertQuery = `
            INSERT INTO deals (
                title, description, discount_percentage, start_date, end_date, 
                product_id, supplier_id, image_url, is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;
        const values = [
            title.trim(),
            description || null,
            discount_percentage ? parseFloat(discount_percentage) : null,
            start_date ? new Date(start_date) : null,
            end_date ? new Date(end_date) : null,
            product_id ? parseInt(product_id, 10) : null,
            supplierId, // Set automatically from authenticated supplier
            image_url || null,
            is_active === undefined ? true : Boolean(is_active)
        ];

        const result = await client.query(insertQuery, values);
        
        console.log(`[SUPPLIER_DEALS] Deal created by supplier ${supplierId}:`, result.rows[0].id);
        res.status(201).json(result.rows[0]);

    } catch (err) {
        console.error(`[SUPPLIER_DEALS] Error creating deal for supplier ${supplierId}:`, err);
        res.status(500).json({ error: 'Failed to create deal.' });
    } finally {
        client.release();
    }
});

app.put('/api/supplier/deals/:dealId', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;
    const { dealId } = req.params;
    const parsedDealId = parseInt(dealId, 10);

    const {
        title,
        description,
        discount_percentage,
        start_date,
        end_date,
        product_id, // Can be null to unlink, or a new product_id
        image_url,
        is_active
    } = req.body;

    // --- Validation ---
    if (isNaN(parsedDealId)) {
        return res.status(400).json({ error: 'Invalid Deal ID.' });
    }
    if (!title || title.trim() === '') {
        return res.status(400).json({ error: 'Deal title is required.' });
    }
    // Add more validation for discount, dates, product_id format as in POST route
    if (discount_percentage !== undefined && discount_percentage !== null && (isNaN(parseFloat(discount_percentage)) || parseFloat(discount_percentage) <= 0 || parseFloat(discount_percentage) > 100)) {
        return res.status(400).json({ error: 'Discount percentage must be a number between 0 and 100 if provided.' });
    }
    if (start_date && end_date && new Date(start_date) >= new Date(end_date)) {
        return res.status(400).json({ error: 'End date must be after start date.' });
    }
    if (product_id !== undefined && product_id !== null && product_id !== '' && isNaN(parseInt(product_id, 10))) {
         return res.status(400).json({ error: 'Invalid product ID format.' });
    }


    const client = await db.pool.connect();
    try {
        await client.query('BEGIN'); // Start transaction

        // 1. Verify the deal exists and belongs to this supplier
        const dealCheckQuery = 'SELECT id, supplier_id, product_id AS old_product_id FROM deals WHERE id = $1';
        const dealCheckResult = await client.query(dealCheckQuery, [parsedDealId]);

        if (dealCheckResult.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: 'Deal not found.' });
        }
        if (dealCheckResult.rows[0].supplier_id !== supplierId) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(403).json({ error: 'Forbidden: You do not own this deal.' });
        }

        // 2. If product_id is provided and is different from old one, verify new product belongs to supplier
        const parsedProductId = product_id ? parseInt(product_id, 10) : null;
        if (parsedProductId && parsedProductId !== dealCheckResult.rows[0].old_product_id) {
            const productCheckQuery = 'SELECT id FROM products WHERE id = $1 AND supplier_id = $2';
            const productCheckResult = await client.query(productCheckQuery, [parsedProductId, supplierId]);
            if (productCheckResult.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(403).json({ error: 'Forbidden: The selected product for the deal does not belong to you or does not exist.' });
            }
        } else if (product_id === '' || product_id === null) {
            // If product_id is explicitly set to empty or null, allow unlinking
        }


        // 3. Update the deal
        const updateQuery = `
            UPDATE deals SET
                title = $1,
                description = $2,
                discount_percentage = $3,
                start_date = $4,
                end_date = $5,
                product_id = $6,
                image_url = $7,
                is_active = $8
            WHERE id = $9 AND supplier_id = $10 -- Ensure supplier_id match again for safety
            RETURNING *;
        `;
        const values = [
            title.trim(),
            description || null,
            discount_percentage ? parseFloat(discount_percentage) : null,
            start_date ? new Date(start_date) : null,
            end_date ? new Date(end_date) : null,
            parsedProductId, // Use parsed and validated product_id
            image_url || null,
            is_active === undefined ? true : Boolean(is_active),
            parsedDealId,
            supplierId
        ];

        const result = await client.query(updateQuery, values);
        await client.query('COMMIT'); // Commit transaction
        
        console.log(`[SUPPLIER_DEALS] Deal ID ${parsedDealId} updated by supplier ${supplierId}`);
        res.status(200).json(result.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error(`[SUPPLIER_DEALS] Error updating deal ${dealId} for supplier ${supplierId}:`, err);
        res.status(500).json({ error: 'Failed to update deal.' });
    } finally {
        client.release();
    }
});

app.delete('/api/supplier/deals/:dealId', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;
    const { dealId } = req.params;
    const parsedDealId = parseInt(dealId, 10);

    if (isNaN(parsedDealId)) {
        return res.status(400).json({ error: 'Invalid Deal ID.' });
    }

    try {
        // Verify ownership before deleting
        const dealCheckQuery = 'SELECT id FROM deals WHERE id = $1 AND supplier_id = $2';
        const dealCheckResult = await db.query(dealCheckQuery, [parsedDealId, supplierId]);

        if (dealCheckResult.rows.length === 0) {
            return res.status(404).json({ error: 'Deal not found or you do not own this deal.' });
        }

        // Delete the deal
        const deleteQuery = 'DELETE FROM deals WHERE id = $1 RETURNING id;'; // Only need id for confirmation
        const result = await db.query(deleteQuery, [parsedDealId]);

        if (result.rowCount === 0) { // Should not happen if above check passed
            return res.status(404).json({ error: 'Deal not found during delete attempt.' });
        }
        
        console.log(`[SUPPLIER_DEALS] Deal ID ${parsedDealId} deleted by supplier ${supplierId}`);
        res.status(200).json({ message: 'Deal deleted successfully', deletedDealId: parsedDealId });

    } catch (err) {
        console.error(`[SUPPLIER_DEALS] Error deleting deal ${dealId} for supplier ${supplierId}:`, err);
        // Check for foreign key constraints if deals are referenced elsewhere (e.g., featured_items)
        if (err.code === '23503') { // Foreign key violation
             return res.status(409).json({ error: 'Cannot delete this deal as it is currently featured or referenced elsewhere. Please remove it from features first.' });
        }
        res.status(500).json({ error: 'Failed to delete deal.' });
    }
});

// telegram-app-backend/server.js
// Ensure authAdmin middleware is imported

// --- ADMIN FEATURED ITEMS MANAGEMENT ---

// GET all featured item definitions for Admin (includes inactive/scheduled)
app.get('/api/admin/featured-items-definitions', authAdmin, async (req, res) => {
    // Basic pagination (can be enhanced)
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 15;
    const offset = (page - 1) * limit;

    try {
        const itemsQuery = `
            SELECT 
                fi.id AS feature_definition_id, 
                fi.item_type, 
                fi.item_id, 
                fi.display_order,
                fi.custom_title, 
                fi.custom_description, 
                fi.custom_image_url,
                fi.is_active, 
                fi.active_from, 
                fi.active_until, 
                fi.created_at,
                CASE
                    WHEN fi.item_type = 'product' THEN p.name
                    WHEN fi.item_type = 'deal' THEN d.title
                    WHEN fi.item_type = 'supplier' THEN s.name
                    ELSE NULL
                END AS original_item_name,
                CASE
                    WHEN fi.item_type = 'product' THEN p.image_url
                    WHEN fi.item_type = 'deal' THEN d.image_url
                    WHEN fi.item_type = 'supplier' THEN s.image_url
                    ELSE NULL
                END AS original_item_image_url
            FROM featured_items fi
            LEFT JOIN products p ON fi.item_type = 'product' AND fi.item_id = p.id
            LEFT JOIN deals d ON fi.item_type = 'deal' AND fi.item_id = d.id
            LEFT JOIN suppliers s ON fi.item_type = 'supplier' AND fi.item_id = s.id
            ORDER BY fi.display_order ASC, fi.created_at DESC
            LIMIT $1 OFFSET $2;
        `;
        const itemsResult = await db.query(itemsQuery, [limit, offset]);

        const countQuery = 'SELECT COUNT(*) AS total_items FROM featured_items;';
        const countResult = await db.query(countQuery);
        const totalItems = parseInt(countResult.rows[0].total_items, 10);
        const totalPages = Math.ceil(totalItems / limit);

        res.json({
            items: itemsResult.rows,
            currentPage: page,
            totalPages: totalPages,
            totalItems: totalItems,
        });

    } catch (err) {
        console.error("[ADMIN_FEATURED] Error fetching featured item definitions:", err);
        res.status(500).json({ error: 'Failed to fetch featured item definitions.' });
    }
});

// telegram-app-backend/server.js

app.post('/api/admin/featured-items', authAdmin, async (req, res) => {
    const {
        item_type,
        item_id,
        display_order = 0, // Default display order
        custom_title,
        custom_description,
        custom_image_url,
        is_active = true,
        active_from,
        active_until
    } = req.body;

    // --- Validation ---
    if (!item_type || !['product', 'deal', 'supplier'].includes(item_type)) {
        return res.status(400).json({ error: 'Valid item_type (product, deal, supplier) is required.' });
    }
    if (item_id === undefined || item_id === null || isNaN(parseInt(item_id, 10))) {
        return res.status(400).json({ error: 'Valid item_id is required.' });
    }
    if (display_order !== undefined && isNaN(parseInt(display_order, 10))) {
        return res.status(400).json({ error: 'Display order must be a number.' });
    }
    // Add more validation for dates if provided

    const parsedItemId = parseInt(item_id, 10);

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN'); // Start transaction

        // Validate that the item_id exists in the respective table
        let itemExistsQuery = '';
        if (item_type === 'product') itemExistsQuery = 'SELECT id FROM products WHERE id = $1';
        else if (item_type === 'deal') itemExistsQuery = 'SELECT id FROM deals WHERE id = $1';
        else if (item_type === 'supplier') itemExistsQuery = 'SELECT id FROM suppliers WHERE id = $1';
        
        const itemExistsResult = await client.query(itemExistsQuery, [parsedItemId]);
        if (itemExistsResult.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: `The specified ${item_type} with ID ${parsedItemId} does not exist.` });
        }

        const insertQuery = `
            INSERT INTO featured_items (
                item_type, item_id, display_order, custom_title, custom_description,
                custom_image_url, is_active, active_from, active_until
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;
        const values = [
            item_type, parsedItemId, parseInt(display_order, 10),
            custom_title || null, custom_description || null, custom_image_url || null,
            is_active === undefined ? true : Boolean(is_active),
            active_from ? new Date(active_from) : null,
            active_until ? new Date(active_until) : null
        ];

        const result = await client.query(insertQuery, values);
        await client.query('COMMIT'); // Commit transaction
        
        console.log(`[ADMIN_FEATURED] New featured item created by admin ${req.admin.adminId}: ID ${result.rows[0].id}`);
        res.status(201).json(result.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error("[ADMIN_FEATURED] Error creating featured item:", err);
        res.status(500).json({ error: 'Failed to create featured item.' });
    } finally {
        client.release();
    }
});



// telegram-app-backend/server.js

app.get('/api/admin/featured-items-definitions/:featureId', authAdmin, async (req, res) => {
    const { featureId } = req.params;
    const parsedFeatureId = parseInt(featureId, 10);

    if (isNaN(parsedFeatureId)) {
        return res.status(400).json({ error: 'Invalid Feature Definition ID format.' });
    }

    try {
        // Similar to the list query, but for a single ID.
        // We still join to get original item name for context if custom_title is null.
        const query = `
            SELECT 
                fi.id AS feature_definition_id, 
                fi.item_type, 
                fi.item_id, 
                fi.display_order,
                fi.custom_title, 
                fi.custom_description, 
                fi.custom_image_url,
                fi.is_active, 
                fi.active_from, 
                fi.active_until, 
                fi.created_at,
                CASE
                    WHEN fi.item_type = 'product' THEN p.name
                    WHEN fi.item_type = 'deal' THEN d.title
                    WHEN fi.item_type = 'supplier' THEN s.name
                    ELSE NULL
                END AS original_item_name 
            FROM featured_items fi
            LEFT JOIN products p ON fi.item_type = 'product' AND fi.item_id = p.id
            LEFT JOIN deals d ON fi.item_type = 'deal' AND fi.item_id = d.id
            LEFT JOIN suppliers s ON fi.item_type = 'supplier' AND fi.item_id = s.id
            WHERE fi.id = $1;
        `;
        const result = await db.query(query, [parsedFeatureId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Featured item definition not found.' });
        }
        res.json(result.rows[0]);

    } catch (err) {
        console.error(`[ADMIN_FEATURED] Error fetching feature definition ID ${parsedFeatureId}:`, err);
        res.status(500).json({ error: 'Failed to fetch feature definition.' });
    }
});

// telegram-app-backend/server.js

app.put('/api/admin/featured-items-definitions/:featureId', authAdmin, async (req, res) => {
    const { featureId } = req.params;
    const parsedFeatureId = parseInt(featureId, 10);

    const {
        item_type, // Usually not changed, but could be allowed
        item_id,
        display_order,
        custom_title,
        custom_description,
        custom_image_url,
        is_active,
        active_from,
        active_until
    } = req.body;

    if (isNaN(parsedFeatureId)) {
        return res.status(400).json({ error: 'Invalid Feature Definition ID format.' });
    }

    // --- Validation (similar to POST, but some fields might be optional for PUT) ---
    if (item_type && !['product', 'deal', 'supplier'].includes(item_type)) {
        return res.status(400).json({ error: 'If provided, item_type must be product, deal, or supplier.' });
    }
    if (item_id !== undefined && (item_id === null || isNaN(parseInt(item_id, 10)))) {
        return res.status(400).json({ error: 'If provided, item_id must be a valid number.' });
    }
    // Add more specific validations as needed...

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Check if the feature definition exists
        const existingFeature = await client.query('SELECT * FROM featured_items WHERE id = $1', [parsedFeatureId]);
        if (existingFeature.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: 'Feature definition not found to update.' });
        }

        const current = existingFeature.rows[0];
        const newItemType = item_type || current.item_type;
        const newItemId = (item_id !== undefined && item_id !== null) ? parseInt(item_id, 10) : current.item_id;

        // If item_id or item_type is being changed, validate the new linked item
        if ((item_id !== undefined && item_id !== null && newItemId !== current.item_id) || (item_type && newItemType !== current.item_type)) {
            let itemExistsQuery = '';
            if (newItemType === 'product') itemExistsQuery = 'SELECT id FROM products WHERE id = $1';
            else if (newItemType === 'deal') itemExistsQuery = 'SELECT id FROM deals WHERE id = $1';
            else if (newItemType === 'supplier') itemExistsQuery = 'SELECT id FROM suppliers WHERE id = $1';
            
            const itemExistsResult = await client.query(itemExistsQuery, [newItemId]);
            if (itemExistsResult.rows.length === 0) {
                await client.query('ROLLBACK');
                client.release();
                return res.status(404).json({ error: `The specified new ${newItemType} with ID ${newItemId} does not exist.` });
            }
        }

        const updateQuery = `
            UPDATE featured_items SET
                item_type = $1,
                item_id = $2,
                display_order = $3,
                custom_title = $4,
                custom_description = $5,
                custom_image_url = $6,
                is_active = $7,
                active_from = $8,
                active_until = $9,
                updated_at = NOW() -- Assuming you have an updated_at column and trigger
            WHERE id = $10
            RETURNING *;
        `;
        const values = [
            newItemType,
            newItemId,
            display_order !== undefined ? parseInt(display_order, 10) : current.display_order,
            custom_title !== undefined ? custom_title : current.custom_title, // Allow sending null to clear
            custom_description !== undefined ? custom_description : current.custom_description,
            custom_image_url !== undefined ? custom_image_url : current.custom_image_url,
            is_active !== undefined ? Boolean(is_active) : current.is_active,
            active_from !== undefined ? (active_from ? new Date(active_from) : null) : current.active_from,
            active_until !== undefined ? (active_until ? new Date(active_until) : null) : current.active_until,
            parsedFeatureId
        ];

        const result = await client.query(updateQuery, values);
        await client.query('COMMIT');
        
        console.log(`[ADMIN_FEATURED] Featured item definition ID ${parsedFeatureId} updated by admin ${req.admin.adminId}`);
        res.status(200).json(result.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[ADMIN_FEATURED] Error updating feature definition ID ${parsedFeatureId}:`, err);
        res.status(500).json({ error: 'Failed to update feature definition.' });
    } finally {
        client.release();
    }
});

// telegram-app-backend/server.js

app.delete('/api/admin/featured-items-definitions/:featureId', authAdmin, async (req, res) => {
    const { featureId } = req.params;
    const parsedFeatureId = parseInt(featureId, 10);

    if (isNaN(parsedFeatureId)) {
        return res.status(400).json({ error: 'Invalid Feature Definition ID format.' });
    }

    try {
        const deleteQuery = 'DELETE FROM featured_items WHERE id = $1 RETURNING id;';
        const result = await db.query(deleteQuery, [parsedFeatureId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Featured item definition not found to delete.' });
        }

        console.log(`[ADMIN_FEATURED] Featured item definition ID ${parsedFeatureId} deleted by admin ${req.admin.adminId}`);
        res.status(200).json({ message: 'Featured item definition deleted successfully.', deletedFeatureId: parsedFeatureId });
        // Or res.sendStatus(204) for no content

    } catch (err) {
        console.error(`[ADMIN_FEATURED] Error deleting feature definition ID ${parsedFeatureId}:`, err);
        res.status(500).json({ error: 'Failed to delete feature definition.' });
    }
});



// telegram-app-backend/server.js
// Ensure these are at the top:
// const db = require('./config/db');
// const authSupplier = require('./middleware/authSupplier');
// const bcrypt = require('bcrypt');
// const jwt = require('jsonwebtoken'); // Not needed for these specific routes, but for auth in general

// ... (existing routes for supplier auth, supplier products, supplier deals) ...

// --- SUPPLIER MANAGEMENT OF THEIR DELIVERY AGENTS ---

// POST /api/supplier/delivery-agents - Supplier creates a new delivery agent for their company
app.post('/api/supplier/delivery-agents', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId; // From authenticated supplier's JWT
    const {
        full_name,
        phone_number, // Required, unique
        password,     // Required
        email,        // Optional, unique if provided
        telegram_user_id // Optional, unique if provided
    } = req.body;

    // --- Validation ---
    if (!full_name || full_name.trim() === '') {
        return res.status(400).json({ error: 'Full name is required.' });
    }
    if (!phone_number || phone_number.trim() === '') {
        return res.status(400).json({ error: 'Phone number is required.' });
    }
    if (!password || password.length < 6) { // Basic password length check
        return res.status(400).json({ error: 'Password is required and must be at least 6 characters.' });
    }
    if (email && email.trim() === '') { // If email provided, it shouldn't be empty
        return res.status(400).json({ error: 'Email cannot be empty if provided.' });
    }
    if (telegram_user_id && isNaN(parseInt(telegram_user_id, 10))) {
        return res.status(400).json({ error: 'Invalid Telegram User ID format.' });
    }
    // Add more specific validation for phone, email format if needed

    try {
        // Hash the password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const insertQuery = `
            INSERT INTO delivery_agents (
                supplier_id, full_name, phone_number, password_hash, email, telegram_user_id, is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, TRUE) -- New agents are active by default
            RETURNING id, supplier_id, full_name, phone_number, email, telegram_user_id, is_active, created_at;
        `;
        const values = [
            supplierId,
            full_name.trim(),
            phone_number.trim(),
            hashedPassword,
            email ? email.toLowerCase().trim() : null,
            telegram_user_id ? parseInt(telegram_user_id, 10) : null
        ];

        const result = await db.query(insertQuery, values);
        
        console.log(`[DELIVERY_AGENT_MGMT] New delivery agent ID ${result.rows[0].id} created by supplier ID ${supplierId}`);
        res.status(201).json(result.rows[0]); // Return the created agent (without password_hash)

    } catch (err) {
        console.error(`[DELIVERY_AGENT_MGMT] Error creating delivery agent for supplier ${supplierId}:`, err);
        if (err.code === '23505') { // Unique constraint violation (e.g., phone_number, email, or telegram_user_id)
            if (err.constraint && err.constraint.includes('phone_number')) {
                return res.status(409).json({ error: 'This phone number is already registered.' });
            }
            if (err.constraint && err.constraint.includes('email')) {
                return res.status(409).json({ error: 'This email address is already registered.' });
            }
             if (err.constraint && err.constraint.includes('telegram_user_id')) {
                return res.status(409).json({ error: 'This Telegram account is already registered as an agent.' });
            }
            return res.status(409).json({ error: 'A delivery agent with some of these unique details already exists.' });
        }
        res.status(500).json({ error: 'Failed to create delivery agent.' });
    }
});


// GET /api/supplier/delivery-agents - Supplier lists their own delivery agents
app.get('/api/supplier/delivery-agents', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;

    // Pagination (optional for now, can add later if a supplier has many agents)
    // const page = parseInt(req.query.page, 10) || 1;
    // const limit = parseInt(req.query.limit, 10) || 10;
    // const offset = (page - 1) * limit;

    try {
        const query = `
            SELECT id, full_name, phone_number, email, telegram_user_id, is_active, created_at 
            FROM delivery_agents
            WHERE supplier_id = $1
            ORDER BY created_at DESC;
            -- LIMIT $2 OFFSET $3; -- For pagination
        `;
        // const result = await db.query(query, [supplierId, limit, offset]);
        const result = await db.query(query, [supplierId]); // Simpler without pagination for now

        // const countQuery = 'SELECT COUNT(*) AS total_items FROM delivery_agents WHERE supplier_id = $1';
        // const countResult = await db.query(countQuery, [supplierId]);
        // const totalItems = parseInt(countResult.rows[0].total_items, 10);
        // const totalPages = Math.ceil(totalItems / limit);

        res.json({
            items: result.rows,
            // currentPage: page,
            // totalPages: totalPages,
            // totalItems: totalItems
        });
        // For simpler response if not paginating: res.json(result.rows);

    } catch (err) {
        console.error(`[DELIVERY_AGENT_MGMT] Error fetching delivery agents for supplier ${supplierId}:`, err);
        res.status(500).json({ error: 'Failed to fetch delivery agents.' });
    }
});

// telegram-app-backend/server.js
// Ensure authSupplier is imported

// PUT - Supplier updates one of their own delivery agents
app.put('/api/supplier/delivery-agents/:agentId', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;
    const { agentId } = req.params;
    const parsedAgentId = parseInt(agentId, 10);

    const {
        full_name,
        phone_number, // Should be unique
        email,        // Optional, should be unique if provided
        telegram_user_id, // Optional, should be unique if provided
        // Password changes should ideally be a separate, more secure endpoint/flow
        // is_active is handled by a separate toggle endpoint
    } = req.body;

    if (isNaN(parsedAgentId)) {
        return res.status(400).json({ error: 'Invalid Delivery Agent ID format.' });
    }

    // Basic validation for fields being updated
    if (!full_name || full_name.trim() === '') {
        return res.status(400).json({ error: 'Full name is required.' });
    }
    if (!phone_number || phone_number.trim() === '') {
        return res.status(400).json({ error: 'Phone number is required.' });
    }
    // Add more specific validations for phone, email, telegram_user_id formats if necessary

    try {
        // Check if agent exists and belongs to this supplier
        const agentCheckResult = await db.query(
            'SELECT id FROM delivery_agents WHERE id = $1 AND supplier_id = $2',
            [parsedAgentId, supplierId]
        );

        if (agentCheckResult.rows.length === 0) {
            return res.status(404).json({ error: 'Delivery agent not found or you do not have permission to edit it.' });
        }

        // Construct SET clause dynamically based on provided fields
        const fieldsToUpdate = {};
        if (full_name !== undefined) fieldsToUpdate.full_name = full_name.trim();
        if (phone_number !== undefined) fieldsToUpdate.phone_number = phone_number.trim();
        if (email !== undefined) fieldsToUpdate.email = email ? email.toLowerCase().trim() : null;
        if (telegram_user_id !== undefined) fieldsToUpdate.telegram_user_id = telegram_user_id ? parseInt(telegram_user_id, 10) : null;
        
        if (Object.keys(fieldsToUpdate).length === 0) {
            return res.status(400).json({ error: 'No fields provided for update.' });
        }
        
        fieldsToUpdate.updated_at = new Date(); // Manual update, or rely on trigger

        const setClauses = Object.keys(fieldsToUpdate).map((key, index) => `${key} = $${index + 1}`).join(', ');
        const values = Object.values(fieldsToUpdate);
        values.push(parsedAgentId); // For WHERE id = $N
        values.push(supplierId);    // For WHERE supplier_id = $N+1

        const updateQuery = `
            UPDATE delivery_agents 
            SET ${setClauses}
            WHERE id = $${values.length - 1} AND supplier_id = $${values.length}
            RETURNING id, supplier_id, full_name, phone_number, email, telegram_user_id, is_active, created_at, updated_at;
        `;

        const result = await db.query(updateQuery, values);
        
        console.log(`[DELIVERY_AGENT_MGMT] Delivery agent ID ${result.rows[0].id} updated by supplier ID ${supplierId}`);
        res.status(200).json(result.rows[0]);

    } catch (err) {
        console.error(`[DELIVERY_AGENT_MGMT] Error updating delivery agent ${parsedAgentId} for supplier ${supplierId}:`, err);
        if (err.code === '23505') { // Unique constraint violation
             if (err.constraint && err.constraint.includes('phone_number')) return res.status(409).json({ error: 'This phone number is already in use by another agent.' });
             if (err.constraint && err.constraint.includes('email')) return res.status(409).json({ error: 'This email is already in use by another agent.' });
             if (err.constraint && err.constraint.includes('telegram_user_id')) return res.status(409).json({ error: 'This Telegram ID is already in use by another agent.' });
            return res.status(409).json({ error: 'A unique detail (phone, email, or Telegram ID) is already in use.' });
        }
        res.status(500).json({ error: 'Failed to update delivery agent.' });
    }
});

// telegram-app-backend/server.js
app.delete('/api/supplier/delivery-agents/:agentId', authSupplier, async (req, res) => { // START OF BLOCK
    const supplierId = req.supplier.supplierId;
    const { agentId } = req.params;
    const parsedAgentId = parseInt(agentId, 10);

    if (isNaN(parsedAgentId)) {
        return res.status(400).json({ error: 'Invalid Delivery Agent ID format.' });
    }

    try { // try block starts
        const deleteQuery = `
            DELETE FROM delivery_agents 
            WHERE id = $1 AND supplier_id = $2 
            RETURNING id;
        `;
        const result = await db.query(deleteQuery, [parsedAgentId, supplierId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Delivery agent not found or you do not have permission to delete it.' });
        }

        console.log(`[DELIVERY_AGENT_MGMT] Delivery agent ID ${parsedAgentId} deleted by supplier ID ${supplierId}`);
        res.status(200).json({ message: 'Delivery agent deleted successfully.', deletedAgentId: parsedAgentId });

    } catch (err) { // catch block starts
        console.error(`[DELIVERY_AGENT_MGMT] Error deleting delivery agent ${parsedAgentId} for supplier ${supplierId}:`, err);
        res.status(500).json({ error: 'Failed to delete delivery agent.' });
    } // catch block ends
}); // END OF BLOCK (closing parenthesis for async (req, res) => { ... } and closing semicolon for app.delete)

// telegram-app-backend/server.js

app.put('/api/supplier/delivery-agents/:agentId/toggle-active', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId;
    const { agentId } = req.params;
    const parsedAgentId = parseInt(agentId, 10);

    if (isNaN(parsedAgentId)) {
        return res.status(400).json({ error: 'Invalid Delivery Agent ID format.' });
    }

    try {
        const agentCheckResult = await db.query(
            'SELECT is_active FROM delivery_agents WHERE id = $1 AND supplier_id = $2',
            [parsedAgentId, supplierId]
        );

        if (agentCheckResult.rows.length === 0) {
            return res.status(404).json({ error: 'Delivery agent not found or you do not have permission to modify it.' });
        }

        const currentStatus = agentCheckResult.rows[0].is_active;
        const newStatus = !currentStatus;

        const updateResult = await db.query(
            'UPDATE delivery_agents SET is_active = $1, updated_at = NOW() WHERE id = $2 AND supplier_id = $3 RETURNING *', // Return full updated agent
            [newStatus, parsedAgentId, supplierId]
        );
        // Remove updated_at = NOW() if trigger exists

        console.log(`[DELIVERY_AGENT_MGMT] Agent ID ${parsedAgentId} status toggled to ${newStatus} by supplier ID ${supplierId}`);
        res.status(200).json(updateResult.rows[0]);

    } catch (err) {
        console.error(`[DELIVERY_AGENT_MGMT] Error toggling status for agent ${parsedAgentId} by supplier ${supplierId}:`, err);
        res.status(500).json({ error: 'Failed to update agent status.' });
    }
});
// TODO LATER for Supplier Panel:
// PUT /api/supplier/delivery-agents/:agentId (authSupplier) - Update an agent's details (name, phone, email, is_active)
// DELETE /api/supplier/delivery-agents/:agentId (authSupplier) - Delete an agent
// PUT /api/supplier/delivery-agents/:agentId/reset-password (authSupplier) - More complex password reset flow

// telegram-app-backend/server.js
// Ensure bcrypt and jwt are imported

app.post('/api/auth/delivery/login', async (req, res) => {
    const { phoneNumber, password } = req.body; // Using phone_number for login

    if (!phoneNumber || !password) {
        return res.status(400).json({ error: 'Phone number and password are required.' });
    }

    try {
        // Fetch agent and their supplier's status
        const agentQuery = `
            SELECT 
                da.id, da.full_name, da.phone_number, da.password_hash, da.is_active AS agent_is_active,
                da.supplier_id, s.is_active AS supplier_is_active
            FROM delivery_agents da
            JOIN suppliers s ON da.supplier_id = s.id
            WHERE da.phone_number = $1;
        `;
        const agentResult = await db.query(agentQuery, [phoneNumber.trim()]);

        if (agentResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials or agent not found.' });
        }

        const agent = agentResult.rows[0];

        if (!agent.agent_is_active) {
            return res.status(403).json({ error: 'Your agent account is inactive. Please contact your supplier.' });
        }
        if (!agent.supplier_is_active) {
            return res.status(403).json({ error: 'Your employing supplier account is inactive. Please contact them.' });
        }

        const match = await bcrypt.compare(password, agent.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid credentials.' });
        }

        // Generate JWT for Delivery Agent
        const tokenPayload = {
            deliveryAgentId: agent.id,
            supplierId: agent.supplier_id, // Useful to have in token
            name: agent.full_name,
            role: 'delivery_agent' // Explicit role
        };
        console.log("[DELIVERY_AUTH] Attempting to sign JWT. Secret from env:", process.env.JWT_DELIVERY_SECRET);
        const token = jwt.sign(tokenPayload, process.env.JWT_DELIVERY_SECRET, { expiresIn: '1d' }); // Use specific secret

        res.json({
            message: 'Delivery agent login successful',
            token,
            agent: {
                id: agent.id,
                name: agent.full_name,
                phoneNumber: agent.phone_number,
                supplierId: agent.supplier_id
            }
        });

    } catch (err) {
        console.error('[DELIVERY_AUTH] Login error:', err);
        res.status(500).json({ error: 'Internal server error during login.' });
    }
});

// telegram-app-backend/server.js


// telegram-app-backend/server.js
// Ensure authDeliveryAgent is imported: const authDeliveryAgent = require('./middleware/authDeliveryAgent');
// Ensure db is available: const db = require('./config/db');

app.get('/api/delivery/assigned-items', authDeliveryAgent, async (req, res) => {
    const deliveryAgentId = req.deliveryAgent.deliveryAgentId;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 15; // Default items per page
    const offset = (page - 1) * limit;

    // Default statuses if none provided by client via query param "statuses"
    let targetStatuses = ['assigned_to_agent', 'out_for_delivery']; // Default active tasks

    if (req.query.statuses) {
        const requestedStatuses = req.query.statuses.split(',').map(s => s.trim()).filter(s => s); // Trim and filter empty strings
        
        // Validate against a list of all possible/allowed statuses for security/correctness
        const allowedDeliveryItemStatuses = [
            'pending_assignment', // Should not typically be fetched by agent, but good to list all
            'assigned_to_agent', 
            'out_for_delivery', 
            'delivered', 
            'delivery_failed', 
            'payment_pending', 
            'returned'
        ];
        
        const validRequestedStatuses = requestedStatuses.filter(s => allowedDeliveryItemStatuses.includes(s));
        
        if (validRequestedStatuses.length > 0) {
            targetStatuses = validRequestedStatuses;
        } else if (requestedStatuses.length > 0 && validRequestedStatuses.length === 0) {
            // If statuses were provided but none were valid, return empty or error
            // For now, let's return empty for invalid filter. Or could default.
             console.log(`[DELIVERY_APP] Agent ${deliveryAgentId} requested invalid statuses: ${req.query.statuses}. Returning empty.`);
            return res.json({ items: [], currentPage: 1, totalPages: 0, totalItems: 0, currentFilterStatuses: [] });
        }
        // If req.query.statuses was empty string after split/trim, it defaults to targetStatuses
    }
    
    console.log(`[DELIVERY_APP] Agent ${deliveryAgentId} fetching items with statuses: ${targetStatuses.join(', ')} for page ${page}`);

    try {
        const itemsQuery = `
            SELECT 
                oi.id AS order_item_id, oi.quantity, oi.price_at_time_of_order,
                oi.delivery_item_status, oi.delivery_notes, oi.item_payment_collected, oi.item_delivered_at,
                p.name AS product_name, p.image_url AS product_image_url, p.description AS product_description,
                o.id AS order_id, o.order_date, o.delivery_status AS overall_order_delivery_status,
                up.full_name AS customer_name, up.phone_number AS customer_phone,
                up.address_line1 AS customer_address1, up.address_line2 AS customer_address2, up.city AS customer_city,
                (oi.quantity * oi.price_at_time_of_order) AS item_total_value 
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            JOIN orders o ON oi.order_id = o.id
            JOIN user_profiles up ON o.user_id = up.user_id
            WHERE oi.assigned_delivery_agent_id = $1
              AND oi.delivery_item_status = ANY($2::varchar[]) -- Use ANY for array of statuses
            ORDER BY 
                -- Custom sort to prioritize actionable items, then by date
                CASE oi.delivery_item_status
                    WHEN 'assigned_to_agent' THEN 1
                    WHEN 'out_for_delivery' THEN 2
                    WHEN 'payment_pending' THEN 3  -- Higher priority than failed/delivered
                    WHEN 'delivery_failed' THEN 4
                    WHEN 'delivered' THEN 5 
                    ELSE 6
                END ASC,
                o.order_date ASC, -- Older orders/items first within same status group
                o.id ASC, 
                oi.id ASC
            LIMIT $3 OFFSET $4;
        `;
        
        const itemsResult = await db.query(itemsQuery, [deliveryAgentId, targetStatuses, limit, offset]);
        
        const countQuery = `
            SELECT COUNT(*) AS total_items
            FROM order_items oi
            WHERE oi.assigned_delivery_agent_id = $1
              AND oi.delivery_item_status = ANY($2::varchar[]);
        `;
        const countResult = await db.query(countQuery, [deliveryAgentId, targetStatuses]);
        const totalItems = parseInt(countResult.rows[0].total_items, 10);
        const totalPages = Math.ceil(totalItems / limit);

        res.json({
            items: itemsResult.rows,
            currentPage: page,
            totalPages: totalPages,
            totalItems: totalItems,
            currentFilterStatuses: targetStatuses // Echo back the statuses that were actually used
        });

    } catch (err) {
        console.error(`[DELIVERY_APP] Error fetching assigned items for agent ${deliveryAgentId} with statuses ${targetStatuses.join(',')}:`, err);
        res.status(500).json({ error: 'Failed to fetch assigned delivery items.' });
    }
});


// telegram-app-backend/server.js

app.put('/api/delivery/order-items/:orderItemId/status', authDeliveryAgent, async (req, res) => {
    const deliveryAgentId = req.deliveryAgent.deliveryAgentId;
    const { orderItemId } = req.params;
    const parsedOrderItemId = parseInt(orderItemId, 10);
    const { newStatus, notes, paymentCollected } = req.body;

    // Validate newStatus against allowed values
    const allowedStatuses = ['out_for_delivery', 'delivered', 'delivery_failed', 'payment_pending'];
    if (!newStatus || !allowedStatuses.includes(newStatus)) {
        return res.status(400).json({ error: `Invalid new status. Must be one of: ${allowedStatuses.join(', ')}` });
    }
    if (isNaN(parsedOrderItemId)) {
        return res.status(400).json({ error: 'Invalid Order Item ID.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // Verify item is assigned to this agent
        const checkQuery = 'SELECT id, order_id FROM order_items WHERE id = $1 AND assigned_delivery_agent_id = $2';
        const checkResult = await client.query(checkQuery, [parsedOrderItemId, deliveryAgentId]);

        if (checkResult.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(403).json({ error: 'Order item not found or not assigned to you.' });
        }
        
        const order_id = checkResult.rows[0].order_id; // Get order_id for potential overall status update

        // Update the order item
        let updateQuery = 'UPDATE order_items SET delivery_item_status = $1';
        const queryParams = [newStatus];
        let paramCount = 1;

        if (notes !== undefined) {
            updateQuery += `, delivery_notes = $${++paramCount}`;
            queryParams.push(notes);
        }
        if (paymentCollected !== undefined) {
            updateQuery += `, item_payment_collected = $${++paramCount}`;
            queryParams.push(Boolean(paymentCollected));
        }
        if (newStatus === 'delivered') {
            updateQuery += `, item_delivered_at = NOW()`; // Set delivery timestamp
        }
        
        updateQuery += ` WHERE id = $${++paramCount} RETURNING *;`;
        queryParams.push(parsedOrderItemId);

        const result = await client.query(updateQuery, queryParams);

        // TODO LATER: After item status update, check if all items in the order (or all items from this supplier in the order)
        // have reached a final status, and if so, update the main orders.delivery_status.
        // This can be complex if an order has items from multiple suppliers.
        // For now, we just update the item.

        await client.query('COMMIT');
        console.log(`[DELIVERY_APP] Item ${parsedOrderItemId} status updated to ${newStatus} by agent ${deliveryAgentId}`);
        res.status(200).json(result.rows[0]);

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error(`[DELIVERY_APP] Error updating status for item ${parsedOrderItemId}:`, err);
        res.status(500).json({ error: 'Failed to update item status.' });
    } finally {
        if (client) client.release();
    }
});
// ... (app.listen) ...
app.post('/api/auth/delivery/verify-telegram', async (req, res) => {
    const { initData } = req.body;

    if (!initData) {
        return res.status(400).json({ error: 'initData is required.' });
    }

    // --- 1. Validate initData ---
    // (Refer to Telegram's documentation for the most up-to-date validation method)
    // The general idea is to check the hash parameter against a calculated hash.
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash'); // Remove hash from params before sorting and stringifying

    // Sort parameters alphabetically by key
    const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = sortedParams.map(([key, value]) => `${key}=${value}`).join('\n');

    if (!process.env.TELEGRAM_BOT_TOKEN) {
        console.error("[VERIFY_TG_AUTH] TELEGRAM_BOT_TOKEN is not set in .env!");
        return res.status(500).json({ error: "Server configuration error." });
    }

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) {
        console.warn("[VERIFY_TG_AUTH] initData hash validation failed.", { receivedHash: hash, calculatedHash });
        return res.status(403).json({ error: 'Invalid initData: Hash mismatch.' });
    }
    console.log("[VERIFY_TG_AUTH] initData hash validated successfully.");

    // --- 2. Extract User Information ---
    const userParam = params.get('user');
    if (!userParam) {
        return res.status(400).json({ error: 'User data not found in initData.' });
    }

    let telegramUser;
    try {
        telegramUser = JSON.parse(userParam);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid user data format in initData.' });
    }

    if (!telegramUser || !telegramUser.id) {
        return res.status(400).json({ error: 'Telegram User ID not found.' });
    }
    const telegramUserId = telegramUser.id;
    console.log(`[VERIFY_TG_AUTH] Attempting login for Telegram User ID: ${telegramUserId}`);

    // --- 3. Find Delivery Agent by Telegram User ID & Check Statuses ---
    try {
        const agentQuery = `
            SELECT 
                da.id, da.full_name, da.phone_number, da.is_active AS agent_is_active,
                da.supplier_id, s.is_active AS supplier_is_active, s.name as supplier_name
            FROM delivery_agents da
            JOIN suppliers s ON da.supplier_id = s.id
            WHERE da.telegram_user_id = $1;
        `;
        const agentResult = await db.query(agentQuery, [telegramUserId]);

        if (agentResult.rows.length === 0) {
            console.log(`[VERIFY_TG_AUTH] No delivery agent found for Telegram User ID: ${telegramUserId}`);
            return res.status(404).json({ error: 'Not registered as a delivery agent with this Telegram account.' });
        }

        const agent = agentResult.rows[0];

        if (!agent.agent_is_active) {
            return res.status(403).json({ error: 'Your agent account is inactive. Please contact your supplier.' });
        }
        if (!agent.supplier_is_active) {
            return res.status(403).json({ error: 'Your employing supplier account is inactive. Please contact them.' });
        }

        // --- 4. Generate JWT ---
        const tokenPayload = {
            deliveryAgentId: agent.id,
            supplierId: agent.supplier_id,
            name: agent.full_name,
            role: 'delivery_agent',
            telegramUserId: telegramUserId // Include TG ID in token if useful
        };
        const token = jwt.sign(tokenPayload, process.env.JWT_DELIVERY_SECRET, { expiresIn: '1d' });

        res.json({
            message: 'Telegram login successful for delivery agent.',
            token,
            agent: {
                id: agent.id,
                name: agent.full_name,
                phoneNumber: agent.phone_number, // May be null if not set
                supplierId: agent.supplier_id,
                supplierName: agent.supplier_name, // Added for frontend convenience
                telegramUserId: telegramUserId
            }
        });

    } catch (dbError) {
        console.error('[VERIFY_TG_AUTH] Database or JWT error:', dbError);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// Add this new route to your backend server file (e.g., server.js)

app.get('/api/favorites/product-details/:productId', async (req, res) => {
    const { productId } = req.params;
    const parsedProductId = parseInt(productId, 10);

    if (isNaN(parsedProductId)) {
        return res.status(400).json({ error: 'Invalid Product ID.' });
    }

    console.log(`[FAVORITE_DETAILS] Fetching details for favorited product ID: ${parsedProductId}`);

    try {
        // Step 1: Fetch the originally favorited product to get its details, supplier status, and master_product_id.
        const originalProductQuery = `
            SELECT 
                p.id, p.name, p.description, p.price AS supplier_base_price, 
                p.discount_price AS supplier_discount_price, p.is_on_sale AS supplier_is_on_sale,
                p.category, p.image_url, p.stock_level, p.supplier_id, p.master_product_id,
                s.name as supplier_name,
                s.is_active as supplier_is_active, -- This is the key field!
                COALESCE(mp.current_price_adjustment_percentage, 0.0000) AS price_adjustment_percentage,
                mp.display_name AS master_product_display_name,
                mp.image_url AS master_product_image_url
            FROM products p
            JOIN suppliers s ON p.supplier_id = s.id
            LEFT JOIN master_products mp ON p.master_product_id = mp.id
            WHERE p.id = $1;
        `;
        const originalProductResult = await db.query(originalProductQuery, [parsedProductId]);
        
        if (originalProductResult.rows.length === 0) {
            // This case handles if the product was somehow deleted despite the plan. It's a good fallback.
            return res.status(404).json({ 
                error: 'المنتج الأصلي الذي أضفته للمفضلة لم يعد موجوداً.',
                isAvailable: false,
                originalProduct: null,
                alternatives: []
            });
        }
        
        const originalProduct = originalProductResult.rows[0];

        // --- Calculate effective price and determine display name/image for the original product ---
        let basePriceForCalc = parseFloat(originalProduct.supplier_base_price);
        if (originalProduct.supplier_is_on_sale && originalProduct.supplier_discount_price !== null) {
            basePriceForCalc = parseFloat(originalProduct.supplier_discount_price);
        }
        const adjustment = parseFloat(originalProduct.price_adjustment_percentage);
        originalProduct.effective_selling_price = parseFloat((basePriceForCalc * (1 + adjustment)).toFixed(2));
        originalProduct.name = originalProduct.master_product_display_name || originalProduct.name;
        originalProduct.image_url = originalProduct.master_product_image_url || originalProduct.image_url;

        // --- Determine availability and get master ID ---
        const masterProductId = originalProduct.master_product_id;
        const isOriginalAvailable = originalProduct.supplier_is_active && originalProduct.stock_level > 0; // The availability is determined by this flag.

        // Step 2: Fetch available alternatives from *other* active suppliers.
        let alternatives = [];
        if (masterProductId) {
            const alternativesQuery = `
                SELECT 
                    p.id, p.name, p.price AS supplier_base_price, p.discount_price AS supplier_discount_price,
                    p.is_on_sale AS supplier_is_on_sale, p.image_url,
                    s.id as supplier_id, s.name as supplier_name,
                    COALESCE(mp.current_price_adjustment_percentage, 0.0000) AS price_adjustment_percentage,
                    mp.display_name AS master_product_display_name,
                    mp.image_url AS master_product_image_url
                FROM products p
                JOIN suppliers s ON p.supplier_id = s.id
                LEFT JOIN master_products mp ON p.master_product_id = mp.id
                WHERE p.master_product_id = $1 -- Match by master ID
                  AND p.id != $2               -- Exclude the original product itself
                  AND s.is_active = TRUE;      -- Only from active suppliers!
            `;
            const alternativesResult = await db.query(alternativesQuery, [masterProductId, parsedProductId]);
            
            // Calculate effective price for each alternative
            alternatives = alternativesResult.rows.map(alt => {
                let altBasePrice = parseFloat(alt.supplier_base_price);
                if (alt.supplier_is_on_sale && alt.supplier_discount_price !== null) {
                    altBasePrice = parseFloat(alt.supplier_discount_price);
                }
                const altAdjustment = parseFloat(alt.price_adjustment_percentage);
                const altEffectivePrice = altBasePrice * (1 + altAdjustment);

                return {
                    id: alt.id,
                    name: alt.master_product_display_name || alt.name,
                    image_url: alt.master_product_image_url || alt.image_url,
                    supplier_id: alt.supplier_id,
                    supplier_name: alt.supplier_name,
                    effective_selling_price: parseFloat(altEffectivePrice.toFixed(2)),
                };
            });
        }

        console.log(`[FAVORITE_DETAILS] Found ${alternatives.length} alternatives for product ${parsedProductId}`);

        // Step 3: Construct the final response object for the frontend.
        res.status(200).json({
            originalProduct: originalProduct,
            isAvailable: isOriginalAvailable,
            alternatives: alternatives
        });

    } catch (err) {
        console.error(`[FAVORITE_DETAILS] Error fetching details for product ${parsedProductId}:`, err);
        res.status(500).json({ error: 'Failed to fetch product details and alternatives' });
    }
});

app.get('/api/cities', async (req, res) => {
    try {
        const result = await db.query('SELECT id, name FROM cities WHERE is_active = TRUE ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        console.error("[CITIES] Error fetching cities:", err);
        res.status(500).json({ error: 'Failed to fetch cities' });
    }
});

// --- Cron Job Scheduling ---
// Example: Run every hour at the 0th minute.
// For testing, you might use '*/1 * * * *' (every minute) - BE CAREFUL with frequent DB updates.
// '0 */2 * * *' would be every 2 hours at minute 0.
const CRON_SCHEDULE = '0 */6 * * *'; // Every 6 hours at minute 0

if (cron.validate(CRON_SCHEDULE)) {
    console.log(`[CRON_SCHEDULER] Scheduling price adjustment job with pattern: ${CRON_SCHEDULE}`);
    cron.schedule(CRON_SCHEDULE, () => {
        console.log(`[CRON_SCHEDULER] Triggering scheduled price adjustment task at ${new Date().toISOString()}`);
        pricingEngine.calculateDemandAndAdjustPercentage();
    });
} else {
    console.error(`[CRON_SCHEDULER] Invalid cron schedule pattern: ${CRON_SCHEDULE}. Job not scheduled.`);
}

// For immediate testing on startup (optional, remove for production)
// setTimeout(() => {
//    console.log("[STARTUP_TRIGGER] Manually triggering price adjustment engine for testing...");
//    pricingEngine.calculateDemandAndAdjustPercentage();
// }, 45000); // e.g., 45 seconds after server starts to ensure DB is ready


// const PORT = process.env.PORT || 3001;
// app.listen(PORT, () => { ... });
// TODO LATER:
// PUT /api/supplier/deals/:dealId (authSupplier) - for editing
// DELETE /api/supplier/deals/:dealId (authSupplier) - for deleting
// ... (app.listen) ...
// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});