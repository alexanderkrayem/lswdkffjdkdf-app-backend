// telegram-app-backend/createAdminHash.js
const bcrypt = require('bcrypt');
const saltRounds = 10; // Standard number of salt rounds for bcrypt

// --- CHOOSE YOUR ADMIN PASSWORD HERE ---
const adminPlainPassword = ''; 
// ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// IMPORTANT: Replace this with a strong, unique password for your admin account.
//            Do NOT commit this file with the plain password to Git if it's a real production password.
//            For local testing, it's okay, but remember to use a strong one for deployment.

if (!adminPlainPassword || adminPlainPassword === 'YourSecureAdminPassword123!') {
    console.error("ERROR: Please set a strong adminPlainPassword in createAdminHash.js before running.");
    process.exit(1); // Exit if default password is still there
}

bcrypt.hash(adminPlainPassword, saltRounds, function(err, hash) {
    if (err) {
        console.error('Error hashing password:', err);
        return;
    }
    console.log('--- Admin Password Hash ---');
    console.log('Plain Password Used (for your reference, do not store this):', adminPlainPassword);
    console.log('Bcrypt Hash (Copy this into your database):');
    console.log(hash);
    console.log('-----------------------------');
    console.log("Now, go to your Neon SQL Editor (or other DB tool) and run an INSERT or UPDATE command.");
    console.log("Example INSERT for a new admin (replace email and full_name):");
    console.log(`INSERT INTO admins (email, password_hash, full_name, role) VALUES ('admin@example.com', '${hash}', 'Platform Super Admin', 'admin');`);
    console.log("\nExample UPDATE if admin user 'admin@example.com' already exists but needs a password:");
    console.log(`UPDATE admins SET password_hash = '${hash}' WHERE email = 'admin@example.com';`);
});