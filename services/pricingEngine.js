// telegram-app-backend/services/pricingEngine.js
const cron = require('node-cron');
const db = require('../config/db'); // Adjust path to your db config

const calculateDemandAndAdjustPercentage = async () => {
    console.log(`[ADJUSTMENT_ENGINE] ${new Date().toISOString()} Starting scheduled price adjustment percentage task...`);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const masterProductsResult = await client.query(
            // Select initial_seed_price if you added it
            'SELECT id, current_price_adjustment_percentage, current_demand_score, initial_seed_price FROM master_products'
        );
        
        if (masterProductsResult.rows.length === 0) {
            console.log('[ADJUSTMENT_ENGINE] No master products found to process.');
            await client.query('COMMIT'); // Important to commit even if no work
            client.release(); // Release client
            return;
        }

        for (const masterProduct of masterProductsResult.rows) {
            const masterProductId = masterProduct.id;
            let currentAdjustmentPct = parseFloat(masterProduct.current_price_adjustment_percentage);
            // const initialSeedPrice = parseFloat(masterProduct.initial_seed_price); // For advanced capping

            // 1. Calculate Current Demand Score
            const demandQuery = `
                SELECT SUM(oi.quantity) AS total_sold
                FROM order_items oi
                JOIN products p ON oi.product_id = p.id
                JOIN orders o ON oi.order_id = o.id
                WHERE p.master_product_id = $1 
                  AND o.order_date >= NOW() - INTERVAL '7 days' 
                  AND o.status NOT IN ('cancelled', 'refunded', 'failed'); 
            `;
            const demandResult = await client.query(demandQuery, [masterProductId]);
            const demandScoreLast7Days = parseInt(demandResult.rows[0]?.total_sold || 0, 10);

            await client.query(
                'UPDATE master_products SET current_demand_score = $1 WHERE id = $2',
                [demandScoreLast7Days, masterProductId]
            );
            console.log(`[ADJUSTMENT_ENGINE] Master Product ${masterProductId}: Demand Score (last 7 days) = ${demandScoreLast7Days}`);

            // 2. Apply Gradual Pricing Adjustment Algorithm
            let newAdjustmentPct = currentAdjustmentPct;

            const HIGH_DEMAND_ADJ_THRESHOLD = 20; 
            const LOW_DEMAND_ADJ_THRESHOLD = 5;  
            const ADJUSTMENT_STEP_PERCENTAGE = 0.005; // 0.5% change per step
            const MAX_TOTAL_ADJUSTMENT_INCREASE = 0.10; // Max +10% adjustment overall
            const MAX_TOTAL_ADJUSTMENT_DECREASE = -0.05; // Max -5% adjustment overall

            if (demandScoreLast7Days > HIGH_DEMAND_ADJ_THRESHOLD) {
                newAdjustmentPct += ADJUSTMENT_STEP_PERCENTAGE;
            } else if (demandScoreLast7Days < LOW_DEMAND_ADJ_THRESHOLD) {
                newAdjustmentPct -= ADJUSTMENT_STEP_PERCENTAGE;
            }

            // Apply caps to the total adjustment percentage
            newAdjustmentPct = Math.min(newAdjustmentPct, MAX_TOTAL_ADJUSTMENT_INCREASE);
            newAdjustmentPct = Math.max(newAdjustmentPct, MAX_TOTAL_ADJUSTMENT_DECREASE);
            
            newAdjustmentPct = parseFloat(newAdjustmentPct.toFixed(4));

            if (newAdjustmentPct !== currentAdjustmentPct) {
                await client.query(
                    'UPDATE master_products SET current_price_adjustment_percentage = $1, last_adjustment_update = NOW() WHERE id = $2',
                    [newAdjustmentPct, masterProductId]
                );
                console.log(`[ADJUSTMENT_ENGINE] Master Product ${masterProductId}: Adjustment % changed from ${currentAdjustmentPct.toFixed(4)} to ${newAdjustmentPct.toFixed(4)}`);
            } else {
                console.log(`[ADJUSTMENT_ENGINE] Master Product ${masterProductId}: Adjustment % remains ${currentAdjustmentPct.toFixed(4)} (Demand: ${demandScoreLast7Days})`);
            }
        }
        await client.query('COMMIT');
        console.log(`[ADJUSTMENT_ENGINE] ${new Date().toISOString()} Price adjustment percentage task completed successfully.`);
    } catch (error) {
        if (client) await client.query('ROLLBACK'); // Ensure rollback on error
        console.error(`[ADJUSTMENT_ENGINE] ${new Date().toISOString()} Error during price adjustment task:`, error);
    } finally {
        if (client) client.release();
    }
};

module.exports = { calculateDemandAndAdjustPercentage };