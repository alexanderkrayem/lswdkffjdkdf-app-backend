// server.js
require('dotenv').config(); // Load environment variables from .env file
const db = require('./config/db'); // Import the db config
const express = require('express');
const cors = require('cors');
const authSupplier = require('./middleware/authSupplier'); // <<< IMPORT
const app = express();
const PORT = process.env.PORT || 3001; // Use port from .env or default to 3001
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const authAdmin = require('./middleware/authAdmin'); // IMPORT THIS

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

app.get('/api/search', async (req, res) => {
    const searchTerm = req.query.searchTerm || '';
    const MIN_SEARCH_LENGTH = 3;
    const DEFAULT_RESULTS_LIMIT = 10;

    const categoryFilter = req.query.category || '';
    // ... other filters like supplierIdFilter, minPriceFilter, maxPriceFilter, sortBy ...
    // ... pagination for products: productPage, productLimit, safeProductPage, safeProductLimit, productOffset ...
    // (Keeping your existing filter and pagination variable declarations)
    const productPage = parseInt(req.query.page, 10) || 1;
    const productLimit = parseInt(req.query.limit, 10) || DEFAULT_RESULTS_LIMIT;
    const safeProductPage = Math.max(1, productPage);
    const safeProductLimit = Math.max(1, productLimit);
    const productOffset = (safeProductPage - 1) * safeProductLimit;


    if (searchTerm.trim().length < MIN_SEARCH_LENGTH && !categoryFilter /* && other filters are also empty */) {
        // ... (your existing return for short search term) ...
        return res.json({ /* ... empty results ... */ });
    }

    const ftsQueryString = `websearch_to_tsquery('pg_catalog.arabic', $1)`;
    const trigramThreshold = 0.1; // Your existing threshold

    try {
        // --- Product Search ---
        // Main change: JOIN suppliers s and add s.is_active = TRUE
        let productsQuery = `
            SELECT
                p.id, p.name, p.category, p.price, p.discount_price, p.is_on_sale, p.image_url, p.supplier_id, s_prod.name as supplier_name
                ${searchTerm.trim() ? `, ts_rank_cd(p.tsv, product_fts_query.query) AS rank` : ''}
            FROM products p
            LEFT JOIN suppliers s_prod ON p.supplier_id = s_prod.id  -- Renamed alias to s_prod to avoid conflict
            ${searchTerm.trim() ? `, LATERAL ${ftsQueryString} AS product_fts_query(query)` : ''}
        `;
        let productCountQuery = `
            SELECT COUNT(DISTINCT p.id) AS total_items 
            FROM products p 
            LEFT JOIN suppliers s_prod ON p.supplier_id = s_prod.id -- Renamed alias
            ${searchTerm.trim() ? `, LATERAL ${ftsQueryString} AS product_fts_query(query)` : ''}
        `;

        const productWhereClauses = ["s_prod.is_active = TRUE"]; // <<< ADDED: Filter by active supplier for products
        const productQueryParams = [];
        let productParamCount = 0;

        if (searchTerm.trim()) {
            productQueryParams.push(searchTerm.trim());
            productWhereClauses.push(`(p.tsv @@ product_fts_query.query OR similarity(p.name, $${productParamCount + 1}) > $${productParamCount + 2})`);
            productQueryParams.push(trigramThreshold);
            productParamCount = 2;
        }
        // ... (your existing code for adding categoryFilter, supplierIdFilter, minPriceFilter, maxPriceFilter to productWhereClauses and productQueryParams) ...
        // Ensure those filters use p.category, p.supplier_id etc.

        if (productWhereClauses.length > 0) {
            const whereString = ' WHERE ' + productWhereClauses.join(' AND ');
            productsQuery += whereString;
            productCountQuery += whereString;
        }

        // ... (your existing productOrderBy logic) ...
        let productOrderBy = ''; // Your existing sorting logic
        if (searchTerm.trim()) { // Example, adapt your full logic
            productOrderBy = ` ORDER BY CASE WHEN p.tsv @@ product_fts_query.query THEN 0 ELSE 1 END, ts_rank_cd(p.tsv, product_fts_query.query) DESC, similarity(p.name, $1) DESC, p.created_at DESC`;
        } else {
            productOrderBy = ' ORDER BY p.created_at DESC';
        }
        productsQuery += productOrderBy;


        productsQuery += ` LIMIT $${++productParamCount} OFFSET $${++productParamCount}`;
        productQueryParams.push(safeProductLimit, productOffset);
        
        const productCountQueryParams = productQueryParams.slice(0, productQueryParams.length - 2);

        console.log("Product Query (Search):", productsQuery, productQueryParams);
        const productsResult = await db.query(productsQuery, productQueryParams);
        console.log("Product Count Query (Search):", productCountQuery, productCountQueryParams);
        const productCountResult = await db.query(productCountQuery, productCountQueryParams);
        // ... (rest of your product pagination setup) ...
        const totalProductItems = parseInt(productCountResult.rows[0].total_items, 10);
        const totalProductPages = Math.ceil(totalProductItems / safeProductLimit);
        const paginatedProducts = {
            items: productsResult.rows,
            currentPage: safeProductPage,
            totalPages: totalProductPages,
            totalItems: totalProductItems,
            limit: safeProductLimit
        };


        // --- Deals Search ---
        // Main change: If deals are linked to suppliers, join and check supplier's is_active status
        let dealsResult = { rows: [] };
        if (searchTerm.trim()) {
            // Assuming d.supplier_id can be NULL for platform deals
            const dealsQuery = `
                SELECT d.id, d.title, d.description, d.image_url, ts_rank_cd(d.tsv, query) AS rank
                FROM deals d
                LEFT JOIN suppliers s_deal ON d.supplier_id = s_deal.id -- Join to check supplier status
                , ${ftsQueryString} query
                WHERE d.is_active = TRUE 
                  AND (d.supplier_id IS NULL OR s_deal.is_active = TRUE) -- Deal is platform OR its supplier is active
                  AND (d.tsv @@ query OR similarity(d.title, $1) > $2)
                ORDER BY CASE WHEN d.tsv @@ query THEN 0 ELSE 1 END, ts_rank_cd(d.tsv, query) DESC, similarity(d.title, $1) DESC, d.created_at DESC
                LIMIT $3;
            `;
            dealsResult = await db.query(dealsQuery, [searchTerm.trim(), trigramThreshold, DEFAULT_RESULTS_LIMIT]);
        }

        // --- Suppliers Search ---
        // Main change: Add WHERE s.is_active = TRUE
        let suppliersResult = { rows: [] };
        if (searchTerm.trim()) {
            const suppliersQuery = `
                SELECT s.id, s.name, s.category, s.location, s.rating, s.image_url, ts_rank_cd(s.tsv, query) AS rank
                FROM suppliers s, ${ftsQueryString} query
                WHERE s.is_active = TRUE -- <<< ADDED: Filter for active suppliers
                  AND (s.tsv @@ query OR similarity(s.name, $1) > $2)
                ORDER BY CASE WHEN s.tsv @@ query THEN 0 ELSE 1 END, ts_rank_cd(s.tsv, query) DESC, similarity(s.name, $1) DESC, s.id
                LIMIT $3;
            `;
            suppliersResult = await db.query(suppliersQuery, [searchTerm.trim(), trigramThreshold, DEFAULT_RESULTS_LIMIT]);
        }

        res.json({
            searchTerm: searchTerm,
            // ... (your existing filters echo back) ...
            results: {
                products: paginatedProducts,
                deals: dealsResult.rows,
                suppliers: suppliersResult.rows
            }
        });

    } catch (err) {
        // ... (your existing error handling) ...
        console.error(`Error during global search:`, err);
        res.status(500).json({ error: 'Failed to perform search' });
    }
});

// ... (rest of server.js, app.listen) ...
// telegram-app-backend/server.js
// ... (other require statements, middleware, existing routes) ...

// --- NEW: GET all active deals ---
// telegram-app-backend/server.js

app.get('/api/deals', async (req, res) => {
    try {
        const query = `
            SELECT 
                d.id, d.title, d.description, d.discount_percentage, 
                d.start_date, d.end_date, d.product_id, d.supplier_id, d.image_url, 
                d.is_active, d.created_at,
                s.name AS supplier_name -- Optionally fetch supplier name if needed by frontend list
            FROM deals d
            LEFT JOIN suppliers s ON d.supplier_id = s.id -- Join to check supplier status
            WHERE d.is_active = TRUE 
              AND (d.end_date IS NULL OR d.end_date >= CURRENT_DATE) -- Filter out expired deals
              AND (d.supplier_id IS NULL OR s.is_active = TRUE) -- <<< MODIFIED: Deal is platform OR its supplier is active
            ORDER BY d.created_at DESC; 
        `;
        const result = await db.query(query);
        console.log(`[DEALS_LIST] Fetched ${result.rows.length} active deals.`);
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
app.get('/api/products', async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, limit);
    const offset = (safePage - 1) * safeLimit;

    // --- LATER: For category filters etc., they would be added to WHERE clauses below ---
    // const categoryFilter = req.query.category || ''; 

    try {
        let itemsQuery = `
            SELECT p.* 
            FROM products p
            JOIN suppliers s ON p.supplier_id = s.id
        `;
        const queryParams = [];
        let paramCount = 0;
        let whereClauses = ["s.is_active = TRUE"]; // Start with active supplier filter

        // --- LATER: Add other filters here if needed ---
        // if (categoryFilter) {
        //     whereClauses.push(`p.category ILIKE $${++paramCount}`);
        //     queryParams.push(`%${categoryFilter}%`);
        // }
        
        if (whereClauses.length > 0) {
            itemsQuery += ' WHERE ' + whereClauses.join(' AND ');
        }

        itemsQuery += ' ORDER BY p.created_at DESC';
        itemsQuery += ` LIMIT $${++paramCount} OFFSET $${++paramCount}`;
        queryParams.push(safeLimit, offset);

        const itemsResult = await db.query(itemsQuery, queryParams);
        const products = itemsResult.rows;

        // --- Count Query ---
        let countQuery = `
            SELECT COUNT(DISTINCT p.id) AS total_items 
            FROM products p
            JOIN suppliers s ON p.supplier_id = s.id
        `;
        const countQueryParams = []; // Parameters for the WHERE clause of count query
        let countParamCountInternal = 0; // Separate counter for these params
        let countWhereClauses = ["s.is_active = TRUE"];


        // --- LATER: Add SAME other filters here ---
        // if (categoryFilter) {
        //     countWhereClauses.push(`p.category ILIKE $${++countParamCountInternal}`);
        //     countQueryParams.push(`%${categoryFilter}%`);
        // }

        if (countWhereClauses.length > 0) {
            countQuery += ' WHERE ' + countWhereClauses.join(' AND ');
        }
        
        const countResult = await db.query(countQuery, countQueryParams); // Pass only filter params
        const totalItems = parseInt(countResult.rows[0].total_items, 10);
        const totalPages = Math.ceil(totalItems / safeLimit);

        res.json({
            items: products,
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
                p.price, 
                p.discount_price, 
                p.category, 
                p.image_url, 
                p.is_on_sale, 
                p.stock_level, 
                p.created_at,
                p.supplier_id,
                s.name AS supplier_name 
                -- p.*, s.name AS supplier_name -- Simpler way to select all from p
            FROM products p
            LEFT JOIN suppliers s ON p.supplier_id = s.id
            WHERE p.id = ANY($1::int[]) 
              AND s.is_active = TRUE; -- <<< MODIFIED: Only products from active suppliers
        `;
        // $1::int[] tells PostgreSQL to treat the parameter as an array of integers.

        const result = await db.query(query, [productIds]);
        
        console.log(`[BATCH_PRODUCTS] Fetched ${result.rows.length} products for IDs: ${productIds.join(',')}, considering active suppliers.`);
        res.json(result.rows);

    } catch (err) {
        console.error('[BATCH_PRODUCTS] Error fetching products by batch:', err);
        res.status(500).json({ error: 'Failed to fetch products by batch' });
    }
});

// ... (rest of server.js, app.listen) ...
// --- NEW: GET a single product by ID ---
// e.g., /api/products/123
app.get('/api/products/:productId', async (req, res) => {
    const { productId } = req.params; // Get productId from URL parameters

    // Validate if productId is a number (basic validation)
    if (isNaN(parseInt(productId, 10))) {
        return res.status(400).json({ error: 'Invalid Product ID format.' });
    }

    try {
        const query = `
            SELECT 
                p.id, 
                p.name, 
                p.description, 
                p.price, 
                p.discount_price, 
                p.category, 
                p.image_url, 
                p.is_on_sale, 
                p.stock_level, 
                p.created_at,
                p.supplier_id, 
                s.name AS supplier_name,  -- Include supplier's name
                s.location AS supplier_location -- Optionally include supplier's location
                -- Add any other product fields you need for the detail view
            FROM products p
            LEFT JOIN suppliers s ON p.supplier_id = s.id -- LEFT JOIN to still get product if supplier is missing (though unlikely with FKs)
            WHERE p.id = $1;
        `;
        // Parameterized query to prevent SQL injection
        const result = await db.query(query, [productId]);

        if (result.rows.length > 0) {
            res.json(result.rows[0]); // Send the first (and should be only) product found
        } else {
            res.status(404).json({ error: 'Product not found' }); // No product with that ID
        }
    } catch (err) {
        console.error(`Error fetching product with ID ${productId}:`, err);
        res.status(500).json({ error: 'Failed to fetch product details' });
    }
});

// ... (other routes, app.listen) ...

// --- NEW: GET all suppliers ---
app.get('/api/suppliers', async (req, res) => {
  try {
      // Select relevant columns from the suppliers table
      // Order by name or rating, for example
      const result = await db.query('SELECT id, name, category, location, rating, image_url FROM suppliers ORDER BY name ASC');

      // Send the results back as JSON
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
app.get('/api/user/profile', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
  }

  try {
      const query = 'SELECT user_id, full_name, phone_number, address_line1, address_line2, city FROM user_profiles WHERE user_id = $1';
      const result = await db.query(query, [userId]);

      if (result.rows.length > 0) {
          res.json(result.rows[0]); // Send the profile data
      } else {
          res.status(404).json({ message: 'User profile not found' }); // User exists in TG but no profile saved yet
      }
  } catch (err) {
      console.error(`Error fetching profile for user ${userId}:`, err);
      res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// POST (Create or Update) user profile
// Expects profile data in request body: { userId, fullName, phoneNumber, addressLine1, addressLine2, city }
app.post('/api/user/profile', async (req, res) => {
  const { userId, fullName, phoneNumber, addressLine1, addressLine2, city } = req.body;

  // Basic validation
  if (!userId || !addressLine1 || !city ) { // Add more required fields as needed (e.g., fullName, phoneNumber)
      return res.status(400).json({ error: 'Missing required profile fields (userId, addressLine1, city)' });
  }

  try {
      // Use INSERT ... ON CONFLICT to UPSERT (update if exists, insert if not)
      const query = `
          INSERT INTO user_profiles (user_id, full_name, phone_number, address_line1, address_line2, city)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id)
          DO UPDATE SET
              full_name = EXCLUDED.full_name,
              phone_number = EXCLUDED.phone_number,
              address_line1 = EXCLUDED.address_line1,
              address_line2 = EXCLUDED.address_line2,
              city = EXCLUDED.city,
              updated_at = NOW() -- Manually update updated_at or rely on trigger if created
          RETURNING user_id, full_name, phone_number, address_line1, address_line2, city; -- Return the saved data
      `;
      const values = [userId, fullName, phoneNumber, addressLine1, addressLine2, city];
      const result = await db.query(query, values);

      res.status(200).json(result.rows[0]); // Send back the created/updated profile

  } catch (err) {
      console.error(`Error creating/updating profile for user ${userId}:`, err);
      res.status(500).json({ error: 'Failed to save user profile' });
  }
});


// --- NEW: Orders API Endpoint ---

// POST Create a new order from user's cart
// Expects { userId } in request body
app.post('/api/orders', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
  }

  // Use a database client for transaction control
  const client = await db.pool.connect(); // Get a client from the pool

  try {
      // --- Start Transaction ---
      await client.query('BEGIN');
      console.log(`Order Transaction BEGIN for user ${userId}`);

      // 1. Fetch cart items and product details for the user, lock rows for update
      // Locking ensures price/stock doesn't change between reading cart and creating order
      // (Optional but safer for high traffic - FOR UPDATE requires careful use)
      // Simpler approach first: just fetch current cart.
      const cartQuery = `
          SELECT
              ci.product_id,
              ci.quantity,
              p.price,
              p.discount_price,
              p.is_on_sale
          FROM cart_items ci
          JOIN products p ON ci.product_id = p.id
          WHERE ci.user_id = $1;
          -- FOR UPDATE; -- Optional: If you need to lock products during checkout
      `;
      const cartResult = await client.query(cartQuery, [userId]);
      const cartItems = cartResult.rows;

      if (cartItems.length === 0) {
          await client.query('ROLLBACK'); // Rollback transaction
          console.log(`Order Transaction ROLLBACK for user ${userId} - Cart empty`);
          return res.status(400).json({ error: 'Cart is empty, cannot create order' });
      }

      // 2. Calculate total amount and prepare order items
      let totalAmount = 0;
      const orderItemsData = cartItems.map(item => {
          const priceAtOrderTime = item.is_on_sale && item.discount_price ? item.discount_price : item.price;
          totalAmount += parseFloat(priceAtOrderTime) * item.quantity;
          return {
              productId: item.product_id,
              quantity: item.quantity,
              priceAtTimeOfOrder: priceAtOrderTime
          };
      });
      console.log(`Order Calculation for user ${userId}: Total=${totalAmount}, Items=${orderItemsData.length}`);

      // 3. Insert into orders table
      const orderInsertQuery = `
          INSERT INTO orders (user_id, total_amount, status)
          VALUES ($1, $2, $3)
          RETURNING id; -- Get the new order ID
      `;
      const orderInsertResult = await client.query(orderInsertQuery, [userId, totalAmount, 'pending']); // Default status 'pending'
      const newOrderId = orderInsertResult.rows[0].id;
      console.log(`Order Created for user ${userId}: OrderID=${newOrderId}`);


      // 4. Insert into order_items table
      // Construct a multi-row insert query for efficiency
      const orderItemsInsertQuery = `
          INSERT INTO order_items (order_id, product_id, quantity, price_at_time_of_order)
          VALUES ${orderItemsData.map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`).join(', ')}
      `;
      // Flatten the values array: [orderId, productId1, qty1, price1, orderId, productId2, qty2, price2, ...]
      const orderItemsValues = orderItemsData.reduce((acc, item) => {
          acc.push(newOrderId, item.productId, item.quantity, item.priceAtTimeOfOrder);
          return acc;
      }, []);

      await client.query(orderItemsInsertQuery, orderItemsValues);
       console.log(`Order Items Inserted for user ${userId}, OrderID=${newOrderId}`);

      // 5. Delete items from cart_items table
      const cartDeleteQuery = 'DELETE FROM cart_items WHERE user_id = $1';
      await client.query(cartDeleteQuery, [userId]);
      console.log(`Cart Cleared for user ${userId}`);

      // --- Commit Transaction ---
      await client.query('COMMIT');
      console.log(`Order Transaction COMMIT for user ${userId}, OrderID=${newOrderId}`);

      res.status(201).json({ message: 'Order created successfully', orderId: newOrderId });

  } catch (err) {
      // --- Rollback Transaction on Error ---
      await client.query('ROLLBACK');
      console.error(`Order Transaction ROLLBACK for user ${userId} due to error:`, err);
      res.status(500).json({ error: 'Failed to create order' });
  } finally {
      // --- Release Client Back to Pool ---
      client.release();
       console.log(`Database client released for user ${userId} order transaction.`);
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
app.get('/api/cart', async (req, res) => {
  const userId = req.query.userId;

  // Basic validation
  if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
  }

  try {
      // Join cart_items with products to get product details
      const query = `
          SELECT
              ci.product_id,
              ci.quantity,
              p.name,
              p.price,
              p.discount_price,
              p.image_url,
              p.is_on_sale
          FROM cart_items ci
          JOIN products p ON ci.product_id = p.id
          WHERE ci.user_id = $1
          ORDER BY ci.added_at DESC;
      `;
      const result = await db.query(query, [userId]);
      res.json(result.rows); // Send array of cart items with product details

  } catch (err) {
      console.error(`Error fetching cart for user ${userId}:`, err);
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
app.post('/api/supplier/products', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId; // From authenticated JWT
    const { 
        name, 
        description, 
        price, 
        discount_price, // Optional
        category, 
        image_url,      // Optional
        is_on_sale,     // Optional, boolean
        stock_level     // Optional, integer
    } = req.body;

    // Basic Validation
    if (!name || !price || !category) { // Add more required fields as necessary
        return res.status(400).json({ error: 'Name, price, and category are required.' });
    }
    if (isNaN(parseFloat(price)) || parseFloat(price) < 0) {
         return res.status(400).json({ error: 'Invalid price format.' });
    }
    if (discount_price && (isNaN(parseFloat(discount_price)) || parseFloat(discount_price) < 0)) {
        return res.status(400).json({ error: 'Invalid discount price format.' });
    }
    if (stock_level && (isNaN(parseInt(stock_level)) || parseInt(stock_level) < 0)) {
        return res.status(400).json({ error: 'Invalid stock level format.' });
    }


    try {
        const query = `
            INSERT INTO products 
                (supplier_id, name, description, price, discount_price, category, image_url, is_on_sale, stock_level, created_at)
            VALUES 
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            RETURNING *; -- Return the newly created product
        `;
        const values = [
            supplierId,
            name,
            description || null, // Default to null if not provided
            parseFloat(price),
            discount_price ? parseFloat(discount_price) : null,
            category,
            image_url || null,
            is_on_sale || false, // Default to false
            stock_level ? parseInt(stock_level) : 0 // Default to 0
        ];

        const result = await db.query(query, values);
        res.status(201).json(result.rows[0]); // Send back the created product
    } catch (err) {
        console.error(`Error creating product for supplier ${supplierId}:`, err);
        // Check for specific DB errors if needed (e.g., foreign key violation if category was a FK)
        res.status(500).json({ error: 'Failed to create product.' });
    }
});
// server.js
// ... (authSupplier middleware, GET and POST /api/supplier/products routes) ...

// PUT - Update an existing product for the authenticated supplier
// server.js
// Ensure authSupplier middleware is imported: const authSupplier = require('./middleware/authSupplier');
// Ensure db object is available: const db = require('./config/db');

// PUT - Update an existing product for the authenticated supplier
app.put('/api/supplier/products/:productId', authSupplier, async (req, res) => {
    const supplierId = req.supplier.supplierId; // From JWT middleware
    const { productId } = req.params;
    const {
        name,
        description,
        price,
        discount_price, // Can be null or a value
        category,
        image_url,      // Can be null or a value
        is_on_sale,     // Should be boolean
        stock_level     // Should be integer
    } = req.body;

    // --- Input Validation ---
    const parsedProductId = parseInt(productId, 10);
    if (isNaN(parsedProductId)) {
        return res.status(400).json({ error: 'Invalid Product ID format.' });
    }

    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'Product name is required and cannot be empty.' });
    }
    if (price === undefined || isNaN(parseFloat(price)) || parseFloat(price) < 0) {
        return res.status(400).json({ error: 'Valid product price is required.' });
    }
    if (!category || typeof category !== 'string' || category.trim() === '') {
        return res.status(400).json({ error: 'Product category is required.' });
    }
    if (discount_price !== undefined && discount_price !== null && (isNaN(parseFloat(discount_price)) || parseFloat(discount_price) < 0)) {
        return res.status(400).json({ error: 'Discount price must be a valid number if provided.' });
    }
    if (stock_level !== undefined && stock_level !== null && (isNaN(parseInt(stock_level, 10)) || parseInt(stock_level, 10) < 0)) {
        return res.status(400).json({ error: 'Stock level must be a valid non-negative integer if provided.' });
    }
    // is_on_sale will be coerced to boolean later

    try {
        // 1. Verify the product exists and belongs to the authenticated supplier
        const checkOwnerQuery = 'SELECT supplier_id FROM products WHERE id = $1';
        const ownerResult = await db.query(checkOwnerQuery, [parsedProductId]);

        if (ownerResult.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found.' });
        }
        // Ensure supplierId from token (number) matches supplier_id from DB (likely number)
        if (ownerResult.rows[0].supplier_id !== supplierId) { 
            return res.status(403).json({ error: 'Forbidden: You do not own this product.' });
        }

        // 2. If ownership is confirmed, proceed with update
        // The database trigger will handle 'updated_at = NOW()' automatically.
        const updateQuery = `
            UPDATE products 
            SET 
                name = $1, 
                description = $2, 
                price = $3, 
                discount_price = $4, 
                category = $5, 
                image_url = $6, 
                is_on_sale = $7, 
                stock_level = $8
            WHERE id = $9 AND supplier_id = $10 -- Double check supplier_id for extra safety
            RETURNING *; 
        `;

        const finalPrice = parseFloat(price);
        const finalDiscountPrice = (discount_price !== undefined && discount_price !== null && !isNaN(parseFloat(discount_price))) ? parseFloat(discount_price) : null;
        const finalIsOnSale = (is_on_sale === true || is_on_sale === 'true'); // Coerce to boolean
        const finalStockLevel = (stock_level !== undefined && stock_level !== null && !isNaN(parseInt(stock_level,10))) ? parseInt(stock_level, 10) : 0;


        const values = [
            name.trim(),
            description || null, // Use null if description is empty or not provided
            finalPrice,
            finalDiscountPrice,
            category.trim(),
            image_url || null,   // Use null if image_url is empty or not provided
            finalIsOnSale,
            finalStockLevel,
            parsedProductId,    // for WHERE id = $9
            supplierId          // for WHERE supplier_id = $10
        ];

        console.log(`[SUPPLIER_PRODUCT_UPDATE] Updating product ID ${parsedProductId} for supplier ID ${supplierId} with values:`, {
            name: values[0], category: values[4], price: values[2], stock: values[7] // Log some key values
        });

        const result = await db.query(updateQuery, values);

        if (result.rows.length === 0) {
            // This case should ideally not be reached if the owner check passed and ID is correct,
            // but it's a safeguard.
            console.error(`[SUPPLIER_PRODUCT_UPDATE] Update failed for product ID ${parsedProductId} despite ownership check.`);
            return res.status(404).json({ error: 'Product not found during update or update failed unexpectedly.' });
        }

        console.log(`[SUPPLIER_PRODUCT_UPDATE] Product ID ${parsedProductId} updated successfully.`);
        res.status(200).json(result.rows[0]); // Send back the updated product

    } catch (err) {
        console.error(`[SUPPLIER_PRODUCT_UPDATE] Error updating product ${parsedProductId} for supplier ${supplierId}:`, err);
        // Check for specific database errors if needed, e.g., constraint violations
        res.status(500).json({ error: 'Failed to update product due to a server error.' });
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
                        originalItemResult = await db.query('SELECT name, description, image_url, price, discount_price, is_on_sale FROM products WHERE id = $1', [definition.item_id]);
                        if (originalItemResult.rows.length > 0) { const p = originalItemResult.rows[0]; title = title || p.name; description = description || p.description; imageUrl = imageUrl || p.image_url; originalItemData = { price: p.price, discount_price: p.discount_price, is_on_sale: p.is_on_sale };}
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

// TODO LATER:
// PUT /api/supplier/deals/:dealId (authSupplier) - for editing
// DELETE /api/supplier/deals/:dealId (authSupplier) - for deleting
// ... (app.listen) ...
// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});