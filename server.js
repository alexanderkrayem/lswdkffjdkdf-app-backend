// server.js
require('dotenv').config(); // Load environment variables from .env file
const db = require('./config/db'); // Import the db config
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001; // Use port from .env or default to 3001

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

// server.js
// ... (other require statements, middleware, existing routes for products, suppliers, cart, profile, orders, favorites) ...

// --- NEW: Global Search API Endpoint ---

// GET /api/search?searchTerm=...
app.get('/api/search', async (req, res) => {
    const searchTerm = req.query.searchTerm || '';
    const MIN_SEARCH_LENGTH = 3; // Minimum length to trigger search

    if (searchTerm.trim().length < MIN_SEARCH_LENGTH) {
        return res.json({
            searchTerm: searchTerm,
            results: { products: [], deals: [], suppliers: [] },
            message: `Search term must be at least ${MIN_SEARCH_LENGTH} characters.`
        });
    }

    // Define limits for each category in the results (can be adjusted)
    const RESULT_LIMIT_PER_CATEGORY = 10;

    // Use 'websearch_to_tsquery' for more flexible user input parsing
    const ftsQueryString = `websearch_to_tsquery('pg_catalog.arabic', $1)`;
    // Parameter for trigram similarity threshold
    const trigramThreshold = 0.25; // Adjust this threshold based on testing (0.0 to 1.0)

    try {
        // --- Search Products ---
        const productsQuery = `
            SELECT
                p.id, p.name, p.category, p.price, p.discount_price, p.is_on_sale, p.image_url, -- Select needed fields
                ts_rank_cd(p.tsv, query) AS rank -- FTS rank
                -- similarity(p.name, $1) AS name_sim -- Optionally calculate similarity
            FROM products p, ${ftsQueryString} query
            WHERE p.tsv @@ query OR similarity(p.name, $1) > $2 -- FTS match OR name similarity
            ORDER BY
                 CASE WHEN p.tsv @@ query THEN 0 ELSE 1 END, -- FTS matches first
                 ts_rank_cd(p.tsv, query) DESC,             -- Then by FTS rank
                 similarity(p.name, $1) DESC,               -- Then by name similarity
                 p.created_at DESC                           -- Finally by date
            LIMIT $3;
        `;
        const productsResult = await db.query(productsQuery, [searchTerm.trim(), trigramThreshold, RESULT_LIMIT_PER_CATEGORY]);

        // --- Search Deals ---
        const dealsQuery = `
            SELECT
                d.id, d.title, d.description, d.image_url, -- Select needed fields
                ts_rank_cd(d.tsv, query) AS rank
            FROM deals d, ${ftsQueryString} query
            WHERE d.is_active = TRUE AND (d.tsv @@ query OR similarity(d.title, $1) > $2)
            ORDER BY
                CASE WHEN d.tsv @@ query THEN 0 ELSE 1 END,
                ts_rank_cd(d.tsv, query) DESC,
                similarity(d.title, $1) DESC,
                d.created_at DESC
            LIMIT $3;
        `;
        const dealsResult = await db.query(dealsQuery, [searchTerm.trim(), trigramThreshold, RESULT_LIMIT_PER_CATEGORY]);

        // --- Search Suppliers ---
        const suppliersQuery = `
            SELECT
                s.id, s.name, s.category, s.location, s.rating, s.image_url, -- Select needed fields
                ts_rank_cd(s.tsv, query) AS rank
            FROM suppliers s, ${ftsQueryString} query
            WHERE s.tsv @@ query OR similarity(s.name, $1) > $2
            ORDER BY
                CASE WHEN s.tsv @@ query THEN 0 ELSE 1 END,
                ts_rank_cd(s.tsv, query) DESC,
                similarity(s.name, $1) DESC,
                s.id -- Tie breaker
            LIMIT $3;
        `;
        const suppliersResult = await db.query(suppliersQuery, [searchTerm.trim(), trigramThreshold, RESULT_LIMIT_PER_CATEGORY]);

        // --- Combine Results ---
        res.json({
            searchTerm: searchTerm,
            results: {
                products: productsResult.rows,
                deals: dealsResult.rows,
                suppliers: suppliersResult.rows
            }
        });

    } catch (err) {
        console.error(`Error during global search for term "${searchTerm}":`, err);
        // Handle specific errors like invalid tsquery syntax if needed
        if (err.message.includes("syntax error in tsquery")) {
             return res.status(400).json({ error: 'Invalid search query format. Please try different terms.' });
        }
        res.status(500).json({ error: 'Failed to perform search' });
    }
});

// ... (rest of server.js, app.listen) ...
// telegram-app-backend/server.js
// ... (other require statements, middleware, existing routes) ...

// --- NEW: GET all active deals ---
app.get('/api/deals', async (req, res) => {
    try {
        // Fetch deals, maybe filter by is_active = TRUE and order by end_date or created_at
        const query = `
            SELECT 
                id, title, description, discount_percentage, 
                start_date, end_date, product_id, supplier_id, image_url, 
                is_active, created_at 
                -- You might want to join with products/suppliers to get their names for display
                -- For example: p.name as product_name, s.name as supplier_name
            FROM deals 
            WHERE is_active = TRUE 
            -- AND (end_date IS NULL OR end_date >= CURRENT_DATE) -- Optionally filter out expired deals
            ORDER BY created_at DESC; 
            -- Or ORDER BY end_date ASC;
        `;
        const result = await db.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching deals:", err);
        res.status(500).json({ error: 'Failed to fetch deals' });
    }
});

// ... (rest of server.js) ...
// GET all products (NOW WITH PAGINATION)
app.get('/api/products', async (req, res) => { // Route handler starts

    // Default values for pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;

    // Ensure page and limit are positive
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, limit);

    const offset = (safePage - 1) * safeLimit;

    // TODO LATER: Variables for searchTerm, category, sortBy will be extracted from req.query here

    try { // Single try block for the entire operation
        // --- Query to get the paginated items ---
        let itemsQuery = 'SELECT * FROM products'; // Base query
        const queryParams = []; // Will hold values for $1, $2, etc.
        let paramCount = 0; // To keep track of parameter numbers $1, $2...

        // --- LATER: WHERE clauses for search and filters will be built here ---
        // Example of how a filter might be added:
        // if (req.query.category) {
        //     itemsQuery += (paramCount === 0 ? ' WHERE' : ' AND') + ` category = $${++paramCount}`;
        //     queryParams.push(req.query.category);
        // }

        itemsQuery += ' ORDER BY created_at DESC'; // Default sort order
        itemsQuery += ` LIMIT $${++paramCount} OFFSET $${++paramCount}`;
        queryParams.push(safeLimit, offset);

        // console.log("Executing itemsQuery:", itemsQuery, "with params:", queryParams);
        const itemsResult = await db.query(itemsQuery, queryParams);
        const products = itemsResult.rows;

        // --- Query to get the total count of items (for totalPages calculation) ---
        // This count MUST reflect any filters applied to itemsQuery for accuracy
        let countQuery = 'SELECT COUNT(*) AS total_items FROM products';
        const countQueryParams = []; // Will hold values for $1, $2 for the count query
        let countParamCount = 0; // Separate counter for count query params

        // --- LATER: The SAME WHERE clauses for search and filters MUST be built here ---
        // Example corresponding to category filter above:
        // if (req.query.category) {
        //     countQuery += (countParamCount === 0 ? ' WHERE' : ' AND') + ` category = $${++countParamCount}`;
        //     countQueryParams.push(req.query.category);
        // }

        // console.log("Executing countQuery:", countQuery, "with params:", countQueryParams);
        const countResult = await db.query(countQuery, countQueryParams);
        const totalItems = parseInt(countResult.rows[0].total_items, 10);
        const totalPages = Math.ceil(totalItems / safeLimit);

        // Send the single, final paginated response
        res.json({
            items: products,
            currentPage: safePage,
            totalPages: totalPages,
            totalItems: totalItems,
            limit: safeLimit
        });

    } catch (err) { // Single catch block for any error within the try
        console.error("Error fetching products with pagination:", err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
}); // Route handler ends
// server.js
// ... (other require statements, middleware, existing /api/products route) ...

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



// TODO LATER: Add PUT endpoint to specifically SET quantity (useful for +/- buttons)
// PUT /api/cart/item/{productId} { userId, newQuantity } -> UPDATE cart_items SET quantity = newQuantity ...
// server.js
// ... (other require statements, middleware, existing cart routes GET, POST, DELETE) ...

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

// ... (rest of server.js, app.listen)

// --- Start the Server ---
// ... (app.listen code) ...

// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});