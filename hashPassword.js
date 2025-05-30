// hashPassword.js
const bcrypt = require('bcrypt');
const saltRounds = 10;
const plainPassword = ''; // Choose a password

bcrypt.hash(plainPassword, saltRounds, function(err, hash) {
    if (err) {
        console.error('Error hashing password:', err);
        return;
    }
    console.log('Hashed Password:', hash);
    // Copy this hash and paste it into the password_hash column for your test supplier in Neon
});