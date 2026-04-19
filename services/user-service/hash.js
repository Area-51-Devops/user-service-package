const bcrypt = require('bcryptjs');
console.log(bcrypt.hashSync('admin123', 10));
